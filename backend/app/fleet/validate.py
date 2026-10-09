"""Structured validation of a gate capture against the trip log and the system clock."""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Any, Literal

from app import vehicles
from app.fleet import store
from app.fleet.extract import PLATE, PLATE_BH, VIN_CHARS, vin_check_digit_ok

Direction = Literal["checkout", "checkin"]

LOW_CONFIDENCE = 0.6
PHOTO_MAX_AGE_MIN = 30
MAX_AVG_KMPH = 90
MAX_TRIP_KM = 800
MIN_TRIP_MIN = 5


def _check(checks: list[dict[str, Any]], code: str, level: str, message: str) -> None:
    checks.append({"code": code, "level": level, "message": message})


def validate(
    conn: sqlite3.Connection,
    direction: Direction,
    *,
    plate: str,
    vin: str | None,
    odometer: int | None,
    now: datetime,
    photo_times: list[str] | None = None,
    confidences: dict[str, float] | None = None,
    allow_walk_in: bool = False,
) -> dict[str, Any]:
    """`allow_walk_in` lets a check-in with no open trip pass: a customer driving in
    to the workshop, as opposed to a fleet car that must have been checked out."""
    checks: list[dict[str, Any]] = []
    trip: dict[str, Any] | None = None
    distance: int | None = None

    # ---- identity
    if not plate:
        _check(checks, "plate_missing", "error", "Registration number is required.")
    elif not (PLATE.match(plate) or PLATE_BH.match(plate)):
        _check(checks, "plate_format", "warning", f"{plate} doesn't match the Indian registration format.")
    else:
        _check(checks, "plate_format", "ok", "Registration format valid.")

    if vin:
        if not VIN_CHARS.fullmatch(vin):
            _check(checks, "vin_format", "error", "VIN must be 17 characters (no I, O or Q).")
        elif not vin_check_digit_ok(vin):
            _check(checks, "vin_check_digit", "warning", "VIN check digit doesn't verify - confirm it by eye.")
        else:
            _check(checks, "vin_format", "ok", "VIN format and check digit valid.")
        other = store.plate_for_vin(conn, vin)
        if other and plate and other != plate:
            _check(checks, "vin_plate_mismatch", "error", f"VIN is registered to {other} in the log, not {plate}.")
    else:
        _check(checks, "vin_missing", "warning", "No VIN captured.")

    if plate:
        prior_vin = store.known_vin(conn, plate)
        if vin and prior_vin and prior_vin != vin:
            _check(checks, "vin_changed", "error", f"{plate} was previously logged with VIN {prior_vin}.")

    if odometer is None:
        _check(checks, "odo_missing", "error", "Odometer reading is required.")

    if plate:
        checks.extend(vehicles.master_checks(conn, plate, vin, odometer))

    for field, conf in (confidences or {}).items():
        if conf is not None and conf < LOW_CONFIDENCE:
            _check(checks, f"{field}_low_confidence", "warning", f"Low OCR confidence on {field} ({conf:.0%}) - verify manually.")

    # ---- photo freshness vs system clock
    for i, ts in enumerate(photo_times or []):
        if not ts:
            continue
        taken = datetime.fromisoformat(ts)
        age = (now - taken).total_seconds() / 60
        label = f"Photo {i + 1}"
        if taken.date() != now.date():
            _check(checks, "photo_stale", "error", f"{label} was taken on {taken:%d %b %Y}, not today.")
        elif abs(age) > PHOTO_MAX_AGE_MIN:
            _check(checks, "photo_old", "warning", f"{label} was taken at {taken:%H:%M}, {abs(age):.0f} min from now.")

    # ---- trip state
    if plate:
        if direction == "checkout":
            if store.open_trip(conn, plate):
                _check(checks, "already_out", "error", f"{plate} is already checked out and hasn't returned.")
            last = store.last_trip(conn, plate)
            last_odo = (last or {}).get("checkin_odo") or (last or {}).get("checkout_odo")
            if odometer is not None and last_odo is not None:
                if odometer < last_odo:
                    _check(checks, "odo_rollback", "error", f"Odometer {odometer:,} is below the last recorded {last_odo:,} km.")
                elif odometer > last_odo:
                    _check(checks, "odo_gap", "warning", f"Odometer moved {odometer - last_odo:,} km since last check-in (unlogged use?).")
                else:
                    _check(checks, "odo_continuity", "ok", "Odometer matches the last check-in.")
        else:
            trip = store.open_trip(conn, plate)
            if not trip and allow_walk_in:
                _check(checks, "walk_in", "ok", "No open trip: recorded as a drive-in arrival.")
            elif not trip:
                _check(checks, "not_out", "error", f"{plate} has no open check-out to close.")
            else:
                out_at = datetime.fromisoformat(trip["checkout_at"])
                hours = (now - out_at).total_seconds() / 3600
                if trip["vin"] and vin and trip["vin"] != vin:
                    _check(checks, "vin_mismatch", "error", "VIN differs from the one captured at check-out.")
                if out_at.date() != now.date():
                    _check(checks, "overnight", "warning", f"Checked out on {out_at:%d %b}, returning on {now:%d %b}.")
                if hours * 60 < MIN_TRIP_MIN:
                    _check(checks, "too_quick", "warning", f"Only {hours * 60:.0f} min since check-out.")
                if odometer is not None:
                    distance = odometer - trip["checkout_odo"]
                    if distance < 0:
                        _check(checks, "odo_rollback", "error", f"Odometer {odometer:,} is below check-out reading {trip['checkout_odo']:,}.")
                    else:
                        _check(checks, "distance", "ok", f"Travelled {distance:,} km in {hours:.1f} h.")
                        if distance > MAX_TRIP_KM:
                            _check(checks, "distance_high", "warning", f"{distance:,} km exceeds the {MAX_TRIP_KM} km daily limit.")
                        if hours > 0.1 and distance / hours > MAX_AVG_KMPH:
                            _check(checks, "speed_implausible", "warning", f"Implies {distance / hours:.0f} km/h average - check the reading.")

    blocking = any(c["level"] == "error" for c in checks)
    return {
        "direction": direction,
        "ok": not blocking,
        "checked_at": now.isoformat(timespec="seconds"),
        "checks": checks,
        "trip": trip,
        "distance_km": distance,
    }
