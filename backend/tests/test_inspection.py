"""Mobile damage inspection: upload by angle, results per photo, note, linked to the visit."""

import time

from fastapi.testclient import TestClient

from app import db


class FakePredictor:
    def predict_bytes(self, payload):
        if payload == b"dent":
            return {"decision": "damage_detected", "reason": "dent", "runtime": {"elapsed_ms": 10},
                    "detections": [{"class_name": "dent", "area_frac": 0.031}]}
        return {"decision": "no_damage_detected", "reason": "clean", "detections": [], "runtime": {"elapsed_ms": 10}}


def test_inspection_flow(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "t.db")
    monkeypatch.setenv("LLM_DISABLED", "1")
    from app import inspection
    from app.damage import service as damage_service
    from app.main import app

    monkeypatch.setattr(inspection, "INSPECTION_CAPTURES", tmp_path / "insp")
    monkeypatch.setattr(damage_service, "get_predictor", lambda: FakePredictor())
    c = TestClient(app)
    visit = c.get("/api/service/reception/visits").json()[0]
    r = c.post("/api/erp/inspections",
               data={"visit_id": str(visit["id"]), "angles": ["Front", "Rear"]},
               files=[("files", ("a.jpg", b"dent", "image/jpeg")), ("files", ("b.jpg", b"ok", "image/jpeg"))])
    assert r.status_code == 200, r.text
    iid = r.json()["id"]
    for _ in range(50):
        out = c.get(f"/api/erp/inspections/{iid}").json()
        if out["status"] == "done":
            break
        time.sleep(0.1)
    assert out["status"] == "done"
    assert [p["result"] for p in out["photos"]] == ["Damage found", "No damage"]
    assert out["photos"][0]["damage"] == [{"type": "dent", "size_pct": 3.1}]
    assert out["summary"] == "Damage on Front"
    assert out["note"]["findings"][0]["area"] == "Front"
    v = c.get(f"/api/service/visits/{visit['id']}").json()
    assert v["condition"]["summary"] == "Damage on Front"
    assert c.get(f"/api/erp/vehicles/{visit['vehicle_id']}").json()["inspections"][0]["id"] == iid
