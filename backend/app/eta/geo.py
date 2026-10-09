"""Offline travel-time model: great-circle distance, a road factor and an hourly speed profile.

The one ETA engine in the platform: the Ride ETA page and pickup monitoring both use it.

No map or traffic service is called. The speed profile is a city-traffic prior for
the NCR; replace SPEED_KMH with averages learned from the dealer's own completed
pickup trips (gps_pings) once enough have accumulated.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta

MODEL_NOTE = "offline: straight-line distance x 1.35 road factor, hourly NCR speed profile"
ROAD_FACTOR = 1.35  # road distance / straight-line distance, typical for Indian cities

# Average urban speed by hour of day (km/h).
SPEED_KMH = {h: 30.0 for h in range(24)}
SPEED_KMH.update({h: 36.0 for h in (0, 1, 2, 3, 4, 5, 22, 23)})
SPEED_KMH.update({h: 17.0 for h in (8, 9, 10, 17, 18, 19)})
SPEED_KMH.update({h: 23.0 for h in (11, 16, 20)})


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def road_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    return haversine_km(lat1, lng1, lat2, lng2) * ROAD_FACTOR


MODES = {
    "DRIVE": {"label": "Car", "factor": 1.0},
    "TWO_WHEELER": {"label": "Bike", "factor": 1.15},
    "BICYCLE": {"label": "Cycle", "fixed_kmh": 14.0},
    "WALK": {"label": "Walk", "fixed_kmh": 4.8},
}
FREE_FLOW_KMH = 36.0


def _speed(mode: str, hour: int) -> float:
    m = MODES[mode]
    return m.get("fixed_kmh") or SPEED_KMH[hour] * m["factor"]


def travel_minutes(km: float, depart: datetime, mode: str = "DRIVE") -> float:
    """Integrate the hourly speed profile so a trip crossing into rush hour slows down."""
    remaining, t, minutes = km, depart, 0.0
    while remaining > 1e-6 and minutes < 24 * 60:
        speed = _speed(mode, t.hour)
        to_next_hour = 60 - t.minute - t.second / 60
        can_cover = speed * to_next_hour / 60
        if can_cover >= remaining:
            minutes += remaining / speed * 60
            break
        remaining -= can_cover
        minutes += to_next_hour
        t = (t + timedelta(minutes=to_next_hour)).replace(second=0, microsecond=0)
    return minutes


def step_towards(lat: float, lng: float, tlat: float, tlng: float, km: float) -> tuple[float, float, bool]:
    """Move `km` of straight-line distance towards a target; returns (lat, lng, arrived)."""
    dist = haversine_km(lat, lng, tlat, tlng)
    if dist <= km or dist < 1e-6:
        return tlat, tlng, True
    f = km / dist
    return lat + (tlat - lat) * f, lng + (tlng - lng) * f, False


def estimate(origin: dict, destination: dict, mode: str = "DRIVE", depart: datetime | None = None) -> dict:
    depart = depart or datetime.now().replace(microsecond=0)
    km = road_km(origin["lat"], origin["lng"], destination["lat"], destination["lng"])
    minutes = travel_minutes(km, depart, mode)
    typical = km / (MODES[mode].get("fixed_kmh") or FREE_FLOW_KMH * MODES[mode]["factor"]) * 60
    return {
        "origin": origin, "destination": destination, "mode": mode,
        "distance_km": round(km, 1), "duration_min": round(minutes), "free_flow_min": round(typical),
        "traffic_delay_min": max(0, round(minutes - typical)), "depart_at": depart.isoformat(),
        "arrive_at": (depart + timedelta(minutes=minutes)).isoformat(timespec="minutes"),
        "speed_profile": "time-of-day" if "factor" in MODES[mode] else "constant",
    }
