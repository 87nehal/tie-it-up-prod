"""Local OCR engine (RapidOCR = PaddleOCR models on ONNX Runtime). No network calls."""

from __future__ import annotations

import io
import threading
from datetime import datetime
from typing import Any

import numpy as np
from PIL import ExifTags, Image, ImageOps

_engine: Any = None
_engine_error: str | None = None
_lock = threading.Lock()

MAX_SIDE = 1600


def get_engine() -> Any:
    global _engine, _engine_error
    with _lock:
        if _engine is None and _engine_error is None:
            try:
                from rapidocr_onnxruntime import RapidOCR

                _engine = RapidOCR()
            except Exception as exc:  # pragma: no cover - import/runtime failure
                _engine_error = f"OCR engine unavailable: {exc}"
        if _engine is None:
            raise RuntimeError(_engine_error or "OCR engine unavailable")
        return _engine


def ocr_health() -> dict[str, Any]:
    try:
        import rapidocr_onnxruntime  # noqa: F401
    except Exception as exc:
        return {"ok": False, "engine": "rapidocr-onnxruntime", "error": str(exc)}
    return {
        "ok": _engine_error is None,
        "engine": "rapidocr-onnxruntime",
        "loaded": _engine is not None,
        "error": _engine_error,
    }


def _exif_time(img: Image.Image) -> datetime | None:
    try:
        exif = img.getexif()
        sub = exif.get_ifd(ExifTags.IFD.Exif)
        raw = sub.get(ExifTags.Base.DateTimeOriginal) or exif.get(ExifTags.Base.DateTime)
        if raw:
            return datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S")
    except Exception:
        pass
    return None


def decode(payload: bytes) -> tuple[np.ndarray, datetime | None]:
    """Upright RGB pixels (longest side capped at MAX_SIDE) and EXIF capture time."""
    try:
        img = Image.open(io.BytesIO(payload))
        taken = _exif_time(img)
        img = ImageOps.exif_transpose(img).convert("RGB")
    except Exception as exc:
        raise ValueError(f"could not decode image: {exc}") from exc

    scale = MAX_SIDE / max(img.size)
    if scale < 1:
        img = img.resize((round(img.width * scale), round(img.height * scale)))
    return np.asarray(img), taken


def ocr(rgb: np.ndarray) -> list[dict[str, Any]]:
    """Text lines (top-to-bottom) with confidence and axis-aligned box."""
    result, _ = get_engine()(rgb[:, :, ::-1])
    lines = []
    for box, text, conf in result or []:
        ys = [p[1] for p in box]
        xs = [p[0] for p in box]
        lines.append(
            {
                "text": str(text),
                "confidence": round(float(conf), 3),
                "cy": float(sum(ys) / len(ys)),
                "x": float(min(xs)),
                "x1": float(max(xs)),
                "y0": float(min(ys)),
                "h": float(max(ys) - min(ys)),
            }
        )
    lines.sort(key=lambda ln: (round(ln["cy"] / max(ln["h"], 1)), ln["x"]))
    return lines


def read_image(payload: bytes) -> tuple[list[dict[str, Any]], datetime | None, np.ndarray]:
    """Run OCR on an image; returns text lines, EXIF capture time and the pixels read."""
    rgb, taken = decode(payload)
    return ocr(rgb), taken, rgb
