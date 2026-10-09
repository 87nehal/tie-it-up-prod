"""Filesystem layout for the merged backend."""

from __future__ import annotations

import os
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = BACKEND_ROOT.parent

SRC_DIR = BACKEND_ROOT / "src"
RUNS_DIR = BACKEND_ROOT / "runs"
SELECTED_MODEL = RUNS_DIR / "SELECTED_DEVELOPMENT_MODEL.json"

TELEMETRY_MODELS = BACKEND_ROOT / "models" / "telemetry"
TELEMETRY_MODEL = TELEMETRY_MODELS / "car_health.joblib"

ODOMETER_MODELS = BACKEND_ROOT / "models" / "odometer"
ODOMETER_MODEL = ODOMETER_MODELS / "odometer_ranker.joblib"
ODOMETER_READER = ODOMETER_MODELS / "cluster_reader.onnx"
ODOMETER_DATA = BACKEND_ROOT / "data" / "odometer"

SAMPLES_DIR = BACKEND_ROOT / "samples"
DAMAGE_SAMPLES_DIR = SAMPLES_DIR / "damage"
TELEMETRY_SAMPLES_DIR = SAMPLES_DIR / "telemetry"

DATA_DIR = BACKEND_ROOT / "data"
# one local database for gate log + service journey (DEALER_DB points a second instance elsewhere)
DB_PATH = Path(os.environ.get("DEALER_DB") or DATA_DIR / "dealer.db")
CAPTURES_DIR = DATA_DIR / "captures"
FLEET_CAPTURES = CAPTURES_DIR / "gate"

FRONTEND_DIST = PROJECT_ROOT / "frontend" / "out"
VISIT_CAPTURES = CAPTURES_DIR / "visits"
OBD_LOGS = DATA_DIR / "obd"
