"""Dealer AI decision engine: who should handle this customer, and why.

Customers act in the mobile app (book, describe the problem, photos). Behind it this
module makes the matching decisions and records each one with its evidence, so the
dealer back office can audit *why* the system chose an advisor or chauffeur, why a car
is due, and what is most likely behind the customer's complaint.

Matching models
    Two logistic-regression models (scikit-learn), one for advisor-customer fit and one
    for chauffeur-pickup fit. Each predicts P(good outcome): for advisors, CSAT >= 4 with
    no repeat repair; for chauffeurs, on-time pickup with rating >= 4. Hard constraints
    (off duty, full, shift end) filter candidates first; the model ranks the rest.
    Explanations are per-feature contributions to the log-odds against the average
    candidate, turned into plain sentences; Laya (local LLM) writes the rationale from
    those facts only.

    POC: the models are trained at start-up on a deterministic synthetic outcome history
    (`_history`). In production, retrain on the dealer's logged assignments and
    outcomes (DMS job cards + CSAT survey + pickup timestamps) with the same features.
"""

from __future__ import annotations

import threading
from datetime import date, datetime
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

from app import db, llm, vehicles
from app.service import concerns as cc
from app.service import outreach, scheduling, store
from app.service.catalog import PMS_INTERVAL_KM

db.register_schema(
    """
CREATE TABLE IF NOT EXISTS ai_decisions (
    id INTEGER PRIMARY KEY, kind TEXT, vehicle_id INTEGER, appointment_id INTEGER,
    visit_id INTEGER, chosen_id INTEGER, chosen_name TEXT, confidence REAL,
    summary TEXT, reasons TEXT, alternatives TEXT, evidence TEXT, narrative TEXT,
    engine TEXT, status TEXT, created_at TEXT
);
""",
    json_columns={"reasons", "alternatives", "evidence"},
)


# ------------------------------------------------------------------ models

ADVISOR_FEATURES = {
    "language": "speaks the customer's language",
    "skills": "specialisation covers this job",
    "relationship": "has handled this car before",
    "workload": "has capacity today",
    "seniority": "seniority / certification",
    "senior_language": "language match for a senior customer",
}
DRIVER_FEATURES = {
    "proximity": "is close to the customer",
    "workload": "has light trip load today",
    "acceptance": "rarely declines trips",
    "rating": "customer rating",
    "spare_shift": "time left in shift",
}


