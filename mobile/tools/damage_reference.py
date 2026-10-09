"""Write the Python device-recipe numbers that test/damage_test.dart compares against.

    cd backend && python ../mobile/tools/damage_reference.py

Writes mobile/test/damage_reference.json and mobile/test/resize_ref/* (raw RGB from PIL:
the decoded image and its bilinear downscale, used to check the Dart resize).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from decision_parity import ROOT, device_recipe  # noqa: E402
from vehicle_damage.inference import assess_quality  # noqa: E402

MOBILE = ROOT / "mobile"
FILES = sorted((MOBILE / "assets" / "samples").glob("damage_*.jpg")) + sorted(
    (ROOT / "backend" / "samples" / "damage" / "user_dents").glob("*.jpg"))
RECAP = {"low_resolution", "underexposed", "excessive_glare_or_overexposure", "blur_or_low_detail"}


def with_quality(img: Image.Image, long_side: int, flip: bool) -> dict:
    r = device_recipe(img, long_side, flip)
    rgb = img.convert("RGB")
    s = min(1.0, long_side / max(rgb.size))
    small = rgb.resize((max(1, round(rgb.width * s)), max(1, round(rgb.height * s))), Image.BILINEAR)
    q = assess_quality(small)
    reasons = [x for x in q.review_reasons if x != "low_resolution"]
    if min(rgb.size) < 480:
        reasons.insert(0, "low_resolution")
    r["recipe_decision"] = r["decision"]
    if any(x in RECAP for x in reasons):
        r["decision"] = "recapture_required"
    elif reasons or r["decision"] == "manual_review_required":
        r["decision"] = "manual_review_required"
    r["quality_reasons"] = reasons
    r["quality"] = {"dark": q.dark_fraction, "clipped": q.clipped_highlight_fraction,
                    "specular": q.specular_highlight_fraction, "sharpness": q.sharpness}
    return r


def main() -> None:
    out = {}
    for f in FILES:
        img = Image.open(f)
        rel = str(f.relative_to(ROOT)).replace("\\", "/")
        out[rel] = {"size": list(img.size), "quick": with_quality(img, 768, False),
                    "thorough": with_quality(img, 1152, True)}
        print(rel, out[rel])
    (MOBILE / "test" / "damage_reference.json").write_text(json.dumps(out, indent=1))
    # resize parity fixture
    d = MOBILE / "test" / "resize_ref"
    d.mkdir(exist_ok=True)
    img = Image.open(FILES[0]).convert("RGB")
    small = img.resize((round(img.width * 768 / max(img.size)), round(img.height * 768 / max(img.size))),
                       Image.BILINEAR)
    (d / "src.rgb").write_bytes(np.asarray(img).tobytes())
    (d / "dst.rgb").write_bytes(np.asarray(small).tobytes())
    (d / "meta.json").write_text(json.dumps({"src": list(img.size), "dst": list(small.size)}))


if __name__ == "__main__":
    main()
