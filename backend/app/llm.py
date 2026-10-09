"""Optional LLM: the local Laya engine first, Ollama Cloud as a fallback.

Laya (`../laya`, started by `frontend/scripts/dev.mjs` on :8100) decodes under a
grammar compiled from the JSON schema, so its replies are always schema-valid and run
fully on this machine. Ollama Cloud is used only when Laya is down and a key is set.

The model is asked for a JSON object matching a schema we send; the reply is parsed and
checked against that schema here, so callers get either a valid object or None. It is
never required: every caller has a deterministic rules path, and the response says
which engine produced it.

Configuration (environment, or `backend/.env`):
    LAYA_URL         default http://127.0.0.1:8100
    OLLAMA_API_KEY   required; without it the LLM is reported as off
    OLLAMA_MODEL     default gpt-oss:120b
    OLLAMA_URL       default https://ollama.com/api
    LLM_DISABLED=1   force the rules / template paths
"""

from __future__ import annotations

import json
from contextvars import ContextVar
import os
import re
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from app.paths import BACKEND_ROOT

ENGINE = "laya"
_ENV_FILE = BACKEND_ROOT / ".env"
_FAIL_COOLDOWN = 30.0  # after a failed call, report unavailable for this long
_last_fail = 0.0
_warm = False
_decision_engine: ContextVar[str | None] = ContextVar("llm_decision_engine", default=None)


def decision_engine() -> str | None:
    """Provider that produced this request's most recent valid response."""
    return _decision_engine.get()


def _load_env_file() -> None:
    """KEY=VALUE lines from backend/.env; real environment variables win."""
    if not _ENV_FILE.exists():
        return
    for raw in _ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file()


def _config() -> tuple[str, str, str]:
    return (
        os.environ.get("OLLAMA_URL", "https://ollama.com/api").rstrip("/"),
        os.environ.get("OLLAMA_MODEL", "gpt-oss:120b"),
        os.environ.get("OLLAMA_API_KEY", ""),
    )


_laya_ok = 0.0  # monotonic time of the last successful Laya health check
_laya_fail = 0.0


def _laya_url() -> str:
    return os.environ.get("LAYA_URL", "http://127.0.0.1:8100").rstrip("/")


def laya_up() -> bool:
    """Cheap, cached health probe of the local engine."""
    global _laya_ok, _laya_fail
    if os.environ.get("LLM_DISABLED") == "1":
        return False
    now = time.monotonic()
    if now - _laya_ok < 15:
        return True
    if now - _laya_fail < 10:
        return False
    try:
        with urllib.request.urlopen(f"{_laya_url()}/health", timeout=1.5) as res:
            ok = json.loads(res.read()).get("status") == "ok"
    except (urllib.error.URLError, OSError, ValueError):
        ok = False
    if ok:
        _laya_ok = now
    else:
        _laya_fail = now
    return ok


def _cloud_available() -> bool:
    if os.environ.get("LLM_DISABLED") == "1" or not _config()[2]:
        return False
    return time.monotonic() - _last_fail > _FAIL_COOLDOWN


def available() -> bool:
    return laya_up() or _cloud_available()


def engine() -> str:
    return "laya" if laya_up() else "ollama" if _cloud_available() else "rules"


def health() -> dict[str, Any]:
    url, model, key = _config()
    local = laya_up()
    return {"ok": available(), "engine": "Laya (local, Qwen3-4B)" if local else f"Ollama Cloud ({model})",
            "model": "lilly-4b" if local else model, "url": _laya_url() if local else url,
            "local": local, "configured": local or bool(key), "available": available(), "warm": _warm}


def warm_up() -> None:
    """One tiny call in the background, so a bad key or outage shows up before a demo."""

    def work() -> None:
        global _warm
        if decide("Reply with ok.", {"type": "object", "properties": {"ok": {"type": "boolean"}},
                                     "required": ["ok"]}, max_tokens=20) is not None:
            _warm = True

    if available():
        threading.Thread(target=work, name="llm-warmup", daemon=True).start()


# ------------------------------------------------------------- validation

def _valid(value: Any, schema: dict[str, Any]) -> bool:
    """The subset of JSON Schema our callers use: type, properties, required, enum,
    items, maxItems, maxLength."""
    if "enum" in schema:
        return value in schema["enum"]
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(value, dict) or any(k not in value for k in schema.get("required", [])):
            return False
        props = schema.get("properties", {})
        return all(_valid(value[k], s) for k, s in props.items() if k in value)
    if kind == "array":
        if not isinstance(value, list) or len(value) > schema.get("maxItems", len(value)):
            return False
        return all(_valid(v, schema.get("items", {})) for v in value)
    if kind == "string":
        return isinstance(value, str) and len(value) <= schema.get("maxLength", len(value))
    if kind == "boolean":
        return isinstance(value, bool)
    if kind in ("number", "integer"):
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return True


def _parse(content: str) -> Any:
    """The JSON object in a reply, tolerating a ```json fence or stray prose around it."""
    content = content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", content, re.S)
    if fenced:
        content = fenced.group(1)
    start, end = content.find("{"), content.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(content[start : end + 1])


# ----------------------------------------------------------------- calls

def _laya_decide(prompt: str, schema: dict[str, Any], max_tokens: int) -> dict[str, Any] | None:
    global _laya_fail, _laya_ok
    body = json.dumps({"prompt": prompt[:8000], "schema": schema, "max_tokens": max_tokens,
                       "model": "lilly-4b"}).encode()
    req = urllib.request.Request(f"{_laya_url()}/v1/schema", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        # first call loads the 4B weights onto the GPU: allow for it
        with urllib.request.urlopen(req, timeout=180) as res:
            value = json.loads(res.read()).get("value")
    except urllib.error.HTTPError:
        return None  # 422: Laya's gate refused; the caller falls back to rules
    except (urllib.error.URLError, OSError, ValueError):
        _laya_fail, _laya_ok = time.monotonic(), 0.0
        return None
    return value if isinstance(value, dict) and _valid(value, schema) else None


def decide(prompt: str, schema: dict[str, Any], max_tokens: int = 400) -> dict[str, Any] | None:
    """Return a schema-valid object from Laya (or the cloud fallback), or None."""
    global _last_fail
    _decision_engine.set(None)
    if laya_up():
        out = _laya_decide(prompt, schema, max_tokens)
        if out is not None:
            _decision_engine.set("laya")
            return out
    if not _cloud_available():
        return None
    url, model, key = _config()
    body = json.dumps({
        "model": model,
        "messages": [
            # Some cloud models ignore `format`, so the schema is also spelled out here.
            {"role": "system", "content": "Reply with only a JSON object that matches this JSON Schema. "
                                          "No prose, no markdown.\n" + json.dumps(schema)},
            {"role": "user", "content": prompt},
        ],
        "format": schema,
        "stream": False,
        # gpt-oss always reasons (it ignores think=false); keep that short instead.
        "think": "low" if model.startswith("gpt-oss") else False,
        # Reasoning tokens count against num_predict, so leave room beyond the answer.
        "options": {"temperature": 0, "num_predict": max_tokens + 1024},
    }).encode()
    req = urllib.request.Request(f"{url}/chat", data=body, headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            data = json.loads(res.read())
    except (urllib.error.URLError, OSError, ValueError):
        _last_fail = time.monotonic()  # network / auth / quota: back off, callers use rules
        return None
    try:
        value = _parse(data.get("message", {}).get("content", ""))
    except ValueError:
        return None
    if isinstance(value, dict) and _valid(value, schema):
        _decision_engine.set("ollama")
        return value
    return None
