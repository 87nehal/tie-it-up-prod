"""Dealer ERP layer: outlet context, workshop work-in-progress, delivery & invoicing,
Vehicle 360 and global search.

The service journey (`app.service`) produces appointments, visits and Job Cards; this
module ties them into one record per vehicle and one pipeline per outlet, so every
screen (desktop or the staff mobile app) works on the same work order.
"""

from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from typing import Any

from app import db, vehicles
from app.fleet.extract import format_plate
from app.service import outreach, store  # noqa: F401  (service tables must be registered first)
from app.service.catalog import GST, PARTS, STOCK_LOCATIONS

db.register_schema(
    """
CREATE TABLE IF NOT EXISTS outlets (
    id INTEGER PRIMARY KEY, code TEXT, name TEXT, channel TEXT, city TEXT, region TEXT,
    kind TEXT, active INTEGER
);
CREATE TABLE IF NOT EXISTS staff (
    id INTEGER PRIMARY KEY, outlet_id INTEGER, name TEXT, role TEXT, ref_id INTEGER
);
CREATE TABLE IF NOT EXISTS wip (
    job_card_id INTEGER PRIMARY KEY, stage TEXT, updated_at TEXT, history TEXT
);
CREATE TABLE IF NOT EXISTS inspections (
    visit_id INTEGER PRIMARY KEY, payload TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS gate_outs (
    id INTEGER PRIMARY KEY, vehicle_id INTEGER, job_card_id INTEGER, at TEXT, by TEXT
);
CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY, job_card_id INTEGER, vehicle_id INTEGER, number TEXT,
    labour REAL, parts REAL, gst REAL, total REAL, paid INTEGER, payment_mode TEXT,
    created_at TEXT
);
""",
    json_columns={"history", "payload"},
)

# Work order pipeline after the Job Card is released to the floor.
WIP_STAGES = ["in_progress", "qc", "ready", "delivered"]
STAGE_LABEL = {
    "expected": "Expected", "arrived": "Arrived", "estimate": "Estimate",
    "approved": "Approved", "in_progress": "In bay", "qc": "Quality check",
    "ready": "Ready for delivery", "delivered": "Delivered",
}

OUTLETS = [
    ("DLR-0412", "Sharma Motors - Sector 18", "ARENA", "Gurugram", "North 2", "Sales + Service", 1),
    ("DLR-0412-W2", "Sharma Motors - Udyog Vihar", "ARENA", "Gurugram", "North 2", "Service", 0),
    ("DLR-0587", "Sharma Motors NEXA - Golf Course Rd", "NEXA", "Gurugram", "North 2", "Sales + Service", 0),
]


def _seed(conn: sqlite3.Connection) -> None:
    from app.service import jobcard

    for i, row in enumerate(OUTLETS, 1):
        conn.execute("INSERT INTO outlets VALUES (?,?,?,?,?,?,?,?)", (i, *row))
    people = [("Anil Mehta", "service_manager", None)]
    people += [(r["name"], "service_advisor", r["id"]) for r in db.many(conn, "SELECT id, name FROM advisors")]
    people += [(r["name"], "technician", r["id"]) for r in db.many(conn, "SELECT id, name FROM technicians")]
    people += [(r["name"], "driver", r["id"]) for r in db.many(conn, "SELECT id, name FROM drivers")]
    people += [("Ram Prakash", "security", None), ("Seema Joshi", "cashier", None)]
    for name, role, ref in people:
        conn.execute("INSERT INTO staff (outlet_id, name, role, ref_id) VALUES (1,?,?,?)", (name, role, ref))

    t0 = store.now()
    for jc in db.many(conn, "SELECT id FROM job_cards WHERE status = 'released'"):
        _set_stage(conn, jc["id"], "in_progress", t0)

    # more cars on the floor so the board reads like a working day
    for vid, adv, concern, stage, mins in ((6, 2, "pms_light", "qc", 200), (10, 3, "battery", "ready", 260),
                                            (14, 4, "wash", "delivered", 330), (18, 1, "pull", "in_progress", 150)):
        arrived = (t0 - timedelta(minutes=mins)).isoformat()
        cur = conn.execute(
            "INSERT INTO appointments (vehicle_id, slot_start, mode, status, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?)",
            (vid, arrived, "walkin", "arrived", store.CONCERNS[concern], f"DSP-{10**7 + vid}", arrived))
        odo = conn.execute("SELECT odometer FROM vehicles WHERE id = ?", (vid,)).fetchone()[0] + 9
        vcur = conn.execute(
            "INSERT INTO visits (appointment_id, vehicle_id, arrived_at, odometer, gate_checks, condition, advisor_id, status) VALUES (?,?,?,?,?,?,?,?)",
            (cur.lastrowid, vid, arrived, odo, "[]", None, adv, "with_advisor"))
        jc = jobcard.create_draft(conn, None, vcur.lastrowid, None, use_llm=False)
        try:
            jobcard.approve(conn, jc["id"])
        except ValueError:
            conn.execute("UPDATE job_cards SET status = 'approved' WHERE id = ?", (jc["id"],))
        jobcard.release(conn, jc["id"])
        for s in WIP_STAGES[: WIP_STAGES.index(stage) + 1]:
            if s == "delivered":
                deliver(conn, jc["id"], "UPI", t0 - timedelta(minutes=20))
            else:
                _set_stage(conn, jc["id"], s, t0)

    # the rest of the outlet around the story vehicles: service base and a full working day
    from app.service import volume

    volume.seed(conn)


db.register_seeder(_seed)


def ensure(conn) -> None:
    """Databases seeded before the ERP layer existed get its seed on first use."""
    if conn.execute("SELECT 1 FROM outlets LIMIT 1").fetchone() is None:
        _seed(conn)
    from app import ai

    ai.seed(conn)


# ---------------------------------------------------------------- context

def context(conn) -> dict[str, Any]:
    outlets = db.many(conn, "SELECT * FROM outlets ORDER BY id")
    return {
        "dealer": {"name": "Sharma Motors Pvt Ltd", "code": "MSIL-D-0412", "oem": "Maruti Suzuki India Ltd"},
        "outlet": outlets[0],
        "outlets": outlets,
        "user": {"name": "Anil Mehta", "role": "Service Manager", "initials": "AM"},
        "business_date": date.today().isoformat(),
    }


