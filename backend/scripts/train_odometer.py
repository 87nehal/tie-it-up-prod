"""Train the odometer ranker (app/fleet/odometer.py).

    python scripts/train_odometer.py --synth 2000 --workers 4

1. Renders synthetic clusters (scripts/odometer_synth.py) and runs the real RapidOCR on
   each; image + OCR lines are cached under data/odometer/synth, so reruns only add
   what's missing.
2. Real photos: put them in data/odometer/real/ with labels.csv (`file,odometer`).
   They are OCR'd once, used for evaluation, and also for training with --train-real.
3. Every number OCR found becomes a candidate; it is a positive if its digits equal the
   true reading. A gradient-boosted classifier learns to score them.
4. Reports, per evaluation set, how often OCR read the true reading at all (the ceiling),
   how often the old rules picked it and how often the model does; then refits on
   everything and writes models/odometer/odometer_ranker.joblib + metrics.json.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scripts"))

from app.fleet import odometer  # noqa: E402
from app.fleet.extract import find_odometer  # noqa: E402
from app.fleet.ocr import decode, ocr  # noqa: E402
from app.paths import ODOMETER_DATA, ODOMETER_MODEL, ODOMETER_MODELS, ODOMETER_READER  # noqa: E402

# Bump the version whenever odometer_synth.py changes so stale renders are not reused.
SYNTH = ODOMETER_DATA / "synth_v2"
REAL = ODOMETER_DATA / "real"
DEMO = ODOMETER_DATA / "demo"


# ----------------------------------------------------------------- caching

def _ocr_to_json(jpg: bytes, label: int, path: Path) -> None:
    rgb, _ = decode(jpg)
    path.write_text(json.dumps({"odometer": label, "lines": ocr(rgb)}))


def _init_worker(threads: int) -> None:
    """Cap ONNX Runtime threads per worker; by default each one grabs every core."""
    import rapidocr_onnxruntime.utils as ort_utils

    base = ort_utils.SessionOptions

    def options():
        opts = base()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        return opts

    ort_utils.SessionOptions = options


def _make_synth(seed: int) -> int:
    from odometer_synth import sample

    img, meta = SYNTH / f"{seed:05d}.jpg", SYNTH / f"{seed:05d}.json"
    if meta.exists():
        return seed
    jpg, label = sample(seed)
    img.write_bytes(jpg)
    _ocr_to_json(jpg, label, meta)
    return seed


def build_synth(n: int, workers: int) -> None:
    SYNTH.mkdir(parents=True, exist_ok=True)
    todo = [s for s in range(n) if not (SYNTH / f"{s:05d}.json").exists()]
    if not todo:
        return
    print(f"rendering + OCR for {len(todo)} synthetic clusters on {workers} workers")
    t0 = time.time()
    threads = max(1, (os.cpu_count() or 4) // workers)
    with ProcessPoolExecutor(workers, initializer=_init_worker, initargs=(threads,)) as pool:
        for i, _ in enumerate(pool.map(_make_synth, todo, chunksize=4), 1):
            if i % 50 == 0 or i == len(todo):
                rate = i / (time.time() - t0)
                print(f"  {i}/{len(todo)}  {rate:.2f} img/s  eta {(len(todo) - i) / rate / 60:.1f} min", flush=True)


def build_real() -> list[tuple[Path, Path]]:
    labels = REAL / "labels.csv"
    if not labels.exists():
        return []
    out = []
    with labels.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            img = REAL / row["file"]
            meta = img.with_suffix(img.suffix + ".json")
            if not meta.exists():
                _ocr_to_json(img.read_bytes(), int(row["odometer"]), meta)
            out.append((img, meta))
    return out


def build_demo(limit: int = 40) -> list[tuple[Path, Path]]:
    """The app's own demo odometer photos, labelled with the reading they were drawn with."""
    from app.db import connect
    from app.service import demo

    DEMO.mkdir(parents=True, exist_ok=True)
    out = []
    with connect() as conn:
        for (vid,) in conn.execute("SELECT id FROM vehicles ORDER BY id LIMIT ?", (limit,)):
            img, meta = DEMO / f"{vid}.jpg", DEMO / f"{vid}.json"
            if not meta.exists():
                from app import vehicles

                jpg = demo.render(conn, vid, "odometer")
                img.write_bytes(jpg)
                _ocr_to_json(jpg, demo.odometer_for(conn, vehicles.get(conn, vid)), meta)
            out.append((img, meta))
    return out


