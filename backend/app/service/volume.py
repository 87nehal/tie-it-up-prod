"""Outlet-scale demo day: a service base and a working day the size of a real Arena workshop.

The scripted story vehicles (ids 1-40, see `store._seed`) stay exactly as they are; this
adds the rest of the outlet around them: ~900 customers on the service base and ~150
vehicles moving through today's pipeline, from expected arrivals to delivered and
invoiced. Every record is produced by the real engines (Job Card draft, allocation,
approval, release, delivery) with the clock set to the time each event happened, so
timestamps, bay bookings, promised times and invoices agree with one another.
"""

from __future__ import annotations

import json
import random
import sqlite3
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from typing import Iterator

from app import db
from app.eta import places
from app.paths import OBD_LOGS
from app.service import store
from app.service.store import CHANNELS, FIRST, LAST, MODELS, PERSONAS, RTO, SERIES, TIMES, valid_vin

BASE_CUSTOMERS = 900  # service base on top of the 40 story vehicles

# What customers say at the desk, as they say it (English, Hindi, Hinglish).
WORDS = [
    "Periodic service", "Paid service and wash", "First free service", "Second free service",
    "Periodic service, also wheel alignment", "Service due, AC cooling weak hai",
    "AC not cooling properly", "Brake lagane par awaaz aati hai", "Battery weak, starting problem in the morning",
    "Car pulling to the right", "Check engine light on", "Clutch hard ho gaya hai",
    "Suspension noise on speed breakers", "Wheel alignment and balancing", "Pickup kam hai",
    "Horn not working", "Dent on front bumper", "Power window stuck", "Tyre puncture, also wash",
    "Mileage drop ho gaya hai", "Door rattle while driving", "Oil leaking from engine",
    "Service and interior cleaning", "Brake pads check karna hai", "Wiper not working and wash",
    # vague or outside the taxonomy: these must reach the advisor, not become a guessed job
    "Gaadi mein kuch problem hai, check kar do", "Sunroof leaks in rain", "Smell inside the cabin",
]
WEIGHTS = [16, 12, 6, 5, 4, 4, 4, 3, 3, 3, 2, 2, 2, 3, 2, 2, 2, 1, 2, 1, 1, 1, 3, 2, 1, 2, 1, 1]
REMINDERS_TODAY = 42  # next-best-action reminders the CRM queue sent this morning

# Today's floor, by the stage each vehicle has reached now (about 150 visits).
TODAY = {"delivered": 34, "ready": 12, "qc": 11, "in_progress": 30, "approved": 5,
         "estimate": 14, "arrived": 8, "expected": 34}
TOMORROW = 96


@contextmanager
def clock(at: datetime) -> Iterator[None]:
    """Run the engines as if it were `at` (they all read time through `store.now`)."""
    real = store.now
    store.now = lambda: at  # type: ignore[assignment]
    try:
        yield
    finally:
        store.now = real  # type: ignore[assignment]


