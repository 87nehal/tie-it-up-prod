"""Damage inspection service backed by the pinned vehicle_damage segmentation model."""

from app.damage.service import damage_health, get_predictor, warm_up

__all__ = ["damage_health", "get_predictor", "warm_up"]
