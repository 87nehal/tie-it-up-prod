"""Dealer ERP API: outlet context, dashboard, workshop board, Vehicle 360, parts and billing."""

from __future__ import annotations

from typing import Any, Literal

from contextlib import contextmanager

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app import ai, demo_journey, erp
from app import inspection as damage_inspection
from app.service import store

router = APIRouter(prefix="/api/erp", tags=["erp"])


@contextmanager
def _db():
    with store.connect() as conn:
        erp.ensure(conn)
        yield conn


def _guard(fn, *args):
    try:
        return fn(*args)
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'")) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/context")
def context() -> dict[str, Any]:
    with _db() as conn:
        return erp.context(conn)


@router.get("/dashboard")
def dashboard() -> dict[str, Any]:
    with _db() as conn:
        return erp.dashboard(conn)


@router.get("/board")
def board() -> dict[str, Any]:
    with _db() as conn:
        return erp.board(conn)


@router.get("/search")
def search(q: str = "") -> list[dict[str, Any]]:
    with _db() as conn:
        return erp.search(conn, q)


@router.get("/customers")
def customers(q: str = "") -> list[dict[str, Any]]:
    with _db() as conn:
        return erp.customers(conn, q)


@router.get("/vehicles/{vehicle_id}")
def vehicle_360(vehicle_id: int) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.vehicle_360, conn, vehicle_id)


@router.get("/work-orders/{jc_id}")
def work_order(jc_id: int) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.work_order, conn, jc_id)


@router.post("/work-orders/{jc_id}/advance")
def advance(jc_id: int) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.advance, conn, jc_id)


class BayMove(BaseModel):
    bay_id: int | None = None  # omit to pull into the next free bay


@router.post("/work-orders/{jc_id}/bay")
def move_bay(jc_id: int, body: BayMove) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.move_bay, conn, jc_id, body.bay_id)


class DemoStep(BaseModel):
    step: str
    ctx: dict[str, Any] = {}


@router.get("/demo/journey")
def demo_journey_steps() -> list[dict[str, str]]:
    return demo_journey.steps()


@router.post("/demo/journey")
def demo_journey_step(body: DemoStep) -> dict[str, Any]:
    """Run one step of the end-to-end mobile demo for a single car."""
    with _db() as conn:
        return _guard(demo_journey.run, conn, body.step, body.ctx)


@router.post("/demo/journey/progress")
def demo_journey_progress(body: DemoStep) -> dict[str, Any]:
    with _db() as conn:
        return demo_journey.progress(conn, body.ctx)


class Delivery(BaseModel):
    payment_mode: Literal["UPI", "Card", "Cash", "Insurance"] = "UPI"


@router.post("/work-orders/{jc_id}/deliver")
def deliver(jc_id: int, body: Delivery) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.deliver, conn, jc_id, body.payment_mode)


@router.get("/parts")
def parts() -> dict[str, Any]:
    with _db() as conn:
        return erp.parts(conn)


@router.get("/invoices")
def invoices() -> dict[str, Any]:
    with _db() as conn:
        return erp.invoices(conn)


@router.get("/vehicles/{vehicle_id}/journey")
def journey(vehicle_id: int) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.journey, conn, vehicle_id)


@router.get("/journey/counts")
def journey_counts() -> dict[str, int]:
    with _db() as conn:
        return erp.counts(conn)


@router.get("/demo/guide")
def demo_guide() -> list[dict[str, Any]]:
    with _db() as conn:
        return erp.demo_guide(conn)


@router.get("/staff")
def staff() -> dict[str, Any]:
    with _db() as conn:
        return erp.staff(conn)


class Inspection(BaseModel):
    fuel: str | None = None
    checklist: dict[str, bool] = {}
    signature: str | None = None  # PNG data URL
    concerns: str | None = None


@router.post("/visits/{visit_id}/inspection")
def inspection(visit_id: int, body: Inspection) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.save_inspection, conn, visit_id, body.model_dump())


class GateOut(BaseModel):
    by: str = "Security"
    plate: str | None = None
    vin: str | None = None
    odometer: int | None = None