def staff(conn) -> dict[str, Any]:
    return {
        "advisors": db.many(conn, "SELECT * FROM advisors ORDER BY id"),
        "technicians": db.many(conn, "SELECT * FROM technicians ORDER BY id"),
        "drivers": db.many(conn, "SELECT * FROM drivers ORDER BY id"),
        "bays": db.many(conn, "SELECT * FROM bays ORDER BY id"),
        "others": db.many(conn, "SELECT * FROM staff WHERE role IN ('service_manager','security','cashier')"),
    }


# ------------------------------------------------------------- work orders

def _set_stage(conn, jc_id: int, stage: str, at=None) -> None:
    at = (at or store.now()).isoformat()
    row = db.one(conn, "SELECT history FROM wip WHERE job_card_id = ?", jc_id)
    hist = (row["history"] if row else []) + [{"stage": stage, "at": at}]
    conn.execute("INSERT OR REPLACE INTO wip VALUES (?,?,?,?)", (jc_id, stage, at, db.dumps(hist)))


def _wip(conn, jc_id: int) -> dict[str, Any] | None:
    return db.one(conn, "SELECT * FROM wip WHERE job_card_id = ?", jc_id)


def advance(conn, jc_id: int) -> dict[str, Any]:
    jc = db.one(conn, "SELECT id, status FROM job_cards WHERE id = ?", jc_id)
    if jc is None:
        raise KeyError("job card not found")
    if jc["status"] != "released":
        raise ValueError("release the job card to the workshop first")
    w = _wip(conn, jc_id)
    stage = w["stage"] if w else "in_progress"  # released = on the floor
    if stage == "delivered":
        raise ValueError("vehicle already delivered")
    nxt = WIP_STAGES[WIP_STAGES.index(stage) + 1]
    if nxt == "delivered":
        raise ValueError("use deliver to close the work order with an invoice")
    _set_stage(conn, jc_id, nxt)
    return work_order(conn, jc_id)


def move_bay(conn, jc_id: int, bay_id: int | None = None) -> dict[str, Any]:
    """Move a job card on the floor to another bay. With no bay_id, pull it to the next free bay."""
    jc = db.one(conn, "SELECT id, status, payload FROM job_cards WHERE id = ?", jc_id)
    if jc is None:
        raise KeyError("job card not found")
    if jc["status"] not in ("approved", "released"):
        raise ValueError("only approved or released job cards hold a bay")
    p = jc["payload"]
    alloc = p.get("allocation") or {}
    current = (alloc.get("bay") or {}).get("bay_id")
    bays = db.many(conn, "SELECT * FROM bays WHERE active = 1 ORDER BY id")
    if not bays:
        raise ValueError("no active bays")
    if bay_id is None:
        taken = {(b or {}).get("bay_id") for b in _bays_in_use(conn, exclude=jc_id)}
        start = next((i for i, b in enumerate(bays) if b["id"] == current), -1)
        ordered = bays[start + 1:] + bays[:start + 1]
        target = next((b for b in ordered if b["id"] not in taken and b["id"] != current), None)
        if target is None:
            raise ValueError("no free bay to move to")
    else:
        target = next((b for b in bays if b["id"] == bay_id), None)
        if target is None:
            raise KeyError("bay not found")
    alloc["bay"] = {**(alloc.get("bay") or {}), "bay_id": target["id"], "name": target["name"], "type": target["type"]}
    p["allocation"] = alloc
    conn.execute("UPDATE job_cards SET payload = ?, updated_at = ? WHERE id = ?",
                 (db.dumps(p), store.now().isoformat(), jc_id))
    conn.execute("UPDATE allocations SET bay_id = ? WHERE job_card_id = ?", (target["id"], jc_id))
    return work_order(conn, jc_id)


def _bays_in_use(conn, exclude: int | None = None) -> list[dict[str, Any]]:
    """Bays held by job cards currently in bay (released, not yet past in_progress)."""
    out = []
    for jc in db.many(conn, "SELECT id, payload FROM job_cards WHERE status = 'released'"):
        if jc["id"] == exclude:
            continue
        w = _wip(conn, jc["id"])
        if (w["stage"] if w else "in_progress") == "in_progress":
            out.append((jc["payload"].get("allocation") or {}).get("bay"))
    return out


def deliver(conn, jc_id: int, payment_mode: str = "UPI", at=None) -> dict[str, Any]:
    from app.service import jobcard

    jc = jobcard.get(conn, jc_id)
    if jc is None:
        raise KeyError("job card not found")
    w = _wip(conn, jc_id)
    if not w or w["stage"] != "ready":
        raise ValueError("vehicle must be ready for delivery")
    at = at or store.now()
    p = jc["payload"]
    t = p["estimate"]["totals"]
    n = conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0] + 1
    number = f"INV/{date.today():%y%m}/0412/{n:05d}"
    conn.execute(
        "INSERT INTO invoices (job_card_id, vehicle_id, number, labour, parts, gst, total, paid, payment_mode, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (jc_id, p["vehicle"]["id"], number, t["labour"], t["parts"], t["gst"], t["customer_payable"], 1,
         payment_mode, at.isoformat()))
    odo = p["vehicle"].get("odometer_at_arrival") or p["vehicle"]["odometer"]
    conn.execute("UPDATE vehicles SET odometer = MAX(odometer, ?), last_service_date = ?, last_service_km = ? WHERE id = ?",
                 (odo, at.date().isoformat(), odo, p["vehicle"]["id"]))
    adv = db.one(conn, "SELECT advisor_id FROM visits WHERE id = ?", p.get("visit_id")) or {}
    conn.execute(
        "INSERT INTO service_history (vehicle_id, date, km, kind, amount, advisor_id, at_dealer, demand_codes) VALUES (?,?,?,?,?,?,?,?)",
        (p["vehicle"]["id"], at.date().isoformat(), odo, "paid" if t["customer_payable"] else "warranty",
         t["customer_payable"], adv.get("advisor_id"), 1, db.dumps(p["demand_codes"])))
    if p.get("visit_id"):
        conn.execute("UPDATE visits SET status = 'delivered' WHERE id = ?", (p["visit_id"],))
    conn.execute("INSERT INTO outreach (vehicle_id, action, channel, offer, message, status, created_at) VALUES (?,?,?,?,?,?,?)",
                 (p["vehicle"]["id"], "delivery", "app", None,
                  f"Your {p['vehicle']['model']} {p['vehicle']['reg_no']} has been delivered. Invoice {number}, Rs {t['customer_payable']:,}. Thank you!",
                  "queued", at.isoformat()))
    _set_stage(conn, jc_id, "delivered", at)
    return work_order(conn, jc_id)


