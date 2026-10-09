from __future__ import annotations

import math
from dataclasses import asdict, is_dataclass
from typing import Any

import numpy as np
import pandas as pd


def to_native(value: Any) -> Any:
    if value is None:
        return None
    try:
        if isinstance(value, (float, int, str, bool, bytes)) is False and pd.isna(value):
            return None
    except (ValueError, TypeError):
        pass
    if isinstance(value, (np.generic,)):
        value = value.item()
    if isinstance(value, (float, np.floating)) and (math.isnan(float(value)) or math.isinf(float(value))):
        return None
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if is_dataclass(value) and not isinstance(value, type):
        return {k: to_native(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): to_native(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_native(v) for v in value]
    return value


def series_to_dict(series: pd.Series | None) -> dict[str, Any] | None:
    if series is None:
        return None
    return {str(k): to_native(v) for k, v in series.to_dict().items()}
