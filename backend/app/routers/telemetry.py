"""Telemetry CSV health-check API — copy of car_tele/model (car_health)."""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, PlainTextResponse

from app.car_health.diagnose import diagnose_log, load_bundle
from app.car_health.features import SENSOR_LABELS
from app.car_health.paths import MODEL_PATH, SAMPLES_DIR

router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])

MAX_PASTE_CHARS = 2_000_000
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

SAMPLES: dict[str, tuple[Path, str]] = {
    "healthy": (SAMPLES_DIR / "healthy.csv", "Healthy engine log"),
    "issue": (SAMPLES_DIR / "issue.csv", "Issue / failure log"),
    "etios": (SAMPLES_DIR / "etios.csv", "Toyota Etios idle (OBD)"),
    "low_battery": (SAMPLES_DIR / "low_battery.csv", "OBD log: weak battery / charging"),
    "mil_on": (SAMPLES_DIR / "mil_on.csv", "OBD log: check-engine lamp on"),
    "overheat": (SAMPLES_DIR / "overheat.csv", "OBD log: coolant overheating"),
}

TEMPLATE_COLUMNS: tuple[str, ...] = (
    "rpm",
    "oil_pressure",
    "fuel_pressure",
    "coolant_pressure",
    "oil_temp",
    "coolant_temp",
    "voltage",
    "mil_time",
    "mil_distance",
    "load",
    "speed",
)


def _payload(diagnosis, source: str) -> dict[str, Any]:
    data = diagnosis.as_dict()
    data["source"] = source
    data["ok"] = True
    data["used_sensor_labels"] = [SENSOR_LABELS.get(name, name) for name in diagnosis.used_sensors]
    return data


def _sample_path(sample_id: str) -> tuple[Path, str]:
    item = SAMPLES.get(sample_id)
    if item is None:
        raise HTTPException(400, f"Unknown sample '{sample_id}'. Use: {', '.join(SAMPLES)}")
    path, _label = item
    if not path.is_file():
        raise HTTPException(404, f"Sample '{sample_id}' is missing on disk")
    return path, f"sample:{sample_id}"


def _write_temp_csv(text: str, prefix: str, original_name: str | None = None) -> tuple[Path, str]:
    if len(text) > MAX_PASTE_CHARS:
        raise HTTPException(400, "CSV text is too large.")
    handle = tempfile.NamedTemporaryFile(
        prefix=f"car_health_{prefix}_",
        suffix=".csv",
        delete=False,
        mode="w",
        encoding="utf-8",
        newline="",
    )
    with handle as tmp:
        tmp.write(text)
        path = Path(tmp.name)
    label = original_name or "pasted.csv"
    return path, f"{prefix}:{label}"


def _run(path: Path, source: str, cleanup: bool, vehicle_id: int | None = None) -> dict[str, Any]:
    """Diagnose a log; with `vehicle_id`, also store it as that vehicle's current
    telemetry so the service journey (due scoring, Job Card) picks it up."""
    try:
        diagnosis = diagnose_log(path)
        payload = _payload(diagnosis, source)
        if vehicle_id is not None:
            from app.service import store, telematics

            with store.connect() as conn:
                if conn.execute("SELECT 1 FROM vehicles WHERE id = ?", (vehicle_id,)).fetchone() is None:
                    raise HTTPException(404, "vehicle not found")
                payload["attached"] = telematics.attach(conn, vehicle_id, path, source)
                payload["attached_to"] = vehicle_id
    except FileNotFoundError as exc:
        raise HTTPException(503, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        if cleanup:
            path.unlink(missing_ok=True)
    return payload


@router.get("/health")
def telemetry_health() -> dict[str, Any]:
    exists = MODEL_PATH.is_file()
    loaded = False
    error = None
    if exists:
        try:
            load_bundle()
            loaded = True
        except Exception as exc:
            error = str(exc)
    return {
        "ok": loaded,
        "model": str(MODEL_PATH),
        "model_exists": exists,
        "error": error,
        "n_samples": sum(1 for path, _ in SAMPLES.values() if path.is_file()),
    }


@router.get("/samples")
def list_samples() -> list[dict[str, Any]]:
    return [
        {
            "id": key,
            "label": label,
            "available": path.is_file(),
            "download_url": f"/api/telemetry/samples/{key}/download",
        }
        for key, (path, label) in SAMPLES.items()
    ]


@router.get("/samples/{sample_id}/download")
def download_sample(sample_id: str) -> FileResponse:
    path, _source = _sample_path(sample_id)
    return FileResponse(
        path,
        media_type="text/csv; charset=utf-8",
        filename=f"telemetry_{sample_id}.csv",
    )


@router.get("/template")
def download_template() -> PlainTextResponse:
    template = ",".join(TEMPLATE_COLUMNS) + "\n"
    headers = {
        "Content-Disposition": 'attachment; filename="telemetry_template.csv"',
    }
    return PlainTextResponse(template, media_type="text/csv; charset=utf-8", headers=headers)


@router.post("/diagnose")
async def diagnose(request: Request) -> dict[str, Any]:
    content_type = (request.headers.get("content-type") or "").lower()
    sample_id = ""
    csv_text = ""
    upload_name = None
    upload_bytes = b""
    vehicle_raw: Any = None

    if "application/json" in content_type:
        body = await request.json()
        if not isinstance(body, dict):
            raise HTTPException(400, "JSON body must be an object.")
        sample_id = str(body.get("sample") or "").strip()
        csv_text = body.get("csv_text") if isinstance(body.get("csv_text"), str) else ""
        vehicle_raw = body.get("vehicle_id")
    else:
        form = await request.form()
        sample_id = str(form.get("sample") or "").strip()
        raw_text = form.get("csv_text")
        csv_text = raw_text if isinstance(raw_text, str) else ""
        vehicle_raw = form.get("vehicle_id")
        uploaded = form.get("file")
        if uploaded is not None and hasattr(uploaded, "read"):
            upload_name = Path(getattr(uploaded, "filename", "") or "upload.csv").name
            upload_bytes = await uploaded.read()

    try:
        vehicle_id = int(vehicle_raw) if vehicle_raw not in (None, "") else None
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "vehicle_id must be an integer") from exc

    if sample_id:
        path, source = _sample_path(sample_id)
        return await run_in_threadpool(_run, path, source, False, vehicle_id)

    if csv_text.strip():
        path, source = _write_temp_csv(csv_text, prefix="paste")
        return await run_in_threadpool(_run, path, source, True, vehicle_id)

    if upload_bytes:
        if Path(upload_name or "").suffix.lower() not in {".csv", ".txt", ".log", ""}:
            raise HTTPException(400, "Upload a .csv (or .txt/.log) telemetry file.")
        if len(upload_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(400, "Uploaded file is too large.")
        if not upload_bytes.strip():
            raise HTTPException(400, "Uploaded file is empty.")
        decoded = upload_bytes.decode("utf-8-sig", errors="replace")
        path, source = _write_temp_csv(decoded, prefix="upload", original_name=upload_name)
        return await run_in_threadpool(_run, path, source, True, vehicle_id)

    raise HTTPException(400, "Send a CSV file, pasted CSV text, or a sample id.")
