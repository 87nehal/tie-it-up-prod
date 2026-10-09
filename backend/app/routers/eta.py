"""Offline trip-time estimates (no map or traffic service)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.eta import geo, places

router = APIRouter(prefix="/api/eta", tags=["eta"])


@router.get("/places")
def search_places(q: str = "") -> list[dict[str, Any]]:
    return places.search(q) if q.strip() else [
        {"name": n, "lat": lat, "lng": lng} for n, lat, lng in places.PLACES
    ]


class EstimateRequest(BaseModel):
    origin: str
    destination: str
    mode: Literal["DRIVE", "TWO_WHEELER", "BICYCLE", "WALK"] = "DRIVE"
    depart_at: str | None = None


@router.post("/estimate")
def estimate(body: EstimateRequest) -> dict[str, Any]:
    a, b = places.resolve(body.origin), places.resolve(body.destination)
    if a is None or b is None:
        raise HTTPException(404, f"Unknown place: {body.origin if a is None else body.destination}")
    depart = datetime.fromisoformat(body.depart_at) if body.depart_at else None
    return {**geo.estimate(a, b, body.mode, depart), "model": geo.MODEL_NOTE}
