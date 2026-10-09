"""Ollama Cloud adapter: reply parsing and schema checks (no network)."""

from app.llm import _parse, _valid

SCHEMA = {
    "type": "object",
    "properties": {"concerns": {"type": "array", "maxItems": 2, "items": {
        "type": "object", "properties": {"code": {"enum": ["PMS", "WASH"]}}, "required": ["code"]}}},
    "required": ["concerns"],
}


def test_parses_fenced_and_wrapped_json():
    assert _parse('Sure!\n```json\n{"a": 1}\n```') == {"a": 1}
    assert _parse('Here you go: {"a": 1} hope it helps') == {"a": 1}


def test_schema_check_rejects_invented_codes_and_overflow():
    assert _valid({"concerns": [{"code": "PMS"}]}, SCHEMA)
    assert not _valid({"concerns": [{"code": "TYRE"}]}, SCHEMA)
    assert not _valid({"concerns": [{"code": "PMS"}] * 3}, SCHEMA)
    assert not _valid({}, SCHEMA)


def test_reports_cloud_provider_when_local_generation_fails(monkeypatch):
    import io
    from app import llm

    monkeypatch.setattr(llm, "laya_up", lambda: True)
    monkeypatch.setattr(llm, "_laya_decide", lambda *args: None)
    monkeypatch.setattr(llm, "_cloud_available", lambda: True)
    monkeypatch.setattr(llm, "_config", lambda: ("http://test", "test", "test"))
    monkeypatch.setattr(llm.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(
        b'{"message":{"content":"{\\"concerns\\":[{\\"code\\":\\"PMS\\"}]}"}}'))
    assert llm.decide("test", SCHEMA) == {"concerns": [{"code": "PMS"}]}
    assert llm.decision_engine() == "ollama"
    monkeypatch.setattr(llm, "_cloud_available", lambda: False)
    assert llm.decide("test", SCHEMA) is None
    assert llm.decision_engine() is None
