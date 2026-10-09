"""Merged car health backend: OBD-II telemetry diagnosis + DINOv2 damage segmentation."""

from __future__ import annotations

import sys
from pathlib import Path

# The vendored vehicle_damage package ships as a source tree, not an installed wheel.
_SRC = Path(__file__).resolve().parents[1] / "src"
if _SRC.is_dir() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))
