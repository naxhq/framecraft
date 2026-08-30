"""Printability validators (04 stage 4).  ``validate()`` is the gate."""
from __future__ import annotations

from app.validate.checks import (
    Check,
    ValidationReport,
    enforce_triangle_budget,
    section_polygons,
    validate,
)

__all__ = [
    "Check",
    "ValidationReport",
    "validate",
    "enforce_triangle_budget",
    "section_polygons",
]
