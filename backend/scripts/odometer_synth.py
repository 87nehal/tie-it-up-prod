"""Synthetic instrument-cluster photos with a known odometer reading.

Each scene mixes the things that make "which number is the odometer" hard: dial scale
markings, a tachometer, trip meters (with and without a decimal), clock, outside
temperature, range / DTE, fuel economy, a digital speed readout, on LCD, seven-segment
and TFT styles. Photos are then degraded (perspective, blur, glare, noise, JPEG) so the
real OCR engine sees something close to a phone picture of a dashboard.
"""

from __future__ import annotations

import io
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS_DIR = Path("C:/Windows/Fonts")
FONT_FILES = ["arial.ttf", "arialbd.ttf", "ARIALN.TTF", "ARIALNB.TTF", "bahnschrift.ttf",
              "calibri.ttf", "calibrib.ttf", "segoeui.ttf", "segoeuib.ttf", "tahoma.ttf",
              "verdana.ttf", "consola.ttf", "OCRAEXT.TTF", "impact.ttf", "trebuc.ttf"]
_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def _available_fonts() -> list[str]:
    return [f for f in FONT_FILES if (FONTS_DIR / f).exists()] or ["arial.ttf"]


FONTS = _available_fonts()


def font(name: str, size: int) -> ImageFont.ImageFont:
    key = (name, max(6, int(size)))
    if key not in _font_cache:
        try:
            _font_cache[key] = ImageFont.truetype(str(FONTS_DIR / name), key[1])
        except OSError:
            _font_cache[key] = ImageFont.load_default(key[1])
    return _font_cache[key]


# ------------------------------------------------------------- seven segment

_SEGS = {
    "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd",
    "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg", "-": "g", " ": "",
}


def _seg_polys(x: float, y: float, h: float, slant: float, thick: float = 0.13,
               gap: float = 0.0) -> dict[str, list[tuple[float, float]]]:
    w, t, g = 0.52 * h, thick * h, gap * h
    half = h / 2

    def P(px, py):  # slant leans the top of the digit to the right
        return (x + px + (h - py) * slant, y + py)

    def hseg(py):
        return [P(t * 0.6 + g, py), P(t + g, py - t / 2), P(w - t - g, py - t / 2), P(w - t * 0.6 - g, py),
                P(w - t - g, py + t / 2), P(t + g, py + t / 2)]

    def vseg(px, py0, py1):
        return [P(px, py0 + t * 0.6 + g), P(px + t / 2, py0 + t + g), P(px + t / 2, py1 - t - g),
                P(px, py1 - t * 0.6 - g), P(px - t / 2, py1 - t - g), P(px - t / 2, py0 + t + g)]

    return {"a": hseg(t / 2), "g": hseg(half), "d": hseg(h - t / 2),
            "f": vseg(t / 2, 0, half), "b": vseg(w - t / 2, 0, half),
            "e": vseg(t / 2, half, h), "c": vseg(w - t / 2, half, h)}


def seven_seg(d: ImageDraw.ImageDraw | None, x: float, y: float, text: str, h: float,
              color, ghost=None, slant: float = 0.08, thick: float = 0.13, gap: float = 0.0) -> float:
    """Draw digits as seven-segment glyphs; returns the x where the run ends."""
    adv = 0.68 * h
    for ch in text:
        if ch in ".,":
            if d:
                s = 0.12 * h
                d.rectangle((x - 0.1 * h, y + h - s, x - 0.1 * h + s, y + h), fill=color)
            x += 0.12 * h
            continue
        if ch == ":":
            if d:
                s = 0.11 * h
                for cy in (0.3 * h, 0.7 * h):
                    d.rectangle((x, y + cy - s / 2, x + s, y + cy + s / 2), fill=color)
            x += 0.3 * h
            continue
        segs = _SEGS.get(ch)
        if segs is None:  # letters: fall back to a plain font
            f = font("arialbd.ttf", h)
            if d:
                d.text((x, y), ch, font=f, fill=color)
            x += f.getlength(ch)
            continue
        if d:
            polys = _seg_polys(x, y, h, slant, thick, gap)
            for name, poly in polys.items():
                if name in segs:
                    d.polygon(poly, fill=color)
                elif ghost is not None:
                    d.polygon(poly, fill=ghost)
        x += adv
    return x


