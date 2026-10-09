"""Package the backend's models for the offline Android app (mobile/assets/models).

    cd backend && python ../mobile/tools/export_models.py

* damage   - the pinned DINOv2 tile model, int8 dynamic-quantised for phone CPUs, plus
             the frozen calibration profile it is thresholded with
* ocr      - RapidOCR's PaddleOCR det / rec ONNX models and the recogniser charset
* reader   - the cluster-text CRNN that re-reads odometer digits
* ranker   - the odometer HistGradientBoosting ranker as plain JSON trees (evaluated in Dart)
* golden   - reference outputs from the server pipelines, used by the app's self-test
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parents[2] / "backend"
OUT = Path(__file__).resolve().parents[1] / "assets" / "models"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "src"))

RUN = BACKEND / "runs" / "pilot_cc0_dinov2_parts_hardneg_long"
DAMAGE_FP32 = RUN / "onnx" / "best-f830d168bdda-tile768.onnx"
CALIBRATION = RUN / "calibration-fp16-comp1200.json"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def export_damage() -> dict:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    dst = OUT / "damage_int8.onnx"
    if not dst.exists():
        print("quantising damage model (int8 dynamic, MatMul/Gemm weights)...")
        quantize_dynamic(str(DAMAGE_FP32), str(dst), weight_type=QuantType.QInt8,
                         op_types_to_quantize=["MatMul", "Gemm"], per_channel=True)
    meta = json.loads(DAMAGE_FP32.with_suffix(".json").read_text())
    calib = json.loads(CALIBRATION.read_text())
    profile = {
        "classes": meta["classes"], "tile_size": meta["tile_size"], "outputs": meta["outputs"],
        "checkpoint_sha256": meta["checkpoint_sha256"], "source_onnx_sha256": meta["onnx_sha256"],
        "threshold": calib["any_damage_threshold"], "exterior_floor": calib["exterior_floor"],
        "overlap": calib["overlap"], "minimum_component_pixels": calib["minimum_component_pixels"],
        "near_threshold_band": 0.03, "max_uncertain_fraction": 0.10,
        "mean": [0.485, 0.456, 0.406], "std": [0.229, 0.224, 0.225],
        "quantisation": "int8 dynamic (per-channel weights)", "sha256": sha(dst),
        "production_approved": False,
    }
    (OUT / "damage_profile.json").write_text(json.dumps(profile, indent=2))
    return profile


def export_ocr() -> None:
    import onnxruntime as ort
    import rapidocr_onnxruntime

    models = Path(rapidocr_onnxruntime.__file__).parent / "models"
    shutil.copy(models / "ch_PP-OCRv3_det_infer.onnx", OUT / "ocr_det.onnx")
    shutil.copy(models / "ch_PP-OCRv3_rec_infer.onnx", OUT / "ocr_rec.onnx")
    rec = ort.InferenceSession(str(OUT / "ocr_rec.onnx"))
    chars = rec.get_modelmeta().custom_metadata_map["character"].splitlines()
    # class 0 is the CTC blank; the last class is a space (PaddleOCR use_space_char)
    (OUT / "ocr_charset.txt").write_text("\n".join(chars), encoding="utf-8")
    from app.paths import ODOMETER_READER

    shutil.copy(ODOMETER_READER, OUT / "cluster_reader.onnx")


def export_ranker() -> None:
    import joblib

    from app.paths import ODOMETER_MODEL

    bundle = joblib.load(ODOMETER_MODEL)
    m = bundle["model"]
    trees = []
    for (pred,) in m._predictors:
        n = pred.nodes
        trees.append({
            "feature": n["feature_idx"].tolist(), "threshold": n["num_threshold"].tolist(),
            "left": n["left"].tolist(), "right": n["right"].tolist(), "leaf": n["is_leaf"].astype(int).tolist(),
            "value": n["value"].tolist(), "missing_left": n["missing_go_to_left"].astype(int).tolist(),
        })
    baseline = float(np.ravel(m._baseline_prediction)[0])
    (OUT / "odometer_ranker.json").write_text(json.dumps({
        "features": bundle["features"], "uses_reader": bool(bundle.get("uses_reader")),
        "baseline": baseline, "trees": trees, "metrics": bundle.get("metrics"),
    }))
    # parity: the JSON trees must reproduce predict_proba
    rng = np.random.default_rng(0)
    X = rng.normal(size=(200, len(bundle["features"]))) * 2
    ref = m.predict_proba(X)[:, 1]
    mine = []
    for x in X:
        raw = baseline
        for t in trees:
            i = 0
            while not t["leaf"][i]:
                v = x[t["feature"][i]]
                go_left = t["missing_left"][i] if np.isnan(v) else v <= t["threshold"][i]
                i = t["left"][i] if go_left else t["right"][i]
            raw += t["value"][i]
        mine.append(1 / (1 + np.exp(-raw)))
    err = float(np.max(np.abs(np.array(mine) - ref)))
    print(f"ranker JSON parity: max |dp| = {err:.2e}")
    assert err < 1e-6


def damage_parity(profile: dict) -> dict:
    """fp32 vs int8 on the bundled samples, single 768 tile (the app's Quick mode)."""
    import onnxruntime as ort
    from PIL import Image

    def run(path: Path, img: Image.Image) -> tuple[np.ndarray, float]:
        s = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        x = np.asarray(img, np.float32) / 255.0
        x = ((x - profile["mean"]) / profile["std"]).transpose(2, 0, 1)[None].astype(np.float32)
        t = time.perf_counter()
        pres, typ, ext = s.run(None, {"image": x})
        dt = time.perf_counter() - t
        p = 1 / (1 + np.exp(-pres[0, 0]))
        e = 1 / (1 + np.exp(-ext[0, 0]))
        anyd = p * (profile["exterior_floor"] + (1 - profile["exterior_floor"]) * e)
        return anyd, dt

    out = {}
    for f in sorted((BACKEND / "samples" / "damage").glob("*.jpg")):
        img = Image.open(f).convert("RGB")
        img.thumbnail((768, 768))
        pad = Image.new("RGB", (768, 768))
        pad.paste(img)
        a, t32 = run(DAMAGE_FP32, pad)
        b, t8 = run(OUT / "damage_int8.onnx", pad)
        th = profile["threshold"]
        agree = float(((a >= th) == (b >= th)).mean())
        out[f.name] = {"fp32_damage_px": int((a >= th).sum()), "int8_damage_px": int((b >= th).sum()),
                       "mask_agreement": round(agree, 4), "max_abs_prob_diff": round(float(np.abs(a - b).max()), 4),
                       "fp32_s": round(t32, 2), "int8_s": round(t8, 2)}
        print(f.name, out[f.name])
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    profile = export_damage()
    export_ocr()
    export_ranker()
    report = {"damage_parity": damage_parity(profile)}
    (OUT.parent / "export_report.json").write_text(json.dumps(report, indent=2))
    for f in sorted(OUT.iterdir()):
        print(f"{f.stat().st_size / 1e6:8.1f} MB  {f.name}")


if __name__ == "__main__":
    main()
