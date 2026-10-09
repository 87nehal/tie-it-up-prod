"""Gate operations shared by the Hub Gate, the chauffeur pickup handover and reception.

Every vehicle movement through a gate goes through `validate` + `checkout` / `checkin`
here, so the same OCR-backed checks and the same trip log apply everywhere.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from app.fleet import store
from app.fleet.extract import format_plate, normalize_plate
from app.fleet.validate import validate

Direction = Literal["checkout", "checkin"]


class GateRejected(Exception):
    def __init__(self, validation: dict[str, Any]):
        super().__init__("validation failed")
        self.validation = validation


@dataclass
class Capture:
    plate: str
    vin: str | None = None
    odometer: int | None = None
    capture_id: str | None = None
    photo_times: list[str | None] = field(default_factory=list)
    confidences: dict[str, float | None] = field(default_factory=dict)

    def clean(self) -> tuple[str, str | None]:
        vin = normalize_plate(self.vin) if self.vin else None
        return normalize_plate(self.plate), vin or None


def now() -> datetime:
    return datetime.now().replace(microsecond=0)


def check(conn: sqlite3.Connection, direction: Direction, cap: Capture, at: datetime,
          allow_walk_in: bool = False) -> dict[str, Any]:
    plate, vin = cap.clean()
    return validate(
        conn, direction, plate=plate, vin=vin, odometer=cap.odometer, now=at,
        photo_times=[t for t in cap.photo_times if t], confidences=cap.confidences,
        allow_walk_in=allow_walk_in,
    )


def _flags(result: dict[str, Any]) -> str:
    return json.dumps([c for c in result["checks"] if c["level"] != "ok"])


def checkout(conn: sqlite3.Connection, cap: Capture, purpose: str = "fleet",
             appointment_id: int | None = None) -> dict[str, Any]:
    at = now()
    result = check(conn, "checkout", cap, at)
    if not result["ok"]:
        raise GateRejected(result)
    plate, vin = cap.clean()
    cur = conn.execute(
        """INSERT INTO trips (plate, vin, purpose, appointment_id, checkout_at, checkout_odo,
               checkout_capture, checkout_flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (plate, vin, purpose, appointment_id, at.isoformat(), cap.odometer, cap.capture_id, _flags(result)),
    )
    trip = store.row(conn.execute("SELECT * FROM trips WHERE id = ?", (cur.lastrowid,)).fetchone())
    return {"trip": present(trip), "validation": result}


def checkin(conn: sqlite3.Connection, cap: Capture, allow_walk_in: bool = False) -> dict[str, Any]:
    """Close the vehicle's open trip. With `allow_walk_in`, a vehicle with no open trip
    is accepted and `trip` is None."""
    at = now()
    result = check(conn, "checkin", cap, at, allow_walk_in=allow_walk_in)
    if not result["ok"]:
        raise GateRejected(result)
    if result["trip"] is None:
        return {"trip": None, "validation": result}
    trip_id = result["trip"]["id"]
    _, vin = cap.clean()
    conn.execute(
        """UPDATE trips SET checkin_at = ?, checkin_odo = ?, checkin_capture = ?, checkin_flags = ?,
               vin = COALESCE(vin, ?) WHERE id = ?""",
        (at.isoformat(), cap.odometer, cap.capture_id, _flags(result), vin, trip_id),
    )
    trip = store.row(conn.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone())
    return {"trip": present(trip), "validation": result}


def present(t: dict[str, Any] | None) -> dict[str, Any] | None:
    if t is None:
        return None
    flags = json.loads(t.get("checkout_flags") or "[]") + json.loads(t.get("checkin_flags") or "[]")
    return {
        **t,
        "plate_display": format_plate(t["plate"]),
        "distance_km": (t["checkin_odo"] - t["checkout_odo"]) if t.get("checkin_odo") is not None else None,
        "status": "returned" if t.get("checkin_at") else "out",
        "flags": flags,
        "checkout_flags": None,
        "checkin_flags": None,
    }