def work_order(conn, jc_id: int) -> dict[str, Any]:
    from app.service import jobcard

    jc = jobcard.get(conn, jc_id)
    if jc is None:
        raise KeyError("job card not found")
    return {"job_card": jc, "wip": _wip(conn, jc_id),
            "invoice": db.one(conn, "SELECT * FROM invoices WHERE job_card_id = ?", jc_id)}


def board(conn) -> dict[str, Any]:
    """Every vehicle the outlet is handling today, one card each, by pipeline stage."""
    today = date.today().isoformat()
    cards: list[dict[str, Any]] = []

    for a in db.many(conn, """SELECT a.*, v.reg_no, v.model, c.name AS customer_name, d.name AS driver_name
                              FROM appointments a JOIN vehicles v ON v.id = a.vehicle_id
                              JOIN customers c ON c.id = v.customer_id LEFT JOIN drivers d ON d.id = a.driver_id
                              WHERE substr(a.slot_start,1,10) = ? AND a.status IN ('booked','en_route','collected','at_gate')
                              ORDER BY a.slot_start""", today):
        sub = {"booked": "Booked", "en_route": "Driver en route", "collected": "Pickup inbound",
               "at_gate": "At gate"}[a["status"]]
        cards.append({"key": f"A{a['id']}", "stage": "expected", "vehicle_id": a["vehicle_id"],
                      "reg_no": a["reg_no"], "reg_display": format_plate(a["reg_no"]), "model": a["model"],
                      "customer_name": a["customer_name"], "time": a["slot_start"],
                      "detail": sub + (f" · {a['driver_name']}" if a["driver_name"] else ""),
                      "mode": a["mode"], "appointment_id": a["id"]})

    for vi in db.many(conn, """SELECT vi.*, v.reg_no, v.model, c.name AS customer_name, ad.name AS advisor_name
                               FROM visits vi JOIN vehicles v ON v.id = vi.vehicle_id
                               JOIN customers c ON c.id = v.customer_id LEFT JOIN advisors ad ON ad.id = vi.advisor_id
                               WHERE substr(vi.arrived_at,1,10) = ? OR vi.status NOT IN ('delivered')
                               ORDER BY vi.arrived_at""", today):
        jc = db.one(conn, "SELECT id, status, payload, updated_at FROM job_cards WHERE visit_id = ? ORDER BY id DESC LIMIT 1", vi["id"])
        base = {"key": f"V{vi['id']}", "vehicle_id": vi["vehicle_id"], "visit_id": vi["id"],
                "reg_no": vi["reg_no"], "reg_display": format_plate(vi["reg_no"]), "model": vi["model"],
                "customer_name": vi["customer_name"], "advisor_name": vi["advisor_name"], "time": vi["arrived_at"]}
        if jc is None:
            cards.append({**base, "stage": "arrived",
                          "detail": "Awaiting advisor" if not vi["advisor_name"] else "Job card to open"})
            continue
        p = jc["payload"]
        alloc = p.get("allocation") or {}
        extra = {"job_card_id": jc["id"], "amount": p["estimate"]["totals"]["customer_payable"],
                 "promised": alloc.get("promised_delivery"),
                 "technician": (alloc.get("technician") or {}).get("name"),
                 "bay": (alloc.get("bay") or {}).get("name")}
        if jc["status"] == "draft":
            cards.append({**base, **extra, "stage": "estimate", "detail": "Awaiting customer approval"})
        elif jc["status"] == "approved":
            cards.append({**base, **extra, "stage": "approved", "detail": "Release to workshop"})
        else:
            w = _wip(conn, jc["id"])
            stage = w["stage"] if w else "in_progress"
            if stage == "delivered" and (w["updated_at"] or "")[:10] != today:
                continue
            detail = {"in_progress": f"{extra['technician'] or 'Technician'} · {extra['bay'] or 'Bay'}",
                      "qc": "Final inspection & road test", "ready": "Inform customer · collect payment",
                      "delivered": "Invoice closed"}[stage]
            cards.append({**base, **extra, "stage": stage, "detail": detail, "time": w["updated_at"] if w else base["time"]})

    order = ["expected", "arrived", "estimate", "approved", "in_progress", "qc", "ready", "delivered"]
    return {"stages": [{"key": s, "label": STAGE_LABEL[s], "cards": [c for c in cards if c["stage"] == s]} for s in order]}


# ---------------------------------------------------------------- dashboard