# --------------------------------------------------------------- text runs

def _run_width(parts, style) -> float:
    return _draw_run(None, 0, 0, parts, style)


def _draw_run(d, x, y, parts, style) -> float:
    """parts: [(text, role)] with role "num" (big digits) or "small" (label / unit)."""
    h = style["h"]
    for text, role in parts:
        if role == "num":
            if style["seg"]:
                x = seven_seg(d, x, y, text, h, style["color"], style.get("ghost"), style["slant"],
                              style.get("thick", 0.13), style.get("gap", 0.0))
            else:
                f = font(style["font"], h * 1.3)
                if d:
                    d.text((x, y - h * 0.22), text, font=f, fill=style["color"])
                x += f.getlength(text)
        else:
            f = font(style["small_font"], h * style["small"])
            if d:
                d.text((x, y + h - f.size * 0.95), text, font=f, fill=style["color"])
            x += f.getlength(text)
        x += h * 0.18
    return x


# ------------------------------------------------------------------ content

def odometer_parts(rng: random.Random, v: int) -> list[tuple[str, str]]:
    digits = str(v)
    style = rng.random()
    if style < 0.12:
        digits = digits.zfill(rng.choice([5, 6]))
    elif style < 0.22 and v >= 1000:
        digits = f"{v:,}"
    elif style < 0.30 and v >= 1000:
        digits = f"{v:,}".replace(",", ".")
    label = rng.choice(["ODO", "ODO", "ODO", "Odo", "TOTAL", "", "", ""])
    unit = rng.choice(["km", "km", "km", "KM", "kms", ""])
    parts = []
    if label:
        parts.append((label, "small"))
    parts.append((digits, "num"))
    if unit:
        parts.append((unit, "small"))
    return parts


def distractor(rng: random.Random, kind: str) -> list[tuple[str, str]]:
    if kind == "trip":
        t = rng.uniform(0, 999.9)
        num = f"{int(t)}" if rng.random() < 0.18 else f"{t:.1f}"
        label = rng.choice(["TRIP A", "TRIP B", "TRIP", "A", "B", "TRIP 1", ""])
        unit = rng.choice(["km", "", "km"])
        return [p for p in ((label, "small"), (num, "num"), (unit, "small")) if p[0]]
    if kind == "clock":
        hh, mm = rng.randint(1, 12), rng.randint(0, 59)
        parts = [(f"{hh}:{mm:02d}", "num")]
        if rng.random() < 0.4:
            parts.append((rng.choice(["AM", "PM"]), "small"))
        return parts
    if kind == "temp":
        return [(str(rng.randint(-5, 48)), "num"), (rng.choice(["°C", "°C", "C"]), "small")]
    if kind == "range":
        return [(rng.choice(["DTE", "RANGE", "Range", ""]), "small"),
                (str(rng.randint(20, 850)), "num"), ("km", "small")]
    if kind == "economy":
        return [(rng.choice(["AVG", "", "INST"]), "small"),
                (f"{rng.uniform(4, 30):.1f}", "num"), (rng.choice(["km/L", "km/l", "kmpl", "L/100km"]), "small")]
    if kind == "avgspeed":
        return [("AVG", "small"), (str(rng.randint(15, 95)), "num"), ("km/h", "small")]
    if kind == "service":
        return [(rng.choice(["SERVICE IN", "Service", "OIL"]), "small"),
                (str(rng.randint(100, 10000)), "num"), ("km", "small")]
    raise ValueError(kind)


DISTRACTORS = ["trip", "trip", "clock", "temp", "range", "economy", "avgspeed", "service"]


# -------------------------------------------------------------------- dials

def _pt(cx, cy, r, deg):
    return cx + r * math.cos(math.radians(deg)), cy - r * math.sin(math.radians(deg))


