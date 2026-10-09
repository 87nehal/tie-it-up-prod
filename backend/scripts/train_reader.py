"""Train the cluster text reader (app/fleet/cluster_reader.py) and export it to ONNX.

    python scripts/train_reader.py --samples 40000 --epochs 5 [--resume]

Rows of cluster text are rendered with the same styles as odometer_synth.py
(seven-segment with and without ghost segments, LCD / TFT fonts, dial labels, units),
cropped the way RapidOCR's detector boxes them, degraded, and used to train a small
CRNN with CTC loss. Real crops can be added in data/odometer/reader_real/labels.csv
(`file,text`) and are used for evaluation.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "scripts"))

from app.fleet.cluster_reader import BLANK, CHARSET, HEIGHT, WIDTH, decode, preprocess  # noqa: E402
from app.paths import ODOMETER_DATA, ODOMETER_MODELS, ODOMETER_READER  # noqa: E402

import odometer_synth as S  # noqa: E402

WORDS = ["km/h", "kmh", "x1000r/min", "x1000rpm", "r/min", "ODO", "Odo", "TRIP", "TRIP A", "TRIP B",
         "km", "E", "F", "1/2", "C", "H", "Service", "INST", "AVG", "RANGE", "DTE", "km/L", "AM", "PM"]


def _content(rng: random.Random) -> list[tuple[str, str]]:
    k = rng.random()
    if k < 0.35:
        return S.odometer_parts(rng, int(10 ** rng.uniform(0.5, 5.95)))
    if k < 0.65:
        return S.distractor(rng, rng.choice(S.DISTRACTORS))
    if k < 0.8:  # dial scale label / digital speed
        return [(str(rng.choice(range(0, 270, 10)) if rng.random() < 0.7 else rng.randint(0, 9)), "num")]
    if k < 0.9:
        return [(rng.choice(WORDS), "small")]
    return [(str(rng.randint(0, 9999999)).zfill(rng.choice([1, 5, 6, 7])), "num")]


def render(seed: int) -> tuple[np.ndarray, str]:
    rng = random.Random(seed)
    parts = _content(rng)
    text = " ".join(t for t, _ in parts if t).strip()
    bg, ink, ghost = rng.choice(S.LCD_STYLES + [((15, 15, 18), (235, 235, 235), None),
                                                 ((225, 225, 220), (20, 20, 20), None)])
    h = rng.uniform(26, 64)
    if rng.random() < 0.4:  # washed-out LCD: ink only a little darker / brighter than the panel
        a = rng.uniform(0.2, 0.6)
        ink = tuple(int(c * (1 - a) + b * a) for c, b in zip(ink, bg))
    # Real seven-segment glyphs vary: thin segments with gaps, strong italic slant.
    style = {"h": h, "seg": rng.random() < 0.55, "font": rng.choice(S.FONTS), "small_font": rng.choice(S.FONTS[:10]),
             "small": rng.uniform(0.35, 0.75), "color": ink, "slant": rng.uniform(0.0, 0.24),
             "thick": rng.uniform(0.07, 0.16), "gap": rng.uniform(0.0, 0.05),
             "ghost": ghost if rng.random() < 0.5 else None}
    if all(role == "small" for _, role in parts):
        style["small"] = rng.uniform(0.7, 1.1)
    w = int(S._run_width(parts, style) + 2 * h)
    H = int(h * 2.2)
    im = Image.new("RGB", (w, H), bg)
    mask = Image.new("L", (w, H), 0)
    S._draw_run(ImageDraw.Draw(im), h, h * 0.6, parts, style)
    S._draw_run(ImageDraw.Draw(mask), h, h * 0.6, parts, dict(style, color=255, ghost=None))
    bbox = mask.getbbox()
    if bbox is None:
        return render(seed + 10_000_000)
    x0, y0, x1, y1 = bbox
    th = y1 - y0
    # detector boxes are a little loose and not centred
    pad = [rng.uniform(0.0, 0.35) * th for _ in range(4)]
    im = im.crop((int(x0 - pad[0]), int(y0 - pad[1]), int(x1 + pad[2]), int(y1 + pad[3])))
    if rng.random() < 0.4:
        im = im.rotate(rng.uniform(-3, 3), Image.Resampling.BICUBIC, expand=False, fillcolor=bg)
    arr = np.asarray(im).astype(np.float32) * rng.uniform(0.6, 1.3) + rng.uniform(-30, 30)
    if rng.random() < 0.3:  # uneven backlight / glare
        arr += np.linspace(0, rng.uniform(-60, 60), arr.shape[1])[None, :, None]
    arr += np.random.default_rng(seed).normal(0, rng.uniform(1, 10), arr.shape)
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    if rng.random() < 0.3:  # backlit segments bloom in a photo: soft glow around the strokes
        glow = im.filter(ImageFilter.GaussianBlur(rng.uniform(1.5, 4.0)))
        im = Image.blend(im, Image.fromarray(np.maximum(np.asarray(im), np.asarray(glow))), rng.uniform(0.4, 0.9))
    # small text in a phone photo: lose resolution, then blur and compress
    scale = rng.uniform(12, 40) / max(im.height, 1)
    if scale < 1:
        small = im.resize((max(4, int(im.width * scale)), max(4, int(im.height * scale))), Image.Resampling.BILINEAR)
        im = small.resize(im.size, Image.Resampling.BILINEAR)
    if rng.random() < 0.6:
        im = im.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.6)))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=rng.randint(40, 95))
    gray = Image.open(buf).convert("L")
    return (preprocess(gray)[0] * 127.5 + 127.5).astype(np.uint8), text


def _render_chunk(seeds: list[int]):
    return [render(s) for s in seeds]


def dataset(n: int, offset: int, workers: int):
    seeds = list(range(offset, offset + n))
    chunks = [seeds[i : i + 500] for i in range(0, n, 500)]
    X = np.empty((n, HEIGHT, WIDTH), np.uint8)
    texts: list[str] = []
    with ProcessPoolExecutor(workers) as pool:
        for chunk in pool.map(_render_chunk, chunks):
            for img, t in chunk:
                X[len(texts)] = img
                texts.append(t)
    return X, texts


def encode(text: str) -> list[int]:
    return [CHARSET.index(c) + 1 for c in text if c in CHARSET]


# ------------------------------------------------------------------- model

def build_model():
    import torch.nn as nn

    def block(i, o, pool):
        return [nn.Conv2d(i, o, 3, padding=1, bias=False), nn.BatchNorm2d(o), nn.ReLU(inplace=True)] + (
            [nn.MaxPool2d(pool)] if pool else [])

    class CRNN(nn.Module):
        def __init__(self, classes: int):
            super().__init__()
            self.cnn = nn.Sequential(
                *block(1, 32, 2),             # 16 x 128
                *block(32, 64, 2),            # 8 x 64
                *block(64, 128, None),
                *block(128, 128, (2, 1)),     # 4 x 64
                *block(128, 192, (2, 1)),     # 2 x 64
                nn.Conv2d(192, 256, (2, 1)), nn.BatchNorm2d(256), nn.ReLU(inplace=True),  # 1 x 64
            )
            self.rnn = nn.LSTM(256, 128, bidirectional=True, batch_first=True)
            self.fc = nn.Linear(256, classes)

        def forward(self, x):
            f = self.cnn(x).squeeze(2).permute(0, 2, 1)  # B x T x C
            f, _ = self.rnn(f)
            return self.fc(f)

    return CRNN(len(CHARSET) + 1)


def accuracy(model, X, texts, batch=256) -> float:
    import torch

    model.eval()
    hits = 0
    with torch.no_grad():
        for i in range(0, len(X), batch):
            xb = torch.from_numpy(X[i : i + batch].astype(np.float32) / 127.5 - 1)[:, None]
            for (pred, _), t in zip(decode(model(xb).numpy()), texts[i : i + batch]):
                hits += pred.replace(" ", "") == t.replace(" ", "")
    model.train()
    return hits / max(len(X), 1)


OUT = ODOMETER_READER  # --out writes a candidate model elsewhere for side-by-side evaluation


def export(model) -> None:
    import torch

    model.eval()
    torch.onnx.export(model, torch.zeros(1, 1, HEIGHT, WIDTH), str(OUT),
                      input_names=["image"], output_names=["logits"],
                      dynamic_axes={"image": {0: "batch"}, "logits": {0: "batch"}}, opset_version=17,
                      dynamo=False)
    model.train()


def main() -> None:
    import torch

    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=60000)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--resume", action="store_true", help="continue from reader_checkpoint.pt")
    ap.add_argument("--finetune", action="store_true", help="new run starting from the checkpoint's weights")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--out", type=Path, default=None, help="export here instead of the live reader")
    args = ap.parse_args()
    global OUT
    if args.out:
        OUT = args.out
    torch.set_num_threads(args.threads)
    torch.manual_seed(0)

    t0 = time.time()
    X, texts = dataset(args.samples, 0, args.workers)
    Xv, tv = dataset(2000, 50_000_000, args.workers)
    print(f"rendered {len(X)} train / {len(Xv)} val rows in {time.time() - t0:.0f}s", flush=True)

    model = build_model()
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = args.epochs * (len(X) // 64)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps, pct_start=0.1)
    ctc = torch.nn.CTCLoss(blank=BLANK, zero_infinity=True)
    labels = [encode(t) for t in texts]
    ckpt = ODOMETER_MODELS / "reader_checkpoint.pt"
    save_ckpt = ckpt if not args.out else args.out.with_suffix(".pt")
    first, best = 0, -1.0
    if args.finetune and ckpt.exists():  # start from trained weights on new data, fresh schedule
        model.load_state_dict(torch.load(ckpt, weights_only=False)["model"])
        print("fine-tuning from", ckpt.name, flush=True)
    elif args.resume and ckpt.exists():
        state = torch.load(ckpt, weights_only=False)
        model.load_state_dict(state["model"])
        opt.load_state_dict(state["opt"])
        sched.load_state_dict(state["sched"])
        first, best = state["epoch"], state["best"]
        print(f"resumed after epoch {first} (val {best:.3f})", flush=True)
    step = 0
    for epoch in range(first, args.epochs):
        order = np.random.default_rng(epoch).permutation(len(X))
        t1, total = time.time(), 0.0
        for b in range(len(X) // 64):
            idx = order[b * 64 : (b + 1) * 64]
            xb = torch.from_numpy(X[idx].astype(np.float32) / 127.5 - 1)[:, None]
            tgt = [labels[i] for i in idx]
            logp = model(xb).log_softmax(-1).permute(1, 0, 2)  # T x B x C
            loss = ctc(logp, torch.tensor([c for t in tgt for c in t]),
                       torch.full((len(idx),), logp.shape[0], dtype=torch.long),
                       torch.tensor([len(t) for t in tgt]))
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            opt.step()
            sched.step()
            step += 1
            total += loss.item()
        val = accuracy(model, Xv, tv)
        print(f"epoch {epoch + 1}/{args.epochs}  loss {total / (len(X) // 64):.3f}  "
              f"val exact {val:.3f}  {time.time() - t1:.0f}s", flush=True)
        # Save every epoch so an interrupted run loses at most one epoch.
        ODOMETER_MODELS.mkdir(parents=True, exist_ok=True)
        if val > best:
            best = val
            export(model)
        torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "sched": sched.state_dict(),
                    "epoch": epoch + 1, "best": best}, save_ckpt)

    metrics = {"train_rows": len(X), "val_rows": len(Xv), "epochs": args.epochs,
               "val_exact_match": round(best, 4)}
    real = ODOMETER_DATA / "reader_real" / "labels.csv"
    if real.exists():
        with real.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        Xr = np.stack([(preprocess(Image.open(real.parent / r["file"]).convert("L"))[0] * 127.5 + 127.5)
                       .astype(np.uint8) for r in rows])
        metrics["real_exact_match"] = round(accuracy(model, Xr, [r["text"] for r in rows]), 4)
        metrics["real_rows"] = len(rows)
    print(json.dumps(metrics, indent=2))

    (OUT.with_suffix(".metrics.json") if args.out else ODOMETER_MODELS / "reader_metrics.json").write_text(
        json.dumps(metrics, indent=2))
    print("saved", OUT)


if __name__ == "__main__":
    main()