def _resources(conn: sqlite3.Connection, rng: random.Random) -> None:
    """Staff and bays for a 150-visit day, after the named story staff (ids keep their meaning)."""
    adv = [("Nitin Arora", ["en", "hi"], ["general"]), ("Pooja Bhatt", ["en", "hi", "gu"], ["general", "warranty"]),
           ("Sameer Khan", ["en", "hi", "ur"], ["general", "body"]), ("Anita Desai", ["en", "hi"], ["general", "fleet"]),
           ("Harpreet Gill", ["en", "hi", "pa"], ["general", "hybrid"]), ("Manoj Tiwari", ["hi", "en"], ["general"]),
           ("Ritika Sen", ["en", "hi", "bn"], ["general", "warranty"]), ("Arvind Rawat", ["hi", "en"], ["general", "body"]),
           ("Kiran Patil", ["en", "hi", "mr"], ["general"])]
    for name, langs, skills in adv:
        conn.execute("INSERT INTO advisors (name, languages, skills, certifications, max_load, on_duty) VALUES (?,?,?,?,?,1)",
                     (name, db.dumps(langs), db.dumps(skills), db.dumps(["MSIL-SA-L1"]), rng.randint(10, 13)))
    conn.execute("UPDATE advisors SET max_load = max_load + 4")
    # stock for ~150 visits a day; parts deliberately out of own stock stay at zero so the
    # alternative-part and network-transfer paths still show
    conn.execute("UPDATE stock SET qty = qty * CASE location WHEN 'warehouse' THEN 20 ELSE 25 END")
    pools = [["general", "brakes", "suspension", "steering"], ["general", "engine", "diagnostics"],
             ["electrical", "diagnostics", "hvac"], ["general", "hvac"], ["transmission", "engine", "general"],
             ["general"], ["general", "brakes"], ["body"]]
    first = ["Rajesh", "Sanjay", "Dinesh", "Mukesh", "Ramesh", "Pawan", "Satish", "Naresh", "Vijay", "Lalit",
             "Anuj", "Gaurav", "Hemant", "Jitender", "Kuldeep", "Mahesh", "Om", "Pradeep", "Rinku", "Sachin",
             "Tarun", "Umesh"]
    for i, name in enumerate(first):
        skills = pools[i % len(pools)]
        certs = ["L3", "Hybrid"] if i % 7 == 2 else ["Paint-L2"] if skills == ["body"] else [f"L{1 + i % 3}"]
        conn.execute("INSERT INTO technicians (name, skills, certifications, level, on_duty) VALUES (?,?,?,?,1)",
                     (f"{name} {rng.choice(LAST)}", db.dumps(skills), db.dumps(certs), 1 + i % 3))
    for name, kind in [(f"Bay {n}", "general") for n in range(4, 17)] + [("Express 2", "express"), ("Express 3", "express"),
                                                                        ("Body shop 2", "body")]:
        conn.execute("INSERT INTO bays (name, type, active) VALUES (?,?,1)", (name, kind))
    hubs = [p for p in places.PLACES if "Gurugram" in p[0] or "Dwarka" in p[0]] or places.PLACES
    for i, name in enumerate(["Mohit Sharma", "Lokesh Kumar", "Bunty Singh", "Deepak Yadav", "Ashok Pal", "Vikas Rana"]):
        _, lat, lng = hubs[(i * 5 + 1) % len(hubs)]
        conn.execute("INSERT INTO drivers (name, lat, lng, status, rating, acceptance_rate, trips_today, max_trips, shift_end, blocked) "
                     "VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (name, lat + rng.uniform(-0.01, 0.01), lng + rng.uniform(-0.01, 0.01), "available",
                      round(rng.uniform(4.0, 4.9), 1), round(rng.uniform(0.75, 0.97), 2), rng.randint(0, 3), 7, "21:00", "[]"))


