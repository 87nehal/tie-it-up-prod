"""Vehicle master: customers and their vehicles, shared by the gate and the service journey."""

from __future__ import annotations

import sqlite3
from typing import Any

from app import db
from app.fleet.extract import format_plate, normalize_plate

db.register_schema(
    """
CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY, name TEXT, phone TEXT, language TEXT,
    lat REAL, lng REAL, locality TEXT, persona TEXT, preferred_channel TEXT, preferred_time TEXT
);
CREATE TABLE IF NOT EXISTS vehicles (
    id INTEGER PRIMARY KEY, customer_id INTEGER, reg_no TEXT UNIQUE, vin TEXT UNIQUE,
    model TEXT, fuel TEXT, sale_date TEXT, odometer INTEGER, avg_km_day REAL,
    last_service_date TEXT, last_service_km INTEGER, obd_log TEXT, telemetry TEXT
);
""",
    json_columns={"telemetry"},
)

SELECT = """SELECT v.*, c.name AS customer_name, c.phone, c.language, c.persona,
                   c.preferred_channel, c.preferred_time, c.lat, c.lng, c.locality
            FROM vehicles v JOIN customers c ON c.id = v.customer_id"""


def _present(v: dict[str, Any] | None) -> dict[str, Any] | None:
    if v is not None:
        v["reg_display"] = format_plate(v["reg_no"])
    return v


def get(conn: sqlite3.Connection, vehicle_id: int) -> dict[str, Any] | None:
    return _present(db.one(conn, f"{SELECT} WHERE v.id = ?", vehicle_id))


def by_plate(conn: sqlite3.Connection, plate: str) -> dict[str, Any] | None:
    return _present(db.one(conn, f"{SELECT} WHERE v.reg_no = ?", normalize_plate(plate)))


def by_vin(conn: sqlite3.Connection, vin: str) -> dict[str, Any] | None:
    return _present(db.one(conn, f"{SELECT} WHERE v.vin = ?", normalize_plate(vin)))


def search(conn: sqlite3.Connection, q: str = "", limit: int = 60) -> list[dict[str, Any]]:
    like = f"%{q.upper().replace(' ', '')}%"
    rows = db.many(conn, f"{SELECT} WHERE v.reg_no LIKE ? OR UPPER(c.name) LIKE ? ORDER BY v.id LIMIT ?",
                   like, f"%{q.upper()}%", limit)
    return [_present(r) for r in rows]  # type: ignore[misc]


def master_checks(conn: sqlite3.Connection, plate: str, vin: str | None, odometer: int | None) -> list[dict[str, str]]:
    """Cross-check a gate capture against the dealer's vehicle records."""
    checks: list[dict[str, str]] = []
    v = by_plate(conn, plate) if plate else None
    if v is None:
        if plate:
            checks.append({"code": "master_unknown", "level": "warning",
                           "message": f"{format_plate(plate)} is not in the vehicle master (new customer?)."})
        return checks
    checks.append({"code": "master_found", "level": "ok",
                   "message": f"{v['model']} of {v['customer_name']} found in the vehicle master."})
    if vin and v["vin"] != vin:
        checks.append({"code": "master_vin_mismatch", "level": "error",
                       "message": f"VIN on record for {v['reg_display']} is {v['vin']}, not {vin}."})
    if odometer is not None and odometer < v["odometer"] - 50:
        checks.append({"code": "master_odo_rollback", "level": "error",
                       "message": f"Odometer {odometer:,} is below the last service record ({v['odometer']:,} km)."})
    return checks
