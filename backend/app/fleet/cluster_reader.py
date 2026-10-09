"""Cluster text reader: a small CRNN (CNN + BiLSTM, CTC) trained on instrument-cluster text.

RapidOCR's recogniser was trained on documents and street text; seven-segment LCD
digits trip it up (a segment "4" reads as "h", gaps around a "1" split numbers). This
model re-reads each text box RapidOCR detected on a cluster photo. It is trained by
`scripts/train_reader.py` on rendered seven-segment, LCD and TFT text and runs on ONNX
Runtime like the rest of the gate OCR.
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np
from PIL import Image

from app.paths import ODOMETER_READER

CHARSET = " 0123456789.,:/-°ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
BLANK = 0  # CTC blank; character i of CHARSET is class i + 1
HEIGHT, WIDTH = 32, 256

_session: Any = None
_lock = threading.Lock()


def preprocess(gray: Image.Image) -> np.ndarray:
    """Grayscale crop -> 1 x 32 x 256 float array, aspect kept, right-padded."""
    w, h = gray.size
    new_w = max(1, min(WIDTH, round(w * HEIGHT / max(h, 1))))
    img = np.asarray(gray.resize((new_w, HEIGHT), Image.Resampling.BILINEAR), np.float32) / 255.0
    out = np.empty((HEIGHT, WIDTH), np.float32)
    out[:, :new_w] = img
    out[:, new_w:] = np.median(np.concatenate([img[:, 0], img[:, -1]]))  # extend the background
    return ((out - 0.5) / 0.5)[None]


def decode(logits: np.ndarray) -> list[tuple[str, float]]:
    """Greedy CTC decode of (batch, T, classes) logits -> (text, confidence)."""
    e = np.exp(logits - logits.max(-1, keepdims=True))
    probs = e / e.sum(-1, keepdims=True)
    out = []
    for p in probs:
        best = p.argmax(-1)
        chars, confs, prev = [], [], BLANK
        for t, k in enumerate(best):
            if k != BLANK and k != prev:
                chars.append(CHARSET[k - 1])
                confs.append(p[t, k])
            prev = k
        out.append(("".join(chars).strip(), float(np.min(confs)) if confs else 0.0))
    return out


def load() -> Any:
    """ONNX session for the trained reader, or None when it hasn't been trained."""
    global _session
    with _lock:
        if _session is None and ODOMETER_READER.exists():
            import onnxruntime as ort

            opts = ort.SessionOptions()
            opts.log_severity_level = 3
            _session = ort.InferenceSession(str(ODOMETER_READER), opts, providers=["CPUExecutionProvider"])
        return _session


def crop(rgb: np.ndarray, line: dict[str, Any]) -> Image.Image:
    """The line's box with a little margin, as grayscale."""
    H, W = rgb.shape[:2]
    h = line.get("h", 10.0)
    x0, x1 = line.get("x", 0.0), line.get("x1", line.get("x", 0.0) + h)
    y0 = line.get("y0", line.get("cy", 0.0) - h / 2)
    pad = 0.12 * h
    box = (int(max(0, x0 - pad)), int(max(0, y0 - pad)), int(min(W, x1 + pad)), int(min(H, y0 + h + pad)))
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        return Image.new("L", (8, 8))
    return Image.fromarray(rgb[box[1] : box[3], box[0] : box[2]]).convert("L")


def read_lines(rgb: np.ndarray, lines: list[dict[str, Any]]) -> list[tuple[str, float]] | None:
    """Re-read every line box; None when the reader isn't available."""
    sess = load()
    if sess is None or not lines:
        return None
    batch = np.stack([preprocess(crop(rgb, ln)) for ln in lines])
    (logits,) = sess.run(None, {"image": batch})
    return decode(logits)
