"""Concern interpretation: the customer's words lead, vehicle-raised concerns follow."""

from app.service.concerns import VEHICLE_SOURCES, interpret

# Due for service and showing a low-voltage telemetry finding, like HR29ZD7267.
VEHICLE = {
    "odometer": 20000,
    "last_service_km": 10000,
    "telemetry": {"codes": ["BAT-START"], "rule_hits": ["control-module voltage dropped to 10.60 V"],
                  "reason": "Low voltage."},
}


def _codes(text):
    return [(c["demand_code"], c["source"] in VEHICLE_SOURCES)
            for c in interpret(text, VEHICLE, use_llm=False)["concerns"]]


def test_customer_concerns_come_before_vehicle_ones():
    # customer concerns keep the order they were said in
    assert _codes("brake noise and AC not cooling") == [
        ("BRK-NOISE", False), ("AC-COOL", False), ("PMS", True), ("BAT-START", True),
    ]


def test_different_concerns_give_different_customer_rows():
    a = [c for c, vehicle in _codes("clutch hard") if not vehicle]
    b = [c for c, vehicle in _codes("car pulling to the left") if not vehicle]
    assert a == ["CLU-HARD"] and b == ["STR-PULL"]


def test_unknown_words_are_reported_not_hidden():
    r = interpret("windshield cracked", VEHICLE, use_llm=False)
    assert r["unmatched"] == ["windshield cracked"]
    assert all(c["source"] in VEHICLE_SOURCES for c in r["concerns"])
    assert r["decision"] == "manual_review"


def test_hinglish_spelling_variants():
    assert [c for c, v in _codes("brake awaz aur AC thanda nahi") if not v] == ["BRK-NOISE", "AC-COOL"]


def test_rear_noise_is_not_engine():
    from app.service import concerns

    for text in ("Car making noise while running from back side", "peeche se khat khat awaaz aati hai",
                 "rear shocker noise on speed breaker"):
        codes = [c["demand_code"] for c in concerns.interpret(text, use_llm=False)["concerns"]]
        assert codes[0] == "RR-NOISE" and "ENG-NOISE" not in codes, (text, codes)
    codes = [c["demand_code"] for c in concerns.interpret("engine se awaaz aati hai", use_llm=False)["concerns"]]
    assert codes == ["ENG-NOISE"]


def test_one_symptom_does_not_create_duplicate_jobs():
    result = interpret("rear shocker noise on speed breaker", use_llm=False)
    assert [c["demand_code"] for c in result["concerns"]] == ["RR-NOISE"]


def test_unconfirmed_symptoms_do_not_quote_replacement_parts():
    from app.service.concerns import estimate

    vehicle = {"sale_date": "2025-01-01", "odometer": 12000, "model": "Swift", "vin": "MA3EJKD1S00700001"}
    result = estimate(["BRK-NOISE", "AC-COOL"], vehicle)
    assert all(line["type"] == "labour" for line in result["lines"])
    assert result["note"]


def test_anomaly_without_sensor_rule_does_not_claim_oil_fault():
    from app.service.telematics import demand_codes

    assert demand_codes({"has_issue": True, "rule_hits": []}) == []


def _customer(text):
    return [c["demand_code"] for c in interpret(text, use_llm=False)["concerns"]]


def test_warning_lights_go_to_the_right_system():
    assert _customer("ABS warning light on dashboard") == ["SAF-SRS"]
    assert _customer("airbag light is on") == ["SAF-SRS"]
    assert _customer("battery warning light") == ["ELEC-CHG"]
    assert _customer("check engine light came on") == ["ENG-MIL"]
    assert _customer("warning light came on") == ["WARN-LIGHT"]


def test_a_system_said_to_be_fine_is_not_a_concern():
    assert _customer("AC cooling is fine but clutch is hard") == ["CLU-HARD"]
    assert _customer("no problem with brakes, just wash") == ["WASH"]


def test_component_needs_a_symptom():
    assert _customer("brake service due") == ["BRK-CHECK"]
    assert _customer("noise on speed breakers") == ["SUS-NOISE"]
    assert _customer("steering vibrates when I brake") == ["BRK-NOISE"]