@router.post("/vehicles/{vehicle_id}/gate-out")
def gate_out(vehicle_id: int, body: GateOut) -> dict[str, Any]:
    with _db() as conn:
        return _guard(erp.gate_out, conn, vehicle_id, body.by, body.plate, body.vin, body.odometer)


@router.get("/gate-outs/today")
def gate_outs_today() -> list[dict[str, Any]]:
    with _db() as conn:
        return erp.gate_outs_today(conn)


# ---------------------------------------------------------------- AI decisions

class CustomerBooking(BaseModel):
    vehicle_id: int
    slot_start: str
    mode: Literal["walkin", "pickup"] = "walkin"
    concerns: str = ""


@router.post("/bookings")
def customer_booking(body: CustomerBooking) -> dict[str, Any]:
    """Customer app booking: chauffeur and advisor are matched by the AI engine."""
    with _db() as conn:
        return _guard(ai.book, conn, body.vehicle_id, body.slot_start, body.mode, body.concerns)


@router.get("/bookings/{appointment_id}")
def booking(appointment_id: int) -> dict[str, Any]:
    with _db() as conn:
        return ai.booking_view(conn, appointment_id)


@router.get("/ai/decisions")
def ai_decisions(kind: str | None = None) -> list[dict[str, Any]]:
    with _db() as conn:
        return ai.decisions(conn, kind)


@router.get("/ai/service-due")
def ai_service_due(horizon: int = 45) -> list[dict[str, Any]]:
    with _db() as conn:
        return ai.service_due(conn, horizon)


@router.get("/ai/models")
def ai_models() -> list[dict[str, Any]]:
    return ai.models()


class Diagnose(BaseModel):
    text: str


@router.post("/ai/diagnose/{vehicle_id}")
def ai_diagnose(vehicle_id: int, body: Diagnose) -> dict[str, Any]:
    with _db() as conn:
        did = _guard(ai.diagnose, conn, vehicle_id, body.text)
        return next(d for d in ai.decisions(conn, "diagnosis") if d["id"] == did)


@router.post("/ai/inspection/{visit_id}")
def ai_inspection(visit_id: int) -> dict[str, Any]:
    with _db() as conn:
        out = ai.inspection_report(conn, visit_id)
    if out is None:
        raise HTTPException(409, "photo assessment not finished yet")
    return out


@router.get("/vehicles/{vehicle_id}/slots")
def customer_slots(vehicle_id: int, date: str, mode: Literal["walkin", "pickup"] = "walkin") -> dict[str, Any]:
    from datetime import date as _date

    from app.service import scheduling

    with _db() as conn:
        return scheduling.slots(conn, _date.fromisoformat(date), vehicle_id, mode)


# ------------------------------------------------------- damage inspection (mobile)

@router.post("/inspections")
async def create_inspection(
    vehicle_id: int | None = Form(None),
    visit_id: int | None = Form(None),
    angles: list[str] = Form(default=[]),
    files: list[UploadFile] = File(...),
) -> dict[str, Any]:
    """Upload once; the damage model runs per photo in the background. Poll GET /inspections/{id}."""
    images = []
    for f in files:
        if f.content_type not in {"image/jpeg", "image/png", "image/webp"}:
            raise HTTPException(415, f"{f.filename}: only JPEG, PNG or WebP")
        data = await f.read()
        if len(data) > 15 * 1024 * 1024:
            raise HTTPException(413, f"{f.filename}: image too large")
        images.append(data)
    with _db() as conn:
        return _guard(damage_inspection.create, conn, vehicle_id, visit_id, angles, images)


@router.get("/inspections/{inspection_id}")
def get_inspection(inspection_id: int) -> dict[str, Any]:
    with _db() as conn:
        out = damage_inspection.get(conn, inspection_id)
    if out is None:
        raise HTTPException(404, "inspection not found")
    return out


@router.get("/inspections/{inspection_id}/photos/{index}")
def inspection_photo(inspection_id: int, index: int, annotated: bool = False) -> FileResponse:
    path = damage_inspection.photo_path(inspection_id, index, annotated)
    if not path.is_file():
        raise HTTPException(404, "photo not found")
    return FileResponse(path, media_type="image/jpeg")
