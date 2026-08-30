"""Shared pytest configuration.

The whole suite runs with ``FRAMECRAFT_OFFLINE=1``, which makes
``app.ingest.overpass`` raise :class:`~app.ingest.overpass.OverpassOffline` on
any attempted network call.  Tests therefore provably read the committed
Overpass fixtures and never touch the internet (03: "In tests and for the six
presets, read the fixture and never hit the network").
"""
from __future__ import annotations

import os

os.environ["FRAMECRAFT_OFFLINE"] = "1"

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _offline_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Re-assert the offline flag for every test, even if one changed it."""
    monkeypatch.setenv("FRAMECRAFT_OFFLINE", "1")
