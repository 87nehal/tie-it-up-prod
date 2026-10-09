"""End-to-end odometer accuracy: OCR -> cluster reader -> ranker -> pick, on every test set.

    python scripts/eval_odometer.py [--synth 300]

Sets: demo (bundled demo photos), real (labelled Maruti photos), field (photos reported
from the field, each also tested at several sizes / crops / tilts, since a phone photo of
a cluster is rarely framed like the original), synth (held-out synthetic clusters).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from pathlib import Path

from PIL import Image

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "src"))

from app.fleet import ocr, odometer  # noqa: E402
from app.paths import ODOMETER_DATA  # noqa: E402


def variants(img: Image.Image) -> list[tuple[str, Image.Image]]:
    """How the same cluster arrives from different phones and hands."""
    w, h = img.size
    out = [("orig", img)]
    for s in (0.5, 0.75, 1.5, 2.0):
        out.append((f"scale{s}", img.resize((int(w * s), int(h * s)), Image.Resampling.LANCZOS)))
    out.append(("crop-center", img.crop((int(w * 0.12), int(h * 0.1), int(w * 0.88), int(h * 0.95)))))
    out.append(("crop-low", img.crop((0, int(h * 0.35), w, h))))
    for a in (-6, 5):
        out.append((f"tilt{a}", img.rotate(a, Image.Resampling.BICUBIC, expand=True, fillcolor=(10, 10, 10))))
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=35)
    out.append(("jpeg35", Image.open(io.BytesIO(buf.getvalue()))))
    return out


def run(img: Image.Image) -> int | None:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "PNG")
    lines, _, rgb = ocr.read_image(buf.getvalue())
    r = odometer.read(lines, rgb)
    return r["value"] if r else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth", type=int, default=300)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--reader", type=Path, default=None, help="evaluate a candidate cluster reader (.onnx)")
    args = ap.parse_args()
    if args.reader:
        from app.fleet import cluster_reader

        cluster_reader.ODOMETER_READER = args.reader
        print("reader:", args.reader.name)
    report: dict[str, dict] = {}

    def score(name: str, items: list[tuple[str, Image.Image, int]]) -> None:
        hits, misses = 0, []
        for label, img, truth in items:
            got = run(img)
            hits += got == truth
            if got != truth:
                misses.append(f"{label}: got {got}, want {truth}")
        report[name] = {"n": len(items), "exact": round(hits / max(len(items), 1), 3)}
        print(f"{name:6s} {hits}/{len(items)} = {hits / max(len(items), 1):.1%}", flush=True)
        if not args.quiet:
            for m in misses[:12]:
                print("   miss", m)

    demo = sorted((ODOMETER_DATA / "demo").glob("*.json"), key=lambda p: int(p.stem))
    score("demo", [(p.stem, Image.open(p.with_suffix(".jpg")), json.loads(p.read_text())["odometer"]) for p in demo])
    for name in ("real", "field"):
        labels = ODOMETER_DATA / name / "labels.csv"
        if not labels.exists():
            continue
        rows = list(csv.DictReader(labels.open(newline="", encoding="utf-8")))
        items = []
        for r in rows:
            img = Image.open(labels.parent / r["file"]).convert("RGB")
            for vname, v in variants(img):
                items.append((f"{r['file']}:{vname}", v, int(r["odometer"])))
        score(name, items)
    synth = sorted((ODOMETER_DATA / "synth_v2").glob("*.json"))[-args.synth:]  # tail: not in training head
    score("synth", [(p.stem, Image.open(p.with_suffix(".jpg")), json.loads(p.read_text())["odometer"]) for p in synth])
    print(json.dumps(report))


if __name__ == "__main__":
    main()
