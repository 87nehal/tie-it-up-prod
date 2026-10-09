"""Gate OCR field extraction, using real RapidOCR output from a three-photo capture."""

from app.fleet.extract import extract_fields, find_odometer
from app.routers.fleet import _merge


def _lines(*pairs):
    return [{"text": t, "confidence": c} for t, c in pairs]


CLUSTER = _lines(
    ("120 160", 0.742), ("60", 0.663), ("180", 0.704), ("15.010", 0.653), ("140", 0.53),
    ("60", 0.665), ("40", 0.665), ("180", 0.678), ("200", 0.726), ("20", 0.578),
    ("kriin", 0.625), ("220", 0.71), ("220", 0.633), ("1099", 0.572),
)
VIN_STICKER = _lines(("7J3ZZ56T7834500003", 0.871))
PLATE = _lines(("UP16C0059TC/20", 0.846))


def _capture(*photos):
    fields = {"vin": None, "plate": None, "odometer": None}
    for i, lines in enumerate(photos):
        found = extract_fields(lines)
        for key in fields:
            fields[key] = _merge(fields[key], found[key], i)
    return fields


def test_capture_picks_each_field_from_the_right_photo():
    fields = _capture(CLUSTER, VIN_STICKER, PLATE)
    assert fields["plate"]["value"] == "UP16C0059"
    assert fields["plate"]["image"] == 2
    assert fields["vin"]["value"] == "7J3ZZ56T783450000"
    assert fields["vin"]["read_length"] == 18


def test_vin_text_is_not_read_as_a_plate():
    assert extract_fields(VIN_STICKER)["plate"] is None


def test_dial_numbers_are_not_read_as_a_plate():
    assert extract_fields(CLUSTER)["plate"] is None


# The hand-written rules, still used when no trained odometer model is installed.

def test_rules_ignore_dial_scale_and_read_dotted_thousands():
    assert find_odometer(CLUSTER, set())["value"] == 15010


def test_rules_do_not_take_digits_from_a_decimal():
    odo = find_odometer(_lines(("TRIP 108.8", 0.9), ("ODO 45678 km", 0.8)), set())
    assert odo["value"] == 45678


def test_valid_plates_still_read():
    assert extract_fields(_lines(("22BH1234AA", 0.8)))["plate"]["value"] == "22BH1234AA"
    assert extract_fields(_lines(("MH12AB1234", 0.8)))["plate"]["value"] == "MH12AB1234"
