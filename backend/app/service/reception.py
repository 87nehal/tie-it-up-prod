"""Use cases 6, 7 and 8: gate-in, condition capture and smart advisor assignment.

Gate-in is the Hub Gate: the same on-device OCR (`/api/fleet/extract`), the same
validation and the same trip log (`app.fleet.gate`). A chauffeur pickup closes its
open trip here; a customer who drives in is recorded as a walk-in arrival. Condition
photos go through the damage model already loaded for the Inspection page.
"""

from __future__ import annotations

import base64
import threading
from datetime import date
from pathlib import Path
from typing import Any

from app import vehicles
from app.fleet import gate
from app.fleet.extract import format_plate
from app.paths import VISIT_CAPTURES
from app.service import concerns as cc
from app.service import store
from app.service.catalog import DEALERSHIP

_PREDICT_LOCK = threading.Lock()  # one inference at a time; the predictor is shared


def _todays_appointment(conn, vehicle_id: int) -> dict[str, Any] | None:
    return store.one(
        conn,
        """SELECT * FROM appointments WHERE vehicle_id = ? AND substr(slot_start,1,10) = ?
           AND status IN ('booked','en_route','at_customer','collected','at_gate') ORDER BY slot_start LIMIT 1""",
        vehicle_id, date.today().isoformat(),
    )


def check_in(conn, cap: gate.Capture, condition_files: list[bytes]) -> dict[str, Any]:
    vehicle = vehicles.by_plate(conn, cap.plate) or (vehicles.by_vin(conn, cap.vin) if cap.vin else None)
    if vehicle is None:
        raise KeyError("vehicle is not in the vehicle master; register the customer first")
    result = gate.checkin(conn, cap, allow_walk_in=True)  # raises gate.GateRejected
    trip = result["trip"]
    # A pickup trip identifies its booking even when demonstrated before its slot
    # or when a delayed trip crosses midnight.
    appt = (store.one(conn, "SELECT * FROM appointments WHERE id = ?", trip["appointment_id"])
            if trip and trip.get("appointment_id") else _todays_appointment(conn, vehicle["id"]))
    cur = conn.execute(
        """INSERT INTO visits (appointment_id, vehicle_id, trip_id, arrived_at, odometer, gate_checks,
               condition, advisor_id, status) VALUES (?,?,?,?,?,?,?,?,?)""",
        (appt["id"] if appt else None, vehicle["id"], trip["id"] if trip else None,
         store.now().isoformat(), cap.odometer, store.dumps(result["validation"]["checks"]),
         store.dumps({"status": "pending", "images": []} if condition_files else None), None, "received"),
    )
    visit_id = cur.lastrowid
    if condition_files:
        VISIT_CAPTURES.mkdir(parents=True, exist_ok=True)
        for i, payload in enumerate(condition_files):
            photo_path(visit_id, i, False).write_bytes(payload)
    if appt:
        from app import ai  # the advisor matched at booking takes the car

        booked = ai.booked_advisor(conn, appt["id"])
        if booked:
            conn.execute("UPDATE visits SET advisor_id = ?, status = 'with_advisor' WHERE id = ?", (booked, visit_id))
        conn.execute("UPDATE appointments SET status = 'arrived' WHERE id = ?", (appt["id"],))
        if appt["driver_id"]:
            conn.execute("UPDATE drivers SET status = 'available', lat = ?, lng = ? WHERE id = ?",
                         (DEALERSHIP["lat"], DEALERSHIP["lng"], appt["driver_id"]))
    if cap.odometer:
        conn.execute("UPDATE vehicles SET odometer = MAX(odometer, ?) WHERE id = ?", (cap.odometer, vehicle["id"]))
    return {"visit": visit(conn, visit_id), "trip": trip, "validation": result["validation"],
            "appointment": appt, "walk_in": appt is None}


# ------------------------------------------------------ condition (use case 7)

def photo_path(visit_id: int, index: int, annotated: bool) -> Path:
    return VISIT_CAPTURES / f"visit{visit_id}_{index}{'_annotated' if annotated else ''}.jpg"


def assess_condition(visit_id: int, images: list[bytes]) -> dict[str, Any]:
    """Damage model over walk-around photos; overlays saved next to the originals."""
    from app.damage.service import get_predictor

    try:
        predictor = get_predictor()
    except RuntimeError as exc:
        return {"status": "done", "available": False, "error": str(exc), "images": []}
    out = []
    for i, payload in enumerate(images):
        try:
            with _PREDICT_LOCK:
                r = predictor.predict_bytes(payload)
        except ValueError as exc:
            out.append({"decision": "recapture_required", "reason": str(exc), "detections": []})
            continue
        annotated = None
        if r.get("annotated_jpeg_b64"):
            photo_path(visit_id, i, True).write_bytes(base64.b64decode(r["annotated_jpeg_b64"]))
            annotated = f"/api/service/visits/{visit_id}/photos/{i}?annotated=true"
        out.append({
            "decision": r["decision"], "reason": r["reason"], "n_detections": r["n_detections"],
            "detections": r["detections"], "photo_url": f"/api/service/visits/{visit_id}/photos/{i}",
            "annotated_url": annotated,
        })
    flagged = [o for o in out if o["decision"] != "no_damage_detected"]
    return {"status": "done", "available": True, "images": out,
            "summary": "No pre-existing damage found" if not flagged
            else f"{len(flagged)} of {len(out)} photo(s) show damage or need review"}


