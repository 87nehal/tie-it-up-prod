"""Hub gate endpoints: local OCR capture, validation, check-out / check-in log."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.fleet import gate, store
from app.fleet.extract import extract_fields
from app.fleet.ocr import ocr_health, read_image
from app.paths import FLEET_CAPTURES

router = APIRouter(prefix="/api/fleet", tags=["fleet"])

ALLOWED = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
MAX_BYTES = 15 * 1024 * 1024
MAX_FILES = 4


def _now() -> datetime:
    return datetime.now().replace(microsecond=0)


def _merge(best: dict[str, Any] | None, cand: dict[str, Any] | None, i: int):
    # Compare the extractor's score (shape, state code, check digit, labels), not raw OCR
    # confidence: a crisp read of the wrong thing must not beat a real plate.
    if cand and (best is None or cand["score"] > best["score"]):
        return {**cand, "image": i}
    return best


@router.get("/health")
def health() -> dict[str, Any]:
    return ocr_health()


@router.post("/extract")
async def extract(files: list[UploadFile] = File(...)) -> dict[str, Any]:
    if not 1 <= len(files) <= MAX_FILES:
        raise HTTPException(400, f"send 1-{MAX_FILES} images")
    capture_id = uuid.uuid4().hex[:12]
    FLEET_CAPTURES.mkdir(parents=True, exist_ok=True)

    images: list[dict[str, Any]] = []
    fields: dict[str, Any] = {"vin": None, "plate": None, "odometer": None}
    for i, f in enumerate(files):
        if f.content_type not in ALLOWED:
            raise HTTPException(415, f"{f.filename}: only JPEG, PNG or WebP")
        payload = await f.read()
        if len(payload) > MAX_BYTES:
            raise HTTPException(413, f"{f.filename}: image too large")
        try:
            lines, taken, rgb = await run_in_threadpool(read_image, payload)
        except RuntimeError as exc:
            raise HTTPException(503, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        (FLEET_CAPTURES / f"{capture_id}_{i}{ALLOWED[f.content_type]}").write_bytes(payload)
        found = await run_in_threadpool(extract_fields, lines, rgb)
        for key in fields:
            fields[key] = _merge(fields[key], found[key], i)
        images.append(
            {
                "index": i,
                "name": f.filename,
                "taken_at": taken.isoformat() if taken else None,
                "lines": [{"text": ln["text"], "confidence": ln["confidence"]} for ln in lines],
            }
        )
    return {
        "capture_id": capture_id,
        "processed_at": _now().isoformat(),
        "fields": fields,
        "images": images,
    }


class GateEntry(BaseModel):
    plate: str
    vin: str | None = None
    odometer: int | None = None
    capture_id: str | None = None
    photo_times: list[str | None] = []
    confidences: dict[str, float | None] = {}

    def capture(self) -> gate.Capture:
        return gate.Capture(**self.model_dump())


def _commit(fn, *args) -> dict[str, Any]:
    try:
        return fn(*args)
    except gate.GateRejected as exc:
        raise HTTPException(409, {"message": "validation failed", "validation": exc.validation}) from exc


@router.post("/validate/{direction}")
def validate_entry(direction: Literal["checkout", "checkin"], entry: GateEntry,
                   walk_in: bool = False) -> dict[str, Any]:
    """`walk_in=true` is the workshop gate: a customer car may arrive without an open trip."""
    with store.connect() as conn:
        return gate.check(conn, direction, entry.capture(), gate.now(), allow_walk_in=walk_in)


@router.post("/checkout")
def checkout(entry: GateEntry) -> dict[str, Any]:
    with store.connect() as conn:
        return _commit(gate.checkout, conn, entry.capture())


@router.post("/checkin")
def checkin(entry: GateEntry) -> dict[str, Any]:
    with store.connect() as conn:
        return _commit(gate.checkin, conn, entry.capture())


@router.get("/trips")
def trips(date: str | None = None) -> dict[str, Any]:
    day = date or _now().date().isoformat()
    try:
        datetime.fromisoformat(day)
    except ValueError as exc:
        raise HTTPException(400, "date must be YYYY-MM-DD") from exc
    with store.connect() as conn:
        rows = [gate.present(t) for t in store.trips_on(conn, day)]
    return {
        "date": day,
        "trips": rows,
        "summary": {
            "out": sum(r["status"] == "out" for r in rows),
            "returned": sum(r["status"] == "returned" for r in rows),
            "distance_km": sum(r["distance_km"] or 0 for r in rows),
            "flagged": sum(bool(r["flags"]) for r in rows),
        },
    }


@router.get("/captures/{capture_id}/{index}")
def capture_image(capture_id: str, index: int) -> FileResponse:
    if not capture_id.isalnum():
        raise HTTPException(400, "bad capture id")
    for ext in ALLOWED.values():
        path = FLEET_CAPTURES / f"{capture_id}_{index}{ext}"
        if path.is_file():
            return FileResponse(path)
    raise HTTPException(404, "capture not found")