def draw_dial(d, rng, cx, cy, r, labels, face, ink, accent, start=225, end=-45, sub=None):
    if face is not None:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=face)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=rng.choice([ink, accent, (90, 95, 105)]),
              width=max(2, int(r * 0.03)))
    n = len(labels) - 1
    f = font(rng.choice(FONTS[:10]), r * rng.uniform(0.11, 0.17))
    minor = rng.choice([1, 2, 4])
    for i in range(n * minor + 1):
        a = start + (end - start) * i / (n * minor)
        major = i % minor == 0
        r0 = r * (0.84 if major else 0.9)
        d.line((_pt(cx, cy, r0, a), _pt(cx, cy, r * 0.97, a)),
               fill=accent if (i > n * minor * 0.8 and rng.random() < 0.5) else ink,
               width=max(1, int(r * (0.022 if major else 0.01))))
    for i, lab in enumerate(labels):
        a = start + (end - start) * i / n
        x, y = _pt(cx, cy, r * rng.uniform(0.68, 0.74), a)
        d.text((x, y), lab, font=f, fill=ink, anchor="mm")
    if sub:
        d.text((cx, cy - r * 0.35), sub, font=font(FONTS[0], r * 0.08), fill=ink, anchor="mm")
    a = start + (end - start) * rng.uniform(0, 0.6)
    d.line(((cx, cy), _pt(cx, cy, r * 0.8, a)), fill=(230, 40, 30), width=max(2, int(r * 0.03)))
    d.ellipse((cx - r * 0.08, cy - r * 0.08, cx + r * 0.08, cy + r * 0.08), fill=(25, 25, 28))


def speedo_labels(rng):
    top = rng.choice([140, 160, 180, 200, 220, 240, 260])
    step = rng.choice([20, 20, 20, 10]) if top <= 160 else rng.choice([20, 20, 40])
    return [str(v) for v in range(0, top + 1, step)]


# --------------------------------------------------------------------- LCD

LCD_STYLES = [
    # (background, ink, ghost) - ghost = faint unlit segments
    ((200, 135, 40), (35, 25, 10), (180, 120, 38)),       # amber backlit
    ((170, 190, 120), (25, 35, 20), (155, 175, 110)),     # green-grey LCD
    ((190, 205, 200), (20, 25, 30), (175, 190, 186)),     # pale LCD
    ((12, 16, 22), (235, 235, 235), (30, 34, 40)),        # TFT white
    ((10, 14, 30), (110, 190, 255), (20, 28, 50)),        # TFT blue
    ((14, 10, 8), (255, 140, 40), (35, 22, 12)),          # TFT amber
    ((8, 18, 10), (120, 240, 140), None),                 # green VFD
    ((10, 22, 24), (80, 235, 200), (22, 40, 40)),         # teal / cyan LCD (common on older clusters)
    ((6, 8, 10), (90, 255, 230), None),                   # bright cyan VFD
]


def draw_lcd(d, rng, box, rows):
    """A panel of text rows; returns nothing - rows are [(parts, height_frac)]."""
    x0, y0, x1, y1 = box
    bg, ink, ghost = rng.choice(LCD_STYLES)
    d.rounded_rectangle(box, radius=int((y1 - y0) * 0.08), fill=bg,
                        outline=rng.choice([(40, 40, 45), (90, 90, 95), bg]), width=2)
    seg = rng.random() < 0.6
    f, small_font = rng.choice(FONTS), rng.choice(FONTS[:10])
    slant = rng.choice([0.0, 0.06, 0.1])
    H = y1 - y0
    total = sum(fr for _, fr in rows)
    y = y0 + H * 0.08
    for parts, fr in rows:
        h = H * 0.84 * fr / total * 0.78
        style = {"h": h, "seg": seg and rng.random() < 0.9, "font": f, "small_font": small_font,
                 "small": rng.uniform(0.35, 0.55), "color": ink, "slant": slant,
                 "ghost": ghost if rng.random() < 0.5 else None}
        w = _run_width(parts, style)
        if w > (x1 - x0) * 0.9:  # shrink the row to fit the panel
            style["h"] = h = h * (x1 - x0) * 0.9 / w
            w = _run_width(parts, style)
        align = rng.choice(["c", "r", "l"])
        pad = (x1 - x0) * 0.06
        x = {"c": (x0 + x1 - w) / 2, "r": x1 - pad - w, "l": x0 + pad}[align]
        _draw_run(d, max(x0 + 2, x), y + (H * 0.84 * fr / total - h) / 2, parts, style)
        y += H * 0.84 * fr / total


def lcd_rows(rng, odo, max_rows):
    rows = [(odometer_parts(rng, odo), rng.uniform(1.2, 1.8))]
    for _ in range(rng.randint(0, max_rows - 1)):
        rows.append((distractor(rng, rng.choice(DISTRACTORS)), rng.uniform(0.6, 1.1)))
    rng.shuffle(rows)
    return rows


