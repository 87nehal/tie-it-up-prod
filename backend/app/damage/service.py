"""Thread-safe lazy loader around the hash-pinned vehicle_damage predictor."""

from __future__ import annotations

import threading
from typing import Any

from vehicle_damage.api import DamagePredictor

from app.paths import SELECTED_MODEL

_LOCK = threading.Lock()
_PREDICTOR: DamagePredictor | None = None
_ERROR: str | None = None


def warm_up() -> DamagePredictor | None:
    """Load the predictor once; startup failures are reported through /api/health."""
    global _PREDICTOR, _ERROR
    with _LOCK:
        if _PREDICTOR is None:
            try:
                _PREDICTOR = DamagePredictor()
                _ERROR = None
            except Exception as exc:
                _ERROR = str(exc)
        return _PREDICTOR


def get_predictor() -> DamagePredictor:
    predictor = warm_up()
    if predictor is None:
        raise RuntimeError(_ERROR or "damage model is unavailable")
    return predictor


def damage_health() -> dict[str, Any]:
    predictor = warm_up()
    if predictor is None:
        return {
            "ok": False,
            "model_loaded": False,
            "weights_exist": SELECTED_MODEL.is_file(),
            "error": _ERROR,
        }
    return predictor.health()