def dashboard(conn) -> dict[str, Any]:
    today = date.today().isoformat()
    q = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
    b = board(conn)
    count = {s["key"]: len(s["cards"]) for s in b["stages"]}
    bays = q("SELECT COUNT(*) FROM bays WHERE active = 1")
    busy_bays = q("""SELECT COUNT(DISTINCT al.bay_id) FROM allocations al JOIN wip w ON w.job_card_id = al.job_card_id
                     WHERE w.stage IN ('in_progress','qc')""")
    techs = q("SELECT COUNT(*) FROM technicians WHERE on_duty = 1")
    booked_hours = 0.0
    for a in db.many(conn, "SELECT start, end FROM allocations WHERE substr(start,1,10) = ?", today):
        from datetime import datetime
        booked_hours += (datetime.fromisoformat(a["end"]) - datetime.fromisoformat(a["start"])).total_seconds() / 3600
    revenue = q("SELECT COALESCE(SUM(total),0) FROM invoices WHERE substr(created_at,1,10) = ?", today)
    pipeline = q("""SELECT COALESCE(SUM(json_extract(payload,'$.estimate.totals.customer_payable')),0) FROM job_cards jc
                    LEFT JOIN wip w ON w.job_card_id = jc.id WHERE COALESCE(w.stage,'') != 'delivered'""")
    alerts: list[dict[str, Any]] = []
    for c in b["stages"][4]["cards"] + b["stages"][5]["cards"]:
        if c.get("promised") and c["promised"] < store.now().isoformat():
            alerts.append({"level": "error", "text": f"{c['reg_display']} past promised delivery", "vehicle_id": c["vehicle_id"]})
    for c in b["stages"][2]["cards"]:
        alerts.append({"level": "warning", "text": f"{c['reg_display']} estimate awaiting customer approval", "vehicle_id": c["vehicle_id"]})
    late = [p for p in db.many(conn, "SELECT a.id, v.reg_no, a.vehicle_id FROM appointments a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.status = 'collected'")]
    for p in late:
        alerts.append({"level": "info", "text": f"{format_plate(p['reg_no'])} pickup inbound to workshop", "vehicle_id": p["vehicle_id"]})
    due_for_followup = sum(
        1 for row in outreach.due_list(conn, horizon_days=30, limit=10_000)["customers"]
        if not row["booked"]
    )
    jcs_today = db.many(conn, "SELECT status, payload FROM job_cards WHERE substr(created_at,1,10) = ?", today)
    assists = {
        "scored_for_service": len(outreach.due_list(conn, horizon_days=30, limit=10_000)["customers"]),
        "outreach_sent": q("SELECT COUNT(*) FROM outreach WHERE substr(created_at,1,10) = ? AND action NOT IN ('delivery','jc_summary')", today),
        "slots_booked": q("SELECT COUNT(*) FROM appointments WHERE substr(created_at,1,10) = ?", today),
        "chauffeurs_matched": q("SELECT COUNT(*) FROM appointments WHERE substr(slot_start,1,10) = ? AND mode = 'pickup' AND driver_id IS NOT NULL", today),
        "gate_ins": q("SELECT COUNT(*) FROM visits WHERE substr(arrived_at,1,10) = ?", today),
        "advisors_matched": q("SELECT COUNT(*) FROM visits WHERE substr(arrived_at,1,10) = ? AND advisor_id IS NOT NULL", today),
        "concerns_interpreted": len(jcs_today),
        "concerns_for_review": sum(1 for j in jcs_today if not j["payload"]["interpretation"]["sufficient"]),
        "estimates_built": len(jcs_today),
        "parts_sourced": sum(1 for j in jcs_today for ln in j["payload"]["estimate"]["lines"] if ln["type"] == "part"),
        "allocations": sum(1 for j in jcs_today if (j["payload"].get("allocation") or {}).get("feasible")),
        "inspections": q("SELECT COUNT(*) FROM visits WHERE substr(arrived_at,1,10) = ? AND condition IS NOT NULL", today),
    }
    return {
        "assists": assists,
        "kpis": {
            "appointments_today": q("SELECT COUNT(*) FROM appointments WHERE substr(slot_start,1,10) = ?", today),
            "expected": count["expected"],
            "in_workshop": count["arrived"] + count["estimate"] + count["approved"] + count["in_progress"] + count["qc"],
            "ready": count["ready"],
            "delivered": count["delivered"],
            "revenue_today": revenue,
            "open_pipeline_value": pipeline,
            "bay_utilisation": round(busy_bays / bays, 2) if bays else 0,
            "technician_hours_booked": round(booked_hours, 1),
            "technician_hours_available": techs * 8,
            "follow_ups_due": due_for_followup,
            "pickups_live": q("SELECT COUNT(*) FROM appointments WHERE mode = 'pickup' AND status IN ('en_route','at_customer','collected','at_gate')"),
            "pickups_scheduled": q("SELECT COUNT(*) FROM appointments WHERE mode = 'pickup' AND status = 'booked'"),
        },
        "pipeline": [{"key": s["key"], "label": s["label"], "count": len(s["cards"])} for s in b["stages"]],
        "alerts": alerts[:8],
        "tomorrow": q("SELECT COUNT(*) FROM appointments WHERE substr(slot_start,1,10) = ?", (date.today() + timedelta(days=1)).isoformat()),
    }


# ------------------------------------------------------------- vehicle 360

def vehicle_360(conn, vehicle_id: int) -> dict[str, Any]:
    v = vehicles.get(conn, vehicle_id)
    if v is None:
        raise KeyError("vehicle not found")
    jcs = []
    for jc in db.many(conn, "SELECT id, status, payload, created_at, updated_at, visit_id FROM job_cards WHERE vehicle_id = ? ORDER BY id DESC", vehicle_id):
        p = jc.pop("payload")
        w = _wip(conn, jc["id"])
        jcs.append({**jc, "stage": (w or {}).get("stage") or jc["status"],
                    "amount": p["estimate"]["totals"]["customer_payable"],
                    "demands": [c["label"] for c in p["interpretation"]["concerns"]],
                    "promised": (p.get("allocation") or {}).get("promised_delivery")})
    history = db.many(conn, """SELECT h.*, a.name AS advisor_name FROM service_history h
                               LEFT JOIN advisors a ON a.id = h.advisor_id WHERE vehicle_id = ? ORDER BY date DESC""", vehicle_id)
    appts = db.many(conn, "SELECT a.*, d.name AS driver_name FROM appointments a LEFT JOIN drivers d ON d.id = a.driver_id WHERE vehicle_id = ? ORDER BY slot_start DESC", vehicle_id)
    visits = db.many(conn, "SELECT vi.*, a.name AS advisor_name FROM visits vi LEFT JOIN advisors a ON a.id = vi.advisor_id WHERE vehicle_id = ? ORDER BY arrived_at DESC", vehicle_id)
    invoices = db.many(conn, "SELECT * FROM invoices WHERE vehicle_id = ? ORDER BY created_at DESC", vehicle_id)
    comms = db.many(conn, "SELECT * FROM outreach WHERE vehicle_id = ? ORDER BY created_at DESC", vehicle_id)

    timeline: list[dict[str, Any]] = []
    for h in history:
        timeline.append({"at": h["date"], "kind": "service", "text": f"{h['kind'].title()} service at {h['km']:,} km"
                         + (f" · {h['advisor_name']}" if h.get("advisor_name") else "")})
    for a in appts:
        timeline.append({"at": a["created_at"], "kind": "appointment",
                         "text": f"Appointment booked for {a['slot_start'][:16].replace('T', ' ')} ({'pickup' if a['mode'] == 'pickup' else 'walk-in'})"})
    for vi in visits:
        timeline.append({"at": vi["arrived_at"], "kind": "gate", "text": f"Gate-in at {vi['odometer'] or '—'} km"})
    for jc in jcs:
        timeline.append({"at": jc["created_at"], "kind": "job_card", "text": f"Job card JC-{jc['id']} opened"})
    for i in invoices:
        timeline.append({"at": i["created_at"], "kind": "invoice", "text": f"Invoice {i['number']} · Rs {i['total']:,.0f}"})
    for m in comms:
        timeline.append({"at": m["created_at"], "kind": "message", "text": m["message"]})
    _gate_out_columns(conn)
    for g in db.many(conn, "SELECT * FROM gate_outs WHERE vehicle_id = ?", vehicle_id):
        odo = f" at {g['odometer']:,} km" if g.get("odometer") else ""
        timeline.append({"at": g["at"], "kind": "gate", "text": f"Gate-out after delivery{odo} (JC-{g['job_card_id']})"})
    timeline.sort(key=lambda e: e["at"], reverse=True)

    inspections = {i["visit_id"]: i["payload"] for i in db.many(
        conn, f"SELECT * FROM inspections WHERE visit_id IN ({','.join(str(x['id']) for x in visits) or '0'})")}
    for vi in visits:
        vi["inspection"] = inspections.get(vi["id"])
    open_jc = next((j for j in jcs if j["stage"] != "delivered"), None)
    from app import inspection

    return {"vehicle": v, "job_cards": jcs, "inspections": inspection.for_vehicle(conn, vehicle_id), "open_job_card": open_jc, "history": history, "appointments": appts,
            "visits": visits, "invoices": invoices, "messages": comms, "timeline": timeline[:40],
            "lifetime_value": sum(h["amount"] or 0 for h in history)}


