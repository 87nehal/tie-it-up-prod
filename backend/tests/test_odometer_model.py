"""Odometer ranker + cluster reader: candidate generation and the trained models."""

import pytest

from app.fleet import cluster_reader, odometer
from app.fleet.ocr import decode, ocr
from app.paths import ODOMETER_DATA


def _line(text, y=0.0, h=20.0, conf=0.8):
    return {"text": text, "confidence": conf, "x": 0.0, "x1": 12.0 * len(text), "y0": y, "h": h, "cy": y + h / 2}


def _values(*texts):
    return {c["value"] for c in odometer.candidates([_line(t, 40.0 * i) for i, t in enumerate(texts)])}


def test_split_seven_segment_digits_are_joined():
    assert 11623 in _values("ODO 1 1623")


def test_zero_padded_reading_is_a_candidate():
    assert 21877 in _values("00021877")


def test_decimals_and_clock_are_not_whole_numbers():
    vals = _values("TRIP 108.8", "10:45")
    assert 108 not in vals and 8 not in vals


def test_reader_only_reading_becomes_a_candidate():
    # RapidOCR read a seven-segment "4" as "h"; the cluster reader got it right.
    cands = odometer.candidates([_line("ODO h6h52")], reads=[("ODO 46452", 0.9)])
    hit = [c for c in cands if c["value"] == 46452]
    assert hit and hit[0]["features"][odometer.FEATURES.index("by_reader")] == 1.0


def test_vin_and_plate_lines_are_excluded():
    assert odometer.candidates([_line("MA3BLESR1TM742412")], exclude={"MA3BLESR1TM742412"}) == []


needs_model = pytest.mark.skipif(odometer.load_model() is None, reason="odometer model not trained")


@needs_model
def test_model_reads_the_real_cluster_photo():
    # Maruti cluster: dial labels 20-220, LCD odometer 15.010 (dotted thousands).
    rgb, _ = decode((ODOMETER_DATA / "real" / "maruti_cluster_01.png").read_bytes())
    assert odometer.read(ocr(rgb), rgb)["value"] == 15010


@pytest.mark.skipif(cluster_reader.load() is None, reason="cluster reader not trained")
def test_reader_decodes_a_box():
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont

    im = Image.new("RGB", (320, 80), (12, 16, 22))
    ImageDraw.Draw(im).text((10, 10), "45678", font=ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 54),
                            fill=(235, 235, 235))
    (text, conf), = cluster_reader.read_lines(np.asarray(im), [{"x": 8, "x1": 200, "y0": 12, "h": 56}])
    assert text.replace(" ", "") == "45678" and conf > 0.5


def test_field_photos_read_correctly():
    """Real cluster photos: a seven-segment teal LCD the general OCR misreads (808160)
    and a Maruti LCD whose cluster-reader read is wrong (75070)."""
    import pytest

    from app.fleet import ocr, odometer
    from app.paths import ODOMETER_DATA

    for rel, want in (("field/jeep_lcd_091308.png", 91308), ("real/maruti_cluster_01.png", 15010)):
        path = ODOMETER_DATA / rel
        if not path.exists():
            pytest.skip(f"{rel} not present")
        lines, _, rgb = ocr.read_image(path.read_bytes())
        assert odometer.read(lines, rgb)["value"] == want, rel
