"""Damage inspection from the mobile app: photos by angle -> damage model -> inspection note.

The phone uploads once and polls: on CPU the damage model takes 30 s - 2 min per photo,
far longer than a request should stay open (and longer than tunnels allow). Each photo
is assessed in a background thread; results fill in one by one. When all photos are
done, Laya writes the advisor's inspection note, using the angle each photo was taken
from as the body area (the model itself does not return a panel location).
"""

from __future__ import annotations

import base64
import threading
from pathlib import Path
from typing import Any

from app import db, llm, vehicles
from app.paths import CAPTURES_DIR
from app.service import store

INSPECTION_CAPTURES = CAPTURES_DIR / "inspections"

db.register_schema(
    """
CREATE TABLE IF NOT EXISTS damage_inspections (
    id INTEGER PRIMARY KEY, vehicle_id INTEGER, visit_id INTEGER, status TEXT,
    photos TEXT, note TEXT, engine TEXT, created_at TEXT, finished_at TEXT
);
""",
    json_columns={"photos", "note"},
)

DECISION_TEXT = {
    "damage_detected": "Damage found",
    "no_damage_detected": "No damage",
    "manual_review_required": "Check manually",
    "recapture_required": "Retake photo",
}

NOTE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "maxLength": 240},
        "findings": {
            "type": "array", "maxItems": 8,
            "items": {
                "type": "object",
                "properties": {
                    "area": {"type": "string", "maxLength": 60},
                    "damage": {"type": "string", "maxLength": 120},
                    "action": {"type": "string", "maxLength": 140},
                },
                "required": ["area", "damage", "action"],
            },
        },
        "customer_note": {"type": "string", "maxLength": 240},
    },
    "required": ["summary", "findings", "customer_note"],
}


def _path(inspection_id: int, index: int, annotated: bool = False) -> Path:
    return INSPECTION_CAPTURES / f"insp{inspection_id}_{index}{'_annotated' if annotated else ''}.jpg"


def photo_path(inspection_id: int, index: int, annotated: bool) -> Path:
    return _path(inspection_id, index, annotated)


def create(conn, vehicle_id: int | None, visit_id: int | None, angles: list[str], images: list[bytes]) -> dict[str, Any]:
    if not images:
        raise ValueError("add at least one photo")
    if vehicle_id is None and visit_id is not None:
        vi = db.one(conn, "SELECT vehicle_id FROM visits WHERE id = ?", visit_id)
        vehicle_id = (vi or {}).get("vehicle_id")
    if vehicle_id is not None and vehicles.get(conn, vehicle_id) is None:
        raise KeyError("vehicle not found")
    photos = [{"index": i, "angle": (angles[i] if i < len(angles) and angles[i] else f"Photo {i + 1}"),
               "status": "queued"} for i in range(len(images))]
    cur = conn.execute(
        "INSERT INTO damage_inspections (vehicle_id, visit_id, status, photos, note, engine, created_at) VALUES (?,?,?,?,?,?,?)",
        (vehicle_id, visit_id, "running", db.dumps(photos), None, None, store.now().isoformat()))
    iid = cur.lastrowid
    INSPECTION_CAPTURES.mkdir(parents=True, exist_ok=True)
    for i, payload in enumerate(images):
        _path(iid, i).write_bytes(payload)  # type: ignore[arg-type]
    conn.commit()
    _run_in_background(iid, len(images))  # type: ignore[arg-type]
    return get(conn, iid)  # type: ignore[arg-type,return-value]


def _update_photo(iid: int, index: int, patch: dict[str, Any]) -> None:
    with store.connect() as conn:
        row = db.one(conn, "SELECT photos FROM damage_inspections WHERE id = ?", iid)
        photos = row["photos"] if row else []
        photos[index].update(patch)
        conn.execute("UPDATE damage_inspections SET photos = ? WHERE id = ?", (db.dumps(photos), iid))


def _assess(iid: int, index: int, predictor) -> None:
    from app.service.reception import _PREDICT_LOCK

    _update_photo(iid, index, {"status": "assessing"})
    try:
        with _PREDICT_LOCK:
            r = predictor.predict_bytes(_path(iid, index).read_bytes())
    except ValueError as exc:  # unreadable / unusable image
        _update_photo(iid, index, {"status": "done", "decision": "recapture_required",
                                   "result": "Retake photo", "reason": str(exc), "damage": []})
        return
    annotated = None
    if r.get("annotated_jpeg_b64"):
        _path(iid, index, True).write_bytes(base64.b64decode(r["annotated_jpeg_b64"]))
        annotated = f"/api/erp/inspections/{iid}/photos/{index}?annotated=true"
    damage = [{"type": (d.get("class_name") or "damage").replace("_", " "),
               "size_pct": round((d.get("area_frac") or 0) * 100, 1)} for d in r.get("detections", [])]
    _update_photo(iid, index, {
        "status": "done", "decision": r["decision"], "result": DECISION_TEXT.get(r["decision"], r["decision"]),
        "reason": r.get("reason"), "damage": damage, "annotated_url": annotated,
        "seconds": round((r.get("runtime") or {}).get("elapsed_ms", 0) / 1000, 1),
    })


