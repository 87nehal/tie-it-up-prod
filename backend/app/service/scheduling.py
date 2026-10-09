"""Use cases 3 and 4: capacity-aware slot recommendation and chauffeur ranking."""

from __future__ import annotations

import secrets
from datetime import date, datetime, time, timedelta
from typing import Any

from app.eta import geo
from app.service import store
from app.service.catalog import DEALERSHIP

OPEN_HOUR, LAST_HOUR = 9, 17
OFF_PEAK = {13, 14, 15, 16, 17}
# Expected walk-ins per hour without an appointment (dealer prior; learn from visits).
WALKIN_PRIOR = {9: 1.5, 10: 1.5, 11: 1.0, 12: 0.5, 13: 0.3, 14: 0.5, 15: 0.5, 16: 0.5, 17: 0.3}
PREF_HOURS = {"morning": {9, 10, 11}, "afternoon": {13, 14, 15, 16}, "evening": {16, 17},
              "weekend": set(range(9, 18))}


def intake_capacity(conn) -> int:
    """Vehicles the floor can receive per hour: bounded by technicians and working bays."""
    techs = conn.execute("SELECT COUNT(*) FROM technicians WHERE on_duty = 1").fetchone()[0]
    bays = conn.execute("SELECT COUNT(*) FROM bays WHERE active = 1 AND type != 'wash'").fetchone()[0]
    advisors = conn.execute("SELECT COUNT(*) FROM advisors WHERE on_duty = 1").fetchone()[0]
    # a technician turns ~0.6 vehicles/hour on a mixed PMS + repair load
    return max(1, min(int(techs * 0.6), bays, advisors))


def slots(conn, day: date, vehicle_id: int | None = None, mode: str = "walkin") -> dict[str, Any]:
    cap = intake_capacity(conn)
    booked: dict[int, int] = {}
    for r in store.many(conn, "SELECT slot_start FROM appointments WHERE substr(slot_start,1,10) = ? AND status != 'cancelled'",
                        day.isoformat()):
        h = datetime.fromisoformat(r["slot_start"]).hour
        booked[h] = booked.get(h, 0) + 1
    pref = None
    if vehicle_id:
        c = store.one(conn, "SELECT c.preferred_time FROM vehicles v JOIN customers c ON c.id = v.customer_id WHERE v.id = ?", vehicle_id)
        pref = c["preferred_time"] if c else None

    now = datetime.now()
    out = []
    for h in range(OPEN_HOUR, LAST_HOUR + 1):
        start = datetime.combine(day, time(h))
        expected = booked.get(h, 0) + WALKIN_PRIOR.get(h, 0.5)
        util = expected / cap
        feasible = start > now + timedelta(minutes=30) and booked.get(h, 0) + 1 <= cap
        reasons = []
        score = 1 - min(util, 1.0)
        if pref and h in PREF_HOURS.get(pref, set()):
            score += 0.35
            reasons.append(f"matches customer preference ({pref})")
        if h in OFF_PEAK:
            score += 0.15
            reasons.append("off-peak: balances workshop load")
        if util >= 0.85:
            reasons.append("near capacity")
        if mode == "pickup" and h in (9, 10, 17):
            score -= 0.1
            reasons.append("rush-hour pickup")
        out.append({
            "start": start.isoformat(), "hour": h, "booked": booked.get(h, 0),
            "expected_load": round(expected, 1), "capacity": cap, "utilisation": round(util, 2),
            "feasible": feasible, "score": round(score, 3) if feasible else 0.0,
            "off_peak": h in OFF_PEAK, "offer": "5% off labour" if h in OFF_PEAK and util < 0.6 else None,
            "reasons": reasons if feasible else ["full or in the past"],
        })
    best = sorted((s for s in out if s["feasible"]), key=lambda s: s["score"], reverse=True)
    for rank, s in enumerate(best[:3], 1):
        s["recommended_rank"] = rank
    return {"date": day.isoformat(), "capacity_per_hour": cap, "preferred_time": pref, "slots": out}


# ------------------------------------------------------------ chauffeur ranking

def _in_blocked(windows: list[str], t: datetime) -> bool:
    for w in windows:
        a, b = w.split("-")
        if time.fromisoformat(a) <= t.time() < time.fromisoformat(b):
            return True
    return False


