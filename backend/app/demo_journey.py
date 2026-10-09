"""One-tap end-to-end demo: a single car goes customer -> chauffeur -> gate -> advisor ->
customer approval -> technician bays -> QC -> cashier -> gate-out.

Every step calls the same domain functions the real screens use, so all other screens
(workshop board, pickups, billing, the customer's My car) update live while it runs.
The client holds the context (vehicle, appointment, visit, job card) and posts it back.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from app import ai, erp, vehicles
from app import db
from app.fleet import gate
from app.fleet import store as trips
from app.service import eta, jobcard, reception, scheduling, store
from app.service.demo import odometer_for

CONCERNS = "Periodic service due. AC not cooling enough and a squeal from the front brakes."

# key, role, title, what the step shows
STEPS: list[tuple[str, str, str, str]] = [
    ("book", "customer", "Customer books a pickup", "AI matches a chauffeur and a service advisor"),
    ("dispatch", "driver", "Chauffeur dispatched", "Driver starts the trip to the customer"),
    ("arrive", "driver", "Chauffeur at customer", "Driver reaches the customer's door"),
    ("handover", "driver", "Car handed over", "Plate, VIN and odometer captured at the door"),
    ("drive", "driver", "Driving to workshop", "Live GPS until the car reaches the gate"),
    ("check_in", "gate", "Gate check-in", "Security validates the car; booked advisor takes it"),
    ("job_card", "advisor", "Job card & estimate", "Concerns become demand codes, parts and labour"),
    ("approve", "customer", "Customer approves estimate", "Parts reserved, bay and technician allocated"),
    ("release", "advisor", "Released to workshop", "Car goes onto the floor"),
    ("bay", "technician", "Technician pulls to next bay", "Car moves to the next free bay"),
    ("qc", "technician", "Work done, sent to QC", "Final inspection & road test"),
    ("qc_pass", "technician", "QC passed", "Ready for delivery"),
    ("deliver", "cashier", "Billed & delivered", "Invoice closed, payment collected"),
    ("gate_out", "gate", "Gate-out", "Car leaves; exit validated against gate-in"),
]


def steps() -> list[dict[str, str]]:
    return [{"key": k, "role": r, "title": t, "hint": h} for k, r, t, h in STEPS]


def _pick_vehicle(conn) -> dict[str, Any]:
    busy = {r["vehicle_id"] for r in db.many(conn, """
        SELECT vehicle_id FROM appointments WHERE status NOT IN ('arrived','cancelled','no_show')
        UNION SELECT vehicle_id FROM visits WHERE status != 'delivered'
        UNION SELECT vehicle_id FROM job_cards WHERE status IN ('draft','approved')""")}
    released = db.many(conn, "SELECT id, vehicle_id FROM job_cards WHERE status = 'released'")
    for jc in released:
        w = erp._wip(conn, jc["id"])
        if not w or w["stage"] != "delivered":
            busy.add(jc["vehicle_id"])
    for row in db.many(conn, "SELECT id FROM vehicles ORDER BY id"):
        if row["id"] in busy:
            continue
        v = vehicles.get(conn, row["id"])
        if v and v.get("vin") and not trips.open_trip(conn, v["reg_no"]):
            return v
    raise ValueError("no idle vehicle available for the demo; reset the demo data first")


def _book(conn, vehicle_id: int) -> dict[str, Any]:
    """Book the earliest pickup slot that has capacity and a chauffeur free."""
    for days in range(7):
        day = (store.now() + timedelta(days=days)).date()
        for slot in scheduling.slots(conn, day, vehicle_id, "pickup")["slots"]:
            if not slot["feasible"]:
                continue
            conn.execute("SAVEPOINT demo_book")
            try:
                out = ai.book(conn, vehicle_id, slot["start"], "pickup", CONCERNS)
                conn.execute("RELEASE demo_book")
                return out
            except ValueError:
                conn.execute("ROLLBACK TO demo_book")
                conn.execute("RELEASE demo_book")
    raise ValueError("no pickup slot with a free chauffeur in the next week")


def run(conn, step: str, ctx: dict[str, Any]) -> dict[str, Any]:
    ctx = dict(ctx or {})
    note = ""
    if step != "bay" and ctx.get("appointment_id"):
        p = progress(conn, ctx)
        ctx = p["ctx"]
        if step in p["done"]:  # already done on a real screen
            return {"ctx": ctx, "note": "done on screen"}
    if step == "book":
        v = _pick_vehicle(conn)
        out = _book(conn, v["id"])
        appt = out["appointment"]
        ctx.update(vehicle_id=v["id"], reg=v["reg_display"], model=v.get("model"),
                   customer=v.get("customer_name"), appointment_id=appt["id"], qr=appt.get("qr_token"))
        drv = db.one(conn, "SELECT name FROM drivers WHERE id = ?", appt["driver_id"]) or {}
        adv = (out.get("advisor") or {}).get("chosen_name") or ""
        ctx["driver"] = drv.get("name")
        note = f"Chauffeur {drv.get('name', '')} matched" + (f" · advisor {adv}" if adv else "")
    elif step == "dispatch":
        eta.dispatch(conn, ctx["appointment_id"])
        note = f"{ctx.get('driver') or 'Chauffeur'} is on the way"
    elif step == "arrive":
        a = db.one(conn, "SELECT pickup_lat, pickup_lng FROM appointments WHERE id = ?", ctx["appointment_id"])
        eta.ping(conn, ctx["appointment_id"], a["pickup_lat"], a["pickup_lng"])
        conn.execute("UPDATE appointments SET status = 'at_customer' WHERE id = ?", (ctx["appointment_id"],))
        note = "Chauffeur is at the customer's door"
    elif step == "handover":
        v = vehicles.get(conn, ctx["vehicle_id"])
        odo = odometer_for(conn, v)
        eta.handover(conn, ctx["appointment_id"], gate.Capture(plate=v["reg_no"], vin=v["vin"], odometer=odo))
        ctx["odo_out"] = odo
        note = f"Handover captured · {odo:,} km"
    elif step == "drive":
        from app.service.catalog import DEALERSHIP
        eta.ping(conn, ctx["appointment_id"], DEALERSHIP["lat"], DEALERSHIP["lng"])
        conn.execute("UPDATE appointments SET status = 'at_gate' WHERE id = ?", (ctx["appointment_id"],))
        note = "Car is at the workshop gate"
    elif step == "check_in":
        v = vehicles.get(conn, ctx["vehicle_id"])
        odo = odometer_for(conn, v)
        out = reception.check_in(conn, gate.Capture(plate=v["reg_no"], vin=v["vin"], odometer=odo), [])
        visit = out["visit"]
        if not visit.get("advisor_id"):
            ranked = reception.rank_advisors(conn, visit["id"])["advisors"]
            if ranked:
                reception.assign_advisor(conn, visit["id"], ranked[0]["advisor_id"])
        ctx.update(visit_id=visit["id"], odo_in=odo)
        note = f"Checked in at {odo:,} km"
    elif step == "job_card":
        jc = jobcard.create_draft(conn, ctx["appointment_id"], ctx["visit_id"], CONCERNS, use_llm=False)
        ctx["job_card_id"] = jc["id"]
        total = jc["payload"]["estimate"]["totals"]["customer_payable"] if "payload" in jc else None
        note = f"Job card JC-{jc['id']}" + (f" · estimate ₹{total:,.0f}" if total else "")
    elif step == "approve":
        jobcard.approve(conn, ctx["job_card_id"])
        note = "Estimate approved by the customer"
    elif step == "release":
        jobcard.release(conn, ctx["job_card_id"])
        note = "Car is on the workshop floor"
    elif step == "bay":
        wo = erp.move_bay(conn, ctx["job_card_id"])
        bay = ((wo["job_card"].get("payload") or wo["job_card"]).get("allocation") or {}).get("bay") or {}
        note = f"Moved to {bay.get('name', 'next bay')}"
    elif step in ("qc", "qc_pass"):
        erp.advance(conn, ctx["job_card_id"])
        note = "Sent to quality check" if step == "qc" else "QC passed · ready for delivery"
    elif step == "deliver":
        erp.deliver(conn, ctx["job_card_id"], "UPI")
        note = "Invoice paid by UPI"
    elif step == "gate_out":
        v = vehicles.get(conn, ctx["vehicle_id"])
        erp.gate_out(conn, ctx["vehicle_id"], "Security", v["reg_no"], v["vin"], (ctx["odo_in"] + 2) if ctx.get("odo_in") else None)
        note = "Car has left the dealership"
    else:
        raise KeyError(f"unknown step {step}")
    return {"ctx": ctx, "note": note}


def progress(conn, ctx: dict[str, Any]) -> dict[str, Any]:
    """Which steps are done for this car, read from the database, so a real button press
    on any screen counts the same as the step being run here."""
    ctx = dict(ctx or {})
    done: list[str] = []
    a = db.one(conn, "SELECT status FROM appointments WHERE id = ?", ctx.get("appointment_id")) if ctx.get("appointment_id") else None
    if a:
        done.append("book")
        order = ["booked", "en_route", "at_customer", "collected", "at_gate", "arrived"]
        i = order.index(a["status"]) if a["status"] in order else -1
        done += [k for k, need in (("dispatch", 1), ("arrive", 2), ("handover", 3), ("drive", 4)) if i >= need]
        vi = db.one(conn, "SELECT id, odometer FROM visits WHERE appointment_id = ? ORDER BY id DESC LIMIT 1", ctx["appointment_id"])
        if vi:
            done.append("check_in")
            ctx.update(visit_id=vi["id"], odo_in=vi["odometer"])
            jc = db.one(conn, "SELECT id, status, payload FROM job_cards WHERE visit_id = ? ORDER BY id DESC LIMIT 1", vi["id"])
            if jc:
                done.append("job_card")
                ctx["job_card_id"] = jc["id"]
                ctx["bay"] = ((jc["payload"].get("allocation") or {}).get("bay") or {}).get("name")
                if jc["status"] in ("approved", "released"):
                    done.append("approve")
                if jc["status"] == "released":
                    done.append("release")
                    w = erp._wip(conn, jc["id"])
                    stage = w["stage"] if w else "in_progress"
                    rank = ["in_progress", "qc", "ready", "delivered"].index(stage)
                    if ctx.get("bay_before") and ctx["bay"] != ctx["bay_before"] or rank >= 1:
                        done.append("bay")
                    done += [k for k, need in (("qc", 1), ("qc_pass", 2), ("deliver", 3)) if rank >= need]
                    erp._gate_out_columns(conn)
                    if db.one(conn, "SELECT id FROM gate_outs WHERE job_card_id = ?", jc["id"]):
                        done.append("gate_out")
    return {"ctx": ctx, "done": done}
