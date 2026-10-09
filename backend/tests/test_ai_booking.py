"""Customer booking: the AI engine assigns chauffeur and advisor and records why."""

from datetime import date, timedelta

from fastapi.testclient import TestClient

from app import db


def test_booking_records_matches(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setenv("LLM_DISABLED", "1")
    from app.main import app

    c = TestClient(app)
    day = (date.today() + timedelta(days=1)).isoformat()
    slots = c.get(f"/api/erp/vehicles/12/slots?date={day}&mode=pickup").json()["slots"]
    slot = next(s for s in slots if s.get("recommended_rank") == 1)
    r = c.post("/api/erp/bookings", json={"vehicle_id": 12, "slot_start": slot["start"], "mode": "pickup",
                                          "concerns": "AC thanda nahi kar raha"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["chauffeur"]["chosen_name"] == b["appointment"]["driver_name"]
    assert b["advisor"]["chosen_id"] and b["advisor"]["reasons"]
    assert all(c["p_good"] <= b["advisor"]["confidence"] for c in b["advisor"]["alternatives"] if c["eligible"])
    assert "AC not cooling" in b["diagnosis"]["summary"]
    kinds = {d["kind"] for d in c.get("/api/erp/ai/decisions").json()}
    assert {"advisor", "chauffeur", "diagnosis"} <= kinds
    assert all(m["holdout_auc"] > 0.65 for m in c.get("/api/erp/ai/models").json())


def test_future_pickup_shared_journey_to_delivery(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "pickup.db")
    monkeypatch.setenv("LLM_DISABLED", "1")
    from app.main import app

    c = TestClient(app)

    def ok(response):
        assert response.status_code < 300, response.text
        return response.json()

    with db.connect() as conn:
        vid = db.one(conn, """SELECT id FROM vehicles v WHERE id <= 40
                     AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.vehicle_id = v.id)
                     AND NOT EXISTS (SELECT 1 FROM visits vi WHERE vi.vehicle_id = v.id)
                     ORDER BY id LIMIT 1""")["id"]
    day = (date.today() + timedelta(days=1)).isoformat()
    slot = next(s for s in ok(c.get(f"/api/erp/vehicles/{vid}/slots?date={day}&mode=pickup"))["slots"]
                if s.get("recommended_rank") == 1)
    booking = ok(c.post("/api/erp/bookings", json={"vehicle_id": vid, "slot_start": slot["start"],
                        "mode": "pickup", "concerns": "Periodic service"}))
    aid = booking["appointment"]["id"]

    def pickup():
        return next(p for p in ok(c.get("/api/service/pickups"))["pickups"] if p["appointment_id"] == aid)

    def journey():
        return ok(c.get(f"/api/erp/vehicles/{vid}/journey"))

    assert pickup()["status"] == "booked"
    assert pickup()["vehicle_id"] == vid
    assert journey()["step"] == "pickup"
    assert journey()["appointment_id"] == aid
    assert any(a["id"] == aid for a in ok(c.get(f"/api/service/appointments?date={day}")))
    assert any(a["id"] == aid for a in ok(c.get(f"/api/erp/vehicles/{vid}"))["appointments"])
    pending = ok(c.get("/api/erp/journey/counts"))["pickup"]

    ok(c.post(f"/api/service/pickups/{aid}/dispatch"))
    assert c.post(f"/api/service/pickups/{aid}/dispatch").status_code == 409
    ok(c.post("/api/service/pickups/simulate?minutes=240"))
    assert pickup()["status"] == "at_customer"
    assert journey()["step"] == "pickup"
    v = ok(c.get(f"/api/service/vehicles/{vid}"))
    capture = {"plate": v["reg_no"], "vin": v["vin"], "odometer": v["odometer"],
               "service_pass": "DSP-00000000"}
    assert c.post(f"/api/service/pickups/{aid}/handover", json=capture).status_code == 409
    assert pickup()["status"] == "at_customer"
    capture["service_pass"] = booking["appointment"]["qr_token"]
    ok(c.post(f"/api/service/pickups/{aid}/handover", json=capture))
    assert pickup()["status"] == "collected"
    ok(c.post("/api/service/pickups/simulate?minutes=240"))
    assert pickup()["status"] == "at_gate"
    assert journey()["next"]["href"].startswith("/reception")
    assert any(a["id"] == aid for a in ok(c.get("/api/service/reception/expected")))

    visit = ok(c.post("/api/service/reception/check-in", data={"plate": v["reg_no"], "vin": v["vin"],
                       "odometer": str(v["odometer"] + 20)}))["visit"]
    assert visit["appointment_id"] == aid
    assert visit["advisor_id"] == booking["advisor"]["chosen_id"]
    assert journey()["step"] == "job_card"
    assert ok(c.get("/api/erp/journey/counts"))["pickup"] == pending - 1
    jc = ok(c.post("/api/service/job-cards", json={"visit_id": visit["id"], "use_llm": False}))["id"]
    ok(c.post(f"/api/service/job-cards/{jc}/approve"))
    ok(c.post(f"/api/service/job-cards/{jc}/release"))
    assert journey()["step"] == "workshop"
    ok(c.post(f"/api/erp/work-orders/{jc}/advance"))
    ok(c.post(f"/api/erp/work-orders/{jc}/advance"))
    assert journey()["step"] == "delivery"
    ok(c.post(f"/api/erp/work-orders/{jc}/deliver", json={"payment_mode": "Card"}))
    ok(c.post(f"/api/erp/vehicles/{vid}/gate-out", json={"plate": v["reg_no"], "vin": v["vin"],
                    "odometer": v["odometer"] + 23}))
    assert journey()["status"] == "Delivered and gated out"
    assert ok(c.get(f"/api/erp/vehicles/{vid}"))["open_job_card"] is None


def test_bookings_survive_next_demo_day(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "persistent.db")
    monkeypatch.delenv("DEMO_AUTO_RESET", raising=False)
    from app.main import app  # register schemas and seeders

    assert app is not None
    with db.connect() as conn:
        conn.execute("UPDATE meta SET value = ? WHERE key = 'seeded'", ((date.today() - timedelta(days=1)).isoformat(),))
        conn.execute("INSERT INTO meta (key, value) VALUES ('booking-preserved', 'yes')")
    with db.connect() as conn:
        assert db.one(conn, "SELECT value FROM meta WHERE key = 'booking-preserved'")["value"] == "yes"
