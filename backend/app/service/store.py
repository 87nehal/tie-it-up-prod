"""Service-journey tables in the shared database, plus the deterministic demo dealership.

Customers and vehicles live in the vehicle master (`app.vehicles`) and gate trips in
`app.fleet.store`; this module owns workshop resources, stock, appointments, visits
and Job Cards. The seed is anchored to the current time so a demo works whenever it
is started: there is always a pickup on the road, one inbound and vehicles in work.
"""

from __future__ import annotations

import random
import sqlite3
from datetime import date, datetime, timedelta
from typing import Any

from app import db, vehicles  # noqa: F401  (vehicles registers the master tables)
from app.eta import places
from app.fleet.extract import _VIN_VALUES, _VIN_WEIGHTS
from app.fleet import store as gate_store  # noqa: F401  (registers the trips table)
from app.paths import OBD_LOGS
from app.service.catalog import DEALERSHIP, PARTS

db.register_schema(
    """
CREATE TABLE IF NOT EXISTS service_history (
    id INTEGER PRIMARY KEY, vehicle_id INTEGER, date TEXT, km INTEGER, kind TEXT,
    amount REAL, advisor_id INTEGER, at_dealer INTEGER, demand_codes TEXT
);
CREATE TABLE IF NOT EXISTS advisors (
    id INTEGER PRIMARY KEY, name TEXT, languages TEXT, skills TEXT,
    certifications TEXT, max_load INTEGER, on_duty INTEGER
);
CREATE TABLE IF NOT EXISTS technicians (
    id INTEGER PRIMARY KEY, name TEXT, skills TEXT, certifications TEXT,
    level INTEGER, on_duty INTEGER
);
CREATE TABLE IF NOT EXISTS bays (id INTEGER PRIMARY KEY, name TEXT, type TEXT, active INTEGER);
CREATE TABLE IF NOT EXISTS drivers (
    id INTEGER PRIMARY KEY, name TEXT, lat REAL, lng REAL, status TEXT, rating REAL,
    acceptance_rate REAL, trips_today INTEGER, max_trips INTEGER, shift_end TEXT,
    blocked TEXT
);
CREATE TABLE IF NOT EXISTS stock (
    part_no TEXT, location TEXT, qty INTEGER, PRIMARY KEY (part_no, location)
);
CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY, vehicle_id INTEGER, slot_start TEXT, mode TEXT, status TEXT,
    driver_id INTEGER, pickup_lat REAL, pickup_lng REAL, concerns TEXT,
    qr_token TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS gps_pings (
    id INTEGER PRIMARY KEY, appointment_id INTEGER, ts TEXT, lat REAL, lng REAL
);
CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY, appointment_id INTEGER, vehicle_id INTEGER, trip_id INTEGER,
    arrived_at TEXT, odometer INTEGER, gate_checks TEXT, condition TEXT, advisor_id INTEGER,
    status TEXT
);
CREATE TABLE IF NOT EXISTS job_cards (
    id INTEGER PRIMARY KEY, visit_id INTEGER, vehicle_id INTEGER, status TEXT,
    payload TEXT, created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS allocations (
    id INTEGER PRIMARY KEY, job_card_id INTEGER, technician_id INTEGER, bay_id INTEGER,
    start TEXT, end TEXT
);
CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY, job_card_id INTEGER, part_no TEXT, location TEXT, qty INTEGER
);
CREATE TABLE IF NOT EXISTS outreach (
    id INTEGER PRIMARY KEY, vehicle_id INTEGER, action TEXT, channel TEXT, offer TEXT,
    message TEXT, status TEXT, created_at TEXT
);
""",
    json_columns={"languages", "skills", "certifications", "blocked", "demand_codes",
                  "gate_checks", "condition", "payload"},
)

connect = db.connect
one = db.one
many = db.many
dumps = db.dumps


def now() -> datetime:
    return datetime.now().replace(second=0, microsecond=0)


