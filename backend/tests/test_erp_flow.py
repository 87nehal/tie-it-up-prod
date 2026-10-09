"""Work order loop: gate-in -> job card -> approve -> release -> QC -> ready -> invoice -> gate-out."""

from fastapi.testclient import TestClient

from app import db


def test_work_order_loop(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    from app.main import app

    c = TestClient(app)

    def ok(r):
        assert r.status_code < 300, r.text
        return r.json()

    appt = next(a for a in ok(c.get("/api/service/reception/expected")) if a["mode"] == "walkin")
    vid = appt["vehicle_id"]
    v = ok(c.get(f"/api/service/vehicles/{vid}"))
    visit = ok(c.post("/api/service/reception/check-in",
                      data={"plate": v["reg_no"], "vin": v["vin"], "odometer": str(v["odometer"] + 20)}))["visit"]
    ok(c.post(f"/api/erp/visits/{visit['id']}/inspection", json={"fuel": "1/2", "checklist": {"Toolkit": True}}))
    jc = ok(c.post("/api/service/job-cards", json={"visit_id": visit["id"], "use_llm": False}))["id"]

    def stage():
        return next(s["key"] for s in ok(c.get("/api/erp/board"))["stages"]
                    if any(x.get("job_card_id") == jc for x in s["cards"]))

    assert stage() == "estimate"
    ok(c.post(f"/api/service/job-cards/{jc}/approve"))
    ok(c.post(f"/api/service/job-cards/{jc}/release"))
    assert stage() == "in_progress"
    ok(c.post(f"/api/erp/work-orders/{jc}/advance"))
    assert stage() == "qc"
    ok(c.post(f"/api/erp/work-orders/{jc}/advance"))
    assert stage() == "ready"
    assert c.post(f"/api/erp/vehicles/{vid}/gate-out", json={}).status_code == 409
    wo = ok(c.post(f"/api/erp/work-orders/{jc}/deliver", json={"payment_mode": "Card"}))
    assert wo["invoice"]["number"].startswith("INV/")
    assert stage() == "delivered"
    odo_in = v["odometer"] + 20
    bad_vin = c.post(f"/api/erp/vehicles/{vid}/gate-out", json={"plate": v["reg_no"], "vin": "MA3XXXXXXXXX00000", "odometer": odo_in + 3})
    assert bad_vin.status_code == 409 and "VIN" in bad_vin.text
    rollback = c.post(f"/api/erp/vehicles/{vid}/gate-out", json={"plate": v["reg_no"], "vin": v["vin"], "odometer": odo_in - 5})
    assert rollback.status_code == 409 and "below the gate-in" in rollback.text
    out = ok(c.post(f"/api/erp/vehicles/{vid}/gate-out", json={"plate": v["reg_no"], "vin": v["vin"], "odometer": odo_in + 3}))
    assert all(ch["level"] == "ok" for ch in out["checks"])
    assert c.post(f"/api/erp/vehicles/{vid}/gate-out", json={}).status_code == 409  # only once

    v360 = ok(c.get(f"/api/erp/vehicles/{vid}"))
    assert v360["open_job_card"] is None
    assert v360["visits"][0]["inspection"]["fuel"] == "1/2"
