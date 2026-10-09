"""Odometer reader: a learned ranker over the numbers OCR finds on an instrument cluster.

RapidOCR reads the digits well; what it can't tell is *which* number is the odometer -
a cluster also shows dial scale markings, trip meters, clock, range, temperature and
fuel economy. Every number OCR returns becomes a candidate described by its digits,
its words and neighbours, its size relative to the other numbers and the pixels around
it (an LCD panel looks different from a dial face). A gradient-boosted classifier
trained by `scripts/train_odometer.py` scores each candidate; the highest wins.
"""

from __future__ import annotations

import math
import re
import threading
from statistics import median
from typing import Any

import numpy as np

from app.paths import ODOMETER_MODEL

# A whole number with optional "15,010" / "15.010" grouping; never a slice of a decimal.
NUM = re.compile(r"(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d+)(?![\d]|[.,]\d)")
_NUM_FIX = str.maketrans({"O": "0", "o": "0", "D": "0", "l": "1", "I": "1", "S": "5", "B": "8"})

_KM = re.compile(r"\bkm\b|\bkms\b|km$|^km", re.I)
_ODO = re.compile(r"\b(odo|total|0d0|od0|0do)\b|^odo|odo$", re.I)
_TRIP = re.compile(r"\b(trip|tr1p|[ab])\b|^trip|trip$", re.I)
_RANGE = re.compile(r"\b(dte|range|rng)\b", re.I)
_RATE = re.compile(r"km\s*/\s*[lh]|kmpl|l\s*/\s*100|/h\b|kmh|km/", re.I)
_RPM = re.compile(r"rpm|r/min|x\s*1000|1000r", re.I)
_TEMP = re.compile(r"°|\bc\b|℃|\d\s*c$", re.I)
_CLOCK = re.compile(r"\d\s*:\s*\d|\b(am|pm)\b", re.I)

FEATURES = [
    "n_digits", "log_value", "has_sep", "merged", "leading_zero", "dial_like", "img_dial_like",
    "img_cands", "in_scale", "same_value", "rel_h", "h_vs_median", "h_rank",
    "w_vs_h", "cx", "cy", "dist_center", "tok_frac", "line_numbers", "line_alpha",
    "line_km", "line_odo", "line_trip", "line_range", "line_rate", "line_rpm",
    "line_temp", "line_clock", "line_decimal", "nb_km", "nb_odo", "nb_trip",
    "nb_range", "nb_rate", "nb_clock", "conf", "by_ocr", "by_reader", "reader_conf", "crop_v", "crop_std", "crop_s",
    "ring_v", "ring_std", "ring_s", "ring_amber", "ring_green", "contrast",
]


def _is_dial(n: int) -> bool:
    return n <= 300 and n % 10 == 0


def _hsv_stats(patch: np.ndarray) -> tuple[float, float, float, float, float]:
    """Mean value, value std, mean saturation, amber and green-LCD pixel fractions."""
    if patch.size == 0:
        return 0.0, 0.0, 0.0, 0.0, 0.0
    p = patch.reshape(-1, 3).astype(np.float32) / 255.0
    mx, mn = p.max(1), p.min(1)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    r, g, b = p[:, 0], p[:, 1], p[:, 2]
    amber = (r > 0.45) & (r > g) & (g > b + 0.08) & (sat > 0.35)
    green = (g > 0.45) & (g >= r - 0.05) & (g > b + 0.08) & (sat > 0.2)
    return float(mx.mean()), float(mx.std()), float(sat.mean()), float(amber.mean()), float(green.mean())


def _appearance(rgb: np.ndarray | None, box: tuple[float, float, float, float]) -> list[float]:
    if rgb is None:
        return [0.0] * 9
    H, W = rgb.shape[:2]
    x0, y0, x1, y1 = box
    h = max(y1 - y0, 4)
    cx0, cy0, cx1, cy1 = (int(max(0, v)) for v in (x0, y0, min(W, x1), min(H, y1)))
    crop = rgb[cy0:cy1, cx0:cx1]
    # The ring around the box: what the digits sit on (LCD panel, dial face, bezel).
    rx0, ry0 = int(max(0, x0 - h)), int(max(0, y0 - h))
    rx1, ry1 = int(min(W, x1 + h)), int(min(H, y1 + h))
    outer = rgb[ry0:ry1, rx0:rx1].astype(np.float32)
    mask = np.ones(outer.shape[:2], bool)
    mask[cy0 - ry0 : cy1 - ry0, cx0 - rx0 : cx1 - rx0] = False
    ring = outer[mask].astype(np.uint8)
    cv, cstd, cs, _, _ = _hsv_stats(crop)
    rv, rstd, rs, ramber, rgreen = _hsv_stats(ring)
    return [cv, cstd, cs, rv, rstd, rs, ramber, rgreen, abs(cv - rv)]