def test_everyday_wording_is_recognised():
    cases = {
        "brakes noisy": "BRK-NOISE", "squeaking noise when braking": "BRK-NOISE",
        "horn not working": "ELEC-ACC", "power window stuck": "ELEC-ACC",
        "smoke from exhaust": "EXH-SMOKE", "fuel average dropped": "FUEL-EFF",
        "door rattle while driving": "BODY-RATTLE", "tyre puncture": "TYRE",
        "pickup kam hai": "ENG-PERF", "oil leaking from engine": "ENG-OIL",
        "brake pedal goes down to the floor": "BRK-WEAK", "engine overheating in traffic": "ENG-HEAT",
    }
    for text, code in cases.items():
        assert _customer(text) == [code], (text, _customer(text))


def test_vague_wording_is_left_to_the_advisor():
    r = interpret("the car feels dead", use_llm=False)
    assert r["concerns"] == [] and r["decision"] == "manual_review"
    assert interpret("battery", use_llm=False)["decision"] == "manual_review"


def test_screenshot_concerns_have_specific_explanations():
    result = interpret("Periodic service due, also check engine light came on last week", use_llm=False)
    assert {c["demand_code"] for c in result["concerns"]} == {"PMS", "ENG-MIL"}
    assert result["sufficient"]
    for c in result["concerns"]:
        assert c["customer_words"] in c["explanation"]
        assert c["demand_code"] in c["explanation"]
    assert _customer("please service my car") == ["PMS"]


def test_hindi_concerns_work_without_a_model():
    result = interpret("एसी ठंडा नहीं कर रहा और ब्रेक से आवाज आती है। टायर पंक्चर है", use_llm=False)
    assert {c["demand_code"] for c in result["concerns"]} == {"AC-COOL", "BRK-NOISE", "TYRE"}
    assert result["sufficient"]
    assert _customer("एसी ठीक है लेकिन क्लच सख्त है") == ["CLU-HARD"]


def test_grounded_model_only_concern_is_shown_for_review(monkeypatch):
    from app.service import concerns

    monkeypatch.setattr(concerns.llm, "decide", lambda *a, **k: {"concerns": [
        {"customer_words": "windscreen demister is inoperative", "demand_code": "ELEC-ACC"}]})
    result = interpret("windscreen demister is inoperative")
    assert result["unmatched"] == []
    assert result["concerns"][0]["demand_code"] == "ELEC-ACC"
    assert result["decision"] == "manual_review"
    assert "advisor must verify" in result["concerns"][0]["explanation"]


def test_model_cannot_invent_words_or_hide_unknown_remainder(monkeypatch):
    from app.service import concerns

    monkeypatch.setattr(concerns.llm, "decide", lambda *a, **k: {"concerns": [
        {"customer_words": "windscreen demister is inoperative", "demand_code": "ELEC-ACC"},
        {"customer_words": "engine is overheating", "demand_code": "ENG-HEAT"}]})
    result = interpret("windscreen demister is inoperative mysterious sensation")
    assert [c["demand_code"] for c in result["concerns"]] == ["ELEC-ACC"]
    assert result["unmatched"] == ["mysterious sensation"]


def test_model_omissions_and_outage_preserve_rules(monkeypatch):
    from app.service import concerns

    for response in (None, {"concerns": []}):
        monkeypatch.setattr(concerns.llm, "decide", lambda *a, **k: response)
        result = interpret("Periodic service due, check engine light came on")
        assert result["sufficient"]
        assert {c["demand_code"] for c in result["concerns"]} == {"PMS", "ENG-MIL"}


def test_model_can_return_more_than_six_concerns(monkeypatch):
    from app.service import concerns

    words = [f"unfamiliar complaint {i}" for i in range(7)]
    codes = ["AC-COOL", "BRK-NOISE", "ENG-MIL", "SUS-NOISE", "ELEC-ACC", "CLU-HARD", "TYRE"]

    def reply(prompt, schema, **kwargs):
        assert schema["properties"]["concerns"]["maxItems"] >= 7
        assert kwargs["max_tokens"] >= 1000
        return {"concerns": [{"customer_words": w, "demand_code": c} for w, c in zip(words, codes)]}

    monkeypatch.setattr(concerns.llm, "decide", reply)
    result = interpret("; ".join(words))
    assert len(result["concerns"]) == 7
    assert result["unmatched"] == []


def test_all_symptom_codes_quote_inspection_without_unconfirmed_parts():
    from app.service.concerns import DEMAND_CODES, estimate

    vehicle = {"sale_date": "2025-01-01", "odometer": 12000, "model": "Swift", "vin": "MA3EJKD1S00700001"}
    result = estimate([c for c in DEMAND_CODES if c not in {"PMS", "WASH"}], vehicle)
    assert all(line["type"] == "labour" for line in result["lines"])