def _history(kind: str, n: int = 4000, seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    """Synthetic past assignments with outcomes. The hidden outcome process includes an
    interaction (language matters far more for senior customers) that the model must learn."""
    rng = np.random.default_rng(seed)
    if kind == "advisor":
        lang = rng.integers(0, 2, n)
        skills = rng.choice([0.0, 0.5, 1.0], n, p=[0.2, 0.4, 0.4])
        rel = rng.choice([0, 1 / 3, 2 / 3, 1], n, p=[0.55, 0.25, 0.12, 0.08])
        work = rng.uniform(0, 1, n)
        sen = rng.choice([0.3, 0.6, 1.0], n)
        senior = rng.integers(0, 2, n) * (rng.uniform(0, 1, n) < 0.25)
        X = np.c_[lang, skills, rel, work, sen, lang * senior]
        z = -2.2 + 1.1 * lang + 2.0 * skills + 1.2 * rel + 1.4 * work + 0.8 * sen + 1.6 * lang * senior - 1.0 * senior
    else:
        prox = rng.uniform(0, 1, n)
        work = rng.uniform(0, 1, n)
        acc = rng.uniform(0.6, 1.0, n)
        rating = rng.uniform(0, 1, n)
        spare = rng.uniform(0, 1, n)
        X = np.c_[prox, work, acc, rating, spare]
        z = -3.6 + 3.0 * prox + 0.9 * work + 2.2 * acc + 1.0 * rating + 0.6 * spare
    y = (rng.uniform(0, 1, n) < 1 / (1 + np.exp(-z))).astype(int)
    return X, y


class Matcher:
    def __init__(self, kind: str, features: dict[str, str]):
        self.kind, self.features = kind, features
        X, y = _history(kind)
        cut = int(len(y) * 0.8)
        self.model = LogisticRegression(max_iter=1000).fit(X[:cut], y[:cut])
        self.auc = float(roc_auc_score(y[cut:], self.model.predict_proba(X[cut:])[:, 1]))
        self.n_train = cut
        self.mean = X[:cut].mean(axis=0)

    def score(self, feats: dict[str, float]) -> tuple[float, dict[str, float]]:
        x = np.array([[feats[k] for k in self.features]])
        p = float(self.model.predict_proba(x)[0, 1])
        contrib = {k: float(c * (v - m)) for k, c, v, m in
                   zip(self.features, self.model.coef_[0], x[0], self.mean)}
        return p, contrib

    def card(self) -> dict[str, Any]:
        return {"kind": self.kind, "algorithm": "logistic regression (scikit-learn)",
                "trained_on": f"{self.n_train} past assignments (synthetic POC history)",
                "holdout_auc": round(self.auc, 3),
                "weights": {self.features[k]: round(float(c), 2) for k, c in zip(self.features, self.model.coef_[0])}}


ADVISOR_MODEL = Matcher("advisor", ADVISOR_FEATURES)
DRIVER_MODEL = Matcher("chauffeur", DRIVER_FEATURES)


def _top_reasons(contrib: dict[str, float], text: dict[str, str], k: int = 3,
                 skip: set[str] | None = None) -> tuple[list[str], list[str]]:
    contrib = {f: v for f, v in contrib.items() if f not in (skip or set())}  # not applicable here
    pos = [text[f] for f, v in sorted(contrib.items(), key=lambda kv: -kv[1]) if v > 0.05][:k]
    neg = [text[f] for f, v in sorted(contrib.items(), key=lambda kv: kv[1]) if v < -0.05][:2]
    return pos, neg


# --------------------------------------------------------------- advisors

LANG = {"hi": "Hindi", "en": "English", "pa": "Punjabi", "ur": "Urdu", "ml": "Malayalam", "kn": "Kannada"}


def _needs(vehicle: dict[str, Any], text: str) -> set[str]:
    needs = {"general"}
    interp = cc.interpret(text or "", vehicle, use_llm=False)
    if "body" in {c["system"] for c in interp["concerns"]}:
        needs.add("body")
    if cc.warranty_status(vehicle)["active"]:
        needs.add("warranty")
    if vehicle["fuel"] == "hybrid":
        needs.add("hybrid")
    return needs


def rank_advisors(conn, vehicle_id: int, text: str, day: date | None = None) -> dict[str, Any]:
    vehicle = vehicles.get(conn, vehicle_id)
    if vehicle is None:
        raise KeyError("vehicle not found")
    day = day or date.today()
    needs = _needs(vehicle, text)
    senior = vehicle["persona"] == "senior"
    out = []
    for a in store.many(conn, "SELECT * FROM advisors"):
        load = conn.execute(
            """SELECT (SELECT COUNT(*) FROM visits WHERE advisor_id = ? AND substr(arrived_at,1,10) = ?)
                    + (SELECT COUNT(*) FROM ai_decisions d JOIN appointments ap ON ap.id = d.appointment_id
                       WHERE d.kind = 'advisor' AND d.chosen_id = ? AND substr(ap.slot_start,1,10) = ?
                       AND ap.status NOT IN ('arrived','cancelled'))""",
            (a["id"], day.isoformat(), a["id"], day.isoformat())).fetchone()[0]
        prior = conn.execute("SELECT COUNT(*) FROM service_history WHERE vehicle_id = ? AND advisor_id = ?",
                             (vehicle_id, a["id"])).fetchone()[0]
        lang = 1.0 if vehicle["language"] in a["languages"] else 0.0
        feats = {
            "language": lang,
            "skills": len(needs & set(a["skills"])) / len(needs),
            "relationship": min(prior, 3) / 3,
            "workload": max(0.0, 1 - load / a["max_load"]),
            "seniority": 1.0 if "MSIL-SA-L3" in a["certifications"] else 0.6 if "MSIL-SA-L2" in a["certifications"] else 0.3,
            "senior_language": lang * (1.0 if senior else 0.0),
        }
        blockers = []
        if not a["on_duty"]:
            blockers.append("off duty")
        if load >= a["max_load"]:
            blockers.append(f"fully booked ({load}/{a['max_load']})")
        p, contrib = ADVISOR_MODEL.score(feats)
        pos, neg = _top_reasons(contrib, ADVISOR_FEATURES, skip=set() if senior else {"senior_language"})
        facts = []
        if lang:
            facts.append(f"speaks {LANG.get(vehicle['language'], vehicle['language'])}")
        covered = sorted((needs & set(a["skills"])) - {"general"})
        if covered:
            facts.append(f"{'/'.join(covered)} specialist")
        if prior:
            facts.append(f"handled this car {prior}x before")
        facts.append(f"{load}/{a['max_load']} customers today")
        out.append({"id": a["id"], "name": a["name"], "eligible": not blockers, "blockers": blockers,
                    "p_good": round(p, 3), "features": {k: round(v, 2) for k, v in feats.items()},
                    "contributions": {ADVISOR_FEATURES[k]: round(v, 2) for k, v in contrib.items()},
                    "for": pos, "against": neg, "facts": facts})
    out.sort(key=lambda r: (r["eligible"], r["p_good"]), reverse=True)
    return {"needs": sorted(needs), "customer_language": vehicle["language"], "senior_customer": senior,
            "candidates": out}


# --------------------------------------------------------------- chauffeurs

def rank_drivers(conn, vehicle_id: int, slot_start: datetime) -> dict[str, Any]:
    v = vehicles.get(conn, vehicle_id)
    if v is None:
        raise KeyError("vehicle not found")
    base = scheduling.rank_drivers(conn, v["lat"], v["lng"], slot_start)
    out = []
    for d in base["drivers"]:
        row = store.one(conn, "SELECT * FROM drivers WHERE id = ?", d["driver_id"])
        end = datetime.combine(slot_start.date(), datetime.strptime(row["shift_end"], "%H:%M").time())
        spare = max(0.0, min(1.0, (end - slot_start).total_seconds() / 3600 / 8))
        feats = {"proximity": max(0.0, 1 - d["distance_km"] / 25), "workload": 1 - d["trips_today"] / row["max_trips"],
                 "acceptance": d["acceptance_rate"], "rating": (d["rating"] - 3) / 2, "spare_shift": spare}
        p, contrib = DRIVER_MODEL.score(feats)
        pos, neg = _top_reasons(contrib, DRIVER_FEATURES)
        out.append({"id": d["driver_id"], "name": d["name"], "eligible": d["eligible"], "blockers": d["blockers"],
                    "p_good": round(p, 3), "features": {k: round(x, 2) for k, x in feats.items()},
                    "contributions": {DRIVER_FEATURES[k]: round(x, 2) for k, x in contrib.items()},
                    "for": pos, "against": neg,
                    "facts": [f"{d['distance_km']} km away", f"~{d['eta_to_customer_min']} min to customer",
                              f"{d['rating']}★", f"{d['trips_today']} trips today"],
                    "eta_to_customer_min": d["eta_to_customer_min"], "distance_km": d["distance_km"]})
    out.sort(key=lambda r: (r["eligible"], r["p_good"]), reverse=True)
    return {"candidates": out, "pickup": base["pickup"]}


# ---------------------------------------------------------- recording

def _record(conn, kind: str, vehicle_id: int, chosen: dict[str, Any] | None, summary: str,
            reasons: list[str], alternatives: list[dict[str, Any]], evidence: dict[str, Any],
            appointment_id: int | None = None, visit_id: int | None = None,
            confidence: float | None = None) -> int:
    cur = conn.execute(
        """INSERT INTO ai_decisions (kind, vehicle_id, appointment_id, visit_id, chosen_id, chosen_name, confidence,
               summary, reasons, alternatives, evidence, narrative, engine, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (kind, vehicle_id, appointment_id, visit_id, (chosen or {}).get("id"), (chosen or {}).get("name"),
         confidence, summary, db.dumps(reasons), db.dumps(alternatives), db.dumps(evidence), None,
         "model" if kind in ("advisor", "chauffeur") else "rules", "pending", store.now().isoformat()))
    return cur.lastrowid  # type: ignore[return-value]


NARRATIVE_SCHEMA = {
    "type": "object",
    "properties": {"rationale": {"type": "string", "maxLength": 420}},
    "required": ["rationale"],
}


def _narrate_prompt(d: dict[str, Any]) -> str:
    alts = "; ".join(f"{a['name']}: {', '.join(a.get('facts', []))}"
                     + (f" (not eligible: {', '.join(a['blockers'])})" if a.get("blockers") else "")
                     for a in d["alternatives"][:4])
    return (
        "You are the decision log of a Maruti Suzuki dealer service system. In 2-3 short sentences, "
        "explain to the service manager why this decision was made. Use ONLY the facts given; do not "
        "invent numbers.\n\n"
        f"Decision type: {d['kind']}\nDecision: {d['summary']}\nKey reasons: {'; '.join(d['reasons'])}\n"
        f"Other candidates: {alts or 'none'}\n"
        f"Evidence: {db.dumps({k: v for k, v in d['evidence'].items() if k != 'model'})[:2500]}"
    )


def narrate_in_background(decision_ids: list[int]) -> None:
    """Laya writes each rationale off the request path (first call loads the model)."""
    def work() -> None:
        for i in decision_ids:
            with store.connect() as conn:
                d = db.one(conn, "SELECT * FROM ai_decisions WHERE id = ?", i)
            if d is None:
                continue
            out = llm.decide(_narrate_prompt(d), NARRATIVE_SCHEMA, max_tokens=220)
            with store.connect() as conn:
                conn.execute("UPDATE ai_decisions SET narrative = ?, engine = ?, status = 'done' WHERE id = ?",
                             (out["rationale"] if out else None,
                              f"{d['engine']}+{llm.engine()}" if out else d["engine"], i))

    threading.Thread(target=work, name="ai-narrate", daemon=True).start()


# ------------------------------------------------------------ decisions

def decide_advisor(conn, vehicle_id: int, text: str, appointment_id: int | None = None,
                   visit_id: int | None = None, day: date | None = None) -> int:
    r = rank_advisors(conn, vehicle_id, text, day)
    best = next((c for c in r["candidates"] if c["eligible"]), None)
    if best is None:
        return _record(conn, "advisor", vehicle_id, None, "No advisor available: assign manually",
                       ["every advisor is off duty or fully booked"], r["candidates"], {"needs": r["needs"]},
                       appointment_id, visit_id)
    reasons = [f[0].upper() + f[1:] for f in best["facts"][:-1]] + [f"Capacity: {best['facts'][-1]}"]
    runner = next((c for c in r["candidates"] if c["id"] != best["id"] and c["eligible"]), None)
    if runner:
        reasons.append(f"Ahead of {runner['name']} ({best['p_good']:.0%} vs {runner['p_good']:.0%} predicted good outcome)")
    return _record(conn, "advisor", vehicle_id, best,
                   f"{best['name']} assigned as service advisor", reasons, r["candidates"],
                   {"needs": r["needs"], "customer_language": r["customer_language"],
                    "senior_customer": r["senior_customer"], "model": ADVISOR_MODEL.card()},
                   appointment_id, visit_id, best["p_good"])


def decide_driver(conn, vehicle_id: int, slot_start: datetime, appointment_id: int | None = None) -> tuple[int, int | None]:
    r = rank_drivers(conn, vehicle_id, slot_start)
    best = next((c for c in r["candidates"] if c["eligible"]), None)
    if best is None:
        return _record(conn, "chauffeur", vehicle_id, None, "No chauffeur available for this slot",
                       ["all chauffeurs off duty, on trips or past shift"], r["candidates"], {},
                       appointment_id), None
    reasons = [f[0].upper() + f[1:] for f in best["facts"]]
    skipped = [c for c in r["candidates"] if not c["eligible"]]
    if skipped:
        reasons.append("Skipped: " + "; ".join(f"{c['name']} ({', '.join(c['blockers'])})" for c in skipped[:3]))
    return _record(conn, "chauffeur", vehicle_id, best,
                   f"{best['name']} assigned for pickup · ETA {best['eta_to_customer_min']} min", reasons,
                   r["candidates"], {"slot": slot_start.isoformat(), "model": DRIVER_MODEL.card()},
                   appointment_id, None, best["p_good"]), best["id"]


DIAG_SCHEMA = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array", "maxItems": 5,
            "items": {
                "type": "object",
                "properties": {
                    "complaint": {"type": "string", "maxLength": 120},
                    "likely_cause": {"type": "string", "maxLength": 200},
                    "why": {"type": "string", "maxLength": 260},
                    "check_first": {"type": "string", "maxLength": 160},
                },
                "required": ["complaint", "likely_cause", "why", "check_first"],
            },
        },
    },
    "required": ["findings"],
}


def diagnose(conn, vehicle_id: int, text: str, appointment_id: int | None = None,
             visit_id: int | None = None, use_llm: bool = True) -> int:
    """Why is this customer facing this issue? Customer words + the car's own data."""
    v = vehicles.get(conn, vehicle_id)
    if v is None:
        raise KeyError("vehicle not found")
    interp = cc.interpret(text, v, use_llm=use_llm)
    hist = store.many(conn, "SELECT date, km, kind, demand_codes FROM service_history WHERE vehicle_id = ? ORDER BY date DESC LIMIT 4", vehicle_id)
    km_since = v["odometer"] - v["last_service_km"]
    tele = v.get("telemetry") or {}
    evidence = {
        "customer_said": text, "model": v["model"], "fuel": v["fuel"], "odometer": v["odometer"],
        "km_since_service": km_since, "last_service": v["last_service_date"],
        "age_years": round((date.today() - date.fromisoformat(v["sale_date"])).days / 365, 1),
        "telemetry": {"issue": tele.get("has_issue"), "reason": tele.get("reason"), "hits": tele.get("rule_hits")},
        "history": hist, "warranty": cc.warranty_status(v),
    }
    findings = []
    for c in interp["concerns"]:
        why = [f"customer said \"{c['customer_words']}\""] if c["source"] not in ("telemetry model", "history") else []
        if c["source"] == "telemetry model":
            why.append(f"car's OBD data: {c['customer_words'].removeprefix('OBD: ')}")
        if c["system"] == "general" and km_since >= PMS_INTERVAL_KM * 0.9:
            why.append(f"{km_since:,} km since last service")
        if c["demand_code"] in {code for h in hist for code in (h["demand_codes"] or [])}:
            why.append("same job done in an earlier visit (possible repeat)")
        findings.append({"complaint": c["label"], "likely_cause": c["cause"], "why": "; ".join(why) or c["source"],
                         "check_first": c["correction"], "demand_code": c["demand_code"]})
    did = _record(conn, "diagnosis", vehicle_id, None,
                  ", ".join(f["complaint"] for f in findings) or "No specific complaint recognised",
                  [f"{f['complaint']}: {f['likely_cause']}" for f in findings], [], evidence | {"findings": findings},
                  appointment_id, visit_id)
    if use_llm and text.strip():
        _diagnose_llm_in_background(did, text, evidence, findings)
    else:
        conn.execute("UPDATE ai_decisions SET status = 'done' WHERE id = ?", (did,))
    return did


def _diagnose_llm_in_background(did: int, text: str, evidence: dict[str, Any], findings: list[dict[str, Any]]) -> None:
    def work() -> None:
        prompt = (
            "You are a senior Maruti Suzuki service technician. For each customer complaint, give the most "
            "likely root cause on THIS car and why, using the vehicle facts (km, age, OBD data, history). "
            "Then what to check first. Be specific and brief. Use only the facts given.\n\n"
            f"Customer said: {text}\nVehicle facts: {db.dumps({k: v for k, v in evidence.items() if k != 'history'})}\n"
            f"Service history: {db.dumps(evidence['history'])}\n"
            f"Rule-based first pass: {db.dumps([{k: f[k] for k in ('complaint', 'likely_cause')} for f in findings])}"
        )
        out = llm.decide(prompt, DIAG_SCHEMA, max_tokens=500)
        with store.connect() as conn:
            if out and out["findings"]:
                d = db.one(conn, "SELECT evidence FROM ai_decisions WHERE id = ?", did)
                ev = (d or {}).get("evidence") or {}
                ev["llm_findings"] = out["findings"]
                # Keep the reviewed taxonomy findings as the decision. Free-form
                # model explanations are visible as supporting notes only.
                conn.execute("UPDATE ai_decisions SET evidence = ?, engine = ?, status = 'done' WHERE id = ?",
                             (db.dumps(ev), f"rules+{llm.engine()}", did))
            else:
                conn.execute("UPDATE ai_decisions SET status = 'done' WHERE id = ?", (did,))

    threading.Thread(target=work, name=f"diagnose-{did}", daemon=True).start()


def inspection_report(conn, visit_id: int) -> dict[str, Any] | None:
    """Laya turns the damage model's photo findings into an advisor-ready inspection note."""
    vi = db.one(conn, "SELECT * FROM visits WHERE id = ?", visit_id)
    cond = (vi or {}).get("condition") or {}
    if not vi or cond.get("status") != "done":
        return None
    existing = db.one(conn, "SELECT * FROM ai_decisions WHERE kind = 'inspection' AND visit_id = ?", visit_id)
    if existing:
        return existing
    images = cond.get("images", [])
    found = []
    for i, im in enumerate(images):
        kinds = [d.get("label") or d.get("class_name") or d.get("type") or "damage" for d in im.get("detections", [])]
        found.append({"photo": i + 1, "decision": im.get("decision"), "damage": kinds})
    flagged = [f for f in found if f["decision"] != "no_damage_detected"]
    summary = "No pre-existing damage found" if not flagged else f"Damage on {len(flagged)} of {len(found)} photos"
    did = _record(conn, "inspection", vi["vehicle_id"], None, summary,
                  [f"Photo {f['photo']}: {', '.join(f['damage']) or f['decision']}" for f in flagged],
                  [], {"photos": found, "available": cond.get("available", True)}, vi["appointment_id"], visit_id)
    narrate_in_background([did])
    return db.one(conn, "SELECT * FROM ai_decisions WHERE id = ?", did)


# ----------------------------------------------------------- service due

def service_due(conn, horizon: int = 45) -> list[dict[str, Any]]:
    """Which car is due and why, in plain reasons (from the outreach model's features)."""
    rows = outreach.due_list(conn, horizon)["customers"]
    out = []
    for r in rows:
        why = list(r["reasons"])
        if r["km_since"] >= PMS_INTERVAL_KM * 0.8 and r["due_in_days"] >= 0:
            why.append(f"{r['km_since']:,} km since last service (interval {PMS_INTERVAL_KM:,} km)")
        if r["retention_risk"] >= 0.5:
            why.append("At risk of servicing elsewhere: act early")
        out.append({"vehicle_id": r["vehicle_id"], "reg_no": r["reg_no"], "model": r["model"],
                    "customer_name": r["customer_name"], "due_date": r["due_date"], "due_in_days": r["due_in_days"],
                    "priority": "High" if r["priority"] >= 0.6 else "Medium" if r["priority"] >= 0.3 else "Low",
                    "due_probability": r["due_probability"], "retention_risk": r["retention_risk"],
                    "reasons": list(dict.fromkeys(why)), "booked": r["booked"],
                    "contributions": r["contributions"]})
    return out


# ------------------------------------------------------------- booking

def book(conn, vehicle_id: int, slot_start: str, mode: str, concerns: str) -> dict[str, Any]:
    """Customer booking from the app: the system picks chauffeur and advisor itself."""
    start = datetime.fromisoformat(slot_start)
    driver_id = driver_decision = None
    if mode == "pickup":
        driver_decision, driver_id = decide_driver(conn, vehicle_id, start)
        if driver_id is None:
            raise ValueError("no chauffeur can cover this pickup; choose another slot or drop the car in")
    appt = scheduling.book(conn, vehicle_id, slot_start, mode, concerns, driver_id)
    ids = []
    if driver_decision:
        conn.execute("UPDATE ai_decisions SET appointment_id = ? WHERE id = ?", (appt["id"], driver_decision))
        ids.append(driver_decision)
    ids.append(decide_advisor(conn, vehicle_id, concerns, appointment_id=appt["id"], day=start.date()))
    ids.append(diagnose(conn, vehicle_id, concerns, appointment_id=appt["id"]))
    narrate_in_background([i for i in ids[:2]])
    return {"appointment": scheduling.appointment(conn, appt["id"]), **booking_view(conn, appt["id"])}


def booking_view(conn, appointment_id: int) -> dict[str, Any]:
    ds = db.many(conn, "SELECT * FROM ai_decisions WHERE appointment_id = ? ORDER BY id", appointment_id)
    by = {d["kind"]: d for d in ds}
    return {"advisor": by.get("advisor"), "chauffeur": by.get("chauffeur"), "diagnosis": by.get("diagnosis")}


def booked_advisor(conn, appointment_id: int | None) -> int | None:
    if not appointment_id:
        return None
    d = db.one(conn, "SELECT chosen_id FROM ai_decisions WHERE kind = 'advisor' AND appointment_id = ? ORDER BY id DESC LIMIT 1",
               appointment_id)
    return (d or {}).get("chosen_id")


def decisions(conn, kind: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    sql = """SELECT d.*, v.reg_no, v.model, c.name AS customer_name FROM ai_decisions d
             JOIN vehicles v ON v.id = d.vehicle_id JOIN customers c ON c.id = v.customer_id"""
    rows = (db.many(conn, f"{sql} WHERE d.kind = ? ORDER BY d.id DESC LIMIT ?", kind, limit) if kind
            else db.many(conn, f"{sql} ORDER BY d.id DESC LIMIT ?", limit))
    from app.fleet.extract import format_plate
    for r in rows:
        r["reg_display"] = format_plate(r["reg_no"])
    return rows


def models() -> list[dict[str, Any]]:
    return [ADVISOR_MODEL.card(), DRIVER_MODEL.card()]


def seed(conn) -> None:
    """Decisions for today's existing bookings so the console is not empty after a reset."""
    if conn.execute("SELECT 1 FROM ai_decisions LIMIT 1").fetchone():
        return
    for a in db.many(conn, "SELECT * FROM appointments WHERE substr(slot_start,1,10) = ? ORDER BY slot_start",
                     date.today().isoformat()):
        if a["mode"] == "pickup" and a["driver_id"]:
            r = rank_drivers(conn, a["vehicle_id"], datetime.fromisoformat(a["slot_start"]))
            chosen = next((c for c in r["candidates"] if c["id"] == a["driver_id"]), None)
            if chosen:
                _record(conn, "chauffeur", a["vehicle_id"], chosen,
                        f"{chosen['name']} assigned for pickup · ETA {chosen['eta_to_customer_min']} min",
                        [f[0].upper() + f[1:] for f in chosen["facts"]], r["candidates"],
                        {"slot": a["slot_start"], "model": DRIVER_MODEL.card()}, a["id"], None, chosen["p_good"])
        if a["status"] != "arrived":
            decide_advisor(conn, a["vehicle_id"], a["concerns"] or "", appointment_id=a["id"])
        diagnose(conn, a["vehicle_id"], a["concerns"] or "", appointment_id=a["id"], use_llm=False)
    conn.execute("UPDATE ai_decisions SET status = 'done' WHERE status = 'pending' AND kind = 'diagnosis'")
    pending = [r["id"] for r in db.many(conn, "SELECT id FROM ai_decisions WHERE status = 'pending'")]
    if pending and llm.available():
        conn.commit()
        narrate_in_background(pending)
    else:
        conn.execute("UPDATE ai_decisions SET status = 'done' WHERE status = 'pending'")