def _numbers(text: str) -> list[dict[str, Any]]:
    """Whole numbers in one line of text, with their character span."""
    fixed = " ".join(
        tok.translate(_NUM_FIX) if sum(ch.isdigit() for ch in tok) * 2 > len(tok) else tok
        for tok in text.split()
    )
    nums = list(NUM.finditer(fixed))
    spans = [(i, i) for i in range(len(nums))]
    # Seven-segment readouts leave a gap beside a "1", so OCR splits "11623" into
    # "1 1623": also offer runs of groups one space apart as a single number.
    for i in range(len(nums)):
        for j in range(i + 1, min(i + 3, len(nums))):
            if fixed[nums[j - 1].end() : nums[j].start()] != " ":
                break
            spans.append((i, j))
    out = []
    # Seven-segment LCDs: segment gaps read as "." / ":" / "-" inside one readout
    # ("09.1308" for 091308). If the line is essentially one run of digits, offer the
    # digits joined as a candidate as well.
    core = re.sub(r"[\s.,:\-'`]", "", fixed)
    if core.isdigit() and 5 <= len(core) <= 8 and re.search(r"\d[.,:\-'`]\d", fixed) and not any(
            len(m.group(1).replace(",", "").replace(".", "")) == len(core) for m in nums):
        out.append({"digits": core, "token": fixed.strip(), "start": 0.0, "end": 1.0, "n_line": 1,
                    "merged": max(len(nums) - 1, 1), "has_sep": False, "lcd_join": True})
    for i, j in spans:
        group = [nums[k].group(1) for k in range(i, j + 1)]
        digits = "".join(g.replace(",", "").replace(".", "") for g in group)
        if len(digits) > 8 or len(digits.lstrip("0")) > 7:  # leading zeros: "00021877"
            continue
        start, end = nums[i].start(), nums[j].end()
        groups = [int(g.replace(",", "").replace(".", "")) for g in group]
        out.append({"digits": digits, "token": fixed[start:end], "start": start / max(len(fixed), 1),
                    "dial_merge": j > i and all(_is_dial(g) for g in groups),
                    "end": end / max(len(fixed), 1), "n_line": len(nums), "merged": j - i,
                    "has_sep": any(len(g) != len(g.replace(",", "").replace(".", "")) for g in group)})
    return out