def customers(conn, q: str = "") -> list[dict[str, Any]]:
    out = []
    for v in vehicles.search(conn, q, limit=200):
        open_jc = db.one(conn, """SELECT jc.id, jc.status, w.stage FROM job_cards jc LEFT JOIN wip w ON w.job_card_id = jc.id
                                  WHERE jc.vehicle_id = ? AND COALESCE(w.stage,'') != 'delivered' ORDER BY jc.id DESC LIMIT 1""", v["id"])
        out.append({k: v[k] for k in ("id", "reg_no", "reg_display", "vin", "model", "fuel", "odometer", "customer_name",
                                       "phone", "locality", "last_service_date", "telemetry")}
                   | {"open_job_card": open_jc})
    return out


def search(conn, q: str) -> list[dict[str, Any]]:
    q = q.strip()
    if not q:
        return []
    out: list[dict[str, Any]] = []
    up = q.upper().replace(" ", "").replace("-", "")
    if up.startswith("JC") and up[2:].isdigit():
        jc = db.one(conn, "SELECT id, vehicle_id FROM job_cards WHERE id = ?", int(up[2:]))
        if jc:
            out.append({"kind": "job_card", "label": f"JC-{jc['id']}", "vehicle_id": jc["vehicle_id"], "job_card_id": jc["id"]})
    rows = db.many(conn, f"""{vehicles.SELECT} WHERE v.reg_no LIKE ? OR v.vin LIKE ? OR UPPER(c.name) LIKE ? OR c.phone LIKE ?
                             ORDER BY v.id LIMIT 8""", f"%{up}%", f"%{up}%", f"%{q.upper()}%", f"%{q}%")
    for r in rows:
        out.append({"kind": "vehicle", "label": format_plate(r["reg_no"]), "sub": f"{r['model']} · {r['customer_name']} · {r['phone']}",
                    "vehicle_id": r["id"]})
    return out


# -------------------------------------------------------------- parts & billing

def parts(conn) -> dict[str, Any]:
    stock = {}
    for r in db.many(conn, "SELECT * FROM stock"):
        stock.setdefault(r["part_no"], {})[r["location"]] = r["qty"]
    reserved = {r["part_no"]: r["qty"] for r in db.many(conn, "SELECT part_no, SUM(qty) AS qty FROM reservations GROUP BY part_no")}
    items = [{"part_no": k, "name": v["name"], "price": v["price"], "stock": stock.get(k, {}),
              "reserved": reserved.get(k, 0), "alt": v["alt"]} for k, v in PARTS.items()]
    res = db.many(conn, """SELECT r.*, jc.vehicle_id, v.reg_no FROM reservations r JOIN job_cards jc ON jc.id = r.job_card_id
                           JOIN vehicles v ON v.id = jc.vehicle_id ORDER BY r.id DESC""")
    for r in res:
        r["reg_display"] = format_plate(r["reg_no"])
        r["name"] = PARTS.get(r["part_no"], {}).get("name", r["part_no"])
    return {"locations": [{"key": k, **v} for k, v in STOCK_LOCATIONS.items()], "items": items, "reservations": res}


def invoices(conn) -> dict[str, Any]:
    rows = db.many(conn, """SELECT i.*, v.reg_no, v.model, c.name AS customer_name FROM invoices i
                            JOIN vehicles v ON v.id = i.vehicle_id JOIN customers c ON c.id = v.customer_id ORDER BY i.id DESC""")
    for r in rows:
        r["reg_display"] = format_plate(r["reg_no"])
    pending = []
    for c in board(conn)["stages"][6]["cards"]:
        pending.append(c)
    return {"invoices": rows, "ready_to_bill": pending, "gst_rate": GST}


# ------------------------------------------------------- mobile capture

