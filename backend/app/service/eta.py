"""Use case 5: predictive pickup/drop ETA monitoring from the driver's own GPS pings.

Pings arrive from the dealer's driver app (POST .../ping) and are stored locally.
ETA uses the platform's one offline travel-time engine (`app.eta.geo`, also behind
the Ride ETA page); a pickup is flagged when the predicted arrival eats the buffer
before the promised time. The handover at the customer's door is a gate check-out
(`app.fleet.gate`), so the trip is logged with odometer and photos like any other.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from app.eta import geo
from app.service import store
from app.service.catalog import DEALERSHIP

AT_RISK_BUFFER_MIN = 10
LIVE = ("en_route", "at_customer", "collected", "at_gate")


def _last_ping(conn, appointment_id: int) -> dict[str, Any] | None:
    return store.one(conn, "SELECT * FROM gps_pings WHERE appointment_id = ? ORDER BY id DESC LIMIT 1", appointment_id)


def _assess(conn, a: dict[str, Any], now: datetime) -> dict[str, Any]:
    slot = datetime.fromisoformat(a["slot_start"])
    ping = _last_ping(conn, a["id"])
    out: dict[str, Any] = {
        "appointment_id": a["id"], "vehicle_id": a["vehicle_id"], "reg_no": a["reg_no"], "customer_name": a["customer_name"],
        "driver_id": a["driver_id"], "driver_name": a["driver_name"], "status": a["status"],
        "promised_pickup": slot.isoformat(), "position": None, "last_ping": None,
        "eta": None, "remaining_km": None, "buffer_min": None, "risk": "not_started",
        "interventions": [],
    }
    if a["status"] not in LIVE or ping is None:
        return out
    out["position"] = {"lat": ping["lat"], "lng": ping["lng"]}
    out["last_ping"] = ping["ts"]
    stale = (now - datetime.fromisoformat(ping["ts"])).total_seconds() > 15 * 60
    if a["status"] == "at_customer":
        out.update(position=out["position"], risk="on_time" if now <= slot + timedelta(minutes=10) else "late",
                   leg="handover", eta=ping["ts"], remaining_km=0.0, buffer_min=round((slot - now).total_seconds() / 60))
        out["interventions"].append("Chauffeur at the customer: capture the handover at the gate app")
        return out
    if a["status"] == "at_gate":
        out.update(risk="on_time", leg="at_gate", eta=ping["ts"], remaining_km=0.0, buffer_min=0)
        out["interventions"].append("At the workshop gate: check the vehicle in at Reception")
        return out
    if a["status"] == "en_route":
        target, deadline, leg = (a["pickup_lat"], a["pickup_lng"]), slot, "to_customer"
    else:
        target = (DEALERSHIP["lat"], DEALERSHIP["lng"])
        deadline = slot + timedelta(minutes=geo.travel_minutes(
            geo.road_km(a["pickup_lat"], a["pickup_lng"], *target), slot) + 15)
        leg = "to_dealership"
    km = geo.road_km(ping["lat"], ping["lng"], *target)
    eta = now + timedelta(minutes=geo.travel_minutes(km, now))
    buffer = (deadline - eta).total_seconds() / 60
    risk = "on_time" if buffer >= AT_RISK_BUFFER_MIN else "at_risk" if buffer >= 0 else "late"
    if stale:
        risk = "no_signal"
        out["interventions"].append("No GPS ping for 15+ min: call the driver")
    if risk in ("at_risk", "late"):
        out["interventions"].append(f"Notify customer of revised time ~{eta:%H:%M}")
        if leg == "to_customer" and buffer < -10:
            out["interventions"].append("Consider reassigning a closer chauffeur")
        if leg == "to_dealership":
            out["interventions"].append("Tell the advisor: arrival shifts the bay plan")
    out.update(leg=leg, eta=eta.isoformat(), deadline=deadline.isoformat(), remaining_km=round(km, 1),
               buffer_min=round(buffer), risk=risk)
    return out


def _pickups(conn, day: str) -> list[dict[str, Any]]:
    return store.many(
        conn,
        """SELECT a.*, v.reg_no, c.name AS customer_name, d.name AS driver_name
           FROM appointments a JOIN vehicles v ON v.id = a.vehicle_id
           JOIN customers c ON c.id = v.customer_id LEFT JOIN drivers d ON d.id = a.driver_id
           WHERE a.mode = 'pickup' AND (
               a.status IN ('booked','en_route','at_customer','collected','at_gate')
               OR (a.status = 'arrived' AND substr(a.slot_start,1,10) = ?)
           ) ORDER BY a.slot_start""",
        day,
    )


def board(conn) -> dict[str, Any]:
    now = datetime.now()
    items = [_assess(conn, a, now) for a in _pickups(conn, now.date().isoformat())]
    return {"generated_at": now.isoformat(timespec="seconds"), "dealership": DEALERSHIP,
            "model": "offline: haversine x road factor, hourly NCR speed profile",
            "pickups": items}


def dispatch(conn, appointment_id: int) -> None:
    a = store.one(conn, "SELECT * FROM appointments WHERE id = ?", appointment_id)
    if a is None or a["mode"] != "pickup":
        raise KeyError("pickup not found")
    if not a["driver_id"]:
        raise ValueError("no chauffeur assigned")
    if a["status"] != "booked":
        raise ValueError(f"pickup is {a['status']}; only a scheduled pickup can be dispatched")
    d = store.one(conn, "SELECT * FROM drivers WHERE id = ?", a["driver_id"])
    if d["status"] in ("on_trip", "off_duty"):
        raise ValueError("chauffeur is unavailable; finish their current trip or reassign first")
    conn.execute("UPDATE appointments SET status = 'en_route' WHERE id = ?", (appointment_id,))
    conn.execute("UPDATE drivers SET status = 'on_trip' WHERE id = ?", (a["driver_id"],))
    ping(conn, appointment_id, d["lat"], d["lng"])


def ping(conn, appointment_id: int, lat: float, lng: float) -> None:
    conn.execute("INSERT INTO gps_pings (appointment_id, ts, lat, lng) VALUES (?,?,?,?)",
                 (appointment_id, datetime.now().isoformat(timespec="seconds"), lat, lng))


def handover(conn, appointment_id: int, cap) -> dict[str, Any]:
    """Customer hands the car to the chauffeur: a gate check-out that opens the pickup trip."""
    from app import vehicles
    from app.fleet import gate

    a = store.one(conn, "SELECT * FROM appointments WHERE id = ?", appointment_id)
    if a is None or a["mode"] != "pickup":
        raise KeyError("pickup not found")
    if a["status"] not in ("en_route", "at_customer"):
        raise ValueError(f"pickup is {a['status']}; handover happens when the chauffeur is at the customer")
    v = vehicles.get(conn, a["vehicle_id"])
    if gate.Capture(plate=cap.plate).clean()[0] != v["reg_no"]:
        raise ValueError(f"plate read does not match the booked vehicle {v['reg_display']}")
    result = gate.checkout(conn, cap, purpose="pickup", appointment_id=appointment_id)
    conn.execute("UPDATE appointments SET status = 'collected' WHERE id = ?", (appointment_id,))
    ping(conn, appointment_id, a["pickup_lat"], a["pickup_lng"])
    return result


def simulate(conn, minutes: float) -> int:
    """Demo helper: advance every live pickup along a straight line at the profile speed."""
    moved = 0
    now = datetime.now()
    for a in store.many(conn, "SELECT * FROM appointments WHERE mode = 'pickup' AND status IN ('en_route','collected')"):
        p = _last_ping(conn, a["id"])
        if p is None:
            continue
        km = geo.SPEED_KMH[now.hour] * minutes / 60 / geo.ROAD_FACTOR
        if a["status"] == "en_route":
            lat, lng, arrived = geo.step_towards(p["lat"], p["lng"], a["pickup_lat"], a["pickup_lng"], km)
            ping(conn, a["id"], lat, lng)
            if arrived:
                conn.execute("UPDATE appointments SET status = 'at_customer' WHERE id = ?", (a["id"],))
        else:
            lat, lng, arrived = geo.step_towards(p["lat"], p["lng"], DEALERSHIP["lat"], DEALERSHIP["lng"], km)
            ping(conn, a["id"], lat, lng)
            if arrived:
                # the gate check-in at reception closes the trip and frees the chauffeur
                conn.execute("UPDATE appointments SET status = 'at_gate' WHERE id = ?", (a["id"],))
        moved += 1
    return moved