def candidates(lines: list[dict[str, Any]], rgb: np.ndarray | None = None,
               exclude: set[str] = frozenset(),
               reads: list[tuple[str, float]] | None = None) -> list[dict[str, Any]]:
    """Every whole number read on the cluster, with the feature vector the ranker scores.

    `reads` are the cluster reader's re-reads of the same boxes (cluster_reader.py); a
    number either engine found is a candidate, and agreement between them is a feature.
    """
    if rgb is not None:
        H, W = rgb.shape[:2]
    else:
        H = max((ln.get("y0", 0) + ln.get("h", 0) for ln in lines), default=1) or 1
        W = max((ln.get("x1", ln.get("x", 0)) for ln in lines), default=1) or 1

    raw = []
    for li, ln in enumerate(lines):
        text = ln["text"]
        reread, reread_conf = reads[li] if reads else ("", 0.0)
        compact = re.sub(r"[^A-Z0-9]", "", f"{text} {reread}".upper())
        if any(ex and ex in compact for ex in exclude):
            continue  # the VIN / plate line
        x0 = ln.get("x", 0.0)
        x1 = ln.get("x1", x0 + len(text) * ln.get("h", 10) * 0.55)
        h = ln.get("h", 10.0)
        y0 = ln.get("y0", ln.get("cy", 0.0) - h / 2)
        found: dict[str, dict[str, Any]] = {}
        for engine, t in (("ocr", text), ("reader", reread)):
            for n in _numbers(t) if t else []:
                if n["digits"] in found:
                    found[n["digits"]]["engines"].add(engine)
                    continue
                found[n["digits"]] = dict(n, engines={engine})
        for n in found.values():
            box = (x0 + n["start"] * (x1 - x0), y0, x0 + n["end"] * (x1 - x0), y0 + h)
            raw.append(dict(n, line=li, box=box, text=text, reread=reread, conf=ln["confidence"],
                            reader_conf=reread_conf))
    if not raw:
        return []

    values = [int(c["digits"]) for c in raw]
    heights = [c["box"][3] - c["box"][1] for c in raw]
    med_h = median(heights) or 1
    order = sorted(range(len(raw)), key=lambda i: heights[i])
    rank = {i: r / max(len(raw) - 1, 1) for r, i in enumerate(order)}
    img_dial = sum(_is_dial(v) for v in values)

    line_flags = []
    for li, ln in enumerate(lines):
        t = f"{ln['text']} {reads[li][0]}" if reads else ln["text"]
        line_flags.append({
            "km": bool(_KM.search(t)) and not _RATE.search(t), "odo": bool(_ODO.search(t)),
            "trip": bool(_TRIP.search(t)), "range": bool(_RANGE.search(t)),
            "rate": bool(_RATE.search(t)), "clock": bool(_CLOCK.search(t)),
        })

    out = []
    for i, c in enumerate(raw):
        v = values[i]
        ln = lines[c["line"]]
        x0, y0, x1, y1 = c["box"]
        h = y1 - y0
        cx, cy = (x0 + x1) / 2 / W, (y0 + y1) / 2 / H
        text = c["text"]
        flags = line_flags[c["line"]]
        nb = {k: 0.0 for k in ("km", "odo", "trip", "range", "rate", "clock")}
        lcx, lcy = (ln.get("x", 0) + ln.get("x1", ln.get("x", 0))) / 2, ln.get("cy", 0)
        for lj, other in enumerate(lines):
            if lj == c["line"]:
                continue
            ocx = (other.get("x", 0) + other.get("x1", other.get("x", 0))) / 2
            if abs(other.get("cy", 0) - lcy) <= 2.5 * h and abs(ocx - lcx) <= 8 * h:
                for k in nb:
                    nb[k] = max(nb[k], float(line_flags[lj][k]))
        letters = sum(ch.isalpha() for ch in text)
        feats = {
            "n_digits": len(c["digits"]),
            "log_value": math.log10(v + 1),
            "has_sep": float(c["has_sep"]),
            "merged": c["merged"],
            "leading_zero": float(len(c["digits"]) > 1 and c["digits"][0] == "0"),
            "dial_like": float(_is_dial(v)),
            "img_dial_like": img_dial,
            "img_cands": len(raw),
            "in_scale": sum(1 for j, w in enumerate(values)
                            if j != i and _is_dial(v) and _is_dial(w) and abs(v - w) in (10, 20, 30, 40)),
            "same_value": sum(1 for j, w in enumerate(values) if j != i and w == v),
            "rel_h": h / H,
            "h_vs_median": h / med_h,
            "h_rank": rank[i],
            "w_vs_h": (x1 - x0) / max(h, 1),
            "cx": cx, "cy": cy,
            "dist_center": math.hypot(cx - 0.5, cy - 0.5),
            "tok_frac": len(c["token"].replace(" ", "")) / max(len(text.replace(" ", "")), 1),
            "line_numbers": c["n_line"],
            "line_alpha": letters / max(len(text), 1),
            "line_km": float(flags["km"]), "line_odo": float(flags["odo"]),
            "line_trip": float(flags["trip"]), "line_range": float(flags["range"]),
            "line_rate": float(flags["rate"]), "line_rpm": float(bool(_RPM.search(text))),
            "line_temp": float(bool(_TEMP.search(text))), "line_clock": float(flags["clock"]),
            "line_decimal": float(bool(re.search(r"\d[.,]\d(?!\d\d)", text))),
            "nb_km": nb["km"], "nb_odo": nb["odo"], "nb_trip": nb["trip"],
            "nb_range": nb["range"], "nb_rate": nb["rate"], "nb_clock": nb["clock"],
            "conf": c["conf"],
            "by_ocr": float("ocr" in c["engines"]),
            "by_reader": float("reader" in c["engines"]),
            "reader_conf": c["reader_conf"],
        }
        app = _appearance(rgb, c["box"])
        feats.update(dict(zip(("crop_v", "crop_std", "crop_s", "ring_v", "ring_std", "ring_s",
                               "ring_amber", "ring_green", "contrast"), app)))
        out.append({"value": v, "digits": c["digits"], "line": c["line"], "engines": c["engines"],
                    "dial_merge": bool(c.get("dial_merge")),
                    "reader_conf": c["reader_conf"],
                    "confidence": c["conf"] if "ocr" in c["engines"] else c["reader_conf"],
                    "text": text if "ocr" in c["engines"] else c["reread"],
                    "features": [feats[k] for k in FEATURES]})
    return out


