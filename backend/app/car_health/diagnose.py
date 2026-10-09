"""Shipped inference path: parse a log, score it, emit issue + mechanic verdict."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from .features import (
    MODEL_FEATURES,
    SENSOR_LABELS,
    canonicalize,
    load_telemetry_csv,
    mapped_sensors,
    model_matrix,
)
from .paths import MODEL_PATH

# Coolant above this (C) is an overheating red flag regardless of the classifier.
OVERHEAT_C = 120.0
LOW_VOLTAGE = 11.0
LOW_VOLTAGE_FRACTION = 0.10
CRANKING_VOLTAGE_FLOOR = 9.0
HIGH_VOLTAGE = 15.5
MIL_ON_EPS = 1e-6
# When a log only shares a couple of sensors with the training schema (typical
# OBD CSV), require a stronger model score so ship-engine RPM priors do not
# send a normal driving log to a mechanic.
SPARSE_SENSOR_THRESHOLD = 0.72
MIN_INDOMAIN_SENSORS = 4


@dataclass(frozen=True)
class Diagnosis:
    has_issue: bool
    needs_mechanic: bool
    issue_probability: float
    reason: str
    n_rows: int
    used_sensors: tuple[str, ...]
    rule_hits: tuple[str, ...] = field(default_factory=tuple)

    def format_report(self, log_path: str | None = None) -> str:
        issue = "YES" if self.has_issue else "NO"
        mechanic = "YES" if self.needs_mechanic else "NO"
        lines = [
            "=== Car telemetry health check ===",
        ]
        if log_path:
            lines.append(f"Log: {log_path}")
        lines.extend(
            [
                f"Rows scored: {self.n_rows}",
                f"Sensors used: {', '.join(self.used_sensors) if self.used_sensors else '(none)'}",
                f"Issue: {issue}",
                f"Mechanic needed: {mechanic}",
                f"Issue probability: {self.issue_probability:.3f}",
                f"Reason: {self.reason}",
            ]
        )
        return "\n".join(lines) + "\n"

    def as_dict(self) -> dict:
        return {
            "has_issue": self.has_issue,
            "needs_mechanic": self.needs_mechanic,
            "issue": "YES" if self.has_issue else "NO",
            "mechanic_needed": "YES" if self.needs_mechanic else "NO",
            "issue_probability": round(float(self.issue_probability), 4),
            "reason": self.reason,
            "n_rows": self.n_rows,
            "used_sensors": list(self.used_sensors),
            "rule_hits": list(self.rule_hits),
        }


_BUNDLE_CACHE: dict | None = None


def load_bundle(model_path: str | Path | None = None) -> dict:
    """Load the persisted sklearn bundle (pipeline + medians + threshold)."""
    global _BUNDLE_CACHE
    path = Path(model_path) if model_path else MODEL_PATH
    if _BUNDLE_CACHE is not None and model_path is None:
        return _BUNDLE_CACHE
    if not path.is_file():
        raise FileNotFoundError(
            f"Trained model not found at {path}. Run: python -m car_health.train"
        )
    bundle = joblib.load(path)
    if model_path is None:
        _BUNDLE_CACHE = bundle
    return bundle


def diagnose_log(path: str | Path, model_path: str | Path | None = None) -> Diagnosis:
    """Parse a telemetry CSV and return the issue / mechanic verdict."""
    frame = load_telemetry_csv(path)
    return diagnose_frame(frame, source=str(path), model_path=model_path)


def diagnose_frame(
    frame: pd.DataFrame,
    source: str | None = None,
    model_path: str | Path | None = None,
) -> Diagnosis:
    """Score an already-loaded telemetry table with the shipped model + rules."""
    del source  # reserved for report formatting at the CLI layer
    canonical = canonicalize(frame)
    sensors = mapped_sensors(canonical)
    if not sensors:
        raise ValueError(
            "No known telemetry sensors found. Expected columns such as "
            "RPM, coolant temperature, oil/fuel/coolant pressure, or voltage."
        )

    bundle = load_bundle(model_path)
    matrix = model_matrix(canonical)
    if matrix.empty:
        raise ValueError("Telemetry log has no numeric rows to score.")

    pipeline = bundle["pipeline"]
    n_model_sensors = sum(1 for name in MODEL_FEATURES if name in canonical.columns)
    threshold = float(bundle["threshold"])
    if n_model_sensors < MIN_INDOMAIN_SENSORS:
        threshold = max(threshold, SPARSE_SENSOR_THRESHOLD)
    proba = pipeline.predict_proba(matrix)[:, 1]
    issue_probability = _aggregate_probability(proba)

    rule_hits = _safety_rules(canonical)
    has_issue = bool(issue_probability >= threshold) or bool(rule_hits)
    needs_mechanic = has_issue
    reason = _build_reason(
        canonical=canonical,
        bundle=bundle,
        has_issue=has_issue,
        issue_probability=issue_probability,
        rule_hits=rule_hits,
    )
    return Diagnosis(
        has_issue=has_issue,
        needs_mechanic=needs_mechanic,
        issue_probability=float(issue_probability),
        reason=reason,
        n_rows=int(len(matrix)),
        used_sensors=sensors,
        rule_hits=tuple(rule_hits),
    )


def _aggregate_probability(proba: np.ndarray) -> float:
    """One score for the whole log. Mean keeps long mixed-operation logs stable."""
    if proba.size == 0:
        return 0.0
    return float(np.mean(proba))


def _safety_rules(canonical: pd.DataFrame) -> list[str]:
    hits: list[str] = []
    if "coolant_temp" in canonical.columns:
        peak = float(np.nanmax(canonical["coolant_temp"].to_numpy(dtype=float)))
        if np.isfinite(peak) and peak >= OVERHEAT_C:
            hits.append(f"coolant temperature peaked at {peak:.1f} C (overheating)")
    if "voltage" in canonical.columns:
        volts = canonical["voltage"].to_numpy(dtype=float)
        volts = volts[np.isfinite(volts) & (volts > 1.0)]
        if volts.size:
            low = float(np.min(volts))
            high = float(np.max(volts))
            frac_low = float(np.mean(volts <= LOW_VOLTAGE))
            if low <= CRANKING_VOLTAGE_FLOOR or frac_low >= LOW_VOLTAGE_FRACTION:
                hits.append(f"control-module voltage dropped to {low:.2f} V")
            if high >= HIGH_VOLTAGE:
                hits.append(f"control-module voltage rose to {high:.2f} V")
    mil_on = False
    for col in ("mil_time", "mil_distance"):
        if col not in canonical.columns:
            continue
        series = canonical[col].to_numpy(dtype=float)
        series = series[np.isfinite(series)]
        if series.size == 0:
            continue
        # OBD PIDs often report 255 / 65535 when unsupported.
        unique = np.unique(series)
        if unique.size == 1 and unique[0] in {255.0, 65535.0}:
            continue
        peak = float(np.nanmax(series))
        if peak > MIL_ON_EPS:
            mil_on = True
    if mil_on:
        hits.append("malfunction indicator lamp (MIL) has been recorded as on")
    return hits


def _build_reason(
    canonical: pd.DataFrame,
    bundle: dict,
    has_issue: bool,
    issue_probability: float,
    rule_hits: list[str],
) -> str:
    bits: list[str] = []
    bits.extend(rule_hits)

    healthy_medians: dict = bundle.get("healthy_medians", {})
    healthy_p10: dict = bundle.get("healthy_p10", {})
    healthy_p90: dict = bundle.get("healthy_p90", {})

    for name in MODEL_FEATURES:
        if name not in canonical.columns:
            continue
        values = canonical[name].to_numpy(dtype=float)
        if not np.isfinite(values).any():
            continue
        mean_v = float(np.nanmean(values))
        min_v = float(np.nanmin(values))
        max_v = float(np.nanmax(values))
        label = SENSOR_LABELS.get(name, name)
        p10 = healthy_p10.get(name)
        p90 = healthy_p90.get(name)
        median = healthy_medians.get(name)
        if p90 is not None and max_v > float(p90) * 1.02:
            bits.append(
                f"{label} is elevated (peak {max_v:.1f}; healthy typical {median:.1f})"
            )
        elif p10 is not None and min_v < float(p10) * 0.98:
            bits.append(
                f"{label} is low (min {min_v:.1f}; healthy typical {median:.1f})"
            )

    # Keep the reason short: rules + up to two sensor deviations.
    unique: list[str] = []
    for item in bits:
        if item not in unique:
            unique.append(item)
    unique = unique[:4]

    if has_issue:
        if unique:
            return (
                "Issue pattern detected — take the car to a mechanic. "
                + "; ".join(unique)
                + f" (model issue probability {issue_probability:.2f})."
            )
        return (
            "Combined sensor pattern matches known engine-issue cases "
            f"(model issue probability {issue_probability:.2f}). "
            "Take the car to a mechanic."
        )
    return (
        "Sensor readings are within the learned healthy operating range "
        f"(model issue probability {issue_probability:.2f}). "
        "No mechanic visit recommended."
    )
