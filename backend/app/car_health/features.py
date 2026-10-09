"""Parse a tabular telemetry log and map columns onto canonical sensors."""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

# Sensors the supervised model was trained on.
MODEL_FEATURES: tuple[str, ...] = (
    "rpm",
    "oil_pressure",
    "fuel_pressure",
    "coolant_pressure",
    "oil_temp",
    "coolant_temp",
)

# Extra sensors used only by safety rules (not required at train time).
RULE_FEATURES: tuple[str, ...] = (
    "voltage",
    "mil_time",
    "mil_distance",
    "load",
    "speed",
)

CANONICAL_SENSORS: tuple[str, ...] = MODEL_FEATURES + RULE_FEATURES

# Human-readable names for reasons.
SENSOR_LABELS: dict[str, str] = {
    "rpm": "engine RPM",
    "oil_pressure": "oil pressure",
    "fuel_pressure": "fuel pressure",
    "coolant_pressure": "coolant pressure",
    "oil_temp": "oil temperature",
    "coolant_temp": "coolant temperature",
    "voltage": "control-module voltage",
    "mil_time": "time with MIL on",
    "mil_distance": "distance traveled with MIL on",
    "load": "engine load",
    "speed": "vehicle speed",
}

# Alias strings are normalized the same way as CSV headers.
_ALIAS_GROUPS: dict[str, tuple[str, ...]] = {
    "rpm": (
        "rpm",
        "engine_rpm",
        "engine rpm",
        "eng_rpm",
        "rotational_speed",
        "rotational speed",
        "rotational speed rpm",
        "rotate",
        "n_rpm",
        "revolutions",
    ),
    "oil_pressure": (
        "oil_pressure",
        "oil pressure",
        "lub_oil_pressure",
        "lub oil pressure",
        "lubrication_oil_pressure",
        "lube_oil_pressure",
        "oil_press",
    ),
    "fuel_pressure": (
        "fuel_pressure",
        "fuel pressure",
        "fuel_press",
        "fuel_rail_pressure",
    ),
    "coolant_pressure": (
        "coolant_pressure",
        "coolant pressure",
        "coolant_press",
    ),
    "oil_temp": (
        "oil_temp",
        "oil temperature",
        "lub_oil_temp",
        "lub oil temp",
        "lube_oil_temp",
        "lubrication_oil_temp",
        "oil_temperature",
    ),
    "coolant_temp": (
        "coolant_temp",
        "coolant temp",
        "coolant_temperature",
        "coolant temperature",
        "engine_coolant_temperature",
        "engine coolant temperature",
        "ect",
        "process_temperature",
        "process temperature",
        "process_temp",
    ),
    "voltage": (
        "voltage",
        "volt",
        "control_module_voltage",
        "control module voltage",
        "battery_voltage",
        "module_voltage",
        "ecu_voltage",
    ),
    "mil_time": (
        "time_run_with_mil_on",
        "time run with mil on",
        "mil_time",
        "mil_on_time",
    ),
    "mil_distance": (
        "distance_traveled_with_mil_on",
        "distance traveled with mil on",
        "mil_distance",
        "distance_with_mil_on",
    ),
    "load": (
        "load",
        "engine_load",
        "engine load",
        "calculated_engine_load",
        "calculated load",
    ),
    "speed": (
        "speed",
        "vehicle_speed",
        "vehicle speed",
        "vss",
    ),
}


def normalize_column(name: str) -> str:
    """Lowercase a header and strip units / punctuation so aliases can match."""
    text = str(name).strip().lower()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\[[^\]]*\]", " ", text)
    text = text.replace("%", " ")
    text = re.sub(r"[^a-z0-9]+", "_", text)
    return text.strip("_")


def _build_alias_lookup() -> dict[str, str]:
    lookup: dict[str, str] = {}
    for canonical, aliases in _ALIAS_GROUPS.items():
        lookup[normalize_column(canonical)] = canonical
        for alias in aliases:
            lookup[normalize_column(alias)] = canonical
    return lookup


ALIAS_LOOKUP: dict[str, str] = _build_alias_lookup()


def load_telemetry_csv(path: str | Path) -> pd.DataFrame:
    """Load a telemetry CSV. Tries comma then semicolon if the first parse is empty.

    ``index_col=False`` is required: many OBD loggers emit a trailing comma, which
    pandas otherwise treats as an extra field and silently uses the first column
    as the index (shifting every sensor).
    """
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"Telemetry log not found: {path}")
    frame = pd.read_csv(path, index_col=False, skipinitialspace=True)
    if frame.shape[1] == 1 and ";" in str(frame.columns[0]):
        frame = pd.read_csv(path, sep=";", index_col=False, skipinitialspace=True)
    unnamed = [c for c in frame.columns if str(c).startswith("Unnamed")]
    if unnamed:
        frame = frame.drop(columns=unnamed)
    if frame.empty:
        raise ValueError(f"Telemetry log is empty: {path}")
    return frame


def canonicalize(frame: pd.DataFrame) -> pd.DataFrame:
    """Rename known sensor columns onto the canonical schema; drop the rest."""
    chosen: dict[str, str] = {}
    for raw in frame.columns:
        canonical = ALIAS_LOOKUP.get(normalize_column(raw))
        if canonical and canonical not in chosen:
            chosen[canonical] = raw

    out = pd.DataFrame(index=frame.index)
    for canonical in CANONICAL_SENSORS:
        raw = chosen.get(canonical)
        if raw is None:
            continue
        out[canonical] = pd.to_numeric(frame[raw], errors="coerce")

    for temp_col in ("coolant_temp", "oil_temp"):
        if temp_col in out.columns:
            out[temp_col] = _maybe_kelvin_to_celsius(out[temp_col])
    return out


def _maybe_kelvin_to_celsius(series: pd.Series) -> pd.Series:
    numeric = pd.to_numeric(series, errors="coerce")
    median = numeric.median()
    if pd.notna(median) and median > 200:
        return numeric - 273.15
    return numeric


def model_matrix(canonical: pd.DataFrame) -> pd.DataFrame:
    """Build the column-aligned matrix the classifier expects (NaN if missing)."""
    data = {name: canonical[name] if name in canonical.columns else pd.NA for name in MODEL_FEATURES}
    matrix = pd.DataFrame(data, index=canonical.index)
    return matrix.apply(pd.to_numeric, errors="coerce")


def mapped_sensors(canonical: pd.DataFrame) -> tuple[str, ...]:
    return tuple(col for col in CANONICAL_SENSORS if col in canonical.columns)
