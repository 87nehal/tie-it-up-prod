"""Dealer service journey: outreach, booking, pickup ETA, reception and Job Card creation.

The journey is built on the platform's existing engines rather than copies of them:
the Hub Gate (OCR + validation + trip log) for pickup handover and gate-in, the
damage model for condition capture, the telemetry model for connected-car findings,
the offline ETA engine and the optional Ollama Cloud LLM. Everything else runs on this machine.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from app import vehicles as master
from app.fleet import gate
from app.routers.fleet import GateEntry
from app.service import concerns, demo, eta, jobcard, outreach, reception, scheduling, store
from app.service.catalog import DEMAND_CODES, PARTS

router = APIRouter(prefix="/api/service", tags=["service"])

ALLOWED = {"image/jpeg", "image/png", "image/webp"}
MAX_BYTES = 15 * 1024 * 1024


def _day(value: str | None) -> date:
    try:
        return date.fromisoformat(value) if value else date.today()
    except ValueError as exc:
        raise HTTPException(400, "date must be YYYY-MM-DD") from exc


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except gate.GateRejected as exc:
        raise HTTPException(409, {"message": "validation failed", "validation": exc.validation}) from exc
    except KeyError as exc:
        raise HTTPException(404, str(exc).strip("'")) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


async def _read(files: list[UploadFile]) -> list[bytes]:
    out = []
    for f in files:
        if f.content_type not in ALLOWED:
            raise HTTPException(415, f"{f.filename}: only JPEG, PNG or WebP")
        payload = await f.read()
        if len(payload) > MAX_BYTES:
            raise HTTPException(413, f"{f.filename}: image too large")
        out.append(payload)
    return out


# ------------------------------------------------------------ overview & demo

@router.get("/summary")
def summary() -> dict[str, Any]:
    with store.connect() as conn:
        return store.summary(conn)


@router.post("/demo/reset")
def reset_demo() -> dict[str, Any]:
    store.reset()
    return summary()


@router.get("/demo/photos/{vehicle_id}/{kind}")
def demo_photo(vehicle_id: int, kind: Literal["plate", "vin", "odometer"]) -> Response:
    with store.connect() as conn:
        payload = _guard(demo.render, conn, vehicle_id, kind)
    return Response(payload, media_type="image/jpeg")


@router.get("/vehicles")
def vehicles(q: str = "") -> list[dict[str, Any]]:
    with store.connect() as conn:
        return master.search(conn, q)


@router.get("/vehicles/{vehicle_id}")
def vehicle(vehicle_id: int) -> dict[str, Any]:
    with store.connect() as conn:
        v = master.get(conn, vehicle_id)
    if v is None:
        raise HTTPException(404, "vehicle not found")
    return v


# ---------------------------------------------------------------- 1, 2 outreach

@router.get("/outreach/due")
def due(horizon: int = 30) -> dict[str, Any]:
    with store.connect() as conn:
        return outreach.due_list(conn, horizon)


@router.get("/outreach/{vehicle_id}/nba")
def nba(vehicle_id: int, llm_rewrite: bool = False) -> dict[str, Any]:
    with store.connect() as conn:
        return _guard(outreach.next_best_action, conn, vehicle_id, llm_rewrite)


class OutreachSend(BaseModel):
    vehicle_id: int
    action: str
    channel: Literal["app", "call", "in_dealer"]
    offer: str | None = None
    message: str


@router.post("/outreach/send")
def outreach_send(body: OutreachSend) -> dict[str, Any]:
    with store.connect() as conn:
        return outreach.send(conn, body.vehicle_id, body.action, body.channel, body.offer, body.message)


@router.get("/outreach/outbox")
def outbox() -> list[dict[str, Any]]:
    with store.connect() as conn:
        return outreach.outbox(conn)


# ---------------------------------------------------------- 3, 4 scheduling

@router.get("/slots")
def slots(date: str | None = None, vehicle_id: int | None = None,
          mode: Literal["walkin", "pickup"] = "walkin") -> dict[str, Any]:
    with store.connect() as conn:
        return scheduling.slots(conn, _day(date), vehicle_id, mode)


class DriverQuery(BaseModel):
    vehicle_id: int
    slot_start: str


@router.post("/drivers/rank")
def drivers_rank(body: DriverQuery) -> dict[str, Any]:
    with store.connect() as conn:
        v = master.get(conn, body.vehicle_id)
        if v is None:
            raise HTTPException(404, "vehicle not found")
        return scheduling.rank_drivers(conn, v["lat"], v["lng"], datetime.fromisoformat(body.slot_start))


class Booking(BaseModel):
    vehicle_id: int
    slot_start: str
    mode: Literal["walkin", "pickup"] = "walkin"
    concerns: str = ""
    driver_id: int | None = None


@router.post("/appointments")
def book(body: Booking) -> dict[str, Any]:
    with store.connect() as conn:
        return _guard(scheduling.book, conn, body.vehicle_id, body.slot_start, body.mode, body.concerns, body.driver_id)


@router.get("/appointments")
def appointments(date: str | None = None) -> list[dict[str, Any]]:
    with store.connect() as conn:
        return scheduling.appointments_on(conn, _day(date))


# ------------------------------------------------------------------ 5 ETA

@router.get("/pickups")
def pickups() -> dict[str, Any]:
    with store.connect() as conn:
        return eta.board(conn)


@router.post("/pickups/{appointment_id}/dispatch")
def dispatch(appointment_id: int) -> dict[str, Any]:
    with store.connect() as conn:
        _guard(eta.dispatch, conn, appointment_id)
        return eta.board(conn)


class Ping(BaseModel):
    lat: float
    lng: float


@router.post("/pickups/{appointment_id}/ping")
def ping(appointment_id: int, body: Ping) -> dict[str, Any]:
    with store.connect() as conn:
        eta.ping(conn, appointment_id, body.lat, body.lng)
        return eta.board(conn)


class PickupHandoverEntry(GateEntry):
    service_pass: str | None = None

    def capture(self) -> gate.Capture:
        return gate.Capture(**self.model_dump(exclude={"service_pass"}))


@router.post("/pickups/{appointment_id}/handover")
def handover(appointment_id: int, entry: PickupHandoverEntry) -> dict[str, Any]:
    """Chauffeur captures plate/VIN/odometer at the customer's door (gate check-out)."""
    with store.connect() as conn:
        if entry.service_pass is not None:
            appt = scheduling.appointment(conn, appointment_id)
            if appt is None:
                raise HTTPException(404, "pickup not found")
            if entry.service_pass.strip().upper() != appt["qr_token"]:
                raise HTTPException(409, "Service pass does not match this booking")
        result = _guard(eta.handover, conn, appointment_id, entry.capture())
        return {**result, "board": eta.board(conn)}


