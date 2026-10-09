"""Connected-car telemetry for the service journey, scored by the existing `car_health` model.

Each vehicle carries its latest OBD-II log. The diagnosis (RandomForest + safety
rules, the same code behind the Telemetry page) is stored on the vehicle and its
findings are mapped to workshop demand codes, which then drive service-due scoring
(use case 1) and the pre-built Job Card (use cases 9-11).
"""

from __future__ import annotations

import csv
import io
import sqlite3
from pathlib import Path
from typing import Any

from app import db
from app.car_health.diagnose import diagnose_log
from app.paths import OBD_LOGS, TELEMETRY_SAMPLES_DIR

# Demo log variants, derived from the bundled real OBD capture (Etios, idle + drive).
KINDS = ("healthy", "low_battery", "mil_on", "overheat", "engine_wear")


def _rows(path: Path) -> tuple[list[str], list[list[str]]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)
        return header, [r for r in reader if r]


def _col(header: list[str], prefix: str) -> int:
    return next(i for i, h in enumerate(header) if h.strip().upper().startswith(prefix))


def write_demo_log(kind: str, dest: Path) -> Path:
    """Write a demo OBD log of the given condition to `dest`."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if kind == "engine_wear":
        dest.write_bytes((TELEMETRY_SAMPLES_DIR / "issue.csv").read_bytes())
        return dest
    header, rows = _rows(TELEMETRY_SAMPLES_DIR / "etios.csv")
    rows = rows[300:540]
    volt, cool = _col(header, "CONTROL_MODULE_VOLTAGE"), _col(header, "COOLANT_TEMPERATURE")
    mil_t, mil_d = _col(header, "TIME_RUN_WITH_MIL_ON"), _col(header, "DISTANCE_TRAVELED_WITH_MIL_ON")
    for i, r in enumerate(rows):
        if kind == "low_battery" and i % 4 == 0:
            r[volt] = "10.6"
        elif kind == "mil_on":
            r[mil_t], r[mil_d] = str(20 + i // 10), str(8 + i // 30)
        elif kind == "overheat" and i > len(rows) * 0.7:
            r[cool] = str(112 + (i % 14))
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerows([header, *rows])
    dest.write_text(buf.getvalue(), encoding="utf-8")
    return dest


def demand_codes(diagnosis: dict[str, Any]) -> list[str]:
    codes: list[str] = []
    for hit in diagnosis.get("rule_hits", []):
        h = hit.lower()
        if "coolant temperature" in h:
            codes.append("ENG-HEAT")
        elif "voltage" in h:
            codes.append("BAT-START")
        elif "malfunction indicator" in h:
            codes.append("ENG-MIL")
    # A general anomaly cannot identify an oil-pressure fault. Only explicit
    # sensor rules may create a specific workshop demand code.
    return list(dict.fromkeys(codes))


def diagnose(path: Path, source: str) -> dict[str, Any]:
    d = diagnose_log(path).as_dict()
    return {
        "has_issue": d["has_issue"], "issue_probability": d["issue_probability"],
        "reason": d["reason"], "rule_hits": d["rule_hits"], "used_sensors": d["used_sensors"],
        "n_rows": d["n_rows"], "codes": demand_codes(d), "source": source,
        "diagnosed_at": db_now(),
    }


def attach(conn: sqlite3.Connection, vehicle_id: int, path: Path, source: str) -> dict[str, Any]:
    """Score a log and store it as the vehicle's current telemetry."""
    dest = OBD_LOGS / f"vehicle{vehicle_id}.csv"
    if path.resolve() != dest.resolve():
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(path.read_bytes())
    result = diagnose(dest, source)
    conn.execute("UPDATE vehicles SET obd_log = ?, telemetry = ? WHERE id = ?",
                 (dest.name, db.dumps(result), vehicle_id))
    return result


def db_now() -> str:
    from datetime import datetime

    return datetime.now().replace(microsecond=0).isoformat()