def assess_in_background(visit_id: int, images: list[bytes]) -> None:
    """On a CPU-only box this takes minutes per photo, so the gate never waits for it."""
    def work() -> None:
        try:
            result = assess_condition(visit_id, images)
        except Exception as exc:  # never leave the visit stuck on "pending"
            result = {"status": "done", "available": False, "error": str(exc), "images": []}
        with store.connect() as conn:
            conn.execute("UPDATE visits SET condition = ? WHERE id = ?", (store.dumps(result), visit_id))
        from app import ai  # Laya writes the advisor's inspection note from the findings

        with store.connect() as conn:
            ai.inspection_report(conn, visit_id)

    threading.Thread(target=work, name=f"condition-{visit_id}", daemon=True).start()


# --------------------------------------------------------------- queries

def visit(conn, visit_id: int) -> dict[str, Any] | None:
    return store.one(
        conn,
        """SELECT vi.*, v.reg_no, v.model, v.fuel, c.name AS customer_name, c.language,
                  a.name AS advisor_name, ap.concerns, ap.slot_start, ap.mode
           FROM visits vi JOIN vehicles v ON v.id = vi.vehicle_id JOIN customers c ON c.id = v.customer_id
           LEFT JOIN advisors a ON a.id = vi.advisor_id LEFT JOIN appointments ap ON ap.id = vi.appointment_id
           WHERE vi.id = ?""",
        visit_id,
    )


def visits_today(conn) -> list[dict[str, Any]]:
    ids = [r["id"] for r in store.many(conn, "SELECT id FROM visits WHERE substr(arrived_at,1,10) = ? ORDER BY id DESC",
                                       date.today().isoformat())]
    out = []
    for i in ids:
        v = visit(conn, i)
        jc = store.one(conn, "SELECT id, status FROM job_cards WHERE visit_id = ? ORDER BY id DESC LIMIT 1", i)
        out.append({**v, "job_card": jc})  # type: ignore[dict-item]
    return out


def arrivals_expected(conn) -> list[dict[str, Any]]:
    rows = store.many(
        conn,
        """SELECT a.id, a.vehicle_id, a.slot_start, a.mode, a.status, a.qr_token, v.reg_no, v.model,
                  c.name AS customer_name, t.id AS trip_id
           FROM appointments a JOIN vehicles v ON v.id = a.vehicle_id JOIN customers c ON c.id = v.customer_id
           LEFT JOIN trips t ON t.appointment_id = a.id AND t.checkin_at IS NULL
           WHERE (substr(a.slot_start,1,10) = ? AND a.status = 'booked')
              OR a.status IN ('en_route','at_customer','collected','at_gate')
           ORDER BY a.slot_start""",
        date.today().isoformat(),
    )
    return [{**r, "reg_display": format_plate(r["reg_no"])} for r in rows]


def by_qr(conn, token: str) -> dict[str, Any] | None:
    a = store.one(conn, "SELECT * FROM appointments WHERE qr_token = ?", token.strip().upper())
    return {**vehicles.get(conn, a["vehicle_id"]), "appointment": a} if a else None  # type: ignore[dict-item]


# --------------------------------------------------- advisor ranking (use case 8)

def rank_advisors(conn, visit_id: int) -> dict[str, Any]:
    """Advisor ranking for a visit, from the AI matching model (app.ai). The advisor
    matched at booking, if still available, stays first so the gate does not reassign."""
    from app import ai

    vi = visit(conn, visit_id)
    if vi is None:
        raise KeyError("visit not found")
    r = ai.rank_advisors(conn, vi["vehicle_id"], vi.get("concerns") or "")
    booked = ai.booked_advisor(conn, vi["appointment_id"]) or vi["advisor_id"]
    out = []
    for c in r["candidates"]:
        a = store.one(conn, "SELECT * FROM advisors WHERE id = ?", c["id"])
        out.append({"advisor_id": c["id"], "name": c["name"], "languages": a["languages"], "skills": a["skills"],
                    "load_today": int(round((1 - c["features"]["workload"]) * a["max_load"])),
                    "max_load": a["max_load"], "prior_visits": int(round(c["features"]["relationship"] * 3)),
                    "available": c["eligible"], "score": c["p_good"] if c["eligible"] else 0.0,
                    "breakdown": c["contributions"], "booked": c["id"] == booked})
    out.sort(key=lambda x: (x["booked"] and x["available"], x["score"]), reverse=True)
    return {"visit_id": visit_id, "needs": r["needs"], "customer_language": vi["language"], "advisors": out}


def assign_advisor(conn, visit_id: int, advisor_id: int) -> dict[str, Any]:
    conn.execute("UPDATE visits SET advisor_id = ?, status = 'with_advisor' WHERE id = ?", (advisor_id, visit_id))
    return visit(conn, visit_id)  # type: ignore[return-value]