# ---------------------------------------------------------------- features

def load(items: list[tuple[Path, Path]]):
    """Per image: (true reading, lines, candidate features, candidate values)."""
    rows = []
    for img, meta in items:
        m = json.loads(meta.read_text())
        rgb, _ = decode(img.read_bytes())
        reads = odometer.reread(m["lines"], rgb)
        cands = [c for c in odometer.candidates(m["lines"], rgb, reads=reads) if odometer.plausible(c)]
        ocr_only = {c["value"] for c in odometer.candidates(m["lines"]) if odometer.plausible(c)}
        rows.append({"label": m["odometer"], "lines": m["lines"], "ocr_values": ocr_only, "cands": cands,
                     "X": np.array([c["features"] for c in cands]).reshape(-1, len(odometer.FEATURES)),
                     "values": [c["value"] for c in cands]})
    return rows


def stack(rows):
    X = np.vstack([r["X"] for r in rows if len(r["values"])])
    y = np.concatenate([[int(v == r["label"]) for v in r["values"]] for r in rows if len(r["values"])])
    return X, y


def fit(X, y):
    from sklearn.ensemble import HistGradientBoostingClassifier

    model = HistGradientBoostingClassifier(
        max_iter=400, learning_rate=0.06, max_leaf_nodes=31, min_samples_leaf=20,
        l2_regularization=0.5, class_weight="balanced", random_state=0,
    )
    return model.fit(X, y)


def evaluate(model, rows) -> dict:
    n = len(rows)
    readable = ocr_readable = picked = rules = 0
    for r in rows:
        readable += r["label"] in r["values"]
        ocr_readable += r["label"] in r["ocr_values"]
        if len(r["values"]):
            p = model.predict_proba(r["X"])[:, 1]
            picked += odometer.pick(r["cands"], p)[0]["value"] == r["label"]
        old = find_odometer(r["lines"], set())
        rules += bool(old) and old["value"] == r["label"]
    pct = lambda k: round(100 * k / max(n, 1), 1)  # noqa: E731
    return {"images": n, "rapidocr_read_true_value_pct": pct(ocr_readable),
            "with_reader_read_true_value_pct": pct(readable),
            "rules_correct_pct": pct(rules), "model_correct_pct": pct(picked),
            "model_correct_when_readable_pct": round(100 * picked / max(readable, 1), 1)}


# -------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synth", type=int, default=2000, help="synthetic clusters to use")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--train-real", action="store_true", help="also train on data/odometer/real")
    args = ap.parse_args()

    build_synth(args.synth, args.workers)
    synth = [(SYNTH / f"{s:05d}.jpg", SYNTH / f"{s:05d}.json") for s in range(args.synth)]
    real, demo_items = build_real(), build_demo()
    print(f"features: {len(synth)} synthetic, {len(real)} real, {len(demo_items)} demo photos")
    synth_rows, real_rows, demo_rows = load(synth), load(real), load(demo_items)

    idx = list(range(len(synth_rows)))
    random.Random(0).shuffle(idx)
    cut = int(len(idx) * 0.8)
    train = [synth_rows[i] for i in idx[:cut]]
    test = [synth_rows[i] for i in idx[cut:]]

    model = fit(*stack(train))
    metrics = {"held_out_synthetic": evaluate(model, test), "demo_photos": evaluate(model, demo_rows)}
    if real_rows:
        metrics["real_photos"] = evaluate(model, real_rows)
    print(json.dumps(metrics, indent=2))

    final_rows = synth_rows + demo_rows + (real_rows if args.train_real else [])
    X, y = stack(final_rows)
    final = fit(X, y)
    ODOMETER_MODELS.mkdir(parents=True, exist_ok=True)
    bundle = {"model": final, "features": odometer.FEATURES, "uses_reader": ODOMETER_READER.exists(),
              "trained_at": datetime.now().isoformat(), "train_images": len(final_rows), "train_candidates": int(len(y)), "metrics": metrics}
    import joblib

    joblib.dump(bundle, ODOMETER_MODEL)
    (ODOMETER_MODELS / "metrics.json").write_text(json.dumps(
        {k: v for k, v in bundle.items() if k != "model"}, indent=2))
    print("saved", ODOMETER_MODEL)


if __name__ == "__main__":
    main()
