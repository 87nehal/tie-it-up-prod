"""Compare the app's on-device damage decision against the server pipeline.

The app runs the int8 model on a downscaled photo (Quick: one 768 tile; Thorough: long
side 1152, overlapping tiles + horizontal flip). This replays exactly that recipe in
NumPy and prints it next to the server's frozen-profile decision for each sample.

    cd backend && python ../mobile/tools/decision_parity.py [images...]
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
MODELS = ROOT / "mobile" / "assets" / "models"
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "backend" / "src"))

P = json.loads((MODELS / "damage_profile.json").read_text())
SESSION = ort.InferenceSession(str(MODELS / "damage_int8.onnx"), providers=["CPUExecutionProvider"])
TILE = P["tile_size"]


def starts(length: int, overlap: int) -> list[int]:
    if length <= TILE:
        return [0]
    stride = TILE - overlap
    pts = list(range(0, length - TILE + 1, stride))
    if pts[-1] != length - TILE:
        pts.append(length - TILE)
    return pts


def probs(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    pres, typ, ext = SESSION.run(None, {"image": x[None]})
    p = 1 / (1 + np.exp(-pres[0, 0]))
    e = np.exp(typ[0] - typ[0].max(0))
    t = e / e.sum(0)
    ext = 1 / (1 + np.exp(-ext[0, 0]))
    any_d = p * (P["exterior_floor"] + (1 - P["exterior_floor"]) * ext)
    return any_d, t


def device_recipe(img: Image.Image, long_side: int, flip: bool) -> dict:
    img = img.convert("RGB")
    s = min(1.0, long_side / max(img.size))
    img = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.BILINEAR)
    w, h = img.size
    x = (np.asarray(img, np.float32) / 255.0 - P["mean"]) / P["std"]
    x = x.transpose(2, 0, 1).astype(np.float32)
    ph, pw = max(0, TILE - h), max(0, TILE - w)
    x = np.pad(x, ((0, 0), (0, ph), (0, pw)), mode="edge")
    H, W = x.shape[1:]
    acc = np.zeros((H, W), np.float32)
    tacc = np.zeros((5, H, W), np.float32)
    wacc = np.zeros((H, W), np.float32)
    win1 = np.clip(np.hanning(TILE), 0.05, None).astype(np.float32)
    win = win1[:, None] * win1[None, :]
    t0 = time.perf_counter()
    passes = 0
    for top in starts(H, P["overlap"]):
        for left in starts(W, P["overlap"]):
            tile = x[:, top:top + TILE, left:left + TILE]
            a, t = probs(tile)
            passes += 1
            if flip:
                a2, t2 = probs(np.ascontiguousarray(tile[:, :, ::-1]))
                a, t = 0.5 * (a + a2[:, ::-1]), 0.5 * (t + t2[:, :, ::-1])
                passes += 1
            acc[top:top + TILE, left:left + TILE] += a * win
            tacc[:, top:top + TILE, left:left + TILE] += t * win
            wacc[top:top + TILE, left:left + TILE] += win
    dt = time.perf_counter() - t0
    a = (acc / np.maximum(wacc, 1e-6))[:h, :w]
    t = (tacc / np.maximum(wacc, 1e-6))[:, :h, :w]
    mask = np.where(a >= P["threshold"], t.argmax(0) + 1, 0).astype(np.uint8)
    # the frozen minimum island size is in full-resolution pixels; scale it with the photo
    min_px = max(1, round(P["minimum_component_pixels"] * s * s))
    lab, n = ndimage.label(mask > 0, structure=np.ones((3, 3)))
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    keep = sizes >= min_px
    keep[0] = False
    mask[~keep[lab]] = 0
    near = float((np.abs(a - P["threshold"]) < P["near_threshold_band"]).mean())
    if near > P["max_uncertain_fraction"]:
        decision = "manual_review_required"
    elif mask.any():
        decision = "damage_detected"
    else:
        decision = "no_damage_detected"
    cls = {P["classes"][k]: round(float((mask == k).mean()) * 100, 2) for k in range(1, 6) if (mask == k).any()}
    return {"decision": decision, "damage_pct": round(float((mask > 0).mean()) * 100, 2), "types": cls,
            "near_threshold": round(near, 3), "passes": passes, "seconds": round(dt, 1)}


def server(path: Path) -> str:
    """The server's decision for the same photo (full-resolution, multi-scale, frozen profile)."""
    import urllib.request
    import uuid

    boundary = uuid.uuid4().hex
    crlf = "\r\n"
    head = (f"--{boundary}{crlf}Content-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"{crlf}"
            f"Content-Type: image/jpeg{crlf}{crlf}")
    body = head.encode() + path.read_bytes() + f"{crlf}--{boundary}--{crlf}".encode()
    req = urllib.request.Request("http://127.0.0.1:8001/api/damage/predict", body,
                                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=600).read())["decision"]["decision"]
    except Exception as exc:  # server not running
        return f"unavailable ({exc})"


def main() -> None:
    files = [Path(a) for a in sys.argv[1:]] or sorted((ROOT / "backend" / "samples" / "damage").rglob("*.jpg"))
    for f in files:
        img = Image.open(f)
        print(f.name, img.size, "server:", server(f))
        print("  quick    ", device_recipe(img, 768, False))
        print("  thorough ", device_recipe(img, 1152, True))


if __name__ == "__main__":
    main()
