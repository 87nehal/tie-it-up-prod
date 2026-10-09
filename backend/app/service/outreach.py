"""Use cases 1 and 2: service-due intelligence and next-best-action outreach.

The due/retention scores are a transparent logistic model over interval, usage,
loyalty and the car's own telemetry verdict (the `car_health` model run on its
latest OBD log, see `telematics`). The coefficients are hand-set priors, not fitted:
there is no labelled "did the customer come in" history yet. Every score ships with
the factor contributions that produced it so a CCE can see why a customer is listed.
"""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Any

from app import llm, vehicles
from app.service import store
from app.service.catalog import DEMAND_CODES, PMS_INTERVAL_DAYS, PMS_INTERVAL_KM

MODEL_NOTE = "Heuristic logistic priors; refit on outreach outcomes once they are logged."


def _sigmoid(z: float) -> float:
    return 1 / (1 + math.exp(-z))


def _features(v: dict[str, Any], hist: list[dict[str, Any]], today: date) -> dict[str, Any]:
    last = date.fromisoformat(v["last_service_date"])
    days_since = (today - last).days
    km_since = max(0, v["odometer"] - v["last_service_km"])
    km_ratio = km_since / PMS_INTERVAL_KM
    day_ratio = days_since / PMS_INTERVAL_DAYS
    km_left = PMS_INTERVAL_KM - km_since
    days_by_km = km_left / max(v["avg_km_day"], 1)
    due_in_days = int(min(PMS_INTERVAL_DAYS - days_since, days_by_km))
    at_dealer = [h for h in hist if h["at_dealer"]]
    loyalty = len(at_dealer) / max(len(hist), 1)
    tele = v.get("telemetry") or {}
    return {
        "days_since": days_since,
        "km_since": km_since,
        "interval_ratio": round(max(km_ratio, day_ratio), 2),
        "due_in_days": due_in_days,
        "due_date": (today + timedelta(days=due_in_days)).isoformat(),
        "loyalty": round(loyalty, 2),
        "last_at_dealer": bool(hist and hist[0]["at_dealer"]),
        "tele_flags": tele.get("codes", []),
        "telemetry": tele or None,
        "vehicle_age_years": round((today - date.fromisoformat(v["sale_date"])).days / 365, 1),
    }


def score_vehicle(v: dict[str, Any], hist: list[dict[str, Any]], today: date) -> dict[str, Any]:
    f = _features(v, hist, today)
    contrib = {
        "interval": 4.0 * (f["interval_ratio"] - 0.85),
        "telemetry": 0.9 * len(f["tele_flags"]),
        "overdue": 0.8 if f["due_in_days"] < 0 else 0.0,
    }
    due_p = _sigmoid(sum(contrib.values()))
    risk_contrib = {
        "overdue_gap": 0.015 * max(0, -f["due_in_days"]),
        "low_loyalty": 2.2 * (1 - f["loyalty"]),
        "went_elsewhere": 1.2 if not f["last_at_dealer"] else 0.0,
        "vehicle_age": 0.25 * max(0.0, f["vehicle_age_years"] - 3),
    }
    risk_p = _sigmoid(sum(risk_contrib.values()) - 1.8)
    reasons = []
    km_over = f["km_since"] - PMS_INTERVAL_KM
    days_over = f["days_since"] - PMS_INTERVAL_DAYS
    if f["due_in_days"] < 0:
        # say which limit was crossed, in its own unit: a km-bound car "overdue by 2,700 days" reads as nonsense
        if km_over > 0 and (days_over <= 0 or km_over / max(v["avg_km_day"], 1) > days_over):
            reasons.append(f"{km_over:,} km past the {PMS_INTERVAL_KM:,} km service interval "
                           f"({f['km_since']:,} km since last service)")
        else:
            reasons.append(f"{days_over} days past the yearly service ({f['days_since']} days since last visit)")
    elif f["due_in_days"] <= 30:
        reasons.append(f"Due in {f['due_in_days']} days ({f['km_since']:,} km since last service, "
                       f"{v['avg_km_day']:.0f} km/day)")
    tele = f["telemetry"] or {}
    for hit in tele.get("rule_hits", []):
        reasons.append(f"Telemetry: {hit}")
    if tele.get("has_issue") and not tele.get("rule_hits"):
        reasons.append(f"Telemetry model: issue pattern (p={tele['issue_probability']:.2f})")
    if not f["last_at_dealer"]:
        reasons.append("Last service done outside the dealership")
    return {
        **f,
        "due_probability": round(due_p, 3),
        "retention_risk": round(risk_p, 3),
        "priority": round(due_p * (0.6 + 0.8 * risk_p), 3),
        "contributions": {k: round(x, 2) for k, x in {**contrib, **risk_contrib}.items()},
        "reasons": reasons,
    }


def _vehicle_rows(conn) -> list[dict[str, Any]]:
    return vehicles.search(conn, limit=10_000)


