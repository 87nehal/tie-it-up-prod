"""Gate trip log: one row per vehicle movement (check-out -> check-in).

A trip is any spell of a vehicle outside the workshop gate: a company fleet run, or
a customer vehicle collected by a chauffeur (`purpose = 'pickup'`, linked to its
appointment). Lives in the shared database (`app.db`).
"""

from __future__ import annotations

import sqlite3
from typing import Any

from app import db

db.register_schema("""
CREATE TABLE IF NOT EXISTS trips (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    plate           TEXT NOT NULL,
    vin             TEXT,
    purpose         TEXT NOT NULL DEFAULT 'fleet',
    appointment_id  INTEGER,
    checkout_at     TEXT NOT NULL,
    checkout_odo    INTEGER NOT NULL,
    checkout_capture TEXT,
    checkout_flags  TEXT,
    checkin_at      TEXT,
    checkin_odo     INTEGER,
    checkin_capture TEXT,
    checkin_flags   TEXT
);
CREATE INDEX IF NOT EXISTS trips_plate ON trips(plate);
CREATE INDEX IF NOT EXISTS trips_checkout_at ON trips(checkout_at);
""")

connect = db.connect


def row(r: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(r) if r is not None else None


def open_trip(conn: sqlite3.Connection, plate: str) -> dict[str, Any] | None:
    return row(
        conn.execute(
            "SELECT * FROM trips WHERE plate = ? AND checkin_at IS NULL ORDER BY id DESC LIMIT 1",
            (plate,),
        ).fetchone()
    )


def last_trip(conn: sqlite3.Connection, plate: str) -> dict[str, Any] | None:
    return row(
        conn.execute(
            "SELECT * FROM trips WHERE plate = ? ORDER BY id DESC LIMIT 1", (plate,)
        ).fetchone()
    )


def known_vin(conn: sqlite3.Connection, plate: str) -> str | None:
    r = conn.execute(
        "SELECT vin FROM trips WHERE plate = ? AND vin IS NOT NULL ORDER BY id DESC LIMIT 1",
        (plate,),
    ).fetchone()
    return r["vin"] if r else None


def plate_for_vin(conn: sqlite3.Connection, vin: str) -> str | None:
    r = conn.execute(
        "SELECT plate FROM trips WHERE vin = ? ORDER BY id DESC LIMIT 1", (vin,)
    ).fetchone()
    return r["plate"] if r else None


def trips_on(conn: sqlite3.Connection, day: str) -> list[dict[str, Any]]:
    """Trips that left on `day` (YYYY-MM-DD) plus any still out from earlier days."""
    rows = conn.execute(
        """SELECT * FROM trips
           WHERE substr(checkout_at, 1, 10) = ?
              OR substr(checkin_at, 1, 10) = ?
              OR (checkin_at IS NULL AND substr(checkout_at, 1, 10) <= ?)
           ORDER BY checkout_at DESC""",
        (day, day, day),
    ).fetchall()
    return [dict(r) for r in rows]