# ----------------------------------------------------------------- demo seed

FIRST = ["Aarav", "Priya", "Rohit", "Sneha", "Vikram", "Anjali", "Karan", "Meera", "Arjun",
         "Pooja", "Rahul", "Neha", "Sandeep", "Kavya", "Amit", "Ritu", "Manish", "Divya",
         "Suresh", "Nisha"]
LAST = ["Sharma", "Verma", "Gupta", "Singh", "Yadav", "Malhotra", "Chauhan", "Kapoor",
        "Jain", "Bansal"]
MODELS = [("Swift", "SW", "petrol"), ("Baleno", "BL", "petrol"), ("Brezza", "BZ", "petrol"),
          ("Ertiga", "ER", "cng"), ("Dzire", "DZ", "petrol"), ("WagonR", "WR", "cng"),
          ("Grand Vitara", "GV", "hybrid"), ("XL6", "XL", "petrol")]
PERSONAS = ["busy_professional", "family", "value_seeker", "fleet_owner", "senior"]
CHANNELS = {"busy_professional": "app", "family": "app", "value_seeker": "call",
            "fleet_owner": "call", "senior": "call"}
TIMES = {"busy_professional": "evening", "family": "weekend", "value_seeker": "morning",
         "fleet_owner": "morning", "senior": "afternoon"}
RTO = ["HR26", "HR29", "DL3C", "DL8C", "HR51", "HR55"]
SERIES = "ABCDEFGHJKLMNPRSTUVWXYZ"

CONCERNS = {
    "ac_brake": "AC thanda nahi kar raha aur front brake se awaaz aati hai",
    "pms_light": "Periodic service due, also check engine light came on last week",
    "battery": "Gaadi subah start nahi hoti, battery weak lagti hai",
    "suspension": "Suspension khat khat noise on speed breakers",
    "pull": "Car pulling to the left, steering vibrates at 80",
    "wash": "Regular service and wash",
    "clutch": "Clutch hard hai, gear shifting difficult",
    "dent": "Small dent on rear bumper, please quote. Also sunroof leaks in rain",
}


def valid_vin(prefix8: str, tail8: str) -> str:
    """Build a 17-char VIN whose ISO 3779 check digit (position 9) verifies."""
    total = sum(_VIN_VALUES[c] * w for c, w in zip(prefix8 + "0" + tail8, _VIN_WEIGHTS))
    digit = "X" if total % 11 == 10 else str(total % 11)
    return prefix8 + digit + tail8


def _token(rng: random.Random) -> str:
    return f"DSP-{rng.randint(10**7, 10**8 - 1)}"