def due_list(conn, horizon_days: int = 30, limit: int = 250) -> dict[str, Any]:
    today = date.today()
    booked = {
        r["vehicle_id"]
        for r in store.many(
            conn, "SELECT vehicle_id FROM appointments WHERE status IN ('booked','en_route') AND slot_start >= ?",
            today.isoformat(),
        )
    }
    out = []
    for v in _vehicle_rows(conn):
        hist = store.many(conn, "SELECT * FROM service_history WHERE vehicle_id = ? ORDER BY date DESC", v["id"])
        s = score_vehicle(v, hist, today)
        if s["due_in_days"] > horizon_days and not s["tele_flags"]:
            continue
        out.append({
            "vehicle_id": v["id"], "reg_no": v["reg_no"], "model": v["model"],
            "customer_name": v["customer_name"], "persona": v["persona"],
            "language": v["language"], "booked": v["id"] in booked, **s,
        })
    out.sort(key=lambda r: r["priority"], reverse=True)
    return {"generated_at": store.now().isoformat(), "horizon_days": horizon_days,
            "model_note": MODEL_NOTE, "customers": out[:limit]}


# ------------------------------------------------------------ next best action

MESSAGES = {
    "en": "Hi {name}, your {model} ({reg}) is {when} for service. {offer} Reply or tap to book {slot}.",
    "hi": "Namaste {name} ji, aapki {model} ({reg}) ki service {when} hai. {offer} Booking ke liye {slot} chunein.",
    "pa": "Sat Sri Akal {name} ji, tuhadi {model} ({reg}) di service {when} hai. {offer} {slot} book karo.",
}


def next_best_action(conn, vehicle_id: int, use_llm: bool = False) -> dict[str, Any]:
    v = vehicles.get(conn, vehicle_id)
    if v is None:
        raise KeyError("vehicle not found")
    hist = store.many(conn, "SELECT * FROM service_history WHERE vehicle_id = ? ORDER BY date DESC", vehicle_id)
    s = score_vehicle(v, hist, date.today())

    # channels are limited to ones the dealership owns end to end
    channel = v["preferred_channel"]
    if s["retention_risk"] > 0.6:
        channel = "call"  # a human conversation for at-risk customers
    action = "remind"
    offer = None
    if s["tele_flags"]:
        action = "proactive_health_check"
        found = ", ".join(DEMAND_CODES[c]["label"].lower() for c in s["tele_flags"] if c in DEMAND_CODES)
        offer = f"Free health check: your car reported {found}"
    if s["retention_risk"] > 0.55:
        action = "win_back"
        offer = "10% off labour on your next paid service"
    elif v["persona"] in ("busy_professional", "senior"):
        offer = offer or "Free pickup and drop"
    elif v["persona"] == "value_seeker":
        offer = offer or "Off-peak slot: 5% off labour on weekday afternoons"
    elif v["persona"] == "fleet_owner":
        offer = offer or "Express service with priority bay"

    when_by_pref = {"morning": "tomorrow 9-11 AM", "afternoon": "tomorrow 2-4 PM",
                    "evening": "tomorrow 6-7 PM", "weekend": "this Saturday"}
    send_at = datetime.combine(date.today() + timedelta(days=0 if datetime.now().hour < 17 else 1),
                               datetime.min.time()).replace(hour=18 if v["preferred_time"] == "evening" else 10)
    when = "overdue" if s["due_in_days"] < 0 else f"due in {max(s['due_in_days'], 0)} days"
    lang = v["language"] if v["language"] in MESSAGES else "en"
    msg = MESSAGES[lang].format(
        name=v["customer_name"].split()[0], model=v["model"], reg=v["reg_no"], when=when,
        offer=(offer + ".") if offer else "", slot=when_by_pref[v["preferred_time"]],
    )
    engine = "template"
    if use_llm:
        out = llm.decide(
            "Rewrite this service reminder for a Maruti Suzuki customer. Keep it under 300 characters, "
            f"polite, in the same language (code '{lang}'), keep the offer and vehicle number.\n\n{msg}",
            {"type": "object", "properties": {"message": {"type": "string", "maxLength": 320}},
             "required": ["message"]},
        )
        if out and out.get("message"):
            msg, engine = out["message"], llm.engine()
    return {
        "vehicle_id": vehicle_id, "customer_name": v["customer_name"], "persona": v["persona"],
        "action": action, "channel": channel, "offer": offer, "send_at": send_at.isoformat(),
        "preferred_time": v["preferred_time"], "language": lang, "message": msg,
        "message_engine": engine, "score": s,
    }


def send(conn, vehicle_id: int, action: str, channel: str, offer: str | None, message: str) -> dict[str, Any]:
    """Queue in the local outbox; the dealer app / CCE dialler drains it. Nothing leaves the box here."""
    cur = conn.execute(
        "INSERT INTO outreach (vehicle_id, action, channel, offer, message, status, created_at) VALUES (?,?,?,?,?,?,?)",
        (vehicle_id, action, channel, offer, message, "queued", store.now().isoformat()),
    )
    return store.one(conn, "SELECT * FROM outreach WHERE id = ?", cur.lastrowid)  # type: ignore[return-value]


def outbox(conn, limit: int = 30) -> list[dict[str, Any]]:
    return store.many(
        conn,
        """SELECT o.*, v.reg_no, c.name AS customer_name FROM outreach o
           JOIN vehicles v ON v.id = o.vehicle_id JOIN customers c ON c.id = v.customer_id
           ORDER BY o.id DESC LIMIT ?""",
        limit,
    )
