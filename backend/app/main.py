"""Dealer platform backend: one FastAPI process, one local database, no cloud services.

Engines: OBD-II telemetry diagnosis, DINOv2 damage segmentation, on-device OCR
(Hub Gate), offline ETA, and the optional Ollama Cloud LLM. The service journey
(`/api/service`) composes them into the twelve DBP use cases.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app import llm
from app.damage.service import damage_health, warm_up
from app.fleet import odometer
from app.fleet.ocr import ocr_health
from app.paths import FRONTEND_DIST
from app.routers.damage import router as damage_router
from app.routers.erp import router as erp_router
from app.routers.eta import router as eta_router
from app.routers.fleet import router as fleet_router
from app.routers.service import router as service_router
from app.routers.telemetry import router as telemetry_router
from app.routers.telemetry import telemetry_health


@asynccontextmanager
async def lifespan(_: FastAPI):
    warm_up()
    odometer.warm_up()
    llm.warm_up()
    yield


app = FastAPI(
    title="Dealer Service Platform",
    version="2.0.0",
    description="Offline dealer service journey on local telemetry, damage, OCR, ETA and LLM engines.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(telemetry_router)
app.include_router(damage_router)
app.include_router(fleet_router)
app.include_router(eta_router)
app.include_router(service_router)
app.include_router(erp_router)


@app.get("/api/health")
def health() -> dict[str, Any]:
    tele = telemetry_health()
    dmg = damage_health()
    return {
        "ok": bool(tele.get("ok") and dmg.get("ok")),
        "telemetry": tele,
        "damage": dmg,
        "ocr": ocr_health(),
        "llm": llm.health(),
        "eta": {"ok": True, "engine": "offline speed-profile model"},
    }


if FRONTEND_DIST.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")


def main() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.environ.get("CAR_HEALTH_API_HOST", "127.0.0.1"),
        port=int(os.environ.get("CAR_HEALTH_API_PORT", "8000")),
        reload=False,
    )


if __name__ == "__main__":
    main()
