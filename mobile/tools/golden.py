"""Reference reads from the server pipeline for every bundled sample photo.

The app's self-test (Settings → Model self-test) runs the same photos on the phone and
compares against this file: OCR lines, plate, VIN and odometer must match.

    cd backend && python ../mobile/tools/golden.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.fleet import extract, ocr  # noqa: E402

SAMPLES = ROOT / "mobile" / "assets" / "samples"


def main() -> None:
    out = {}
    for f in sorted(SAMPLES.iterdir()):
        if not f.name.startswith(("gate_", "odometer_")):
            continue
        lines, _, rgb = ocr.read_image(f.read_bytes())
        fields = extract.extract_fields(lines, rgb)
        out[f.name] = {
            "size": [int(rgb.shape[1]), int(rgb.shape[0])],
            "lines": [{"text": ln["text"], "confidence": ln["confidence"]} for ln in lines],
            "plate": (fields.get("plate") or {}).get("value"),
            "vin": (fields.get("vin") or {}).get("value"),
            "odometer": (fields.get("odometer") or {}).get("value"),
            "odometer_engine": (fields.get("odometer") or {}).get("engine"),
        }
        print(f.name, {k: out[f.name][k] for k in ("plate", "vin", "odometer")}, [l["text"] for l in out[f.name]["lines"]])
    (SAMPLES / "golden.json").write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
