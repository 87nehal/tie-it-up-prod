"""Visual damage inspection endpoints served by the DINOv2 segmentation model."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from vehicle_damage.api import MAX_UPLOAD_BYTES

from app.damage.service import damage_health, get_predictor
from app.paths import DAMAGE_SAMPLES_DIR

router = APIRouter(prefix="/api/damage", tags=["damage"])

ALLOWED_CONTENT_TYPES = {"image/jpeg", "image/png", "image/webp"}

SAMPLES: dict[str, tuple[str, str, bool]] = {
    "damaged": ("damaged.jpg", "Known damaged (smashed front)", True),
    "clean": ("clean.jpg", "Undamaged body lines / paint", False),
    "silver_quarter": ("user_dents/silver_quarter.jpg", "Close-up dent (silver quarter)", True),
    "torn_bumper": ("user_dents/torn_bumper.jpg", "Torn bumper / broken part", True),
    "blue_fender": ("user_dents/blue_fender.jpg", "Close-up dent (blue fender)", True),
    "taillight_dent": ("user_dents/taillight_dent.jpg", "Bumper dent by taillight", True),
    "black_mahindra": ("showroom/black_mahindra.jpg", "Showroom (black Mahindra)", False),
    "white_scorpio": ("showroom/white_scorpio.jpg", "Showroom (white Scorpio)", False),
    "white_bmw": ("showroom/white_bmw.jpg", "Intact listing (white sedan)", False),
}


def _sample_path(sample_id: str) -> Path:
    item = SAMPLES.get(sample_id)
    if item is None:
        raise HTTPException(404, "unknown sample")
    path = DAMAGE_SAMPLES_DIR / item[0]
    if not path.is_file():
        raise HTTPException(404, "sample missing on disk")
    return path


def _predict(payload: bytes) -> dict[str, Any]:
    try:
        predictor = get_predictor()
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    try:
        return predictor.predict_bytes(payload)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/health")
def health() -> dict[str, Any]:
    return damage_health()


@router.get("/samples")
def samples() -> list[dict[str, Any]]:
    return [
        {
            "id": key,
            "file": Path(rel).name,
            "label": label,
            "expected_damage": expected_damage,
            "url": f"/api/damage/file/sample/{key}",
        }
        for key, (rel, label, expected_damage) in SAMPLES.items()
        if (DAMAGE_SAMPLES_DIR / rel).is_file()
    ]


@router.get("/file/sample/{sample_id}")
def sample_file(sample_id: str) -> FileResponse:
    return FileResponse(_sample_path(sample_id), media_type="image/jpeg")


@router.post("/predict")
async def predict(file: UploadFile = File(...)) -> dict[str, Any]:
    if file.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(415, "upload a JPEG, PNG, or WebP image")
    payload = await file.read(MAX_UPLOAD_BYTES + 1)
    # Inference is CPU/NPU bound: keep it off the event loop or every other request stalls.
    report = await run_in_threadpool(_predict, payload)
    report["source"] = f"upload:{Path(file.filename or 'upload').name}"
    return report


@router.get("/predict/sample/{sample_id}")
def predict_sample(sample_id: str) -> dict[str, Any]:
    path = _sample_path(sample_id)
    report = _predict(path.read_bytes())
    report["source"] = f"sample:{sample_id}"
    report["sample_id"] = sample_id
    return report