def plausible(c: dict[str, Any]) -> bool:
    """Shown with at least 3 digits (zero padding counts) and at most 7 significant."""
    return len(c["digits"]) >= 3 and len(c["digits"].lstrip("0")) <= 7


_LCD = [FEATURES.index(k) for k in ("ring_green", "ring_amber", "ring_v", "contrast")]


def _on_lcd(c: dict[str, Any]) -> bool:
    """Digits on a backlit display: green/amber glow, or bright digits on a dark panel
    (teal, blue and white LCDs carry no green/amber signal, only the contrast)."""
    green, amber, ring_v, contrast = (c["features"][i] for i in _LCD)
    return green > 0.02 or amber > 0.02 or (ring_v < 0.4 and contrast > 0.15)


def _significant(c: dict[str, Any]) -> int:
    return len(c["digits"].lstrip("0"))


def prior(cands: list[dict[str, Any]], probs: np.ndarray) -> np.ndarray:
    """Workshop rule of thumb on top of the ranker: the odometer is the longest number on
    the cluster. Dial labels, speed, clock, temperature and trip meters are short; a car
    that has left the showroom shows 4+ significant digits. The longest non-dial reading
    gets a boost; readings of 3 or fewer digits are damped when a longer one exists."""
    if not cands:
        return probs
    # display width ("091308" is 6); dial labels OCR glued together ("120 160") don't count
    shown = np.array([0 if c.get("dial_merge") else len(c["digits"]) for c in cands])
    sig = np.array([_significant(c) for c in cands])
    longest = shown.max()
    out = probs.copy()
    if longest >= 4:
        out[shown == longest] += 0.25
        out[sig <= 3] *= 0.5
    return np.clip(out, 0, 1)


def pick(cands: list[dict[str, Any]], probs: np.ndarray) -> tuple[dict[str, Any], float]:
    """The ranker chooses the box; the reading of that box is chosen separately.

    On synthetic training data the cluster reader is nearly always right, so the ranker
    learns to favour its reads - but on a real panel it can be the weaker engine. When
    the two engines read the chosen box differently, take the one they agree on, else
    the more confident one, instead of whichever the ranker scored a hair higher.
    """
    best = int(np.argmax(probs))
    line, p = cands[best]["line"], float(probs[best])
    rivals = [i for i, c in enumerate(cands) if c["line"] == line and probs[i] >= 0.5 * p]

    def trust(i: int) -> tuple[int, float]:
        c = cands[i]
        return len(c["engines"]), c["confidence"]

    return cands[max(rivals, key=trust)], p


# ------------------------------------------------------------------- voting