def _seed(conn: sqlite3.Connection) -> None:
    from app.service import telematics

    rng = random.Random(42)
    today = date.today()
    t0 = now()
    ins = conn.execute

    advisors = [
        ("Rakesh Kumar", ["en", "hi"], ["general", "warranty"], ["MSIL-SA-L2"], 8),
        ("Farah Ali", ["en", "hi", "ur"], ["general", "body"], ["MSIL-SA-L1", "Insurance"], 7),
        ("Gurpreet Kaur", ["en", "hi", "pa"], ["general", "hybrid"], ["MSIL-SA-L2", "Hybrid"], 8),
        ("Vinod Nair", ["en", "ml", "hi"], ["general", "fleet"], ["MSIL-SA-L1"], 9),
        ("Shalini Rao", ["en", "hi", "kn"], ["general", "warranty", "body"], ["MSIL-SA-L3"], 6),
    ]
    for i, (name, langs, skills, certs, load) in enumerate(advisors, 1):
        ins("INSERT INTO advisors VALUES (?,?,?,?,?,?,?)",
            (i, name, dumps(langs), dumps(skills), dumps(certs), load, 1))

    techs = [
        ("Mohan Lal", ["general", "engine", "diagnostics"], ["L2"], 3),
        ("Imran Khan", ["brakes", "suspension", "steering", "general"], ["L2"], 2),
        ("Ajay Pal", ["electrical", "diagnostics", "hvac", "engine"], ["L3", "Hybrid"], 3),
        ("Deepak Rawat", ["general", "hvac"], ["L1"], 1),
        ("Sunil Thakur", ["transmission", "engine", "general"], ["L2"], 2),
        ("Bablu Prasad", ["body"], ["Paint-L2"], 2),
        ("Harish Negi", ["general", "brakes"], ["L1"], 1),
        ("Ravi Shankar", ["diagnostics", "electrical", "engine"], ["L3", "Hybrid"], 3),
    ]
    for i, (name, skills, certs, level) in enumerate(techs, 1):
        ins("INSERT INTO technicians VALUES (?,?,?,?,?,?)",
            (i, name, dumps(skills), dumps(certs), level, 1))

    for i, (name, kind) in enumerate([("Bay 1", "general"), ("Bay 2", "general"),
                                      ("Bay 3", "general"), ("Express 1", "express"),
                                      ("Body shop 1", "body"), ("Wash bay", "wash")], 1):
        ins("INSERT INTO bays VALUES (?,?,?,1)", (i, name, kind))

    hubs = [p for p in places.PLACES if "Gurugram" in p[0] or "Dwarka" in p[0]]
    for i, name in enumerate(["Sonu Yadav", "Pappu Singh", "Raju Mehra", "Kishan Lal",
                              "Naveen Joshi", "Tarun Bisht"], 1):
        _, lat, lng = hubs[(i * 3) % len(hubs)]
        ins("INSERT INTO drivers VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (i, name, lat, lng, "available" if i != 6 else "off_duty",
             round(rng.uniform(3.8, 4.9), 1), round(rng.uniform(0.7, 0.98), 2),
             rng.randint(0, 2), 6, "21:00", dumps(["13:00-14:00"] if i == 2 else [])))

    for part_no in PARTS:
        for loc, hi in (("own", 12), ("dealer_b", 8), ("warehouse", 60)):
            qty = rng.randint(2, hi)
            if part_no in ("P-BRKPAD", "P-R134A") and loc == "own":
                qty = 0  # demonstrates the alternative / transfer branches
            ins("INSERT INTO stock VALUES (?,?,?)", (part_no, loc, qty))

    # vehicle master + service history + OBD logs
    kinds = ["healthy"] * 24 + ["low_battery"] * 5 + ["mil_on"] * 4 + ["overheat"] * 3 + ["engine_wear"] * 4
    rng.shuffle(kinds)
    story = {8: "low_battery", 12: "mil_on", 4: "healthy", 20: "overheat"}  # vehicles used in the demo
    for cid in range(1, 41):
        persona = rng.choice(PERSONAS)
        locality, plat, plng = rng.choice(places.PLACES[1:])
        lat, lng = round(plat + rng.uniform(-0.004, 0.004), 5), round(plng + rng.uniform(-0.004, 0.004), 5)
        ins("INSERT INTO customers VALUES (?,?,?,?,?,?,?,?,?,?)",
            (cid, f"{rng.choice(FIRST)} {rng.choice(LAST)}", f"98{rng.randint(10**7, 10**8 - 1)}",
             rng.choices(["hi", "en", "pa"], [5, 4, 1])[0], lat, lng, locality, persona,
             CHANNELS[persona], TIMES[persona]))

        model, code, fuel = rng.choice(MODELS)
        age_days = rng.randint(200, 2200)
        sale = today - timedelta(days=age_days)
        avg = round(rng.uniform(18, 75 if persona == "fleet_owner" else 45), 1)
        odo = int(age_days * avg)
        since_days = rng.randint(60, 460)
        last_date = today - timedelta(days=since_days)
        last_km = max(1000, odo - int(since_days * avg * rng.uniform(0.8, 1.2)))
        vin = valid_vin(f"MA3{code}ESR", f"{rng.choice('RSTN')}{rng.choice('GM')}{rng.randint(100_000, 899_999)}")
        reg = f"{rng.choice(RTO)}{rng.choice(SERIES)}{rng.choice(SERIES)}{rng.randint(1000, 9999)}"
        ins("INSERT INTO vehicles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, cid, reg, vin, model, fuel, sale.isoformat(), odo, avg,
             last_date.isoformat(), last_km, None, None))
        kind = story.get(cid, kinds[cid - 1])
        log = telematics.write_demo_log(kind, OBD_LOGS / f"vehicle{cid}.csv")
        telematics.attach(conn, cid, log, f"connected car ({kind.replace('_', ' ')})")

        visits = max(1, age_days // 330)
        loyal = rng.random() > 0.2
        for k in range(visits):
            d = last_date - timedelta(days=330 * k)
            if d < sale:
                break
            ins("INSERT INTO service_history (vehicle_id, date, km, kind, amount, advisor_id, at_dealer, demand_codes) VALUES (?,?,?,?,?,?,?,?)",
                (cid, d.isoformat(), max(500, last_km - int(330 * k * avg)),
                 "free" if k == visits - 1 and visits <= 3 else "paid", rng.randint(2500, 9500),
                 rng.randint(1, 5), 1 if (loyal or k > 0) else 0,
                 dumps(["PMS"] + (["WASH"] if rng.random() < 0.5 else []))))

    # today's schedule, anchored to the current hour
    def appt(vid: int, offset_min: int, mode: str, concern: str, status: str = "booked",
             driver: int | None = None) -> int:
        c = one(conn, "SELECT lat, lng FROM customers WHERE id = ?", vid)
        cur = ins(
            "INSERT INTO appointments (vehicle_id, slot_start, mode, status, driver_id, pickup_lat, pickup_lng, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (vid, min(t0 + timedelta(minutes=offset_min), t0.replace(hour=23, minute=30)).isoformat(), mode, status, driver,
             c["lat"] if mode == "pickup" else None, c["lng"] if mode == "pickup" else None,
             CONCERNS[concern], _token(rng), (t0 - timedelta(days=2)).isoformat()))
        return cur.lastrowid  # type: ignore[return-value]

    # walk-ins still expected at the gate
    appt(12, 0, "walkin", "pms_light")
    appt(16, 30, "walkin", "ac_brake")
    appt(24, 60, "walkin", "suspension")
    appt(28, 120, "walkin", "dent")
    appt(36, 180, "walkin", "clutch")
    # pickups: one collected and inbound (open gate trip), one on its way to the customer,
    # one assigned but not dispatched yet
    inbound = appt(8, -40, "pickup", "battery", "collected", driver=3)
    appt(20, 50, "pickup", "pull", "en_route", driver=1)
    appt(32, 150, "pickup", "wash", "booked", driver=4)
    for d in (1, 3):
        ins("UPDATE drivers SET status = 'on_trip', trips_today = trips_today + 1 WHERE id = ?", (d,))

    v8 = one(conn, "SELECT * FROM vehicles WHERE id = 8")
    c8 = one(conn, "SELECT * FROM customers WHERE id = 8")
    ins("""INSERT INTO trips (plate, vin, purpose, appointment_id, checkout_at, checkout_odo, checkout_flags)
           VALUES (?,?,?,?,?,?,?)""",
        (v8["reg_no"], v8["vin"], "pickup", inbound, (t0 - timedelta(minutes=35)).isoformat(),
         v8["odometer"], "[]"))
    mid = (c8["lat"] + (DEALERSHIP["lat"] - c8["lat"]) * 0.7, c8["lng"] + (DEALERSHIP["lng"] - c8["lng"]) * 0.7)
    for ts, (lat, lng) in ((t0 - timedelta(minutes=35), (c8["lat"], c8["lng"])), (t0 - timedelta(minutes=2), mid)):
        ins("INSERT INTO gps_pings (appointment_id, ts, lat, lng) VALUES (?,?,?,?)", (inbound, ts.isoformat(), lat, lng))
    en_route = one(conn, "SELECT id FROM appointments WHERE vehicle_id = 20")["id"]
    d1 = one(conn, "SELECT lat, lng FROM drivers WHERE id = 1")
    ins("INSERT INTO gps_pings (appointment_id, ts, lat, lng) VALUES (?,?,?,?)",
        (en_route, (t0 - timedelta(minutes=1)).isoformat(), d1["lat"], d1["lng"]))

    # tomorrow's bookings, so capacity-aware scheduling has load to balance
    for n, hour in enumerate([9, 9, 10, 10, 10, 11, 14], 1):
        slot = datetime.combine(today + timedelta(days=1), datetime.min.time()).replace(hour=hour)
        ins("INSERT INTO appointments (vehicle_id, slot_start, mode, status, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?)",
            (n * 5 + 1, slot.isoformat(), "walkin", "booked", CONCERNS["wash"], _token(rng), t0.isoformat()))

    # two vehicles that arrived earlier today: one in work, one awaiting approval
    _seed_workshop(conn, t0)
    ins("INSERT INTO meta VALUES ('seeded', ?)", (t0.isoformat(),))