@router.post("/pickups/simulate")
def simulate(minutes: float = 5) -> dict[str, Any]:
    with store.connect() as conn:
        eta.simulate(conn, minutes)
        return eta.board(conn)


# ------------------------------------------------------- 6, 7, 8 reception

@router.get("/reception/expected")
def expected() -> list[dict[str, Any]]:
    with store.connect() as conn:
        return reception.arrivals_expected(conn)


@router.get("/reception/visits")
def visits() -> list[dict[str, Any]]:
    with store.connect() as conn:
        return reception.visits_today(conn)


@router.get("/reception/qr/{token}")
def lookup_qr(token: str) -> dict[str, Any]:
    with store.connect() as conn:
        v = reception.by_qr(conn, token)
    if v is None:
        raise HTTPException(404, "service pass not recognised")
    return v


@router.post("/reception/check-in")
async def check_in(
    plate: str = Form(...),
    vin: str | None = Form(None),
    odometer: int | None = Form(None),
    capture_id: str | None = Form(None),
    photo_times: list[str] = Form(default=[]),
    files: list[UploadFile] = File(default=[]),
) -> dict[str, Any]:
    """Gate-in: validates like the Hub Gate, closes the pickup trip (or logs a drive-in),
    opens the service visit and starts the condition assessment in the background."""
    images = await _read(files)
    cap = gate.Capture(plate=plate, vin=vin, odometer=odometer, capture_id=capture_id,
                       photo_times=[t for t in photo_times if t])
    with store.connect() as conn:
        out = _guard(reception.check_in, conn, cap, images)
        out["advisors"] = reception.rank_advisors(conn, out["visit"]["id"])
    if images:
        reception.assess_in_background(out["visit"]["id"], images)
    return out


