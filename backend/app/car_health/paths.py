"""Resolve model / sample locations relative to the merged backend root."""

from __future__ import annotations

from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = PACKAGE_DIR.parents[1]
MODELS_DIR = BACKEND_ROOT / "models" / "telemetry"
MODEL_PATH = MODELS_DIR / "car_health.joblib"
METRICS_PATH = MODELS_DIR / "metrics.json"
SAMPLES_DIR = BACKEND_ROOT / "samples" / "telemetry"
FIXTURES_DIR = SAMPLES_DIR
