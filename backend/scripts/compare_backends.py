"""Compare CUDA-free inference backends on real images with the frozen profile.

Runs the full calibrated pipeline (tiling, flip TTA, multi-scale fusion,
thresholds, component filter, decision routing) per backend and reports
latency plus agreement with a reference backend:

    python scripts/compare_backends.py IMAGE [IMAGE ...] --backends torch gpu npu cpu

``torch`` is PyTorch FP32 on CPU (the unaltered model function; slow on ARM64).
The first backend listed is the reference.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vehicle_damage.api import selected_artifacts  # noqa: E402
from vehicle_damage.calibration import Calibration  # noqa: E402
from vehicle_damage.inference import (  # noqa: E402
    assess_quality,
    predict_profile_probabilities,
    probabilities_to_mask,
    route_inference_decision,
)
from vehicle_damage.model import load_checkpoint  # noqa: E402
from vehicle_damage.onnx_backend import load_onnx_model  # noqa: E402


def _run(model, image: Image.Image, calibration: Calibration, mixed_precision: bool) -> dict:
    started = time.perf_counter()
    (triage_damage, triage_exterior), (mask_damage, mask_exterior) = (
        predict_profile_probabilities(
            model,
            image,
            device="cpu",
            triage_scales=calibration.triage_scales,
            segmentation_scales=calibration.effective_segmentation_scales,
            tile_size=calibration.tile_size,
            overlap=calibration.overlap,
            horizontal_flip_tta=calibration.horizontal_flip_tta,
            mixed_precision=mixed_precision,
        )
    )
    elapsed = time.perf_counter() - started
    triage_mask, uncertainty = probabilities_to_mask(
        triage_damage,
        triage_exterior,
        calibration.any_damage_threshold,
        calibration.exterior_floor,
        calibration.minimum_component_pixels,
        calibration.type_probability_multipliers,
    )
    mask, _ = probabilities_to_mask(
        mask_damage,
        mask_exterior,
        calibration.effective_segmentation_threshold,
        calibration.exterior_floor,
        calibration.effective_segmentation_minimum_component_pixels,
        calibration.type_probability_multipliers,
    )
    decision = route_inference_decision(
        assess_quality(image),
        triage_mask,
        mask,
        near_threshold_fraction=float((uncertainty < 0.03).mean()),
        max_uncertain_fraction=0.10,
    )
    score = (1.0 - triage_damage[0]) * (
        calibration.exterior_floor + (1.0 - calibration.exterior_floor) * triage_exterior
    )
    return {
        "seconds": elapsed,
        "score": score.numpy(),
        "mask": triage_mask,
        "decision": decision.decision,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("images", nargs="+")
    parser.add_argument(
        "--backends", nargs="+", default=["gpu", "npu", "cpu"],
        choices=["torch", "gpu", "npu", "cpu"],
    )
    parser.add_argument("--output")
    args = parser.parse_args()

    artifacts = selected_artifacts()
    calibration = Calibration.load(artifacts["development_profile"])
    checkpoint = artifacts["checkpoint"]
    images = []
    for path in args.images:
        with Image.open(path) as source:
            images.append((Path(path).name, ImageOps.exif_transpose(source).convert("RGB")))

    results: dict[str, dict[str, dict]] = {}
    report: dict[str, object] = {
        "machine": platform.processor() or platform.machine(),
        "threshold": calibration.any_damage_threshold,
        "backends": {},
    }
    for backend in args.backends:
        loaded = time.perf_counter()
        if backend == "torch":
            model, _ = load_checkpoint(str(checkpoint), "cpu")
            mixed_precision, name = False, "torch:cpu:fp32"
        else:
            model = load_onnx_model(checkpoint, tile_size=calibration.tile_size, device=backend)
            if model.device != backend:
                raise RuntimeError(f"{backend} requested but {model.device} was loaded")
            mixed_precision, name = calibration.mixed_precision, model.description
        load_seconds = time.perf_counter() - loaded
        results[backend] = {}
        for image_name, image in images:
            results[backend][image_name] = _run(model, image, calibration, mixed_precision)
            row = results[backend][image_name]
            print(f"{name:>18} {image_name}: {row['seconds']:.2f}s {row['decision']}", flush=True)
        report["backends"][backend] = {
            "runtime": name,
            "load_seconds": load_seconds,
            "mean_image_seconds": float(
                np.mean([row["seconds"] for row in results[backend].values()])
            ),
        }
        del model

    reference = args.backends[0]
    threshold = calibration.any_damage_threshold
    for backend in args.backends[1:]:
        score_error, flips, positives, decisions = [], 0, 0, 0
        for image_name, _ in images:
            ref, other = results[reference][image_name], results[backend][image_name]
            error = np.abs(ref["score"] - other["score"])
            score_error.append(float(error.max()))
            flips += int(((ref["mask"] > 0) != (other["mask"] > 0)).sum())
            positives += int((ref["mask"] > 0).sum())
            decisions += int(ref["decision"] == other["decision"])
        report["backends"][backend]["vs_" + reference] = {
            "max_abs_score_error": max(score_error),
            "mask_pixel_flips": flips,
            "reference_positive_pixels": positives,
            "decision_agreement": f"{decisions}/{len(images)}",
        }
    print(json.dumps(report, indent=2))
    if args.output:
        Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