@router.get("/visits/{visit_id}")
def get_visit(visit_id: int) -> dict[str, Any]:
    with store.connect() as conn:
        v = reception.visit(conn, visit_id)
    if v is None:
        raise HTTPException(404, "visit not found")
    return v


@router.get("/visits/{visit_id}/photos/{index}")
def visit_photo(visit_id: int, index: int, annotated: bool = False) -> FileResponse:
    path = reception.photo_path(visit_id, index, annotated)
    if not path.is_file():
        raise HTTPException(404, "photo not found")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/visits/{visit_id}/advisors")
def advisors(visit_id: int) -> dict[str, Any]:
    with store.connect() as conn:
        return _guard(reception.rank_advisors, conn, visit_id)


class Assign(BaseModel):
    advisor_id: int


@router.post("/visits/{visit_id}/assign")
def assign(visit_id: int, body: Assign) -> dict[str, Any]:
    with store.connect() as conn:
        return reception.assign_advisor(conn, visit_id, body.advisor_id)


# ---------------------------------------------------- 9, 10, 11, 12 job card

@router.get("/demand-codes")
def demand_codes() -> list[dict[str, Any]]:
    return [{"code": k, "label": v["label"], "system": v["system"]} for k, v in DEMAND_CODES.items()]


class Interpret(BaseModel):
    text: str
    vehicle_id: int | None = None
    use_llm: bool = True


@router.post("/concerns/interpret")
def interpret(body: Interpret) -> dict[str, Any]:
    with store.connect() as conn:
        v = master.get(conn, body.vehicle_id) if body.vehicle_id else None
    return concerns.interpret(body.text, v, use_llm=body.use_llm)


class DraftRequest(BaseModel):
    appointment_id: int | None = None
    visit_id: int | None = None
    text: str | None = None
    use_llm: bool = True


@router.post("/job-cards")
def create_job_card(body: DraftRequest) -> dict[str, Any]:
    if not (body.appointment_id or body.visit_id):
        raise HTTPException(400, "appointment_id or visit_id is required")
    with store.connect() as conn:
        return _guard(jobcard.create_draft, conn, body.appointment_id, body.visit_id, body.text, body.use_llm)


@router.get("/job-cards")
def job_cards() -> list[dict[str, Any]]:
    with store.connect() as conn:
        return jobcard.listing(conn)


@router.get("/job-cards/{jc_id}")
def job_card(jc_id: int) -> dict[str, Any]:
    with store.connect() as conn:
        jc = jobcard.get(conn, jc_id)
    if jc is None:
        raise HTTPException(404, "job card not found")
    return jc


class Revision(BaseModel):
    text: str | None = None
    demand_codes: list[str] | None = None
    removed: list[str] | None = None
    override_reason: str | None = None


@router.patch("/job-cards/{jc_id}")
def revise(jc_id: int, body: Revision) -> dict[str, Any]:
    with store.connect() as conn:
        return _guard(jobcard.revise, conn, jc_id, body.text, body.demand_codes, body.removed, body.override_reason)


@router.post("/job-cards/{jc_id}/approve")
def approve(jc_id: int) -> dict[str, Any]:
    with store.connect() as conn:
        return _guard(jobcard.approve, conn, jc_id)


@router.post("/job-cards/{jc_id}/release")
def release(jc_id: int) -> dict[str, Any]:
    with store.connect() as conn:
        return _guard(jobcard.release, conn, jc_id)


@router.get("/parts/{part_no}/availability")
def part_availability(part_no: str, qty: int = 1) -> dict[str, Any]:
    if part_no not in PARTS:
        raise HTTPException(404, "unknown part")
    with store.connect() as conn:
        return {"part_no": part_no, "name": PARTS[part_no]["name"], **jobcard.availability(conn, part_no, qty)}
