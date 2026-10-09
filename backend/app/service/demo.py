"""Demo gate photos: rendered plate, VIN-sticker and odometer images for a vehicle.

They are ordinary JPEGs pushed through the real OCR and validation, so a demo shows
the actual pipeline without needing a car in the room. The odometer is made
consistent with the vehicle's situation (open pickup trip, or driven in).
"""

from __future__ import annotations

import io
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app import vehicles
from app.eta import geo
from app.fleet import store as trips
from app.fleet.extract import format_plate
from app.service.catalog import DEALERSHIP

KINDS = ("plate", "vin", "odometer")
_FONTS = Path("C:/Windows/Fonts")


def _font(name: str, size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype(str(_FONTS / name), size)
    except OSError:
        return ImageFont.load_default(size)


def odometer_for(conn, vehicle: dict) -> int:
    trip = trips.open_trip(conn, vehicle["reg_no"])
    if trip:  # collected by a chauffeur: odometer grew by the drive to the workshop
        km = geo.road_km(vehicle["lat"], vehicle["lng"], DEALERSHIP["lat"], DEALERSHIP["lng"])
        return trip["checkout_odo"] + max(1, round(km))
    rng = random.Random(vehicle["id"])
    return vehicle["odometer"] + rng.randint(40, 260)


def render(conn, vehicle_id: int, kind: str) -> bytes:
    v = vehicles.get(conn, vehicle_id)
    if v is None:
        raise KeyError("vehicle not found")
    if kind == "plate":
        im = Image.new("RGB", (900, 560), (70, 78, 90))
        d = ImageDraw.Draw(im)
        d.rectangle((0, 380, 900, 560), fill=(40, 44, 52))
        d.rounded_rectangle((120, 220, 780, 360), 18, fill="white", outline="black", width=6)
        d.text((450, 290), format_plate(v["reg_no"]), font=_font("arialbd.ttf", 84), fill="black", anchor="mm")
    elif kind == "vin":
        im = Image.new("RGB", (900, 420), (232, 232, 224))
        d = ImageDraw.Draw(im)
        d.text((60, 50), "MARUTI SUZUKI INDIA LTD", font=_font("arialbd.ttf", 40), fill="black")
        d.text((60, 120), f"MODEL {v['model'].upper()}", font=_font("arialbd.ttf", 30), fill=(60, 60, 60))
        d.text((60, 220), f"VIN: {v['vin']}", font=_font("consola.ttf", 52), fill="black")
    elif kind == "odometer":
        im = Image.new("RGB", (900, 500), (10, 12, 16))
        d = ImageDraw.Draw(im)
        d.ellipse((150, 30, 750, 470), outline=(40, 60, 90), width=10)
        d.text((450, 250), f"ODO {odometer_for(conn, v)} km", font=_font("arialbd.ttf", 92),
               fill=(240, 240, 240), anchor="mm")
    else:
        raise KeyError(f"unknown photo kind {kind}")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return buf.getvalue()