def rank_drivers(conn, lat: float, lng: float, slot_start: datetime) -> dict[str, Any]:
    leg2_km = geo.road_km(lat, lng, DEALERSHIP["lat"], DEALERSHIP["lng"])
    out = []
    for d in store.many(conn, "SELECT * FROM drivers"):
        km = geo.road_km(d["lat"], d["lng"], lat, lng)
        depart = max(datetime.now(), slot_start - timedelta(minutes=45))
        to_customer = geo.travel_minutes(km, depart)
        to_dealer = geo.travel_minutes(leg2_km, slot_start)
        trip_end = slot_start + timedelta(minutes=to_dealer + 10)
        blockers = []
        if d["status"] == "off_duty":
            blockers.append("off duty")
        if d["status"] == "on_trip":
            blockers.append("on another trip")
        if d["trips_today"] >= d["max_trips"]:
            blockers.append("daily trip limit reached")
        if trip_end.time() > time.fromisoformat(d["shift_end"]):
            blockers.append(f"trip ends after shift ({d['shift_end']})")
        if _in_blocked(d["blocked"] or [], slot_start):
            blockers.append("blocked slot")
        parts = {
            "proximity": max(0.0, 1 - km / 25),
            "workload": 1 - d["trips_today"] / d["max_trips"],
            "acceptance": d["acceptance_rate"],
            "rating": (d["rating"] - 3) / 2,
        }
        weights = {"proximity": 0.4, "workload": 0.2, "acceptance": 0.25, "rating": 0.15}
        score = sum(parts[k] * weights[k] for k in weights)
        out.append({
            "driver_id": d["id"], "name": d["name"], "status": d["status"],
            "distance_km": round(km, 1), "eta_to_customer_min": round(to_customer),
            "trip_to_dealer_min": round(to_dealer), "trips_today": d["trips_today"],
            "rating": d["rating"], "acceptance_rate": d["acceptance_rate"],
            "eligible": not blockers, "blockers": blockers,
            "score": round(score, 3) if not blockers else 0.0,
            "breakdown": {k: round(v * weights[k], 3) for k, v in parts.items()},
        })
    out.sort(key=lambda r: (r["eligible"], r["score"]), reverse=True)
    return {"pickup": {"lat": lat, "lng": lng}, "slot_start": slot_start.isoformat(),
            "feasible": any(r["eligible"] for r in out), "drivers": out}


# ------------------------------------------------------------ booking

def book(conn, vehicle_id: int, slot_start: str, mode: str, concerns: str,
         driver_id: int | None) -> dict[str, Any]:
    start = datetime.fromisoformat(slot_start)
    day = slots(conn, start.date(), vehicle_id, mode)
    slot = next((s for s in day["slots"] if s["hour"] == start.hour), None)
    if slot is None or not slot["feasible"]:
        raise ValueError("slot is not available")
    cust = store.one(conn, "SELECT c.* FROM vehicles v JOIN customers c ON c.id = v.customer_id WHERE v.id = ?", vehicle_id)
    if cust is None:
        raise KeyError("vehicle not found")
    lat = lng = None
    if mode == "pickup":
        lat, lng = cust["lat"], cust["lng"]
        ranking = rank_drivers(conn, lat, lng, start)
        eligible = [d["driver_id"] for d in ranking["drivers"] if d["eligible"]]
        if not eligible:
            raise ValueError("no chauffeur can cover this pickup; choose another slot or walk-in")
        if driver_id is None:
            driver_id = eligible[0]
        elif driver_id not in eligible:
            raise ValueError("selected chauffeur is not eligible for this slot")
    token = f"DSP-{secrets.randbelow(9 * 10**7) + 10**7}"
    cur = conn.execute(
        """INSERT INTO appointments (vehicle_id, slot_start, mode, status, driver_id, pickup_lat,
               pickup_lng, concerns, qr_token, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (vehicle_id, start.isoformat(), mode, "booked", driver_id if mode == "pickup" else None,
         lat, lng, concerns, token, store.now().isoformat()),
    )
    if mode == "pickup":
        conn.execute("UPDATE drivers SET trips_today = trips_today + 1 WHERE id = ?", (driver_id,))
    return appointment(conn, cur.lastrowid)  # type: ignore[arg-type]


def appointment(conn, appointment_id: int) -> dict[str, Any] | None:
    return store.one(
        conn,
        """SELECT a.*, v.reg_no, v.model, v.vin, c.name AS customer_name, c.phone,
                  d.name AS driver_name
           FROM appointments a JOIN vehicles v ON v.id = a.vehicle_id
           JOIN customers c ON c.id = v.customer_id LEFT JOIN drivers d ON d.id = a.driver_id
           WHERE a.id = ?""",
        appointment_id,
    )


def appointments_on(conn, day: date) -> list[dict[str, Any]]:
    return store.many(
        conn,
        """SELECT a.*, v.reg_no, v.model, c.name AS customer_name, d.name AS driver_name
           FROM appointments a JOIN vehicles v ON v.id = a.vehicle_id
           JOIN customers c ON c.id = v.customer_id LEFT JOIN drivers d ON d.id = a.driver_id
           WHERE substr(a.slot_start,1,10) = ? ORDER BY a.slot_start""",
        day.isoformat(),
    )