# ------------------------------------------------------------------- scenes

def _background(rng, W, H):
    base = np.array([rng.randint(8, 45)] * 3, np.float32) + np.array([rng.randint(-6, 6) for _ in range(3)])
    yy = np.linspace(0, 1, H)[:, None, None]
    img = base + (yy * rng.uniform(-25, 25))
    img = np.clip(img + np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, 3, (H, W, 3)), 0, 255)
    return Image.fromarray(np.broadcast_to(img, (H, W, 3)).astype(np.uint8))


def scene(rng: random.Random) -> tuple[Image.Image, int]:
    W, H = rng.randint(1100, 1600), rng.randint(520, 820)
    im = _background(rng, W, H)
    d = ImageDraw.Draw(im)
    odo = int(10 ** rng.uniform(1.6, 5.95))
    face = rng.choice([None, (15, 15, 18), (225, 225, 220), (30, 32, 38), (5, 5, 8)])
    ink = (20, 20, 20) if face == (225, 225, 220) else rng.choice([(235, 235, 235), (210, 220, 235), (240, 240, 230)])
    accent = rng.choice([(220, 40, 30), (240, 120, 20), (60, 160, 255)])
    layout = rng.choices(["analog2", "analog1", "tft", "lcd_full"], weights=[4, 3, 2, 1])[0]

    if layout in ("analog2", "analog1"):
        r = min(H * rng.uniform(0.36, 0.46), W * 0.22)
        if layout == "analog2":
            sx = W * rng.uniform(0.62, 0.7)
            tx = sx - r * rng.uniform(1.9, 2.2)
            draw_dial(d, rng, tx, H * 0.52, r * rng.uniform(0.8, 1.0),
                      [str(i) for i in range(rng.choice([7, 8, 9]))], face, ink, accent,
                      sub=rng.choice(["x1000r/min", "x1000 rpm", "r/min x1000", None]))
        else:
            sx = W * 0.5
            for side in (-1, 1):  # fuel and temperature
                gx = sx + side * r * rng.uniform(1.45, 1.7)
                gr = r * 0.45
                labels = ["E", "1/2", "F"] if side < 0 else ["C", "H"]
                draw_dial(d, rng, gx, H * 0.55, gr, labels, face, ink, accent, start=210, end=-30)
        draw_dial(d, rng, sx, H * 0.52, r, speedo_labels(rng), face, ink, accent,
                  sub=rng.choice(["km/h", "km/h", "kmh", None]))
        # LCD inside the speedo's lower half, or between the dials
        if layout == "analog2" and rng.random() < 0.4:
            bw, bh = r * rng.uniform(0.7, 1.0), r * rng.uniform(0.45, 0.75)
            bx, by = (sx + tx) / 2 - bw / 2, H * rng.uniform(0.45, 0.62)
        else:
            bw, bh = r * rng.uniform(0.72, 0.98), r * rng.uniform(0.36, 0.6)
            bx, by = sx - bw / 2, H * 0.52 + r * rng.uniform(0.18, 0.3)
        draw_lcd(d, rng, (bx, by, bx + bw, by + bh), lcd_rows(rng, odo, 3 if bh > r * 0.45 else 2))
        # extras outside the gauges: clock / temperature box, range strip
        for _ in range(rng.randint(0, 2)):
            kind = rng.choice(["clock", "temp", "range", "trip"])
            ew, eh = W * rng.uniform(0.1, 0.16), H * rng.uniform(0.07, 0.11)
            ex, ey = rng.choice([(W * 0.5 - ew / 2, H * 0.03), (W * 0.03, H * 0.85), (W * 0.82, H * 0.85)])
            draw_lcd(d, rng, (ex, ey, ex + ew, ey + eh), [(distractor(rng, kind), 1.0)])
    elif layout == "tft":
        d.rounded_rectangle((W * 0.05, H * 0.06, W * 0.95, H * 0.94), radius=40, fill=(6, 8, 12))
        ink = rng.choice([(235, 235, 235), (110, 200, 255), (255, 170, 60)])
        style = {"h": H * rng.uniform(0.2, 0.3), "seg": rng.random() < 0.3, "font": rng.choice(FONTS),
                 "small_font": FONTS[0], "small": 0.3, "color": ink, "slant": 0.05}
        speed = [(str(rng.randint(0, 185)), "num"), ("km/h", "small")]
        w = _run_width(speed, style)
        _draw_run(d, W / 2 - w / 2, H * 0.3, speed, style)
        slots = [(W * 0.08, H * 0.12), (W * 0.08, H * 0.7), (W * 0.64, H * 0.12), (W * 0.64, H * 0.7),
                 (W * 0.36, H * 0.74)]
        rng.shuffle(slots)
        items = [odometer_parts(rng, odo)] + [distractor(rng, rng.choice(DISTRACTORS))
                                              for _ in range(rng.randint(2, 4))]
        for parts, (x, y) in zip(items, slots):
            st = dict(style, h=H * rng.uniform(0.06, 0.1), seg=rng.random() < 0.25, small=0.6)
            _draw_run(d, x, y, parts, st)
        # bar-graph tach
        for i in range(rng.randint(12, 30)):
            bx = W * 0.12 + i * W * 0.025
            d.rectangle((bx, H * 0.08, bx + W * 0.015, H * 0.1), fill=accent if i % 5 else ink)
    else:  # full-width LCD, two-wheeler / older car style
        draw_lcd(d, rng, (W * 0.08, H * 0.12, W * 0.92, H * 0.88),
                 [([(str(rng.randint(0, 140)), "num"), ("km/h", "small")], 2.2)] + lcd_rows(rng, odo, 3))

    # warning tell-tales
    for _ in range(rng.randint(0, 6)):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        s = rng.uniform(8, 20)
        d.ellipse((x, y, x + s, y + s), fill=rng.choice([(230, 40, 30), (240, 180, 0), (40, 200, 60)]))
    return im, odo