def _run_in_background(iid: int, n: int) -> None:
    def work() -> None:
        from app.damage.service import get_predictor

        try:
            predictor = get_predictor()
        except Exception as exc:  # model not loaded: say so on every photo
            for i in range(n):
                _update_photo(iid, i, {"status": "done", "decision": "manual_review_required",
                                       "result": "Check manually", "reason": f"Damage model unavailable: {exc}",
                                       "damage": []})
        else:
            for i in range(n):
                try:
                    _assess(iid, i, predictor)
                except Exception as exc:  # never leave a photo stuck
                    _update_photo(iid, i, {"status": "done", "decision": "manual_review_required",
                                           "result": "Check manually", "reason": str(exc), "damage": []})
        _finish(iid)

    threading.Thread(target=work, name=f"inspection-{iid}", daemon=True).start()


def _summary(photos: list[dict[str, Any]]) -> str:
    hit = [p for p in photos if p.get("decision") == "damage_detected"]
    check = [p for p in photos if p.get("decision") in ("manual_review_required", "recapture_required")]
    if not hit and not check:
        return f"No damage found on {len(photos)} photo(s)"
    parts = []
    if hit:
        parts.append("Damage on " + ", ".join(p["angle"] for p in hit))
    if check:
        parts.append(("check " if hit else "Check ") + ", ".join(p["angle"] for p in check))
    return "; ".join(parts)


def _finish(iid: int) -> None:
    with store.connect() as conn:
        row = db.one(conn, "SELECT * FROM damage_inspections WHERE id = ?", iid)
    photos = row["photos"]
    summary = _summary(photos)
    note: dict[str, Any] = {"summary": summary, "findings": [
        {"area": p["angle"], "damage": ", ".join(f"{d['type']} ({d['size_pct']}% of photo)" for d in p["damage"]) or p["result"],
         "action": "Note on job card; quote repair if customer wants" if p.get("decision") == "damage_detected"
         else "Inspect by hand / retake photo"}
        for p in photos if p.get("decision") != "no_damage_detected"], "customer_note": ""}
    engine = "damage model"
    flagged = [p for p in photos if p.get("decision") != "no_damage_detected"]
    if flagged and llm.available():
        facts = [{"area": p["angle"], "result": p["result"], "damage": p["damage"]} for p in photos]
        out = llm.decide(
            "You are a Maruti Suzuki service advisor writing the arrival inspection note. Photo results "
            "from the damage model are given per car area (the area is the angle the photo was taken from). "
            "For each area with damage or needing a check, state the damage in plain words and the action "
            "(note pre-existing damage on the job card, offer a body-shop quote, or retake/inspect by hand). "
            "Then one short sentence to read to the customer. Use only these facts; do not invent damage.\n"
            f"{db.dumps(facts)}", NOTE_SCHEMA, max_tokens=450)
        if out:
            note, engine = out, f"damage model + {llm.engine()}"
    with store.connect() as conn:
        conn.execute("UPDATE damage_inspections SET status = 'done', note = ?, engine = ?, finished_at = ? WHERE id = ?",
                     (db.dumps(note), engine, store.now().isoformat(), iid))
        if row["visit_id"]:  # the arrival record shows the same result
            images = [{"decision": p.get("decision"), "reason": p.get("reason"),
                       "detections": [{"class_name": d["type"], "area_frac": d["size_pct"] / 100, "score": 1.0,
                                       "kind": "segmentation"} for d in p["damage"]],
                       "n_detections": len(p["damage"]),
                       "photo_url": f"/api/erp/inspections/{iid}/photos/{p['index']}",
                       "annotated_url": p.get("annotated_url")} for p in photos]
            conn.execute("UPDATE visits SET condition = ? WHERE id = ?",
                         (db.dumps({"status": "done", "available": True, "images": images, "summary": summary}),
                          row["visit_id"]))


def get(conn, iid: int) -> dict[str, Any] | None:
    row = db.one(conn, """SELECT di.*, v.reg_no, v.model, c.name AS customer_name FROM damage_inspections di
                          LEFT JOIN vehicles v ON v.id = di.vehicle_id LEFT JOIN customers c ON c.id = v.customer_id
                          WHERE di.id = ?""", iid)
    if row:
        for p in row["photos"]:
            p["photo_url"] = f"/api/erp/inspections/{iid}/photos/{p['index']}"
        done = [p for p in row["photos"] if p["status"] == "done"]
        row["progress"] = {"done": len(done), "total": len(row["photos"])}
        row["summary"] = _summary(done) if done else "Assessing photos…"
    return row


def for_vehicle(conn, vehicle_id: int) -> list[dict[str, Any]]:
    ids = [r["id"] for r in db.many(conn, "SELECT id FROM damage_inspections WHERE vehicle_id = ? ORDER BY id DESC", vehicle_id)]
    return [get(conn, i) for i in ids]  # type: ignore[misc]
