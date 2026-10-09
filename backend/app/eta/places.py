"""Offline gazetteer: named places the ETA search can resolve without a geocoding service.

Covers the demo dealership's catchment (Delhi NCR). Extend with the dealer's own
customer localities; any "lat,lng" string is accepted as well.
"""

from __future__ import annotations

import re

PLACES: list[tuple[str, float, float]] = [
    ("Arena Workshop, Sector 18, Gurugram", 28.4949, 77.0694),
    ("Cyber City, Gurugram", 28.4950, 77.0890),
    ("Udyog Vihar, Gurugram", 28.5010, 77.0820),
    ("MG Road, Gurugram", 28.4796, 77.0800),
    ("Golf Course Road, Gurugram", 28.4530, 77.0990),
    ("Sohna Road, Gurugram", 28.4180, 77.0450),
    ("Sector 56, Gurugram", 28.4240, 77.1030),
    ("Palam Vihar, Gurugram", 28.5080, 77.0360),
    ("DLF Phase 1, Gurugram", 28.4720, 77.0930),
    ("DLF Phase 4, Gurugram", 28.4660, 77.0820),
    ("South City 2, Gurugram", 28.4340, 77.0600),
    ("Sector 45, Gurugram", 28.4420, 77.0620),
    ("Manesar, Gurugram", 28.3570, 76.9380),
    ("IFFCO Chowk, Gurugram", 28.4720, 77.0720),
    ("Rajiv Chowk, Gurugram", 28.4460, 77.0290),
    ("Dwarka Sector 21, Delhi", 28.5520, 77.0580),
    ("Dwarka Sector 10, Delhi", 28.5810, 77.0570),
    ("IGI Airport Terminal 3, Delhi", 28.5562, 77.1000),
    ("Vasant Kunj, Delhi", 28.5200, 77.1590),
    ("Mahipalpur, Delhi", 28.5450, 77.1260),
    ("Saket, Delhi", 28.5245, 77.2066),
    ("Connaught Place, Delhi", 28.6315, 77.2167),
    ("Janakpuri, Delhi", 28.6219, 77.0878),
    ("Kapashera, Delhi", 28.5270, 77.0830),
    ("Sector 29, Gurugram", 28.4680, 77.0660),
]

LATLNG = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def search(q: str, limit: int = 8) -> list[dict]:
    words = q.lower().split()
    hits = [p for p in PLACES if all(w in p[0].lower() for w in words)]
    return [{"name": n, "lat": lat, "lng": lng} for n, lat, lng in hits[:limit]]


def resolve(value: str) -> dict | None:
    if m := LATLNG.match(value):
        return {"name": value.strip(), "lat": float(m.group(1)), "lng": float(m.group(2))}
    exact = [p for p in PLACES if p[0].lower() == value.strip().lower()]
    if exact:
        n, lat, lng = exact[0]
        return {"name": n, "lat": lat, "lng": lng}
    hits = search(value, 1)
    return hits[0] if hits else None


def nearest(lat: float, lng: float) -> str:
    from app.eta.geo import haversine_km

    n, *_ = min(PLACES, key=lambda p: haversine_km(lat, lng, p[1], p[2]))
    return n