def _base(conn: sqlite3.Connection, rng: random.Random, today: date) -> list[int]:
    """Customers and vehicles of the service base. A third are connected cars whose OBD log
    is scored by the telemetry model (one scoring per log condition, shared)."""
    from app.service import telematics

    scored: dict[str, tuple[bytes, dict]] = {}
    start = conn.execute("SELECT COALESCE(MAX(id), 0) FROM customers").fetchone()[0] + 1
    taken = {r[0] for r in conn.execute("SELECT reg_no FROM vehicles")}
    ids = []
    for cid in range(start, start + BASE_CUSTOMERS):
        persona = rng.choice(PERSONAS)
        locality, plat, plng = rng.choice(places.PLACES[1:])
        conn.execute("INSERT INTO customers VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (cid, f"{rng.choice(FIRST)} {rng.choice(LAST)}", f"9{rng.randint(10**8, 10**9 - 1)}",
                      rng.choices(["hi", "en", "pa"], [5, 4, 1])[0],
                      round(plat + rng.uniform(-0.006, 0.006), 5), round(plng + rng.uniform(-0.006, 0.006), 5),
                      locality, persona, CHANNELS[persona], TIMES[persona]))
        model, code, fuel = rng.choice(MODELS)
        age_days = rng.randint(120, 2600)
        avg = round(rng.uniform(16, 60 if persona == "fleet_owner" else 38), 1)
        # a service base mostly on schedule: most cars are 1-11 months from their last visit
        since = min(age_days - 30, int(rng.triangular(20, 430, 200)))
        odo = int(age_days * avg)
        last_km = max(800, odo - int(since * avg))
        while True:
            reg = f"{rng.choice(RTO)}{rng.choice(SERIES)}{rng.choice(SERIES)}{rng.randint(1000, 9999)}"
            if reg not in taken:
                taken.add(reg)
                break
        vin = valid_vin(f"MA3{code}ESR", f"{rng.choice('RSTN')}{rng.choice('GM')}{rng.randint(100_000, 899_999)}")
        conn.execute("INSERT INTO vehicles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (cid, cid, reg, vin, model, fuel, (today - timedelta(days=age_days)).isoformat(), odo, avg,
                      (today - timedelta(days=since)).isoformat(), last_km, None, None))
        if rng.random() < 0.33:
            kind = rng.choices(telematics.KINDS, [80, 7, 5, 3, 5])[0]
            if kind not in scored:
                path = telematics.write_demo_log(kind, OBD_LOGS / f"_{kind}.csv")
                scored[kind] = (path.read_bytes(), telematics.diagnose(path, f"connected car ({kind.replace('_', ' ')})"))
            log, result = scored[kind]
            (OBD_LOGS / f"vehicle{cid}.csv").write_bytes(log)
            conn.execute("UPDATE vehicles SET obd_log = ?, telemetry = ? WHERE id = ?",
                         (f"vehicle{cid}.csv", db.dumps(result), cid))
        visits = max(1, (age_days - since) // 340 + 1)
        loyal = rng.random() > 0.18
        for k in range(visits):
            d = today - timedelta(days=since + 340 * k)
            if (today - d).days > age_days:
                break
            conn.execute("INSERT INTO service_history (vehicle_id, date, km, kind, amount, advisor_id, at_dealer, demand_codes) "
                         "VALUES (?,?,?,?,?,?,?,?)",
                         (cid, d.isoformat(), max(500, last_km - int(340 * k * avg)),
                          "free" if k >= visits - 3 and age_days < 1100 else "paid", rng.randint(2800, 9800),
                          rng.randint(1, 14), 1 if (loyal or k > 0) else 0,
                          db.dumps(["PMS"] + (["WASH"] if rng.random() < 0.5 else []))))
        ids.append(cid)
    return ids


def _visit(conn, rng: random.Random, vid: int, words: str, arrived: datetime, advisors: int) -> int:
    from app.service import jobcard

    with clock(arrived):
        a = conn.execute(
            "INSERT INTO appointments (vehicle_id, slot_start, mode, status, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?)",
            (vid, arrived.replace(minute=0).isoformat(), "walkin", "arrived",
             words, f"DSP-{rng.randint(10**7, 10**8 - 1)}", (arrived - timedelta(days=rng.randint(1, 6))).isoformat()))
        odo = conn.execute("SELECT odometer FROM vehicles WHERE id = ?", (vid,)).fetchone()[0] + rng.randint(5, 60)
        v = conn.execute(
            "INSERT INTO visits (appointment_id, vehicle_id, arrived_at, odometer, gate_checks, condition, advisor_id, status) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (a.lastrowid, vid, arrived.isoformat(), odo, "[]", None, rng.randint(1, advisors), "with_advisor"))
        return v.lastrowid  # type: ignore[return-value]


LATE_SHARE = 0.05  # a healthy floor: about one car in twenty is running behind its promise


def _keep_promise(conn: sqlite3.Connection, rng: random.Random, jc_id: int, released: datetime, t0: datetime) -> None:
    """Cars already on the floor started when they were released, so their plan runs from then
    (the allocator would otherwise queue them behind later jobs on the same bay). Most are on
    time; about LATE_SHARE are running behind, the way a real floor has a few."""
    row = conn.execute("SELECT payload FROM job_cards WHERE id = ?", (jc_id,)).fetchone()
    p = json.loads(row[0])
    alloc = p["allocation"]
    hours = alloc["hours"] * 1.15
    end = released + timedelta(hours=hours)
    promised = end + timedelta(minutes=30)
    if rng.random() < LATE_SHARE:
        if promised > t0:
            promised = t0 - timedelta(minutes=rng.randint(8, 55))
    elif promised < t0 + timedelta(minutes=20):
        promised = t0 + timedelta(minutes=rng.randint(25, 280))
    end = max(promised - timedelta(minutes=30), released + timedelta(minutes=30))
    alloc.update(start=released.isoformat(), end=end.isoformat(), promised_delivery=promised.isoformat())
    conn.execute("UPDATE job_cards SET payload = ? WHERE id = ?", (db.dumps(p), jc_id))
    conn.execute("UPDATE allocations SET start = ?, end = ? WHERE job_card_id = ?", (alloc["start"], alloc["end"], jc_id))


def seed(conn: sqlite3.Connection) -> None:
    from app import erp
    from app.service import jobcard

    rng = random.Random(7)
    t0 = store.now()
    today = t0.date()
    _resources(conn, rng)
    base = _base(conn, rng, today)
    advisors = conn.execute("SELECT COUNT(*) FROM advisors").fetchone()[0]

    # Workshop day. Gate opens 08:30; if the demo runs outside hours, the day is laid out
    # as if it were early afternoon so every stage has vehicles in it.
    opening = t0.replace(hour=8, minute=30)
    span = max(240, min(int((t0 - opening).total_seconds() // 60), 600))
    pool = rng.sample(base, sum(TODAY.values()) + TOMORROW)
    words = lambda: rng.choices(WORDS, WEIGHTS)[0]  # noqa: E731

    # earliest arrivals are the furthest along
    plan = [(stage, n) for stage in ("delivered", "ready", "qc", "in_progress", "approved", "estimate", "arrived")
            for n in range(TODAY[stage])]
    k = 0
    for i, (stage, _) in enumerate(plan):
        vid = pool[k]
        k += 1
        frac = i / len(plan)
        arrived = t0 - timedelta(minutes=int(span * (1 - frac) * rng.uniform(0.85, 1.0)) + 8)
        visit = _visit(conn, rng, vid, words(), arrived, advisors)
        if stage == "arrived":
            continue
        with clock(arrived + timedelta(minutes=12)):
            jc = jobcard.create_draft(conn, None, visit, None, use_llm=False)
        if stage == "estimate":
            continue
        approved_at = min(t0 - timedelta(minutes=3), arrived + timedelta(minutes=rng.randint(20, 45)))
        with clock(approved_at):
            if not jc["payload"]["interpretation"]["sufficient"]:
                p = jc["payload"]
                p["overrides"] = [{"at": approved_at.isoformat(), "reason": "Advisor confirmed demand codes with customer"}]
                conn.execute("UPDATE job_cards SET payload = ? WHERE id = ?", (db.dumps(p), jc["id"]))
            try:
                jobcard.approve(conn, jc["id"])
            except ValueError:
                conn.execute("UPDATE job_cards SET status = 'approved' WHERE id = ?", (jc["id"],))
        if stage == "approved":
            continue
        released = min(t0 - timedelta(minutes=2), approved_at + timedelta(minutes=10))
        with clock(released):
            jobcard.release(conn, jc["id"])
            erp._set_stage(conn, jc["id"], "in_progress", released)
        if stage in ("in_progress", "qc"):
            _keep_promise(conn, rng, jc["id"], released, t0)
        hours = jc["payload"]["estimate"]["labour_hours"] or 1.0
        marks = {"qc": released + timedelta(hours=hours * 1.1), "ready": released + timedelta(hours=hours * 1.1 + 0.4)}
        for s in ("qc", "ready"):
            if erp.WIP_STAGES.index(stage) >= erp.WIP_STAGES.index(s):
                erp._set_stage(conn, jc["id"], s, min(marks[s], t0 - timedelta(minutes=1)))
        if stage in ("ready", "delivered"):
            # the work is finished: the technician and bay are free again from the moment it went to QC
            conn.execute("UPDATE allocations SET start = ?, end = ? WHERE job_card_id = ?",
                         (released.isoformat(), min(marks["qc"], t0 - timedelta(minutes=1)).isoformat(), jc["id"]))
        if stage == "delivered":
            at = min(t0 - timedelta(minutes=1), marks["ready"] + timedelta(minutes=rng.randint(15, 70)))
            with clock(at):
                erp.deliver(conn, jc["id"], rng.choice(["UPI", "UPI", "Card", "Cash"]), at)

    # this morning's follow-up round: reminders for the highest-priority due customers
    from app.service import outreach

    due = [r for r in outreach.due_list(conn, horizon_days=30, limit=400)["customers"] if not r["booked"]]
    for n, row in enumerate(due[:REMINDERS_TODAY]):
        at = max(opening, t0 - timedelta(minutes=span)) + timedelta(minutes=4 * n)
        with clock(min(at, t0 - timedelta(minutes=5))):
            nba = outreach.next_best_action(conn, row["vehicle_id"])
            outreach.send(conn, row["vehicle_id"], nba["action"], nba["channel"], nba["offer"], nba["message"])

    # still to arrive today, in slots from now to closing (never past midnight)
    left = (t0.replace(hour=23, minute=45) - t0).total_seconds() / 60 - 15
    gap = max(0.5, min(9.0, left / TODAY["expected"]))
    for n in range(TODAY["expected"]):
        vid = pool[k]
        k += 1
        slot = (t0 + timedelta(minutes=15 + n * gap)).replace(second=0, microsecond=0)
        conn.execute(
            "INSERT INTO appointments (vehicle_id, slot_start, mode, status, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?)",
            (vid, slot.isoformat(), "walkin", "booked", words(), f"DSP-{rng.randint(10**7, 10**8 - 1)}",
             (t0 - timedelta(days=rng.randint(1, 5))).isoformat()))

    # tomorrow: a booked diary with a morning peak, so slot recommendation has load to balance
    hours = [9] * 15 + [10] * 16 + [11] * 14 + [12] * 10 + [13] * 6 + [14] * 9 + [15] * 10 + [16] * 9 + [17] * 7
    for n in range(TOMORROW):
        vid = pool[k]
        k += 1
        slot = datetime.combine(today + timedelta(days=1), datetime.min.time()).replace(hour=hours[n % len(hours)],
                                                                                    minute=rng.choice([0, 15, 30, 45]))
        conn.execute(
            "INSERT INTO appointments (vehicle_id, slot_start, mode, status, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?)",
            (vid, slot.isoformat(), rng.choice(["walkin"] * 5 + ["pickup"]), "booked", words(),
             f"DSP-{rng.randint(10**7, 10**8 - 1)}", t0.isoformat()))