def _box_reads(rgb: np.ndarray, line: dict[str, Any]) -> dict[str, float]:
    """Re-read one box several ways (looser crops, 2-3x enlarged, both engines) and
    count the 4+ digit readings. A true read is stable across views; a misread
    seven-segment glyph (0/8, 9/8, 1/7) usually is not."""
    from PIL import Image

    from app.fleet import cluster_reader
    from app.fleet.ocr import get_engine

    H, W = rgb.shape[:2]
    h = line.get("h", 10.0)
    sess = cluster_reader.load()
    votes: dict[str, float] = {}
    for pad in (0.15, 0.4, 0.8):
        box = (int(max(0, line["x"] - pad * h)), int(max(0, line["y0"] - pad * h)),
               int(min(W, line["x1"] + pad * h)), int(min(H, line["y0"] + h + pad * h)))
        if box[2] - box[0] < 4 or box[3] - box[1] < 4:
            continue
        crop = Image.fromarray(rgb[box[1]:box[3], box[0]:box[2]])
        for scale in (1, 2, 3):
            im = crop.resize((crop.width * scale, crop.height * scale), Image.Resampling.LANCZOS)
            texts = [(str(t), float(c)) for _, t, c in (get_engine()(np.asarray(im)[:, :, ::-1])[0] or [])]
            if sess is not None:
                (logits,) = sess.run(None, {"image": np.stack([cluster_reader.preprocess(im.convert("L"))])})
                texts += cluster_reader.decode(logits)
            for t, c in texts:
                for n in {n["digits"] for n in _numbers(t) if len(n["digits"]) >= 4}:
                    votes[n] = votes.get(n, 0.0) + 1.0 + 0.1 * c  # count first, confidence breaks ties
    return votes


def vote(cands: list[dict[str, Any]], probs: np.ndarray, lines: list[dict[str, Any]],
         rgb: np.ndarray | None, chosen: dict[str, Any]) -> tuple[dict[str, Any], float | None]:
    """When the engines read the chosen box differently, let repeated reads decide."""
    rivals = [c for c, p in zip(cands, probs) if c["line"] == chosen["line"] and len(c["digits"]) >= 4]
    if rgb is None or len({c["digits"] for c in rivals}) < 2:
        return chosen, None
    votes = _box_reads(rgb, lines[chosen["line"]])
    total = sum(votes.get(c["digits"], 0.0) for c in rivals)
    if not total:
        return chosen, None
    best = max(rivals, key=lambda c: (votes.get(c["digits"], 0.0), c is chosen))
    return best, votes.get(best["digits"], 0.0) / total


# ------------------------------------------------------------------ inference

def reread(lines: list[dict[str, Any]], rgb: np.ndarray | None) -> list[tuple[str, float]] | None:
    """The cluster reader's take on every OCR box, when the reader model is installed."""
    from app.fleet import cluster_reader

    return cluster_reader.read_lines(rgb, lines) if rgb is not None else None


_model: Any = None
_model_lock = threading.Lock()


def load_model() -> Any:
    """The trained ranker, or None when it hasn't been trained (heuristic fallback)."""
    global _model
    with _model_lock:
        if _model is None and ODOMETER_MODEL.exists():
            import joblib

            bundle = joblib.load(ODOMETER_MODEL)
            if bundle.get("features") == FEATURES:
                _model = bundle
        return _model


def warm_up() -> None:
    """Load both models up front: unpickling the ranker imports scikit-learn, and doing
    that lazily from two request threads at once can deadlock the import system."""
    from app.fleet import cluster_reader

    load_model()
    cluster_reader.load()


def read(lines: list[dict[str, Any]], rgb: np.ndarray | None,
         exclude: set[str] = frozenset()) -> dict[str, Any] | None:
    bundle = load_model()
    if bundle is None:
        return None
    reads = reread(lines, rgb) if bundle.get("uses_reader") else None
    cands = [c for c in candidates(lines, rgb, exclude, reads) if plausible(c)]
    if not cands:
        return None
    probs = bundle["model"].predict_proba(np.array([c["features"] for c in cands]))[:, 1]
    probs = prior(cands, probs)
    c, p = pick(cands, probs)
    c, agreement = vote(cands, probs, lines, rgb, c)
    # How sure we are this is the right number *and* that it was read right: the
    # engine's own confidence, or, after a vote, the share of re-reads that agreed.
    read_conf = c["confidence"] if agreement is None else max(c["confidence"], agreement)
    return {
        "value": c["value"],
        "confidence": round(min(1.0, p) * read_conf, 3),
        "votes": None if agreement is None else round(agreement, 2),
        "score": round(p, 3),
        "model_probability": round(p, 3),
        "source_text": c["text"],
        "engine": "odometer-ranker",
    }