def _seed_workshop(conn: sqlite3.Connection, t0: datetime) -> None:
    from app.service import jobcard

    for vid, adv, concern, approve in ((4, 1, "wash", True), (40, 5, "ac_brake", False)):
        arrived = (t0 - timedelta(minutes=90 if approve else 45)).isoformat()
        cur = conn.execute(
            "INSERT INTO appointments (vehicle_id, slot_start, mode, status, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?)",
            (vid, arrived, "walkin", "arrived", CONCERNS[concern], f"DSP-{10**7 + vid}", arrived))
        odo = conn.execute("SELECT odometer FROM vehicles WHERE id = ?", (vid,)).fetchone()[0] + 14
        vcur = conn.execute(
            "INSERT INTO visits (appointment_id, vehicle_id, arrived_at, odometer, gate_checks, condition, advisor_id, status) VALUES (?,?,?,?,?,?,?,?)",
            (cur.lastrowid, vid, arrived, odo, "[]", None, adv, "with_advisor"))
        jc = jobcard.create_draft(conn, None, vcur.lastrowid, None, use_llm=False)
        if approve:
            jobcard.approve(conn, jc["id"])
            jobcard.release(conn, jc["id"])


db.register_seeder(_seed)


def reset() -> None:
    db.reset()


def summary(conn: sqlite3.Connection) -> dict[str, Any]:
    """Headline numbers for the journey overview."""
    day = date.today().isoformat()
    q = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
    return {
        "appointments_today": q("SELECT COUNT(*) FROM appointments WHERE substr(slot_start,1,10) = ?", day),
        "expected_at_gate": q("SELECT COUNT(*) FROM appointments WHERE (substr(slot_start,1,10) = ? AND status = 'booked') OR status IN ('en_route','at_customer','collected','at_gate')", day),
        "pickups_live": q("SELECT COUNT(*) FROM appointments WHERE mode = 'pickup' AND status IN ('en_route','at_customer','collected','at_gate')"),
        "arrived_today": q("SELECT COUNT(*) FROM visits WHERE substr(arrived_at,1,10) = ?", day),
        "job_cards": {s: q("SELECT COUNT(*) FROM job_cards WHERE status = ?", s) for s in ("draft", "approved", "released")},
        "queued_messages": q("SELECT COUNT(*) FROM outreach WHERE status = 'queued'"),
        "telemetry_flags": q("SELECT COUNT(*) FROM vehicles WHERE json_extract(telemetry, '$.has_issue') = 1"),
        "seeded_at": (conn.execute("SELECT value FROM meta WHERE key = 'seeded'").fetchone() or [None])[0],
    }