# ---------------------------------------------------------------- degrading

def _perspective_coeffs(src, dst):
    A, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return np.linalg.solve(np.array(A, float), np.array(b, float)).tolist()


def degrade(rng: random.Random, im: Image.Image) -> bytes:
    W, H = im.size
    if rng.random() < 0.7:
        j = 0.07
        src = [(0, 0), (W, 0), (W, H), (0, H)]
        dst = [(x + rng.uniform(-j, j) * W, y + rng.uniform(-j, j) * H) for x, y in src]
        im = im.transform((W, H), Image.Transform.PERSPECTIVE, _perspective_coeffs(src, dst),
                          Image.Resampling.BICUBIC, fillcolor=(20, 20, 22))
    if rng.random() < 0.5:
        im = im.rotate(rng.uniform(-5, 5), Image.Resampling.BICUBIC, fillcolor=(20, 20, 22))
    if rng.random() < 0.5:  # tighter framing
        c = rng.uniform(0, 0.08)
        im = im.crop((W * c, H * c, W * (1 - c), H * (1 - c)))
    arr = np.asarray(im).astype(np.float32)
    arr = arr * rng.uniform(0.6, 1.25) + rng.uniform(-25, 25)
    if rng.random() < 0.4:  # glare blob
        h, w = arr.shape[:2]
        yy, xx = np.mgrid[0:h, 0:w]
        gx, gy, gr = rng.uniform(0, w), rng.uniform(0, h), rng.uniform(0.1, 0.4) * w
        arr += rng.uniform(40, 140) * np.exp(-((xx - gx) ** 2 + (yy - gy) ** 2) / (2 * gr**2))[..., None]
    arr += np.random.default_rng(rng.randint(0, 1 << 30)).normal(0, rng.uniform(1, 6), arr.shape)
    im = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    if rng.random() < 0.6:
        im = im.filter(ImageFilter.GaussianBlur(rng.uniform(0.2, 1.4)))
    scale = rng.uniform(0.75, 1.0)
    im = im.resize((int(im.width * scale), int(im.height * scale)), Image.Resampling.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=rng.randint(55, 92))
    return buf.getvalue()


def sample(seed: int) -> tuple[bytes, int]:
    rng = random.Random(seed)
    im, odo = scene(rng)
    return degrade(rng, im), odo


if __name__ == "__main__":  # write a few previews
    out = Path(__file__).resolve().parent / "_odo_preview"
    out.mkdir(exist_ok=True)
    for s in range(8):
        jpg, odo = sample(s)
        (out / f"{s}_{odo}.jpg").write_bytes(jpg)
    print("wrote", out)