def save_inspection(conn, visit_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    if db.one(conn, "SELECT id FROM visits WHERE id = ?", visit_id) is None:
        raise KeyError("visit not found")
    conn.execute("INSERT OR REPLACE INTO inspections VALUES (?,?,?)",
                 (visit_id, db.dumps(payload), store.now().isoformat()))
    return db.one(conn, "SELECT * FROM inspections WHERE visit_id = ?", visit_id)  # type: ignore[return-value]


GATE_OUT_MAX_KM = 25  # road test + wash run allowed between gate-in and gate-out


def _gate_out_columns(conn) -> None:
    cols = {r[1] for r in conn.execute("PRAGMA table_info(gate_outs)")}
    for col, kind in (("plate", "TEXT"), ("vin", "TEXT"), ("odometer", "INTEGER"), ("checks", "TEXT")):
        if col not in cols:
            conn.execute(f"ALTER TABLE gate_outs ADD COLUMN {col} {kind}")


def gate_out(conn, vehicle_id: int, by: str = "Security", plate: str | None = None,
             vin: str | None = None, odometer: int | None = None) -> dict[str, Any]:
    """Customer vehicle leaving after delivery: plate, VIN and odometer are checked
    against the vehicle master and the gate-in reading before the exit is recorded."""
    from app.fleet.extract import normalize_plate

    _gate_out_columns(conn)
    v = vehicles.get(conn, vehicle_id)
    if v is None:
        raise KeyError("vehicle not found")
    jc = db.one(conn, """SELECT jc.id, jc.visit_id FROM job_cards jc JOIN wip w ON w.job_card_id = jc.id
                         WHERE jc.vehicle_id = ? AND w.stage = 'delivered' ORDER BY jc.id DESC LIMIT 1""", vehicle_id)
    if jc is None:
        raise ValueError("vehicle is not delivered and invoiced; gate-out not allowed")
    if db.one(conn, "SELECT id FROM gate_outs WHERE job_card_id = ?", jc["id"]):
        raise ValueError("vehicle already gated out")
    checks: list[dict[str, str]] = []
    errors: list[str] = []
    if plate:
        if normalize_plate(plate) != v["reg_no"]:
            errors.append(f"Plate {plate} does not match {v['reg_display']}")
        else:
            checks.append({"level": "ok", "message": "Number plate matches"})
    if vin:
        if normalize_plate(vin) != v["vin"]:
            errors.append(f"VIN does not match the vehicle record ({v['vin']})")
        else:
            checks.append({"level": "ok", "message": "VIN matches the vehicle record"})
    else:
        checks.append({"level": "warning", "message": "VIN not captured"})
    if odometer is not None:
        visit = db.one(conn, "SELECT odometer FROM visits WHERE id = ?", jc["visit_id"]) or {}
        odo_in = visit.get("odometer")
        if odo_in is not None and odometer < odo_in:
            errors.append(f"Odometer {odometer:,} km is below the gate-in reading {odo_in:,} km")
        elif odo_in is not None and odometer - odo_in > GATE_OUT_MAX_KM:
            errors.append(f"Driven {odometer - odo_in} km inside the workshop (gate-in {odo_in:,} km); "
                          f"more than {GATE_OUT_MAX_KM} km needs the service manager")
        else:
            km = f" · {odometer - odo_in} km since gate-in" if odo_in is not None else ""
            checks.append({"level": "ok", "message": f"Odometer {odometer:,} km{km}"})
    else:
        checks.append({"level": "warning", "message": "Odometer not captured"})
    if errors:
        raise ValueError("; ".join(errors))
    at = store.now().isoformat()
    conn.execute("INSERT INTO gate_outs (vehicle_id, job_card_id, at, by, plate, vin, odometer, checks) VALUES (?,?,?,?,?,?,?,?)",
                 (vehicle_id, jc["id"], at, by, v["reg_no"], vin, odometer, db.dumps(checks)))
    if odometer:
        conn.execute("UPDATE vehicles SET odometer = MAX(odometer, ?) WHERE id = ?", (odometer, vehicle_id))
    return {"vehicle_id": vehicle_id, "job_card_id": jc["id"], "at": at, "checks": checks}


def gate_outs_today(conn) -> list[dict[str, Any]]:
    _gate_out_columns(conn)
    return db.many(conn, "SELECT vehicle_id, job_card_id, at, odometer FROM gate_outs WHERE substr(at,1,10) = ?",
                   date.today().isoformat())


# ------------------------------------------------------------ vehicle journey

# The seven operating steps every screen belongs to, in order.
STEPS = [
    {"key": "follow_up", "n": 1, "label": "Follow-up", "href": "/crm"},
    {"key": "appointment", "n": 2, "label": "Appointment", "href": "/appointments"},
    {"key": "pickup", "n": 3, "label": "Pickup & drop", "href": "/pickups"},
    {"key": "arrival", "n": 4, "label": "Vehicle arrival", "href": "/reception"},
    {"key": "job_card", "n": 5, "label": "Job card", "href": "/job-cards"},
    {"key": "workshop", "n": 6, "label": "Workshop", "href": "/workshop"},
    {"key": "delivery", "n": 7, "label": "Billing & delivery", "href": "/billing"},
]

_APPT = """SELECT a.*, d.name AS driver_name FROM appointments a LEFT JOIN drivers d ON d.id = a.driver_id"""


def journey(conn, vehicle_id: int) -> dict[str, Any]:
    """Where one vehicle is in the service journey, what the staff do next, and which
    intelligent assists (use cases 1-12) have already worked on it, with their outcome."""
    from app.service import jobcard, outreach

    v = vehicles.get(conn, vehicle_id)
    if v is None:
        raise KeyError("vehicle not found")
    today = date.today().isoformat()
    visit = db.one(conn, """SELECT vi.*, ad.name AS advisor_name FROM visits vi LEFT JOIN advisors ad ON ad.id = vi.advisor_id
                            WHERE vi.vehicle_id = ? AND (vi.status != 'delivered' OR substr(vi.arrived_at,1,10) = ?)
                            ORDER BY vi.id DESC LIMIT 1""", vehicle_id, today)
    if visit and visit.get("appointment_id"):
        appt = db.one(conn, f"{_APPT} WHERE a.id = ?", visit["appointment_id"])
    else:
        appt = db.one(conn, f"""{_APPT} WHERE a.vehicle_id = ? AND a.status NOT IN ('cancelled','arrived')
                                AND (substr(a.slot_start,1,10) >= ? OR a.status IN ('booked','en_route','at_customer','collected','at_gate'))
                                ORDER BY a.slot_start LIMIT 1""", vehicle_id, today)
    jc_row = db.one(conn, "SELECT id FROM job_cards WHERE visit_id = ? ORDER BY id DESC LIMIT 1", visit["id"]) if visit else None
    jc = jobcard.get(conn, jc_row["id"]) if jc_row else None
    w = _wip(conn, jc["id"]) if jc else None
    invoice = db.one(conn, "SELECT * FROM invoices WHERE job_card_id = ?", jc["id"]) if jc else None
    _gate_out_columns(conn)
    gone = db.one(conn, "SELECT * FROM gate_outs WHERE job_card_id = ?", jc["id"]) if jc else None

    jc_q = f"?jc={jc['id']}" if jc else ""
    if gone:
        step, status, nxt = "delivery", "Delivered and gated out", None
    elif w and w["stage"] == "delivered":
        step, status, nxt = "delivery", "Delivered · invoice closed", {"label": "Gate-out at security", "href": "/m/gate"}
    elif w and w["stage"] == "ready":
        step, status, nxt = "delivery", "Ready for delivery", {"label": "Invoice and deliver", "href": f"/billing?v={vehicle_id}"}
    elif jc and jc["status"] == "released":
        stage = (w or {}).get("stage") or "in_progress"
        step = "workshop"
        status = {"in_progress": "In bay", "qc": "Quality check"}.get(stage, stage)
        nxt = {"label": "Move to quality check" if stage == "in_progress" else "Mark ready for delivery",
               "href": f"/workshop?v={vehicle_id}"}
    elif jc and jc["status"] == "approved":
        step, status, nxt = "job_card", "Estimate approved", {"label": "Release to workshop", "href": f"/job-cards{jc_q}"}
    elif jc:
        step, status, nxt = "job_card", "Estimate with customer", {"label": "Review and approve estimate", "href": f"/job-cards{jc_q}"}
    elif visit:
        step, status, nxt = "job_card", "Arrived · job card to open", {"label": "Open job card", "href": f"/job-cards?visit={visit['id']}"}
    elif appt and appt["mode"] == "pickup" and appt["status"] in ("booked", "en_route", "at_customer", "collected", "at_gate"):
        step = "pickup"
        status = {"booked": f"Pickup scheduled {appt['slot_start'][:16].replace('T', ' ')}",
                  "en_route": "Driver on the way to customer", "at_customer": "Driver at customer · handover pending",
                  "collected": "Collected · inbound to workshop", "at_gate": "At workshop gate · check-in pending"}[appt["status"]]
        nxt = {"label": "Check in at the gate" if appt["status"] == "at_gate" else "Track pickup",
               "href": f"/reception?v={vehicle_id}" if appt["status"] == "at_gate" else f"/pickups?v={vehicle_id}"}
    elif appt and appt["slot_start"][:10] == today:
        step = "arrival"
        status = f"Expected today {appt['slot_start'][11:16]}" + (" · pickup" if appt["mode"] == "pickup" else "")
        nxt = {"label": "Check in at the gate", "href": f"/reception?v={vehicle_id}"}
    elif appt:
        step = "appointment"
        status = f"Booked for {appt['slot_start'][:10]} {appt['slot_start'][11:16]}"
        nxt = {"label": "View appointment", "href": f"/appointments?v={vehicle_id}"}
    else:
        step, status, nxt = "follow_up", "No visit booked", {"label": "Book service", "href": f"/appointments?book={vehicle_id}"}

    # intelligent assists that have worked on this vehicle, with their outcome
    assists: list[dict[str, Any]] = []
    hist = db.many(conn, "SELECT * FROM service_history WHERE vehicle_id = ? ORDER BY date DESC", vehicle_id)
    s = outreach.score_vehicle(v, hist, date.today())
    assists.append({"uc": 1, "title": "Service-due prediction",
                    "outcome": (s["reasons"] or [f"Next service due {s['due_date']}"])[0],
                    "confidence": s["due_probability"]})
    sent = db.one(conn, "SELECT * FROM outreach WHERE vehicle_id = ? AND action NOT IN ('delivery','jc_summary') "
                        "ORDER BY id DESC LIMIT 1", vehicle_id)
    if sent:
        assists.append({"uc": 2, "title": "Next-best-action outreach",
                        "outcome": f"{sent['action'].replace('_', ' ').capitalize()} via {sent['channel']}"
                                   + (f" · {sent['offer']}" if sent.get("offer") else "")})
    latest: dict[str, dict[str, Any]] = {}
    for d in db.many(conn, "SELECT * FROM ai_decisions WHERE vehicle_id = ? ORDER BY id DESC", vehicle_id):
        latest.setdefault(d["kind"], d)
    if appt:
        assists.append({"uc": 3, "title": "Capacity-aware slot",
                        "outcome": f"{'Pickup' if appt['mode'] == 'pickup' else 'Walk-in'} slot "
                                   f"{appt['slot_start'][11:16]} on {appt['slot_start'][:10]}"})
    if "chauffeur" in latest or (appt and appt.get("driver_name")):
        d = latest.get("chauffeur") or {}
        assists.append({"uc": 4, "title": "Chauffeur matching", "outcome": d.get("summary") or f"{appt['driver_name']} assigned",
                        "confidence": d.get("confidence"), "decision_id": d.get("id")})
    if appt and appt["mode"] == "pickup":
        pings = conn.execute("SELECT COUNT(*) FROM gps_pings WHERE appointment_id = ?", (appt["id"],)).fetchone()[0]
        if pings:
            assists.append({"uc": 5, "title": "Pickup ETA monitoring", "outcome": f"Live GPS · {pings} position updates"})
    if visit:
        bad = [c for c in (visit.get("gate_checks") or []) if c.get("level") == "error"]
        assists.append({"uc": 6, "title": "Gate-in OCR & validation",
                        "outcome": f"Checked in at {visit['arrived_at'][11:16]}"
                                   + (f" · {len(bad)} mismatch flagged" if bad else " · matches vehicle master")})
        cond = visit.get("condition") or {}
        if cond or "inspection" in latest:
            d = latest.get("inspection") or {}
            assists.append({"uc": 7, "title": "Condition capture", "decision_id": d.get("id"),
                            "outcome": d.get("summary") or ("Damage check running" if cond.get("status") != "done"
                                                             else "Walk-around photos assessed")})
        if visit.get("advisor_name"):
            d = latest.get("advisor") or {}
            assists.append({"uc": 8, "title": "Advisor matching", "outcome": f"{visit['advisor_name']} assigned",
                            "confidence": d.get("confidence"), "decision_id": d.get("id")})
    elif "advisor" in latest:
        d = latest["advisor"]
        assists.append({"uc": 8, "title": "Advisor matching", "outcome": d["summary"], "confidence": d.get("confidence"),
                        "decision_id": d["id"]})
    if jc:
        p = jc["payload"]
        concerns = p["interpretation"]["concerns"]
        assists.append({"uc": 9, "title": "Concern interpretation",
                        "outcome": ", ".join(c["label"] for c in concerns[:3]) or "Advisor to code concerns",
                        "review": not p["interpretation"]["sufficient"]})
        t = p["estimate"]["totals"]
        assists.append({"uc": 10, "title": "Estimate automation",
                        "outcome": f"Rs {t['customer_payable']:,} incl. GST · {p['estimate']['labour_hours']} labour h"})
        parts = [ln for ln in p["estimate"]["lines"] if ln["type"] == "part"]
        moved = [ln for ln in parts if (ln.get("availability") or {}).get("status") not in (None, "available")]
        assists.append({"uc": 11, "title": "Draft job card & parts",
                        "outcome": f"{len(p['estimate']['lines'])} lines drafted · "
                                   + (f"{len(moved)} part(s) via alternative/transfer" if moved else
                                      f"{len(parts)} part(s) in own stock" if parts else "inspection first, no parts yet")})
        alloc = p.get("allocation") or {}
        if alloc.get("feasible"):
            assists.append({"uc": 12, "title": "Bay & technician allocation",
                            "outcome": f"{alloc['technician']['name']} · {alloc['bay']['name']} · promised "
                                       f"{alloc['promised_delivery'][11:16]}"})
    elif "diagnosis" in latest:
        assists.append({"uc": 9, "title": "Concern interpretation", "outcome": latest["diagnosis"]["summary"],
                        "decision_id": latest["diagnosis"]["id"]})

    return {
        "vehicle": {k: v[k] for k in ("id", "reg_no", "reg_display", "model", "fuel", "customer_name", "phone", "odometer")},
        "step": step, "step_n": next(x["n"] for x in STEPS if x["key"] == step), "status": status, "next": nxt,
        "appointment_id": (appt or {}).get("id"), "visit_id": (visit or {}).get("id"),
        "job_card_id": (jc or {}).get("id"), "invoice": (invoice or {}).get("number"),
        "advisor": (visit or {}).get("advisor_name") or (latest.get("advisor") or {}).get("chosen_name"), "driver": (appt or {}).get("driver_name"),
        "promised": ((jc or {}).get("payload", {}).get("allocation") or {}).get("promised_delivery"),
        "assists": sorted(assists, key=lambda a: a["uc"]),
    }


def counts(conn) -> dict[str, int]:
    """Live work waiting at each journey step, for the navigation badges."""
    from app.service import outreach

    today = date.today().isoformat()
    b = {s["key"]: len(s["cards"]) for s in board(conn)["stages"]}
    q = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
    return {
        "follow_up": sum(1 for r in outreach.due_list(conn, horizon_days=30, limit=10_000)["customers"] if not r["booked"]),
        "appointment": q("SELECT COUNT(*) FROM appointments WHERE substr(slot_start,1,10) = ? AND status != 'cancelled'", today),
        "pickup": q("SELECT COUNT(*) FROM appointments WHERE mode = 'pickup' AND status IN ('booked','en_route','at_customer','collected','at_gate')"),
        "arrival": b["expected"],
        "job_card": b["arrived"] + b["estimate"] + b["approved"],
        "workshop": b["in_progress"] + b["qc"],
        "delivery": b["ready"],
    }


def demo_guide(conn) -> list[dict[str, Any]]:
    """For the presenter: the twelve use cases, each pointed at a live vehicle that shows it now."""
    from app.service import outreach

    by = {s["key"]: s["cards"] for s in board(conn)["stages"]}
    due = next((r for r in outreach.due_list(conn, horizon_days=30, limit=50)["customers"] if not r["booked"]), None)
    pickup = db.one(conn, "SELECT vehicle_id FROM appointments WHERE mode = 'pickup' AND status IN ('collected','en_route') "
                          "ORDER BY status = 'collected' DESC LIMIT 1")
    walkin = next((c for c in by["expected"] if c.get("mode") != "pickup"), None)
    estimate = next(iter(by["estimate"]), None)
    inbay = next(iter(by["in_progress"]), None)
    ready = next(iter(by["ready"]), None)

    def vid(x: dict[str, Any] | None) -> int | None:
        return (x or {}).get("vehicle_id")

    def link(base: str, x: dict[str, Any] | None, param: str = "v") -> str:
        return f"{base}?{param}={vid(x)}" if x else base

    jc_link = f"/job-cards?jc={estimate['job_card_id']}" if estimate else "/job-cards"
    rows = [
        (1, "Service-due prediction", "follow_up", "Who is due and why: interval, usage and the car's own telemetry",
         link("/crm", due, "vehicle"), vid(due)),
        (2, "Next-best-action outreach", "follow_up", "Channel, offer, timing and message in the customer's language",
         link("/crm", due, "vehicle"), vid(due)),
        (3, "Capacity-aware slot recommendation", "appointment", "Slots ranked against workshop load and customer preference",
         link("/appointments", due, "book"), vid(due)),
        (4, "Chauffeur matching", "pickup", "Eligible driver assigned automatically when a pickup is booked",
         link("/pickups", pickup), vid(pickup)),
        (5, "Pickup & drop ETA monitoring", "pickup", "Live position and predicted arrival at the workshop",
         link("/pickups", pickup), vid(pickup)),
        (6, "Gate-in OCR & validation", "arrival", "Plate, VIN and odometer read from photos and checked against records",
         link("/reception", walkin), vid(walkin)),
        (7, "Condition capture", "arrival", "Walk-around photos assessed for existing damage",
         link("/reception", walkin), vid(walkin)),
        (8, "Advisor matching", "arrival", "Best-fit service advisor by skill, language and load",
         link("/reception", walkin), vid(walkin)),
        (9, "Concern interpretation", "job_card", "Customer words in Hindi or English mapped to demand codes", jc_link, vid(estimate)),
        (10, "Estimate automation", "job_card", "Labour, parts, warranty and campaigns priced automatically", jc_link, vid(estimate)),
        (11, "Draft job card & parts sourcing", "job_card", "Job card pre-built; parts from stock, alternative or network",
         jc_link, vid(estimate)),
        (12, "Bay & technician allocation", "workshop", "Skill-matched technician and bay with a promised time",
         link("/workshop", inbay), vid(inbay)),
    ]
    ids = {r[5] for r in rows if r[5]}
    regs = {r["id"]: format_plate(r["reg_no"]) for r in db.many(
        conn, f"SELECT id, reg_no FROM vehicles WHERE id IN ({','.join(str(i) for i in ids) or '0'})")}
    out = [{"uc": n, "title": t, "step": s, "what": w, "href": h, "vehicle_id": v, "reg_display": regs.get(v)}
           for n, t, s, w, h, v in rows]
    if ready:
        out.append({"uc": None, "title": "Invoice & delivery", "step": "delivery", "what": "Close the work order and gate out",
                    "href": f"/billing?v={ready['vehicle_id']}", "vehicle_id": ready["vehicle_id"],
                    "reg_display": ready["reg_display"]})
    return out
