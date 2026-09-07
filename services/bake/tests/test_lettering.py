"""Phase V2-P5 (lettering, ornaments, advisor) tests.

Layout:

* ``test_font_*``      - the bundled OFL faces and the generated shared assets.
* ``test_glyph_*``     - outlines, counters as holes, unsupported characters.
* ``test_layout_*``    - the shared layout math: edges, aligns, auto-fit, refusal.
* ``test_ornament_*``  - north arrow, scale bar, keyhole, magnets, underside mark.
* ``test_repair_*``    - 04 stage 1 applied to text, in print millimetres.
* ``test_validator_*`` - the ``lettering`` and ``base_floor`` rows, both ways.
* ``test_parity_*``    - ``fixtures/lettering-expected.json``, the contract with
  ``apps/web/lib/transform.ts``.  Regenerate with
  ``FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_lettering.py``.

Everything runs offline; nothing here needs a scene.
"""
from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any, Dict, List

import pytest
import shapely
import trimesh
from manifold3d import Manifold, OpType
from shapely.geometry import Polygon

from app import bake as bake_pipeline
from app.contracts import PrintParams
from app.geom import extrude, lettering as L, thicken
from app.geom import tokens as TOK
from app.geom import transform as T
from app.validate import checks as validators

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = REPO_ROOT / "fixtures"
LETTERING_EXPECTED = FIXTURES / "lettering-expected.json"
SCHEMA = REPO_ROOT / "packages" / "contracts" / "schema" / "print_params.json"
WEB_FONT_DIR = REPO_ROOT / "apps" / "web" / "lib" / "fonts"
BAKE_FONT_DIR = Path(L.FONT_DIR)

FACES = tuple(L.FACE_FILES)


def params(**overrides: Any) -> PrintParams:
    return PrintParams(**overrides)


def ctx(**overrides: Any) -> TOK.TokenContext:
    base: Dict[str, Any] = {
        "lat": 41.8827,
        "lon": -87.6233,
        "scale_mm_per_m": 168.0 / 1800.0,  # Chicago at the defaults, 1:10,714
        "radius_m": 900.0,
        "date": "2026-08-30",
        "buildings": 994,
        "city": "Chicago",
    }
    base.update(overrides)
    return TOK.TokenContext(**base)


# --------------------------------------------------------------------------
# Fonts and the generated assets
# --------------------------------------------------------------------------


def test_font_files_and_licences_are_bundled() -> None:
    """Every face ships its own static TTF and its own licence, side by side."""
    for face in FACES:
        directory, filename = L.FACE_FILES[face]
        ttf = BAKE_FONT_DIR / directory / filename
        licence = BAKE_FONT_DIR / directory / "OFL.txt"
        assert ttf.is_file(), f"{face}: {ttf} is missing"
        assert licence.is_file(), f"{face}: no licence next to {filename}"
        text = licence.read_text(encoding="utf-8", errors="replace")
        assert "SIL OPEN FONT LICENSE" in text.upper()
        assert ttf.stat().st_size > 100_000


def _licence_key(text: str) -> str:
    """Lowercase, with every run of non-alphanumerics collapsed to one space.

    So "Copyright 2014 - 2023 Adobe (http://www.adobe.com/), with Reserved Font
    Name 'Source'" and the same line written with a hyphen and straight quotes
    compare equal: the credit is a human-readable rewrap of the licence header,
    not a byte copy of it.
    """
    return " ".join("".join(c if c.isalnum() else " " for c in text.lower()).split())


def test_credits_table_matches_the_bundled_fonts() -> None:
    """v2-03 finding 5: the export has to credit the faces it cuts from.

    `export.FONT_CREDITS` is hand-written prose, so this is what stops it from
    drifting: every row is checked against the generated metrics (version) and
    against the bundled OFL header (copyright holder), and every face the bake
    can cut with has a row.
    """
    from app import export

    assert {f.key for f in export.FONT_CREDITS} == set(FACES)
    for credit in export.FONT_CREDITS:
        directory, _filename = L.FACE_FILES[credit.key]
        metrics = json.loads(
            (BAKE_FONT_DIR / f"{credit.key}.metrics.json").read_text(encoding="utf-8")
        )
        assert credit.version in metrics["version"], (
            f"{credit.key}: credited {credit.version}, font says {metrics['version']}"
        )
        header = (BAKE_FONT_DIR / directory / "OFL.txt").read_text(
            encoding="utf-8"
        ).splitlines()[0]
        assert _licence_key(credit.copyright) in _licence_key(header), (
            f"{credit.key}: the credited copyright is not the font's own"
        )
        assert credit.name.lower().replace(" ", "") in _licence_key(header).replace(
            " ", ""
        ) or credit.name.split()[0].lower() in _licence_key(header)
    # ... and the one-line 3MF form names all three
    for credit in export.FONT_CREDITS:
        assert credit.name in export.FONT_LICENSE_LINE
    assert "SIL Open Font License 1.1" in export.FONT_LICENSE_LINE


def test_web_glyph_assets_ship_their_licence() -> None:
    """`<face>.glyphs.json` IS font software - outlines extracted from the TTF
    and served to every visitor - so the OFL text has to travel with it."""
    licences = WEB_FONT_DIR.parents[1] / "licences"
    names = {
        "sans": "OFL-Inter.txt",
        "serif": "OFL-Source-Serif-4.txt",
        "mono": "OFL-JetBrains-Mono.txt",
    }
    for face in FACES:
        directory, _filename = L.FACE_FILES[face]
        assert (WEB_FONT_DIR / f"{face}.glyphs.json").is_file()
        copied = licences / names[face]
        assert copied.is_file(), f"{face}: {copied} is missing"
        assert copied.read_text(encoding="utf-8") == (
            BAKE_FONT_DIR / directory / "OFL.txt"
        ).read_text(encoding="utf-8"), f"{face}: the web licence copy has drifted"


def test_font_metrics_are_the_same_bytes_in_both_trees() -> None:
    """The browser and the bake read the same table, not two copies of one."""
    for face in FACES:
        web = (WEB_FONT_DIR / f"{face}.metrics.json").read_bytes()
        bake = (BAKE_FONT_DIR / f"{face}.metrics.json").read_bytes()
        assert web == bake, f"{face}.metrics.json differs between apps/web and services/bake"


def test_font_metrics_match_the_font_they_came_from() -> None:
    """Every number in the generated table is re-derived from the TTF here.

    This is what stops the committed asset from drifting away from the font: the
    layout math reads the JSON and the bake cuts from the TTF, so a stale JSON
    would put the preview's text somewhere the bake does not.
    """
    import hashlib

    for face_name in FACES:
        table = T.font_metrics(face_name)
        face = L.load_face(face_name)
        assert table["units_per_em"] == face.upem
        assert table["cap_height"] == face.cap_height
        assert table["file"] == face.path.name
        assert table["sha256"] == hashlib.sha256(face.path.read_bytes()).hexdigest()
        tolerance = L.flatten_tolerance_units(face, L.GLYPH_ASSET_SIZE_MM)
        # A sample rather than all 190 glyphs: the measurements are the slow
        # part and the sample covers every kind (counter, no counter, blank,
        # island-in-counter, accented composite).
        for ch in "oae8Bl1M. gjQ%@°é":
            row = table["glyphs"][str(ord(ch))]
            assert row["adv"] == L.advance_units(face, ch)
            geom = L.glyph_polygon_units(face, ch, tolerance)
            assert row["stem"] == pytest.approx(L.glyph_stem_units(geom, face.upem), abs=1e-3)
            counter = L.glyph_counter_units(geom)
            if counter is None:
                assert row["counter"] is None
            else:
                assert row["counter"] == pytest.approx(counter, abs=1e-3)
            if geom is not None and not geom.is_empty:
                assert row["top"] == pytest.approx(geom.bounds[3], abs=1e-3)
                assert row["bot"] == pytest.approx(geom.bounds[1], abs=1e-3)
                assert row["left"] == pytest.approx(geom.bounds[0], abs=1e-3)
                assert row["right"] == pytest.approx(geom.bounds[2], abs=1e-3)


def test_font_glyph_outlines_are_what_the_bake_produces() -> None:
    """``<face>.glyphs.json`` is the same contour data the bake cuts, at the
    size the asset is generated for."""
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
    import gen_font_assets as gen

    for face_name in FACES:
        committed = json.loads(
            (WEB_FONT_DIR / f"{face_name}.glyphs.json").read_text(encoding="utf-8")
        )
        face = L.load_face(face_name)
        assert committed["units_per_em"] == face.upem
        assert committed["glyph_asset_size_mm"] == L.GLYPH_ASSET_SIZE_MM
        tolerance = L.flatten_tolerance_units(face, L.GLYPH_ASSET_SIZE_MM)
        for ch in "oae8B1M":
            fresh = [
                {
                    "shell": [[round(x, 3), round(y, 3)] for x, y in part["shell"]],
                    "holes": [
                        [[round(x, 3), round(y, 3)] for x, y in hole]
                        for hole in part["holes"]
                    ],
                }
                for part in gen.glyph_parts(face, ch, tolerance)
            ]
            assert committed["glyphs"][str(ord(ch))] == fresh, f"{face_name} {ch!r}"


def test_font_metrics_cover_every_character_the_tokens_can_emit() -> None:
    """The layout can only measure what the table holds, so the table has to
    hold everything a token expands to."""
    sample = TOK.TokenContext(
        lat=-33.8688,
        lon=151.2093,
        scale_mm_per_m=0.0424,
        radius_m=1980.0,
        date="2026-08-30",
        buildings=1234567,
        city="",
    )
    emitted = "".join(
        TOK.expand_tokens("{" + name + "}", sample) for name in TOK.TOKENS
    )
    for face in FACES:
        for ch in emitted:
            assert T.supported_codepoint(face, ch), f"{face} cannot lay out {ch!r}"
        # ASCII 32-126 and the degree sign, per the brief.
        for cp in list(range(32, 127)) + [0xB0]:
            assert T.supported_codepoint(face, chr(cp))


# --------------------------------------------------------------------------
# Glyph outlines
# --------------------------------------------------------------------------


@pytest.mark.parametrize("face", FACES)
@pytest.mark.parametrize("ch,holes", [("o", 1), ("a", 1), ("e", 1), ("8", 2), ("B", 2)])
def test_glyph_counters_come_out_as_holes(face: str, ch: str, holes: int) -> None:
    """The counters of o, a, e, 8 and B are HOLES, not filled blobs.

    Nesting is decided by containment depth rather than by winding direction; a
    representative-point test gets ``o`` wrong (the filled outer ring's
    representative point lands inside its own counter) and the glyph comes out
    empty.
    """
    f = L.load_face(face)
    geom = L.glyph_polygon_units(f, ch, L.flatten_tolerance_units(f, 6.0))
    assert geom is not None and not geom.is_empty
    parts = thicken.explode(geom)
    assert sum(len(p.interiors) for p in parts) == holes, f"{face} {ch!r}"
    assert geom.area > 0.0


def test_glyph_counter_of_a_dotted_zero_excludes_the_island() -> None:
    """JetBrains Mono's zero carries an island; the counter is the ring AROUND
    it, not the hole that contains both."""
    face = L.load_face("mono")
    geom = L.glyph_polygon_units(face, "0", L.flatten_tolerance_units(face, 6.0))
    parts = thicken.explode(geom)
    assert len(parts) >= 2, "the zero should have an island inside its counter"
    hole = max(
        (Polygon(ring) for part in parts for ring in part.interiors),
        key=lambda p: p.area,
    )
    counters = L.counter_regions(geom)
    assert counters, "the ring around the island is the counter"
    assert max(c.area for c in counters) < hole.area
    assert L.glyph_counter_units(geom) < thicken.inscribed_width(hole, 1.0)


def test_glyph_flattening_follows_the_printed_size() -> None:
    """Bezier flattening is a PRINT tolerance, so a bigger letter gets more
    chords - the same 0.02 mm of error either way."""
    face = L.load_face("sans")
    small = L.glyph_contours_units(face, "o", L.flatten_tolerance_units(face, 1.5))
    large = L.glyph_contours_units(face, "o", L.flatten_tolerance_units(face, 8.0))
    assert sum(len(c) for c in large) > sum(len(c) for c in small)
    # ... and the printed error really is the stated tolerance: rendering the
    # same letter at the same PRINTED size, coarsely and finely, the two
    # outlines stay within 0.02 mm of each other.
    coarse = L.glyph_polygon_mm(face, "o", 1.5)
    fine = shapely.affinity.scale(
        L.glyph_polygon_mm(face, "o", 8.0), 1.5 / 8.0, 1.5 / 8.0, origin=(0, 0)
    )
    assert coarse.hausdorff_distance(fine) <= 1.5 * L.FLATTEN_TOLERANCE_MM


def test_glyph_unsupported_characters_are_dropped_and_named() -> None:
    """An unsupported character is dropped with a warning naming it, never
    replaced by the font's .notdef box."""
    p = params()
    fit = T.fit_text("sans", "Tokyo 東京", 6.0, 160.0, T.edge_band_mm(p), p, "test")
    assert fit.text == "Tokyo "
    assert fit.dropped == "東京"
    assert any("2 character(s)" in w and "東京" in w for w in fit.warnings)
    polys, dropped = L.text_polygons_mm("Tokyo 東京", "sans", 6.0)
    assert dropped == ["東", "京"]
    assert polys, "the supported half is still laid out"


def test_glyph_advance_widths_match_the_metrics_table() -> None:
    """``text_advance_em`` (JSON) and the bake's own pen (TTF) must agree."""
    for face_name in FACES:
        face = L.load_face(face_name)
        for text in ("Chicago", "41.8827° N", "1:10,714", "WWW iii"):
            units, dropped = L.text_advance_units(face, text)
            assert dropped == []
            assert T.text_advance_em(face_name, text) == pytest.approx(
                units / face.upem, abs=1e-12
            )


# --------------------------------------------------------------------------
# The shared layout math
# --------------------------------------------------------------------------


def engraving(**overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {"edge": "top", "text": "Chicago", "size_mm": 6.0}
    base.update(overrides)
    return base


@pytest.mark.parametrize(
    "edge,rotation",
    [("top", 0.0), ("bottom", 0.0), ("left", 90.0), ("right", -90.0)],
)
def test_layout_every_edge_reads_correctly_for_a_hung_frame(
    edge: str, rotation: float
) -> None:
    """Top and bottom upright, the left edge bottom-to-top, the right edge
    top-to-bottom - which is what a viewer facing the wall reads."""
    p = params(engravings=[engraving(edge=edge)])
    layout = T.lettering_layout(p, ctx())
    placed = layout.engravings[0]
    assert placed.placement.rotation_deg == rotation
    # The anchor sits on the edge's own band, near its centre line.
    cx, cy = T.edge_band_center_mm(p, edge)
    ax, ay = placed.placement.anchor_x, placed.placement.anchor_y
    across = abs(ax - cx) if edge in ("left", "right") else abs(ay - cy)
    assert across < T.FRAME_WIDTH_MM / 2.0
    # ... and the text's UP direction points the way that rotation implies.
    ux, uy = T.edge_up(edge)
    expected = {
        "top": (0.0, 1.0),
        "bottom": (0.0, 1.0),
        "left": (-1.0, 0.0),
        "right": (1.0, 0.0),
    }[edge]
    assert ux == pytest.approx(expected[0], abs=1e-12)
    assert uy == pytest.approx(expected[1], abs=1e-12)


@pytest.mark.parametrize("edge", ["top", "bottom", "left", "right"])
def test_layout_aligns_place_the_block_where_they_say(edge: str) -> None:
    p_start = params(engravings=[engraving(edge=edge, align="start")])
    p_center = params(engravings=[engraving(edge=edge, align="center")])
    p_end = params(engravings=[engraving(edge=edge, align="end")])
    usable = T.edge_usable_mm(p_center)
    ax, ay = T.edge_axis(edge)
    out = []
    for p in (p_start, p_center, p_end):
        placed = T.lettering_layout(p, ctx()).engravings[0]
        cx, cy = T.edge_band_center_mm(p, edge)
        u = (placed.placement.anchor_x - cx) * ax + (placed.placement.anchor_y - cy) * ay
        out.append(u - placed.fit.dilation_mm)  # back to the block's leading edge
    start, center, end = out
    assert start == pytest.approx(-usable / 2.0, abs=1e-9)
    width = T.lettering_layout(p_center, ctx()).engravings[0].fit.width_mm
    assert center == pytest.approx(-width / 2.0, abs=1e-9)
    assert end == pytest.approx(usable / 2.0 - width, abs=1e-9)
    assert start < center < end


def test_layout_auto_fit_shrinks_instead_of_clipping() -> None:
    """A string too long for its edge is made smaller, and the fitted size is
    named in a warning.  It is never cut short."""
    long_text = "A very long dedication that will not fit at eight millimetres"
    p = params(plate_mm=100, engravings=[engraving(text=long_text, size_mm=8.0)])
    fit = T.lettering_layout(p, ctx()).engravings[0].fit
    assert fit.text == long_text, "never clipped"
    assert fit.size_mm < 8.0
    assert fit.width_mm <= T.edge_usable_mm(p) + 1e-9
    assert any("reduced from 8 mm" in w and f"{fit.size_mm:.2f}" in w for w in fit.warnings)
    # and the fitted size is on the shared grid, so both sides round the same
    assert fit.size_mm == pytest.approx(
        T.floor_to_grid(fit.size_mm, T.TEXT_FIT_GRID_MM), abs=1e-12
    )


def test_layout_auto_fit_also_respects_the_lip_band() -> None:
    """The band across the lip is the other limit: 8 mm of type does not fit
    the lip's flat face, whatever the plate is - and the warning names the band
    it measured (4 mm at the default rebate, [V3.1-P2-2]), not a literal."""
    p = params(plate_mm=256, engravings=[engraving(text="Chicago", size_mm=8.0)])
    fit = T.lettering_layout(p, ctx()).engravings[0].fit
    assert fit.size_mm < 8.0
    ink = fit.ink_top_mm - fit.ink_bottom_mm + 2.0 * fit.dilation_mm
    assert ink <= T.edge_band_mm(p) + 1e-9
    assert T.edge_band_mm(p) == pytest.approx(4.0)
    assert any(f"{T._g(T.edge_band_mm(p))} mm text band on the lip" in w for w in fit.warnings)
    assert not any("6 mm" in w for w in fit.warnings)


def emboss_mesh(p: PrintParams, geom: L.LetteringGeometry) -> trimesh.Trimesh:
    """Plate + lip with the built emboss solids on it, as the validator sees it."""
    import numpy as np

    solid = Manifold.batch_boolean([extrude.base_plate(p), extrude.frame_lip(p)], OpType.Add)
    solid = Manifold.batch_boolean([solid, *geom.emboss], OpType.Add)
    mesh = solid.to_mesh64()
    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vert_properties)[:, :3].astype(float),
        faces=np.asarray(mesh.tri_verts).astype(int),
        process=False,
        validate=False,
    )


def test_build_joins_an_embossed_pair_a_nozzle_cannot_part_and_the_gate_passes() -> None:
    """[V3.1-P2-5], the larger half: embossed text gets the gap treatment
    engraved text has.

    The layout WARNS when adjacent letters come within a nozzle, and for
    engraved text the ridge merge makes that true.  Until this, embossed text
    had no merge: a sans date at the 4.80 mm the 5 mm face allows put two
    raised digits 0.208 mm apart, the Stage 4 ``lettering`` row failed the
    slit, and the interim fix was to refuse the line.  Now the slit is filled
    and the join widened to a wall (:func:`L.merge_emboss_gaps`,
    :func:`L.widen_joins`): the line is BUILT, the user is told which pairs
    were joined and how close they came, and the validator's own reading of
    the finished mesh passes with the joined pair as one stroke.
    """
    p = params(engravings=[engraving(edge="right", text="2026-09-06", size_mm=8.0, mode="emboss")])
    fit = T.lettering_layout(p, ctx()).engravings[0].fit
    assert not fit.refused
    assert fit.size_mm < fit.gap_size_mm, "the premise: the layout only warns about this gap"
    geom = L.build(p, ctx(), rotation_deg=0.0)
    assert geom.emboss != []
    assert not any("was not cut" in w for w in geom.warnings)
    [note] = [w for w in geom.warnings if "were joined where they touch" in w]
    joined = int(re.search(r": (\d+) pair\(s\)", note).group(1))
    gap = float(re.search(r"came within (\d+\.\d\d) mm", note).group(1))
    assert joined >= 1 and 0.0 < gap < 0.36
    assert "0.36 mm" in note and f"{fit.gap_size_mm:.2f} mm would keep them apart" in note
    [measure] = geom.measures
    assert measure["joined"] == joined and measure["gaps_closed"] >= joined
    # The joins are strokes and were widened to the emboss target, so the
    # narrowest stroke is a full wall and the gate agrees on the mesh.
    assert measure["narrowest_mm"] >= 0.9 * T.min_wall_mm(p)
    [row] = validators.validate_lettering(emboss_mesh(p, geom), p)
    assert row.passed, row.message
    assert "1 piece(s)" in str(row.value)


def test_build_refuses_an_embossed_pair_that_would_fuse_into_one_shape() -> None:
    """The case a repair cannot honestly save: two straight stems.

    A wedge (a bowl against anything) is under a nozzle only near its closest
    point and the join is a short touch; a SLOT between two stems is under a
    nozzle along the whole height the stems share, and filling it prints one
    clean bar where the user typed two letters.  :data:`L.EMBOSS_JOIN_MAX_EM`
    draws that line at 0.4 em, and the refusal names the gap, how far it runs
    and the size that keeps the pair apart.
    """
    p = params(engravings=[engraving(edge="right", text="Illinois", size_mm=8.0, mode="emboss")])
    fit = T.lettering_layout(p, ctx()).engravings[0].fit
    assert not fit.refused
    geom = L.build(p, ctx(), rotation_deg=0.0)
    assert geom.emboss == []
    [refusal] = [w for w in geom.warnings if "was not cut" in w]
    assert "would print as one shape rather than as two letters that touch" in refusal
    run = float(re.search(r"along (\d+\.\d\d) mm of their height", refusal).group(1))
    gap = float(re.search(r"run within (\d+\.\d\d) mm", refusal).group(1))
    assert run > L.EMBOSS_JOIN_MAX_EM * fit.size_mm
    assert 0.0 < gap < 0.36
    assert "0.36 mm" in refusal
    # The same string in mono keeps a nozzle between its stems and is built
    # with nothing joined: the rule is about the measured slot, not the mode.
    q = params(engravings=[engraving(edge="right", text="Illinois", size_mm=8.0, mode="emboss", font="mono")])
    built = L.build(q, ctx(), rotation_deg=0.0)
    assert built.emboss != [] and built.measures[0]["joined"] == 0
    assert not any("was not cut" in w or "were joined" in w for w in built.warnings)


def test_build_still_refuses_an_embossed_gap_the_merge_cannot_close(monkeypatch) -> None:
    """The belt under the braces: when the merge closes nothing, the gate's own
    reading of the void still refuses the line before Stage 4 fails it, and
    the message says the merge was tried."""
    monkeypatch.setattr(L, "gap_stretches", lambda void, params: [])
    p = params(engravings=[engraving(edge="right", text="2026-09-06", size_mm=8.0, mode="emboss")])
    geom = L.build(p, ctx(), rotation_deg=0.0)
    assert geom.emboss == []
    [refusal] = [w for w in geom.warnings if "was not cut" in w]
    assert "raised letters come within" in refusal
    assert "even after joining the pairs a nozzle cannot part" in refusal
    gap = float(re.search(r"come within (\d+\.\d\d) mm", refusal).group(1))
    assert 0.0 < gap < 0.36 and "0.36 mm" in refusal


def test_merge_emboss_gaps_joins_only_what_a_nozzle_cannot_part() -> None:
    """Two raised bars closer than a nozzle are joined and the join is widened
    to a wall; further apart they stay two bars (the emboss mirror of
    ``test_repair_merges_only_the_ridges_a_nozzle_cannot_lay_down``)."""
    p = params()
    band = shapely.box(-20.0, -3.0, 20.0, 3.0)
    target = T.text_stroke_target_mm(p, "emboss")
    floor = L.text_area_floor(p)
    near = [shapely.box(-3.0, -1.5, -0.15, 1.5), shapely.box(0.15, -1.5, 3.0, 1.5)]
    far = [shapely.box(-3.0, -1.5, -0.5, 1.5), shapely.box(0.5, -1.5, 3.0, 1.5)]
    merged_near = L.merge_emboss_gaps(near, band, p)
    merged_far = L.merge_emboss_gaps(far, band, p)
    assert merged_near.joined == 1 and len(merged_near.bridges) == 1, "0.3 mm gap joined"
    assert merged_near.narrowest_gap_mm == pytest.approx(0.3, abs=0.02)
    assert merged_far.joined == 0 and merged_far.bridges == [], "1.0 mm gap kept"
    # A 3 mm slot (read a tenth short at each mouth, where the disc's cap
    # reaches in) is a fusion at any size the lip band allows and a touch at
    # the contract's 8 mm maximum ...
    assert merged_near.longest_join_mm == pytest.approx(2.85, abs=0.15)
    assert merged_near.fuses(4.8) and not merged_near.fuses(8.0)
    # ... and the join, a neck as wide as the slot was long, is a full wall
    # after widening, measured the way the gate measures a raised stroke.
    joined = L.widen_joins(merged_near.polygons, merged_near.bridges, target, floor)
    [piece] = thicken.explode(shapely.union_all(joined))
    assert thicken.narrowest_width(piece, target, floor) >= 0.9 * target


def test_merge_emboss_gaps_never_fills_a_counter_whole() -> None:
    """An enclosed void is the counter rule's to judge, not the merge's to fill:
    a 0.3 mm slot inside one bar is left standing (and would be refused by
    ``verify``), while a counter wide enough to keep has only its sub-nozzle
    tail filled and its body untouched."""
    p = params()
    band = shapely.box(-20.0, -3.0, 20.0, 3.0)
    detail = T.min_detail_mm(p)
    bar = shapely.box(-3.0, -1.5, 3.0, 1.5)
    slot = shapely.box(-1.0, -0.15, 1.0, 0.15)
    [holed] = thicken.valid_polygons(bar.difference(slot))
    kept = L.merge_emboss_gaps([holed], band, p)
    assert kept.bridges == [] and len(kept.polygons[0].interiors) == 1
    # A counter 1.2 mm wide with a 0.3 mm wide, 1 mm long tail off one side.
    eye = shapely.union_all([shapely.box(-0.6, -0.6, 0.6, 0.6), shapely.box(0.6, -0.15, 1.6, 0.15)])
    [tailed] = thicken.valid_polygons(bar.difference(eye))
    merged = L.merge_emboss_gaps([tailed], band, p)
    assert len(merged.bridges) == 1 and merged.joined == 0
    assert merged.longest_join_mm == 0.0, "a counter's tail is not a join between letters"
    [counter] = L.counter_regions(shapely.union_all(merged.polygons))
    body = shapely.box(-0.6, -0.6, 0.6, 0.6)
    # The tail (0.3 mm^2) is gone; the body keeps its area to within the
    # bridge's four grid cells of growth at the mouth, and its width to within
    # a tenth of a millimetre of the 1.2 it had.
    assert body.area - 0.05 < counter.area < eye.area - 0.25
    assert thicken.inscribed_width(counter, 1e-3) == pytest.approx(1.2, abs=0.1)
    assert thicken.narrowest_width(counter, detail, L.text_area_floor(p)) >= 0.9 * detail


def test_layout_refuses_text_whose_counters_cannot_survive() -> None:
    """A face whose horizontals are much lighter than its stems cannot be cut
    small; the refusal names the size that would work."""
    # The contract's smallest legal type, in the face with the lightest
    # horizontals: widening its strokes to a printable groove would fill the
    # bowls of the a, the g and the o.
    p = params(engravings=[engraving(text="Chicago", size_mm=1.5, font="serif")])
    layout = T.lettering_layout(p, ctx())
    fit = layout.engravings[0].fit
    assert fit.refused
    assert "closing a counter" in fit.reason
    assert f"{fit.min_size_mm:.2f} mm" in fit.reason
    assert fit.min_size_mm > fit.size_mm
    assert any("was not cut" in w for w in layout.warnings)
    # The same string at a size that clears it is fine.
    ok = T.lettering_layout(
        params(engravings=[engraving(text="Chicago", size_mm=5.0, font="serif")]), ctx()
    ).engravings[0]
    assert not ok.fit.refused
    # ... and so is a fat nozzle refusing type it cannot hold at any size that
    # fits the lip.
    fat = T.lettering_layout(
        params(nozzle_mm=0.8, engravings=[engraving(text="Chicago", size_mm=8.0)]), ctx()
    ).engravings[0]
    assert fat.fit.refused and "0.8 mm nozzle" in fat.fit.reason


def test_layout_min_size_is_a_closed_form_of_the_counter_rule() -> None:
    """The refusal size is solved, not searched: at exactly that size the
    narrowest counter survives the dilation, and a twentieth of a millimetre
    under it, it does not."""
    p = params()
    detail = T.min_detail_mm(p)
    for face in FACES:
        for text in ("Chicago", "1:10,714", "8", "Bageo"):
            need = T.text_min_size_mm(face, text, p)
            if need <= T.TEXT_MIN_SIZE_MM:
                continue
            for size, ok in ((need, True), (need - 0.05, False)):
                dilation = T.text_dilation_mm(face, text, size, p)
                upem = T.font_metrics(face)["units_per_em"]
                worst = min(
                    float(g["counter"]) / upem * size
                    for ch in text
                    if (g := T.font_metrics(face)["glyphs"].get(str(ord(ch))))
                    and g["counter"] is not None
                )
                # every counter shrinks by the SAME dilation, the one the
                # thinnest glyph of the string asks for
                survives = worst - 2.0 * dilation >= detail - 1e-9
                assert survives is ok, f"{face} {text!r} at {size}"


def test_layout_touching_letters_are_a_warning_not_a_refusal() -> None:
    """A closed counter destroys a letter; letters that touch where they are
    closest stay perfectly legible, so that one warns."""
    p = params(plate_mm=100)
    fit = T.fit_text(
        "sans", "FOR ANNA AND TOM 2026", 8.0, T.edge_usable_mm(p), T.edge_band_mm(p), p
    )
    assert not fit.refused
    assert fit.gap_size_mm > fit.size_mm
    assert any("come within a nozzle of each other" in w for w in fit.warnings)
    # ... and at a size where they do not touch, the warning is gone.
    roomy = T.fit_text("sans", "AN", 8.0, 160.0, T.edge_band_mm(p), p)
    if roomy.size_mm >= roomy.gap_size_mm:
        assert not any("come within a nozzle" in w for w in roomy.warnings)


def test_layout_scale_bar_and_an_engraving_split_one_edge() -> None:
    """The bar takes the start of its edge and the text lays out in what is
    left, so neither is drawn on top of the other."""
    p_alone = params(engravings=[engraving(edge="bottom", align="start")])
    p_shared = params(
        engravings=[engraving(edge="bottom", align="start")],
        scale_bar={"enabled": True, "edge": "bottom"},
    )
    alone = T.lettering_layout(p_alone, ctx()).engravings[0]
    shared_layout = T.lettering_layout(p_shared, ctx())
    shared = shared_layout.engravings[0]
    bar = shared_layout.scale_bar
    assert bar.enabled and bar.span_mm > 0.0
    assert shared.placement.anchor_x > alone.placement.anchor_x
    assert shared.placement.anchor_x - alone.placement.anchor_x == pytest.approx(
        bar.span_mm + T.ORNAMENT_GAP_MM, abs=1e-9
    )
    # the bar itself starts at the beginning of the usable edge
    assert bar.placement.anchor_x == pytest.approx(-T.edge_usable_mm(p_shared) / 2.0)


def test_layout_frame_off_skips_the_lip_ornaments_with_one_warning() -> None:
    p = params(
        frame=False,
        engravings=[engraving(), engraving(edge="bottom")],
        north_arrow={"enabled": True},
        scale_bar={"enabled": True},
        underside_mark={"enabled": True},
    )
    assert T.frame_text_available(p) is False
    layout = T.lettering_layout(p, ctx())
    assert layout.north_arrow.enabled is False
    assert layout.scale_bar.enabled is False
    assert layout.underside_mark.enabled is True, "the underside does not need a lip"
    notices = [w for w in layout.warnings if "the frame is off" in w]
    assert len(notices) == 1
    assert "2 edge engraving(s)" in notices[0]
    assert "the north arrow" in notices[0] and "the scale bar" in notices[0]
    # ... and with the frame ON they are all available again.
    assert T.frame_text_available(params(frame=True)) is True


def test_layout_expands_tokens_through_the_shared_table() -> None:
    p = params(engravings=[engraving(text="{city} {scale} {date}", size_mm=6.0)])
    fit = T.lettering_layout(p, ctx()).engravings[0].fit
    assert fit.text == "Chicago 1:10,714 2026-08-30"


def test_layout_engraving_defaults_match_the_contract_schema() -> None:
    """The TS mirror applies these by hand (every member of an Engraving is
    optional on the wire), so they have to be the schema's own defaults."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    props = schema["$defs"]["Engraving"]["properties"]
    assert props["align"]["default"] == "center"
    assert props["mode"]["default"] == "engrave"
    # 4.0, not the 3.0 this shipped with: at 3.0 the DEFAULT face refuses six of
    # the eight strings a user actually types, measured face by face and string
    # by string in docs/handoff/v2-03-lettering.md (v2-03 audit, finding 4).
    assert props["size_mm"]["default"] == 4.0
    assert PrintParams(engravings=[{"edge": "top", "text": "x"}]).engravings[0].size_mm == 4.0
    assert props["depth_mm"]["default"] == 0.4
    assert props["font"]["default"] == "sans"
    assert props["size_mm"]["minimum"] == T.TEXT_MIN_SIZE_MM
    assert props["size_mm"]["maximum"] == T.TEXT_MAX_SIZE_MM


# --------------------------------------------------------------------------
# Ornaments
# --------------------------------------------------------------------------


def arrow_tip_bearing_deg(size_mm: float, rotation_deg: float) -> float:
    """Compass bearing of the placed arrow's apex, in the PLATE frame.

    Bearings are measured the way a compass does: 0 at +y, growing clockwise
    toward +x, which is `atan2(x, y)`.
    """
    poly = L.north_arrow_polygon(size_mm)
    # The apex is the FIRST vertex of the glyph - (0, +size/2) in its own frame -
    # and `place` is an affine transform, so it stays first.  (Not "the vertex
    # furthest from the centre": the two base corners are further out than the
    # tip on this arrowhead.)
    assert poly.exterior.coords[0] == pytest.approx((0.0, size_mm / 2.0))
    placed = L.place(poly, 0.0, 0.0, rotation_deg)
    tip = placed.exterior.coords[0]
    return math.degrees(math.atan2(tip[0], tip[1])) % 360.0


def true_north_bearing_deg(lat: float, lon: float, rotation_deg: float) -> float:
    """Where true north ends up in the plate frame, from the PROJECTION itself.

    Derived by projecting a point due north of the centre through the same
    `LocalFrame` the scene was cropped with, so this number owes nothing to the
    formula under test.
    """
    from app.geom.project import LocalFrame

    frame = LocalFrame(lat, lon, rotation_deg)
    x, y = frame.point_to_local(lon, lat + 0.01)
    return math.degrees(math.atan2(x, y)) % 360.0


#: UTM meridian convergence at Chicago: true north is 0.42 deg off grid north
#: there, and no arrow drawn from a rotation angle can know that.
CONVERGENCE_TOLERANCE_DEG = 1.0


@pytest.mark.parametrize("rotation_deg", [0.0, 29.0, 90.0, 180.0, 271.0])
def test_ornament_north_arrow_points_at_true_north(rotation_deg: float) -> None:
    """The arrow's apex points where the PROJECTION puts north, at every angle.

    The previous version of this test placed the glyph with
    `arrow.placement.rotation_deg` and then asserted the tip was where that same
    rotation had put it - a tautology that could not fail for either sign, and
    did not: the arrow shipped turned by `-rotation_deg`, which is ground bearing
    `2 * rotation`, 59 deg out at the New York preset and due SOUTH at rotation
    90 (v2-03 audit, finding 1).
    """
    lat, lon = 41.8827, -87.6233
    p = params(north_arrow={"enabled": True, "corner": "ne", "size_mm": 4.0})
    layout = T.lettering_layout(p, ctx(), rotation_deg=rotation_deg)
    arrow = layout.north_arrow
    assert arrow.enabled

    drawn = arrow_tip_bearing_deg(arrow.size_mm, arrow.placement.rotation_deg)
    north = true_north_bearing_deg(lat, lon, rotation_deg)
    error = abs((drawn - north + 180.0) % 360.0 - 180.0)
    assert error <= CONVERGENCE_TOLERANCE_DEG, (
        f"at rotation {rotation_deg} the arrow points {drawn:.2f} deg and true "
        f"north is at {north:.2f} deg"
    )
    # ... and the sign really is +rotation: the wrong one is only right at 0/180.
    assert arrow.placement.rotation_deg == pytest.approx(rotation_deg)
    if rotation_deg % 180.0 != 0.0:
        wrong = arrow_tip_bearing_deg(arrow.size_mm, -rotation_deg)
        assert abs((wrong - north + 180.0) % 360.0 - 180.0) > CONVERGENCE_TOLERANCE_DEG


@pytest.mark.parametrize("corner", ["ne", "nw", "se", "sw"])
def test_ornament_north_arrow_sits_in_its_corner(corner: str) -> None:
    p = params(north_arrow={"enabled": True, "corner": corner, "size_mm": 4.0})
    layout = T.lettering_layout(p, ctx(), rotation_deg=29.0)
    arrow = layout.north_arrow
    assert arrow.enabled
    sx = -1.0 if corner in ("nw", "sw") else 1.0
    sy = -1.0 if corner in ("se", "sw") else 1.0
    # The corner square is the lip's FLAT top face, 5 mm at the default
    # sight-edge rebate ([V3.1-P2-2]), so the arrow sits 2.5 mm in from the
    # outer edge on both axes rather than 3.
    offset = p.plate_mm / 2.0 - T.lip_face_width_mm(p) / 2.0
    assert offset == pytest.approx(87.5)
    assert arrow.placement.anchor_x == pytest.approx(sx * offset)
    assert arrow.placement.anchor_y == pytest.approx(sy * offset)
    # The glyph is two triangles: a concave quadrilateral, tip on +y.
    poly = L.north_arrow_polygon(arrow.size_mm)
    assert len(poly.exterior.coords) == 5  # 4 corners, closed
    assert not poly.convex_hull.equals(poly), "the notch makes it concave"
    assert poly.bounds[3] == pytest.approx(arrow.size_mm / 2.0)


@pytest.mark.parametrize("rotation_deg", [0.0, 29.0, 45.0, 200.0])
def test_ornament_north_arrow_is_fitted_to_the_band_not_clipped(rotation_deg: float) -> None:
    """v2-03 finding 9: the arrow had no fitting step, so it was silently cut.

    At the contract's maximum 6 mm the point crossed the lip's keep region and
    the clip flattened it - 0.5 mm off at rotation 0 - with nothing said.  It is
    fitted to the band now, like text, and says so.
    """
    p = params(north_arrow={"enabled": True, "corner": "ne", "size_mm": 6.0})
    layout = T.lettering_layout(p, ctx(), rotation_deg=rotation_deg)
    arrow = layout.north_arrow
    assert arrow.size_mm == pytest.approx(T.north_arrow_max_size_mm(p))
    # 4.28746 mm on the full 6 mm band; the 4 mm band the sight-edge rebate
    # leaves holds 3.42997 mm ([V3.1-P2-2]).
    assert arrow.size_mm == pytest.approx(3.42997, abs=1e-5)
    assert any("the north arrow was reduced from 6 mm to 3.42997 mm" in w for w in layout.warnings)

    keep = L.lip_keep_region(p)
    placed = L.place(
        L.north_arrow_polygon(arrow.size_mm),
        arrow.placement.anchor_x,
        arrow.placement.anchor_y,
        arrow.placement.rotation_deg,
    )
    assert keep.contains(placed), "the fitted arrow needs no clipping at all"
    # ... and the size that used to ship really was clipped
    unfitted = L.place(
        L.north_arrow_polygon(6.0),
        arrow.placement.anchor_x,
        arrow.placement.anchor_y,
        arrow.placement.rotation_deg,
    )
    assert not keep.contains(unfitted)
    assert unfitted.intersection(keep).area < unfitted.area


def test_ornament_north_arrow_under_the_cap_is_untouched() -> None:
    """The fit is a cap, not a resize: anything the band can hold is left alone."""
    cap = T.north_arrow_max_size_mm(params(north_arrow={"enabled": True, "corner": "sw"}))
    assert 3.4 < cap < 3.5  # the 4 mm band of [V3.1-P2-2]; 4.0 is over it now
    for asked in (2.0, 3.0, math.floor(cap * 100.0) / 100.0):
        p = params(north_arrow={"enabled": True, "corner": "sw", "size_mm": asked})
        layout = T.lettering_layout(p, ctx())
        assert layout.north_arrow.size_mm == pytest.approx(asked)
        assert not any("north arrow was reduced" in w for w in layout.warnings)


def test_ornament_north_arrow_needs_the_lip() -> None:
    p = params(frame=False, north_arrow={"enabled": True})
    assert T.lettering_layout(p, ctx()).north_arrow.enabled is False


def test_layout_frame_off_refuses_every_engraving_rather_than_warning() -> None:
    """A warning is advice; `refused` is what the BAKE reads.

    With the frame off the layout used to hand back fits with `refused=False`
    and a warning beside them, so `lettering.build` cheerfully built an EMBOSS
    and the plate shipped with two letters floating over it (v2-03 audit,
    finding 2).
    """
    # "Loop" for the emboss: on the 4 mm band the sight-edge rebate leaves
    # ([V3.1-P2-2]) an embossed "Chicago" fits at 3.62 mm, where its counters
    # close, and is refused by the lip itself rather than by the rule under
    # test here.
    p = params(frame=False, engravings=[engraving(), engraving(edge="bottom", mode="emboss", text="Loop")])
    for placed in T.lettering_layout(p, ctx()).engravings:
        assert placed.fit.refused is True
        assert "no lip" in placed.fit.reason
        assert "turn the frame on" in placed.fit.reason
    # and with the frame on, the same two engravings are accepted
    on = T.lettering_layout(params(engravings=p.engravings), ctx())
    assert [e.fit.refused for e in on.engravings] == [False, False]


def test_build_frame_off_builds_no_lip_geometry_even_from_a_forged_layout() -> None:
    """The belt to the layout's braces: `build()` checks the frame itself.

    Forge a layout whose fits claim to be printable with `frame=False` - the
    exact state the shipped bug was in - and assert nothing lands on the missing
    lip anyway.
    """
    from dataclasses import replace

    p = params(
        frame=False,
        engravings=[engraving(text="AB"), engraving(text="CD", edge="bottom", mode="emboss")],
        north_arrow={"enabled": True},
        scale_bar={"enabled": True},
    )
    layout = T.lettering_layout(p, ctx())
    forged = replace(
        layout,
        engravings=[
            replace(e, fit=replace(e.fit, refused=False, reason="")) for e in layout.engravings
        ],
        north_arrow=replace(layout.north_arrow, enabled=True),
        scale_bar=replace(layout.scale_bar, enabled=True),
    )
    assert all(not e.fit.refused for e in forged.engravings), "the forgery must take"
    geom = L.build(p, ctx(), rotation_deg=0.0, layout=forged)
    assert geom.cut == []
    assert geom.emboss == []


@pytest.mark.parametrize(
    "scale_mm_per_m,length_m,label",
    [
        (168.0 / 1800.0, 200.0, "200 m"),  # Chicago at the defaults, 1:10,714
        (168.0 / 3960.0, 500.0, "500 m"),  # the 1:23,571 bake from [V2-P1]
        (0.005, 5000.0, "5 km"),
        (0.02, 2000.0, "2 km"),
    ],
)
def test_ornament_scale_bar_auto_picks_a_round_number_that_fits(
    scale_mm_per_m: float, length_m: float, label: str
) -> None:
    """1-2-5, the longest whose printed bar lands in [15, 40] mm."""
    assert T.scale_bar_auto_length_m(scale_mm_per_m) == length_m
    assert T.scale_bar_label(length_m) == label
    printed = length_m * scale_mm_per_m
    assert T.SCALE_BAR_MIN_MM <= printed <= T.SCALE_BAR_MAX_MM
    # nothing longer fits
    longer = [c for c in T.scale_bar_candidates() if c > length_m]
    assert all(c * scale_mm_per_m > T.SCALE_BAR_MAX_MM for c in longer)


def test_ornament_scale_bar_window_always_has_a_candidate() -> None:
    """The 1-2-5 series steps by at most 2.5x and the window spans 2.67x, so a
    round number always lands inside it - at every legal scale."""
    for radius_m in (250.0, 900.0, 1980.0, 3000.0):
        for plate_mm in (100.0, 180.0, 256.0):
            scale = T.scale_mm_per_m(params(plate_mm=plate_mm), radius_m)
            length_m = T.scale_bar_auto_length_m(scale)
            printed = length_m * scale
            assert T.SCALE_BAR_MIN_MM <= printed <= T.SCALE_BAR_MAX_MM


def test_ornament_scale_bar_fixed_length_is_clamped_with_a_warning() -> None:
    p = params(
        scale_bar={"enabled": True, "length_mode": "fixed", "length_m": 5000.0},
    )
    layout = T.lettering_layout(p, ctx())
    bar = layout.scale_bar
    assert bar.length_m == T.scale_bar_auto_length_m(ctx().scale_mm_per_m)
    assert any("outside the 15-40 mm window" in w for w in bar.warnings)
    # A fixed length that DOES fit is honoured verbatim.
    ok = T.lettering_layout(
        params(scale_bar={"enabled": True, "length_mode": "fixed", "length_m": 200.0}),
        ctx(),
    ).scale_bar
    assert ok.length_m == 200.0 and ok.warnings == ()


def test_ornament_keyhole_is_a_standard_hanger_at_top_centre() -> None:
    p = params(base_thickness_mm=4.0, hanger="keyhole")
    hole = L.keyhole_polygon(p)
    cx, cy = T.keyhole_center_mm(p)
    assert cx == 0.0 and cy > 0.0, "top centre"
    # 8 mm round entry ...
    assert hole.intersects(shapely.Point(cx, cy).buffer(T.KEYHOLE_HOLE_D_MM / 2.0 - 0.01))
    # ... with the 4 mm slot running toward the TOP edge, so the frame hangs
    # level once it drops onto the screw.
    assert hole.bounds[3] > cy + T.KEYHOLE_SLOT_LEN_MM - 0.01
    assert hole.bounds[1] == pytest.approx(cy - T.KEYHOLE_HOLE_D_MM / 2.0, abs=0.02)
    width_at_slot = hole.intersection(
        shapely.box(-50, cy + T.KEYHOLE_SLOT_LEN_MM - 0.5, 50, cy + T.KEYHOLE_SLOT_LEN_MM)
    ).bounds
    assert width_at_slot[2] - width_at_slot[0] == pytest.approx(
        T.KEYHOLE_SLOT_W_MM, abs=0.05
    )
    # and it stays clear of the plate edge
    assert hole.bounds[3] <= p.plate_mm / 2.0 - T.KEYHOLE_EDGE_MARGIN_MM + 1e-9


def test_ornament_magnets_are_four_pockets_inset_from_the_corners() -> None:
    p = params(base_thickness_mm=5.0, hanger="magnets")
    pockets = L.magnet_polygons(p)
    assert len(pockets) == 4
    for pocket in pockets:
        minx, miny, maxx, maxy = pocket.bounds
        assert maxx - minx == pytest.approx(T.MAGNET_D_MM, abs=0.02)
        assert maxy - miny == pytest.approx(T.MAGNET_D_MM, abs=0.02)
        # inset from the plate edge, and clear of the chamfer
        assert abs(maxx) <= p.plate_mm / 2.0 - T.CHAMFER_MM
    centres = {(round(x, 3), round(y, 3)) for x, y in T.magnet_centers_mm(p)}
    assert len(centres) == 4


def test_ornament_underside_mark_is_mirrored_so_it_reads_when_turned_over() -> None:
    """The mark is cut into the BOTTOM, so it is mirrored: what the cutter
    draws is the mirror image of what a reader sees from below."""
    p = params(base_thickness_mm=4.0, underside_mark={"enabled": True, "template": "AB"})
    layout = T.lettering_layout(p, ctx())
    mark = layout.underside_mark
    assert mark.enabled and mark.placement.mirror_x is True
    glyphs, _ = L.text_polygons_mm("AB", mark.fit.face, mark.fit.size_mm)
    placed = [
        L.place(g, mark.placement.anchor_x, mark.placement.anchor_y, 0.0, True)
        for g in glyphs
    ]
    upright = [
        L.place(g, mark.placement.anchor_x, mark.placement.anchor_y, 0.0, False)
        for g in glyphs
    ]
    # 'A' comes first in the string; mirrored, it is the RIGHTMOST shape.
    assert placed[0].centroid.x > placed[-1].centroid.x
    assert upright[0].centroid.x < upright[-1].centroid.x
    # the block is still centred on the plate
    both = shapely.union_all(placed)
    assert both.centroid.x == pytest.approx(0.0, abs=0.35)
    # and it clears the chamfer
    assert both.bounds[0] > -p.plate_mm / 2.0 + T.CHAMFER_MM


def test_ornament_underside_mark_keeps_clear_of_the_magnets() -> None:
    p = params(base_thickness_mm=5.0, hanger="magnets", underside_mark={"enabled": True})
    assert T.underside_mark_available_mm(p) < T.underside_mark_available_mm(
        params(base_thickness_mm=5.0, underside_mark={"enabled": True})
    )
    geometry = L.build(p, ctx())
    mark = [
        m for m in geometry.measures if m["what"] == "underside mark"
    ]
    if mark:  # it may be refused at this plate, which is a legitimate outcome
        pockets = shapely.union_all(L.magnet_polygons(p))
        half = T.underside_mark_available_mm(p) / 2.0
        assert not pockets.intersects(shapely.box(-half, -6.0, half, 6.0))


# --------------------------------------------------------------------------
# The base floor rule
# --------------------------------------------------------------------------


def test_hanger_minimum_base_is_the_pocket_plus_a_millimetre() -> None:
    assert T.hanger_min_base_mm("none") == 0.0
    assert T.hanger_min_base_mm("keyhole") == T.KEYHOLE_DEPTH_MM + T.HANGER_MIN_ROOF_MM
    assert T.hanger_min_base_mm("magnets") == T.MAGNET_DEPTH_MM + T.HANGER_MIN_ROOF_MM
    assert T.underside_mark_min_base_mm() == T.UNDERSIDE_MARK_DEPTH_MM + T.HANGER_MIN_ROOF_MM
    assert T.UNDERSIDE_MARK_DEPTH_MM < 4.0 - 1.0, "04: depth < base - 1 mm"
    # The composite adds whatever a recess has already taken off the top.
    p = params(hanger="keyhole")  # engraved roads: 0.6 mm off the top
    assert T.deepest_recess_mm(p) == 0.6
    assert T.underside_min_base_mm(p) == pytest.approx(3.0 + 0.6)
    dry = params(hanger="keyhole", water=False, road_mode="off")
    assert T.deepest_recess_mm(dry) == 0.0
    assert T.underside_min_base_mm(dry) == pytest.approx(3.0)


def test_lettering_refuses_a_base_too_thin_for_its_pockets() -> None:
    """A hole through the picture is a refusal, not a warning."""
    with pytest.raises(L.BaseTooThinError) as exc:
        L.build(params(base_thickness_mm=3.0, hanger="keyhole"), ctx())
    assert "3.6 mm" in str(exc.value) and "keyhole" in str(exc.value)
    with pytest.raises(L.BaseTooThinError):
        L.build(params(base_thickness_mm=4.0, hanger="magnets"), ctx())
    # ... and one millimetre more is fine.
    assert L.build(params(base_thickness_mm=3.6, hanger="keyhole"), ctx()).underside_cut
    assert L.build(params(base_thickness_mm=4.7, hanger="magnets"), ctx()).underside_cut


def test_underside_band_is_only_reported_when_there_is_one() -> None:
    assert T.underside_band_mm(params()) is None
    assert T.underside_pockets(params()) == []
    p = params(base_thickness_mm=5.0, hanger="magnets", underside_mark={"enabled": True})
    assert T.underside_pockets(p) == ["mark", "magnets"]
    assert T.underside_band_mm(p) == (0.0, T.MAGNET_DEPTH_MM)


# --------------------------------------------------------------------------
# 04 stage 1, applied to text
# --------------------------------------------------------------------------


def test_repair_widens_a_stroke_to_its_target() -> None:
    """An engraved groove is a void and gets ONE nozzle; embossed material gets
    04's two-perimeter wall."""
    p = params()
    assert T.text_stroke_target_mm(p, "engrave") == T.min_detail_mm(p)
    assert T.text_stroke_target_mm(p, "emboss") == T.min_wall_mm(p)
    for mode in ("engrave", "emboss"):
        target = T.text_stroke_target_mm(p, mode)
        size = 4.0
        dilation = T.text_dilation_mm("sans", "Chicago", size, p, mode)
        polys, _ = L.text_polygons_mm("Chicago", "sans", size)
        repair = L.repair_text(polys, p, dilation_mm=dilation, target_mm=target)
        assert repair.polygons
        assert repair.narrowest_mm >= thicken.MIN_WALL_FAIL_FACTOR * target
        # the dilation is 04's own (target - w) / 2
        stem = T.text_stem_em("sans", "Chicago") * size
        assert dilation == pytest.approx(max(0.0, (target - stem) / 2.0))


def test_repair_protects_the_counters_it_promised_to_keep() -> None:
    """The appendage pass would grow a light horizontal straight into the
    counter; a one-nozzle core of every counter is put back afterwards.

    Swept over the sizes where the two differ at all: the protection is a no-op
    wherever nothing needs the extra widening, and the point is that it is never
    the counter that pays for it.
    """
    p = params()
    floor = L.text_area_floor(p)
    detail = T.min_detail_mm(p)
    bit = False
    for face, ch in (("serif", "0"), ("serif", "e"), ("mono", "a"), ("sans", "8")):
        for size in (4.5, 5.0, 5.5, 6.0, 7.0):
            if size < T.text_min_size_mm(face, ch, p, "emboss"):
                continue  # the layout refuses this size; nothing to protect
            polys, _ = L.text_polygons_mm(ch, face, size)
            dilation = T.text_dilation_mm(face, ch, size, p, "emboss")
            protected = L.repair_text(
                polys, p, dilation_mm=dilation, target_mm=T.min_wall_mm(p)
            )
            counters = L.counter_widths_mm(protected.polygons, p)
            assert protected.lost_counters == 0, f"{face} {ch!r} at {size}"
            assert counters, f"{face} {ch!r} at {size} lost its counter entirely"
            assert min(counters) >= detail - 0.05, f"{face} {ch!r} at {size}"
            # the same glyph WITHOUT the protection, for comparison
            grown = [
                g
                for poly in polys
                for g in thicken.valid_polygons(L.dilate_glyph(poly, dilation))
            ]
            naive: List[Polygon] = []
            for poly in thicken.snap(grown, thicken.PRINT_GRID_MM):
                naive.extend(
                    thicken.regrid_layer(
                        [thicken.widen_thin_parts(poly, T.min_wall_mm(p), floor)],
                        thicken.PRINT_GRID_MM,
                    )
                )
            naive_counters = L.counter_widths_mm(naive, p)
            if not naive_counters or min(naive_counters) < min(counters) - 1e-6:
                bit = True
    assert bit, "the protection never made a difference: the test proves nothing"


def test_repair_merges_only_the_ridges_a_nozzle_cannot_lay_down() -> None:
    """Two grooves closer than one nozzle are joined; further apart they stay
    two grooves, because merging them would print a smear instead of text."""
    p = params()
    band = shapely.box(-20.0, -3.0, 20.0, 3.0)
    near = [shapely.box(-2.0, -1.0, -0.15, 1.0), shapely.box(0.15, -1.0, 2.0, 1.0)]
    far = [shapely.box(-2.0, -1.0, -0.5, 1.0), shapely.box(0.5, -1.0, 2.0, 1.0)]
    merged_near = L.merge_stroke_ridges(near, band, p)
    merged_far = L.merge_stroke_ridges(far, band, p)
    assert len(thicken.explode(shapely.union_all(merged_near))) == 1, "0.3 mm ridge merged"
    assert len(thicken.explode(shapely.union_all(merged_far))) == 2, "1.0 mm ridge kept"


def test_repair_measures_in_print_millimetres_not_ground_metres() -> None:
    """A letter is a printed object: the map scale must not touch its size."""
    small = L.build(params(engravings=[engraving(size_mm=6.0)]), ctx(scale_mm_per_m=0.01))
    large = L.build(params(engravings=[engraving(size_mm=6.0)]), ctx(scale_mm_per_m=0.5))
    assert small.measures and large.measures
    assert small.measures[0]["size_mm"] == large.measures[0]["size_mm"]
    assert small.measures[0]["narrowest_mm"] == pytest.approx(
        large.measures[0]["narrowest_mm"], abs=1e-9
    )


def test_repair_refuses_when_the_finished_geometry_does_not_hold() -> None:
    """The shared math PREDICTS printability; the bake MEASURES it.  When the
    two disagree the bake cuts nothing and says so."""
    p = params(engravings=[engraving(text="1:10,714", size_mm=5.5, font="serif")])
    fit = T.lettering_layout(p, ctx()).engravings[0].fit
    assert not fit.refused, "the prediction lets this through"
    geometry = L.build(p, ctx())
    assert not geometry.cut, "the measurement does not"
    assert any("was not cut" in w for w in geometry.warnings)


def size_in(warning: str) -> float:
    """The size a refusal names, from `it prints at 5.75 mm`."""
    match = re.search(r"it prints at ([0-9.]+) mm", warning)
    assert match, f"the refusal named no size: {warning}"
    return float(match.group(1))


def test_build_refusal_names_a_size_that_really_cuts() -> None:
    """v2-03 finding 4: the refusal used to say "try a larger size" - no number.

    Five consecutive legal sizes of this string were refused with a measured
    width that did not even trend toward the threshold (0.30 -> 0.31 -> 0.29),
    so "larger" was not advice.  The size named now is MEASURED: the same
    geometry chain, at that size, through the same gate.
    """
    # "1:1,000" rather than "1:10,714": on the 4 mm band the sight-edge rebate
    # leaves ([V3.1-P2-2]) the original string has no legal size in this face
    # at all (`test_build_refusal_admits_it_when_no_size_works` keeps that
    # case), and the point here is a refusal that names a MEASURED size.
    p = params(engravings=[engraving(text="1:1,000", size_mm=3.0, font="serif")])
    geometry = L.build(p, ctx())
    assert not geometry.cut
    refusal = next(w for w in geometry.warnings if "was not cut" in w)
    named = size_in(refusal)

    # the named size cuts, and the one just under it does not
    works = params(engravings=[engraving(text="1:1,000", size_mm=named, font="serif")])
    assert L.build(works, ctx()).cut, f"{named} mm was named but does not cut"
    under = round(named - L.TEXT_SEARCH_FINE_MM, 3)
    lower = params(engravings=[engraving(text="1:1,000", size_mm=under, font="serif")])
    assert not L.build(lower, ctx()).cut, f"{under} mm cuts too, so {named} is not the smallest"


def test_build_refusal_admits_it_when_no_size_works(monkeypatch) -> None:
    """With nowhere left to look the message says so, and says how far it looked
    - it never quotes a ceiling the search did not reach."""
    monkeypatch.setattr(L, "TEXT_SEARCH_LADDER_MM", (0.25, 0.5))
    p = params(engravings=[engraving(text="1:10,714", size_mm=3.5, font="serif")])
    geometry = L.build(p, ctx())
    refusal = next(w for w in geometry.warnings if "was not cut" in w)
    assert "no size up to 4.00 mm" in refusal, refusal
    assert "plainer face" in refusal


def test_build_refusal_search_is_bounded() -> None:
    """The search is capped, so a refusal cannot turn into a minute of geometry.

    Bounded by construction: at most one probe per ladder rung plus
    `TEXT_SEARCH_REFINE_STEPS`, and every probe is cached by fitted size.
    """
    assert len(L.TEXT_SEARCH_LADDER_MM) + L.TEXT_SEARCH_REFINE_STEPS <= 24
    assert L.TEXT_SEARCH_LADDER_MM == tuple(sorted(L.TEXT_SEARCH_LADDER_MM))
    assert L.TEXT_SEARCH_MAX_MM == T.TEXT_MAX_SIZE_MM, "never name a size the editor rejects"


def test_build_counter_refusal_also_goes_through_the_measured_search(monkeypatch) -> None:
    """The counter branch used to name `fit.min_size_mm` - a size the LAYOUT had
    just accepted and the geometry had just refused (the audit's "aggravating"
    note).  It goes through the same measured search now.

    No real face/nozzle/size in the sweep reaches this branch (the layout's
    counter prediction is the conservative one), so the counter measurement is
    faulted here to reach it.
    """
    monkeypatch.setattr(L, "counter_widths_mm", lambda *a, **k: [0.01])
    monkeypatch.setattr(L, "TEXT_SEARCH_LADDER_MM", (0.25,))
    p = params(engravings=[engraving(text="CHICAGO", size_mm=5.0)])
    assert not T.lettering_layout(p, ctx()).engravings[0].fit.refused
    geometry = L.build(p, ctx())
    assert not geometry.cut
    refusal = next(w for w in geometry.warnings if "was not cut" in w)
    assert "left a counter 0.01 mm wide" in refusal
    assert "no size up to 5.25 mm" in refusal, refusal


# --------------------------------------------------------------------------
# The Stage 4 rows
# --------------------------------------------------------------------------


def lip_model(p: PrintParams, cutters: List[Polygon] = (), depth: float = 0.4):
    """A bare plate + lip with the given polygons engraved into the lip top."""
    solid = extrude.base_plate(p)
    lip = extrude.frame_lip(p)
    solid = Manifold.batch_boolean([solid, lip], OpType.Add)
    lip_top = T.base_top_mm(p) + T.FRAME_LIP_MM
    if len(cutters):
        cutter = extrude.extrude_polygons(list(cutters), lip_top - depth, lip_top + 0.5)
        solid = Manifold.batch_boolean([solid, cutter], OpType.Subtract)
    mesh = solid.to_mesh64()
    import numpy as np

    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vert_properties)[:, :3].astype(float),
        faces=np.asarray(mesh.tri_verts).astype(int),
        process=False,
        validate=False,
    )


def test_build_engraved_rim_is_the_margin_less_the_separation() -> None:
    """v2-03 finding 8: the rim is `margin - 0.02 mm`, not the margin.

    The ink is clipped to `lip_keep_region` and the cutter is THEN grown by
    `thicken.LAYER_SEPARATION_MM` so it cannot share a face with the lip it
    cuts, which pushes it 0.02 mm back outside the keep region.  DECISIONS
    [V2-P5] claimed the clip guarantees the full margin; it guarantees the
    margin for embossed ink (which is not separated) and the margin less the
    separation for engraved ink.  Harmless - 0.48 mm is still more than a
    nozzle - but the invariant as written was false, so here is the true one.
    """
    # Four lines that still cut on the 4 mm band the sight-edge rebate leaves
    # ([V3.1-P2-2]): a serif "{scale}" and an embossed "{date}" no longer fit
    # it, and this test is about the rim, not about which strings fit.
    p = params(
        city_label="Chicago",
        engravings=[
            engraving(edge="top", text="{city}", size_mm=8.0),
            engraving(edge="bottom", text="{date}", size_mm=8.0, font="mono"),
            engraving(edge="left", text="{city}", size_mm=8.0, font="serif"),
            engraving(edge="right", text="LOOP", size_mm=8.0, mode="emboss"),
        ],
    )
    geom = L.build(p, ctx())
    assert len(geom.cut) == 3 and len(geom.emboss) == 1
    half = float(p.plate_mm) / 2.0
    margin = T.lip_text_margin_mm(p)
    engraved_limit = half - margin + thicken.LAYER_SEPARATION_MM
    reach = []
    for solid in geom.cut:
        box = solid.bounding_box()
        far = max(abs(box[0]), abs(box[1]), abs(box[3]), abs(box[4]))
        assert far <= engraved_limit + 1e-6, f"{far} past {engraved_limit}"
        reach.append(far)
    assert max(reach) == pytest.approx(engraved_limit, abs=1e-3), (
        "the bound has to be TIGHT, or this test would pass on any inset"
    )
    assert max(reach) == pytest.approx(89.52, abs=1e-3)

    box = geom.emboss[0].bounding_box()
    far = max(abs(box[0]), abs(box[1]), abs(box[3]), abs(box[4]))
    assert far <= half - margin + 1e-6, "embossed ink is not separated, so it keeps the margin"
    assert far == pytest.approx(89.5, abs=2e-3)


def test_validator_lettering_row_appears_only_with_text() -> None:
    p_plain = params()
    plain = validators.validate(lip_model(p_plain), p_plain, slices=0)
    assert plain.get("lettering") is None
    assert plain.get("base_floor") is None
    p_text = params(engravings=[engraving()])
    text = validators.validate(lip_model(p_text), p_text, slices=0)
    assert text.get("lettering") is not None


def test_validator_lettering_fails_when_an_accepted_piece_left_no_stroke() -> None:
    """v2-07 audit finding 2: ``0.000 mm stroke`` is not a pass.

    The row only ever measured how NARROW the strokes were, so a bake that asked
    for every ornament and cut none of them reported
    ``lettering  PASS  0.000 mm stroke`` - and ``make gate-v2``'s
    ``lettering +PASS`` grep accepted it.  A piece the SHARED LAYOUT agreed to
    cut has to leave material at its own probe band; a piece the layout refused
    keeps the zero honest, because refusing text is a documented outcome.
    """
    p = params(engravings=[engraving()], north_arrow={"enabled": True})
    assert [label for _z, _mode, label in validators.lettering_expected_pieces(p)] == [
        "engraving 1 (top)",
        "the north arrow",
    ]
    empty = validators.validate_lettering(lip_model(p), p)[0]
    assert not empty.passed, empty.message
    assert "measured 0 strokes" in empty.message
    assert "engraving 1 (top)" in empty.message and "the north arrow" in empty.message
    assert str(empty.value).startswith("0 strokes of 2 piece(s)")

    # The same bare lip, but at a size the shared math refuses (3 mm closes the
    # counter of the `a` in "Chicago" at a 0.4 mm nozzle): nothing was promised,
    # so nothing missing.
    refused = params(engravings=[engraving(size_mm=3.0)])
    assert validators.lettering_expected_pieces(refused) == []
    row = validators.validate_lettering(lip_model(refused), refused)[0]
    assert row.passed, row.message
    assert str(row.value).startswith("0 strokes of 0 piece(s)")


def test_validator_lettering_fails_a_stroke_thinner_than_a_nozzle() -> None:
    """A groove under one nozzle does not appear at all; the row says so."""
    p = params(engravings=[engraving()])
    band_y = T.edge_band_center_mm(p, "top")[1]
    good = shapely.box(-10.0, band_y - 1.0, -5.0, band_y + 1.0)
    thin = shapely.box(5.0, band_y - 1.0, 5.2, band_y + 1.0)  # 0.2 mm groove
    ok = validators.validate_lettering(lip_model(p, [good]), p)
    assert ok and ok[0].passed, ok[0].message
    bad = validators.validate_lettering(lip_model(p, [good, thin]), p)
    assert bad and not bad[0].passed
    assert "engraved stroke" in bad[0].message


def test_validator_lettering_fails_a_ridge_thinner_than_a_nozzle() -> None:
    """Two grooves 0.2 mm apart leave a ridge of lip no nozzle can lay down."""
    p = params(engravings=[engraving()])
    band_y = T.edge_band_center_mm(p, "top")[1]
    pair = [
        shapely.box(-6.0, band_y - 1.5, -0.6, band_y + 1.5),
        shapely.box(-0.4, band_y - 1.5, 6.0, band_y + 1.5),
    ]
    report = validators.validate_lettering(lip_model(p, pair), p)
    assert report and not report[0].passed
    assert "lip ridge" in report[0].message


def test_validator_lettering_holds_the_embossed_rule_to_a_full_wall() -> None:
    """Embossed strokes are MATERIAL and get 04's two perimeters."""
    p = params(engravings=[engraving(mode="emboss", depth_mm=0.4)])
    lip_top = T.base_top_mm(p) + T.FRAME_LIP_MM
    band_y = T.edge_band_center_mm(p, "top")[1]
    solid = Manifold.batch_boolean(
        [extrude.base_plate(p), extrude.frame_lip(p)], OpType.Add
    )
    thin = extrude.extrude_polygons(
        [shapely.box(-6.0, band_y - 0.25, 6.0, band_y + 0.25)],
        lip_top - T.BUILDING_OVERLAP_MM,
        lip_top + 0.4,
    )
    solid = Manifold.batch_boolean([solid, thin], OpType.Add)
    mesh_data = solid.to_mesh64()
    import numpy as np

    mesh = trimesh.Trimesh(
        vertices=np.asarray(mesh_data.vert_properties)[:, :3].astype(float),
        faces=np.asarray(mesh_data.tri_verts).astype(int),
        process=False,
        validate=False,
    )
    report = validators.validate_lettering(mesh, p)
    assert report and not report[0].passed
    assert "embossed stroke" in report[0].message
    assert f"{thicken.MIN_WALL_FAIL_FACTOR * T.min_wall_mm(p):.3f}" in str(
        report[0].threshold
    )


def test_validator_base_floor_fails_when_a_pocket_breaches_the_plate() -> None:
    """Cut a keyhole 2 mm into a 2.5 mm plate and the row names the breach."""
    p = params(base_thickness_mm=2.5, hanger="keyhole", water=False, road_mode="off")
    solid = extrude.base_plate(p)
    pocket = extrude.extrude_polygons([L.keyhole_polygon(p)], -0.5, T.KEYHOLE_DEPTH_MM)
    solid = Manifold.batch_boolean([solid, pocket], OpType.Subtract)
    import numpy as np

    mesh_data = solid.to_mesh64()
    mesh = trimesh.Trimesh(
        vertices=np.asarray(mesh_data.vert_properties)[:, :3].astype(float),
        faces=np.asarray(mesh_data.tri_verts).astype(int),
        process=False,
        validate=False,
    )
    report = validators.validate_base_floor(mesh, p)
    assert report and not report[0].passed
    assert "2.5 mm" in report[0].message and "3 mm" in report[0].message
    # A plate thick enough for the same pocket passes.
    thick = params(base_thickness_mm=4.0, hanger="keyhole", water=False, road_mode="off")
    solid = Manifold.batch_boolean(
        [extrude.base_plate(thick), extrude.extrude_polygons(
            [L.keyhole_polygon(thick)], -0.5, T.KEYHOLE_DEPTH_MM
        )],
        OpType.Subtract,
    )
    mesh_data = solid.to_mesh64()
    ok = trimesh.Trimesh(
        vertices=np.asarray(mesh_data.vert_properties)[:, :3].astype(float),
        faces=np.asarray(mesh_data.tri_verts).astype(int),
        process=False,
        validate=False,
    )
    good = validators.validate_base_floor(ok, thick)
    assert good and good[0].passed, good[0].message


def test_validator_base_floor_catches_a_recess_eating_the_roof() -> None:
    """The arithmetic cannot see a lake sitting over a magnet pocket; the
    slices can."""
    p = params(base_thickness_mm=4.7, hanger="magnets", water=False, road_mode="off")
    solid = extrude.base_plate(p)
    pockets = extrude.extrude_polygons(L.magnet_polygons(p), -0.5, T.MAGNET_DEPTH_MM)
    solid = Manifold.batch_boolean([solid, pockets], OpType.Subtract)
    import numpy as np

    def to_mesh(m):
        d = m.to_mesh64()
        return trimesh.Trimesh(
            vertices=np.asarray(d.vert_properties)[:, :3].astype(float),
            faces=np.asarray(d.tri_verts).astype(int),
            process=False,
            validate=False,
        )

    assert validators.validate_base_floor(to_mesh(solid), p)[0].passed
    # now take 1 mm off the top exactly above one pocket
    x, y = T.magnet_centers_mm(p)[0]
    bite = extrude.extrude_polygons(
        [shapely.box(x - 5.0, y - 5.0, x + 5.0, y + 5.0)],
        T.base_top_mm(p) - 1.0,
        T.base_top_mm(p) + 1.0,
    )
    breached = Manifold.batch_boolean([solid, bite], OpType.Subtract)
    report = validators.validate_base_floor(to_mesh(breached), p)
    assert not report[0].passed
    assert "magnets pocket has no plate over it" in report[0].message


def underside_model(p: PrintParams, pockets: List[Polygon], depth: float):
    """A bare plate + lip with ``pockets`` cut into the BOTTOM of the plate."""
    solid = Manifold.batch_boolean([extrude.base_plate(p), extrude.frame_lip(p)], OpType.Add)
    cutter = extrude.extrude_polygons(list(pockets), -0.5, depth)
    solid = Manifold.batch_boolean([solid, cutter], OpType.Subtract)
    mesh = solid.to_mesh64()
    import numpy as np

    return trimesh.Trimesh(
        vertices=np.asarray(mesh.vert_properties)[:, :3].astype(float),
        faces=np.asarray(mesh.tri_verts).astype(int),
        process=False,
        validate=False,
    )


def test_validator_min_wall_skips_only_the_underside_band() -> None:
    """The min-wall probe's "is this a wall?" test looks UP, which cannot judge
    a pocket cut from below; those slices go to base_floor and lettering.

    Both halves are exercised: a model WITH a pocket (the skip path, which this
    test used to leave untested by building a model that had none - v2-03 audit,
    finding 10) and a model without one.
    """
    p = params(base_thickness_mm=5.0, hanger="magnets")
    band = T.underside_band_mm(p)
    assert band == (0.0, T.MAGNET_DEPTH_MM)
    pocketed = underside_model(p, L.magnet_polygons(p), T.MAGNET_DEPTH_MM)
    report = validators.validate(pocketed, p)
    row = report.get("min_wall")
    assert row.passed, row.message
    assert "underside pocket band" in row.message, "the skip has to be declared"
    assert "base_floor and lettering" in row.message

    plain = params(base_thickness_mm=5.0)
    assert T.underside_band_mm(plain) is None
    mesh = lip_model(plain)
    report = validators.validate(mesh, plain)
    assert report.get("min_wall").passed
    assert "underside pocket band" not in report.get("min_wall").message


def test_validator_lettering_measures_the_underside_marks_own_strokes() -> None:
    """v2-03 finding 10: the mark's strokes were measured by no Stage 4 row.

    `min_wall` skips the pocket band, and `base_floor` only asks whether the
    plate above each pocket is still solid - so a sub-nozzle groove on the
    underside reached the file unmeasured.  The `lettering` row probes that band
    now, with the same floors it uses on the lip.
    """
    p = params(base_thickness_mm=4.0, underside_mark={"enabled": True, "template": "X"})
    assert validators.underside_probe_zs(p) == [(T.UNDERSIDE_MARK_DEPTH_MM / 2.0, "underside")]

    ok = underside_model(p, [shapely.box(-10.0, -1.0, 10.0, 1.0)], T.UNDERSIDE_MARK_DEPTH_MM)
    row = validators.validate_lettering(ok, p)[0]
    assert row.passed, row.message
    assert "on 1 text band(s)" in row.message

    # a groove one third of a nozzle wide is a stroke the printer cannot cut
    thin = underside_model(
        p, [shapely.box(-10.0, -0.06, 10.0, 0.06)], T.UNDERSIDE_MARK_DEPTH_MM
    )
    bad = validators.validate_lettering(thin, p)[0]
    assert not bad.passed
    assert "underside stroke" in bad.message

    # ... and with no mark the band is not probed at all
    assert validators.underside_probe_zs(params(base_thickness_mm=4.0)) == []


# --------------------------------------------------------------------------
# The parity fixture
# --------------------------------------------------------------------------

PARITY_CASES: List[Dict[str, Any]] = [
    {
        "name": "every-edge",
        "rotation_deg": 0.0,
        "params": {
            "city_label": "Chicago",
            "engravings": [
                {"edge": "top", "text": "{city}", "size_mm": 6.0, "font": "sans"},
                {
                    "edge": "bottom",
                    "text": "{coords}",
                    "size_mm": 6.0,
                    "font": "mono",
                    "align": "end",
                },
                {"edge": "left", "text": "{scale}", "size_mm": 6.0, "font": "serif"},
                {
                    "edge": "right",
                    "text": "{date}",
                    "size_mm": 6.0,
                    "font": "sans",
                    "mode": "emboss",
                },
            ],
        },
    },
    {
        "name": "aligns-on-one-edge",
        "rotation_deg": 0.0,
        "params": {
            "engravings": [
                {"edge": "top", "text": "START", "size_mm": 5.0, "align": "start"},
                {"edge": "left", "text": "CENTRE", "size_mm": 5.0, "align": "center"},
                {"edge": "right", "text": "END", "size_mm": 5.0, "align": "end"},
            ],
        },
    },
    {
        "name": "auto-fit-shrinks",
        "rotation_deg": 0.0,
        "params": {
            "plate_mm": 100,
            "engravings": [
                # Long enough that the EDGE, not the lip band, is what shrinks
                # it - and still printable at the size that fits.
                {
                    "edge": "bottom",
                    "text": "FOR ANNA AND TOM 2026",
                    "size_mm": 8.0,
                }
            ],
        },
    },
    {
        "name": "refused-counters",
        "rotation_deg": 0.0,
        "params": {
            "engravings": [
                {"edge": "top", "text": "Chicago", "size_mm": 1.5, "font": "serif"},
                {"edge": "bottom", "text": "Chicago", "size_mm": 5.0, "font": "mono"},
            ],
        },
    },
    {
        "name": "north-arrow-ne-rotated",
        "rotation_deg": 29.0,
        "params": {"north_arrow": {"enabled": True, "corner": "ne", "size_mm": 4.0}},
    },
    {
        "name": "north-arrow-nw-rotated",
        "rotation_deg": 29.0,
        "params": {"north_arrow": {"enabled": True, "corner": "nw", "size_mm": 6.0}},
    },
    {
        "name": "north-arrow-sw-rotated",
        "rotation_deg": 29.0,
        "params": {"north_arrow": {"enabled": True, "corner": "sw", "size_mm": 2.0}},
    },
    {
        "name": "scale-bar-auto-chicago",
        "rotation_deg": 0.0,
        "ctx": {"scale_mm_per_m": 168.0 / 1800.0},  # 1:10,714
        "params": {
            "scale_bar": {"enabled": True, "edge": "bottom", "length_mode": "auto"},
            "engravings": [{"edge": "bottom", "text": "{radius}", "size_mm": 5.0}],
        },
    },
    {
        "name": "scale-bar-auto-wide",
        "rotation_deg": 0.0,
        "ctx": {"scale_mm_per_m": 168.0 / 3960.0, "radius_m": 1980.0},  # 1:23,571
        "params": {
            "scale_bar": {"enabled": True, "edge": "top", "length_mode": "auto"},
        },
    },
    {
        "name": "scale-bar-fixed-clamped",
        "rotation_deg": 0.0,
        "params": {
            "scale_bar": {
                "enabled": True,
                "edge": "left",
                "length_mode": "fixed",
                "length_m": 5000.0,
            },
        },
    },
    {
        "name": "underside-and-hanger",
        "rotation_deg": 0.0,
        "params": {
            "base_thickness_mm": 5.0,
            "hanger": "magnets",
            "city_label": "Chicago",
            "underside_mark": {"enabled": True, "template": "{city} {scale} {date}"},
        },
    },
    {
        "name": "frame-off-skips-the-lip",
        "rotation_deg": 0.0,
        "params": {
            "frame": False,
            "base_thickness_mm": 4.0,
            "hanger": "keyhole",
            "engravings": [{"edge": "top", "text": "Chicago", "size_mm": 6.0}],
            "north_arrow": {"enabled": True},
            "scale_bar": {"enabled": True},
            "underside_mark": {"enabled": True, "template": "made by hand"},
        },
    },
    {
        "name": "fat-nozzle-refuses-everything",
        "rotation_deg": 0.0,
        "params": {
            "nozzle_mm": 0.8,
            "engravings": [{"edge": "top", "text": "Chicago", "size_mm": 8.0}],
        },
    },
]


def build_parity() -> Dict[str, Any]:
    cases = []
    for case in PARITY_CASES:
        p = PrintParams(**case["params"])
        context = ctx(**case.get("ctx", {}))
        cases.append(
            {
                "name": case["name"],
                "params": p.model_dump(mode="json"),
                "ctx": {
                    "lat": context.lat,
                    "lon": context.lon,
                    "scale_mm_per_m": context.scale_mm_per_m,
                    "radius_m": context.radius_m,
                    "date": context.date,
                    "buildings": context.buildings,
                    "city": context.city,
                },
                "rotation_deg": case["rotation_deg"],
                "layout": T.lettering_layout_json(p, context, case["rotation_deg"]),
            }
        )
    return {
        "_comment": (
            "GENERATED by services/bake/tests/test_lettering.py. The contract "
            "between app/geom/transform.py's lettering layout and apps/web/lib/"
            "transform.ts; both test suites assert against it. Regenerate with "
            "FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_lettering.py"
        ),
        "cases": cases,
    }


def test_parity_lettering_matches_the_committed_fixture() -> None:
    fresh = build_parity()
    if os.environ.get("FRAMECRAFT_WRITE_PARITY") == "1":
        LETTERING_EXPECTED.write_text(
            json.dumps(fresh, indent=2, sort_keys=False) + "\n", encoding="utf-8"
        )
    assert LETTERING_EXPECTED.is_file(), (
        "fixtures/lettering-expected.json is missing; regenerate with "
        "FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_lettering.py"
    )
    committed = json.loads(LETTERING_EXPECTED.read_text(encoding="utf-8"))
    assert committed == fresh


EMBOSS_GAPS_EXPECTED = FIXTURES / "emboss-gaps-expected.json"

#: The emboss gap merge's decisions, pinned for both engines ([V3.1-P2-5]).
#: Every case is one embossed frame-edge line at the contract defaults; the
#: decision is built or refused, how many letter pairs were joined, and whether
#: the refusal was the fusion rule.  Strings are literal so the token context
#: cannot enter.  Chosen clear of the area floor: the disc opening both
#: libraries take reads the same stretch a few hundredths of a mm^2 apart, and
#: a stretch AT the floor (sans "HELLO WORLD" at 8 mm, 0.157 mm^2 in GEOS
#: against 0.194 in Clipper2) is a case the two decide differently.
EMBOSS_GAP_CASES: List[Dict[str, Any]] = [
    {"name": "sans-date-joined", "edge": "right", "text": "2026-09-06", "font": "sans", "size_mm": 8.0},
    {"name": "mono-date-joined", "edge": "right", "text": "2026-09-06", "font": "mono", "size_mm": 8.0},
    {"name": "serif-date-joined", "edge": "right", "text": "2026-09-06", "font": "serif", "size_mm": 8.0},
    {"name": "sans-stems-fuse", "edge": "right", "text": "Illinois", "font": "sans", "size_mm": 8.0},
    {"name": "mono-stems-clear", "edge": "right", "text": "Illinois", "font": "mono", "size_mm": 8.0},
    {"name": "sans-il-fuses", "edge": "right", "text": "Milano", "font": "sans", "size_mm": 8.0},
    {"name": "sans-bowls-joined", "edge": "right", "text": "Brooklyn", "font": "sans", "size_mm": 8.0},
    {"name": "sans-many-joined", "edge": "right", "text": "Kalamazoo", "font": "sans", "size_mm": 8.0},
    {"name": "sans-two-joined", "edge": "right", "text": "Toronto", "font": "sans", "size_mm": 8.0},
    {"name": "sans-caps-one-joined", "edge": "right", "text": "LOOP", "font": "sans", "size_mm": 8.0},
    {"name": "sans-caps-clear", "edge": "bottom", "text": "FRAMECRAFT", "font": "sans", "size_mm": 5.0},
]


#: Lines the two engines are KNOWN to decide differently, pinned rather than
#: left out (the `matrix.probes.ts:KNOWN_DEFECTS` idiom: the row, the reason
#: beside it, each side held to ITS number so a change on either side is a red
#: test).  Kept apart from ``EMBOSS_GAP_CASES`` so the agreeing count cannot be
#: diluted.  ``engine_joined`` is the browser engine's count, a literal here
#: because only `text.test.ts` can measure it; the reference's own count is
#: measured at generation and pinned beside it.
EMBOSS_GAP_DIVERGENCES: List[Dict[str, Any]] = [
    {
        "name": "sans-hello-world-at-the-floor",
        "edge": "right",
        "text": "HELLO WORLD",
        "font": "sans",
        "size_mm": 8.0,
        "engine_joined": 2,
        "reason": (
            "one stretch of void sits AT the text area floor: the disc opening "
            "reads it 0.157 mm^2 in GEOS and 0.194 in Clipper2 against a 0.16 "
            "floor, so the reference leaves that pair apart and the engine joins "
            "it. A count difference only: at 0.31 mm wide the stretch is 0.5 to "
            "0.6 mm long, far under the 0.4 em fusion rule, and a stretch under "
            "the floor is under the gate's floor too, so built/refused cannot move."
        ),
    },
]


def _emboss_line(case: Dict[str, Any]) -> Dict[str, Any]:
    return engraving(
        edge=case["edge"], text=case["text"], font=case["font"], size_mm=case["size_mm"], mode="emboss"
    )


def _emboss_decision(line: Dict[str, Any]) -> Dict[str, Any]:
    p = params(engravings=[line])
    geom = L.build(p, ctx(), rotation_deg=0.0)
    built = bool(geom.emboss)
    return {
        "built": built,
        "joined": int(geom.measures[0]["joined"]) if built else 0,
        "fused": any("one shape rather than as two letters" in w for w in geom.warnings),
    }


def build_emboss_parity() -> Dict[str, Any]:
    cases = []
    for case in EMBOSS_GAP_CASES:
        line = _emboss_line(case)
        cases.append({"name": case["name"], "engravings": [line], "expect": _emboss_decision(line)})
    divergences = []
    for case in EMBOSS_GAP_DIVERGENCES:
        line = _emboss_line(case)
        decision = _emboss_decision(line)
        divergences.append(
            {
                "name": case["name"],
                "engravings": [line],
                "reason": case["reason"],
                "expect": {
                    "built": decision["built"],
                    "fused": decision["fused"],
                    "reference_joined": decision["joined"],
                    "engine_joined": int(case["engine_joined"]),
                },
            }
        )
    return {
        "_comment": (
            "GENERATED by services/bake/tests/test_lettering.py. The emboss gap "
            "merge's decisions ([V3.1-P2-5]): app/geom/lettering.py's build and "
            "apps/web/lib/engine/solid/lettering.ts's buildLettering must agree "
            "on built/refused, the pairs joined and the fusion rule for each line "
            "in `cases`; `divergences` are the lines they are KNOWN to count "
            "differently, each side held to its own number, with the reason. "
            "Regenerate with FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_lettering.py"
        ),
        "cases": cases,
        "divergences": divergences,
    }


def test_parity_emboss_gaps_match_the_committed_fixture() -> None:
    fresh = build_emboss_parity()
    if os.environ.get("FRAMECRAFT_WRITE_PARITY") == "1":
        EMBOSS_GAPS_EXPECTED.write_text(
            json.dumps(fresh, indent=2, sort_keys=False) + "\n", encoding="utf-8"
        )
    assert EMBOSS_GAPS_EXPECTED.is_file(), (
        "fixtures/emboss-gaps-expected.json is missing; regenerate with "
        "FRAMECRAFT_WRITE_PARITY=1 uv run pytest tests/test_lettering.py"
    )
    committed = json.loads(EMBOSS_GAPS_EXPECTED.read_text(encoding="utf-8"))
    assert committed == fresh


def test_parity_emboss_gap_divergences_still_diverge() -> None:
    """A known divergence is a row expected to differ, with the reason beside
    it.  The reference is held to ITS count here (the regeneration above pins
    it), and a row whose two counts have become equal is stale: the engines
    agree on it now and it belongs in ``EMBOSS_GAP_CASES``, where the
    agreement is what gets pinned."""
    data = json.loads(EMBOSS_GAPS_EXPECTED.read_text(encoding="utf-8"))
    rows = {row["name"]: row for row in data["divergences"]}
    assert set(rows) == {case["name"] for case in EMBOSS_GAP_DIVERGENCES}
    for case in EMBOSS_GAP_DIVERGENCES:
        expect = rows[case["name"]]["expect"]
        assert expect["reference_joined"] != expect["engine_joined"], (
            f"{case['name']}: the engines agree now; move it to EMBOSS_GAP_CASES"
        )
        # Bounded to the count: both engines build it, and neither fuses it.
        assert expect["built"] and not expect["fused"], case["name"]
        assert rows[case["name"]]["reason"] == case["reason"]


def test_parity_emboss_gaps_fixture_is_not_vacuous() -> None:
    """Every outcome the mirror could get wrong has to be represented: a join
    in each face, a fusion refusal, a clean line in each of two faces, and a
    line with several joins."""
    data = json.loads(EMBOSS_GAPS_EXPECTED.read_text(encoding="utf-8"))
    cases = {c["name"]: c["expect"] for c in data["cases"]}
    assert len(cases) == len(EMBOSS_GAP_CASES) >= 11
    for name in ("sans-date-joined", "mono-date-joined", "serif-date-joined"):
        assert cases[name]["built"] and cases[name]["joined"] >= 1 and not cases[name]["fused"], name
    for name in ("sans-stems-fuse", "sans-il-fuses"):
        assert not cases[name]["built"] and cases[name]["fused"], name
    for name in ("mono-stems-clear", "sans-caps-clear"):
        assert cases[name]["built"] and cases[name]["joined"] == 0, name
    assert cases["sans-many-joined"]["joined"] >= 3
    assert cases["sans-caps-one-joined"]["joined"] == 1


def test_parity_lettering_fixture_is_not_vacuous() -> None:
    """Every branch the mirror could get wrong has to be represented."""
    data = json.loads(LETTERING_EXPECTED.read_text(encoding="utf-8"))
    cases = {c["name"]: c for c in data["cases"]}
    assert len(cases) == len(PARITY_CASES) >= 13

    edges = cases["every-edge"]["layout"]["engravings"]
    assert [e["edge"] for e in edges] == ["top", "bottom", "left", "right"]
    assert [e["placement"]["rotation_deg"] for e in edges] == [0.0, 0.0, 90.0, -90.0]
    assert {e["fit"]["face"] for e in edges} == {"sans", "mono", "serif"}
    assert any(e["mode"] == "emboss" for e in edges)

    aligns = cases["aligns-on-one-edge"]["layout"]["engravings"]
    assert {e["align"] for e in aligns} == {"start", "center", "end"}

    shrunk = cases["auto-fit-shrinks"]["layout"]["engravings"][0]
    assert shrunk["fit"]["size_mm"] < shrunk["fit"]["requested_mm"]
    assert any("reduced from" in w for w in shrunk["fit"]["warnings"])
    assert not shrunk["fit"]["refused"], "auto-fit never refuses on length alone"

    refused = cases["refused-counters"]["layout"]["engravings"]
    assert refused[0]["fit"]["refused"] and "counter" in refused[0]["fit"]["reason"]
    assert not refused[1]["fit"]["refused"], "the same string at 5 mm is fine"

    for name, corner, rotation in (
        # +29, not -29: `to_local` turns the ground CCW by +rotation_deg, so the
        # arrow is turned the same way to land on true north (v2-03 finding 1).
        ("north-arrow-ne-rotated", "ne", 29.0),
        ("north-arrow-nw-rotated", "nw", 29.0),
        ("north-arrow-sw-rotated", "sw", 29.0),
    ):
        arrow = cases[name]["layout"]["north_arrow"]
        assert arrow["enabled"] and arrow["corner"] == corner
        assert arrow["placement"]["rotation_deg"] == rotation
    ne = cases["north-arrow-ne-rotated"]["layout"]["north_arrow"]["placement"]
    nw = cases["north-arrow-nw-rotated"]["layout"]["north_arrow"]["placement"]
    sw = cases["north-arrow-sw-rotated"]["layout"]["north_arrow"]["placement"]
    assert ne["anchor_x"] > 0 and ne["anchor_y"] > 0
    assert nw["anchor_x"] < 0 and nw["anchor_y"] > 0
    assert sw["anchor_x"] < 0 and sw["anchor_y"] < 0

    chicago = cases["scale-bar-auto-chicago"]["layout"]["scale_bar"]
    wide = cases["scale-bar-auto-wide"]["layout"]["scale_bar"]
    fixed = cases["scale-bar-fixed-clamped"]["layout"]["scale_bar"]
    assert chicago["length_m"] == 200.0 and chicago["label"] == "200 m"
    assert wide["length_m"] == 500.0 and wide["label"] == "500 m"
    for bar in (chicago, wide):
        assert T.SCALE_BAR_MIN_MM <= bar["bar_mm"] <= T.SCALE_BAR_MAX_MM
    assert fixed["length_m"] != 5000.0 and any(
        "window" in w for w in fixed["warnings"]
    )
    # the bar and the engraving share the bottom edge without overlapping
    shared = cases["scale-bar-auto-chicago"]["layout"]["engravings"][0]
    assert shared["placement"]["anchor_x"] > chicago["placement"]["anchor_x"]

    mark = cases["underside-and-hanger"]["layout"]["underside_mark"]
    assert mark["enabled"] and mark["placement"]["mirror_x"] is True
    assert mark["depth_mm"] == T.UNDERSIDE_MARK_DEPTH_MM

    off = cases["frame-off-skips-the-lip"]["layout"]
    assert off["north_arrow"]["enabled"] is False
    assert off["scale_bar"]["enabled"] is False
    assert off["underside_mark"]["enabled"] is True
    assert any("the frame is off" in w for w in off["warnings"])

    fat = cases["fat-nozzle-refuses-everything"]["layout"]["engravings"][0]
    assert fat["fit"]["refused"], "a 0.8 mm nozzle cannot cut 6 mm type"


# --------------------------------------------------------------------------
# The pipeline
# --------------------------------------------------------------------------


def test_pipeline_skips_the_whole_lettering_path_for_v1_parameters() -> None:
    """A v1 parameter set must not even open a font: that is what keeps the v1
    golden byte-identical."""
    assert bake_pipeline._wants_lettering(params()) is False
    for p in (
        params(engravings=[engraving()]),
        params(north_arrow={"enabled": True}),
        params(scale_bar={"enabled": True}),
        params(underside_mark={"enabled": True}),
        params(base_thickness_mm=4.0, hanger="keyhole"),
    ):
        assert bake_pipeline._wants_lettering(p) is True


def test_pipeline_token_context_comes_from_the_scene_and_the_params() -> None:
    from app.contracts import Bounds, Center, SceneGraph, SceneRequest, Stats

    scene = SceneGraph(
        bounds=Bounds(min_x=-900.0, min_y=-900.0, max_x=900.0, max_y=900.0),
        center=Center(lat=41.8827, lon=-87.6233),
        buildings=[],
        roads=[],
        water=[],
        green=[],
        trees=[],
        stats=Stats(building_count=994, coverage="good", height_tag_ratio=0.1),
    )
    p = params(city_label="Chicago")
    context = bake_pipeline.token_context(scene, p, date="2026-08-30")
    assert context.city == "Chicago"
    assert context.radius_m == 900.0
    assert context.buildings == 994
    assert context.scale_mm_per_m == pytest.approx(168.0 / 1800.0)
    assert TOK.expand_tokens("{city} {scale} {date}", context) == (
        "Chicago 1:10,714 2026-08-30"
    )
    # The date defaults to today's UTC date, in ISO form.
    import datetime

    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    assert bake_pipeline.token_context(scene, p).date == today


# ---------------------------------------------------------------------------
# The attribution row (v3 phase 7, DECISIONS [V3-P7-A8])
# ---------------------------------------------------------------------------


def test_validator_has_no_attribution_row_without_a_sidecar_field() -> None:
    """A file that declares no bands is judged exactly as it always was."""
    p = params(base_thickness_mm=5.0)
    report = validators.validate(lip_model(p), p)
    assert report.get("attribution") is None
    assert "attribution" not in report.get("min_wall").message


def test_validator_attribution_row_bounds_what_min_wall_may_skip() -> None:
    """The row is the guard on the exclusion, not a rubber stamp for it.

    The browser engine declares the Z bands its mandatory attribution marks
    occupy and ``min_wall`` does not judge them (the marks are cut at 1.2 to
    1.8 mm cap height, which puts their strokes under one nozzle by
    construction).  An exclusion nobody checks is a hole in the gate, so this
    row fails a band that is too tall, a set of bands that covers too much of
    the model, and a band that is not inside the model at all.
    """
    p = params(base_thickness_mm=5.0)
    mesh = lip_model(p)
    z_hi = float(mesh.bounds[1][2])

    ok = validators.validate(mesh, p, attribution_bands=[(0.0, 0.5), (3.2, 4.8)])
    row = ok.get("attribution")
    assert row is not None and row.passed, row.message
    assert "3.20-4.80" in row.message
    # ... and the min_wall row says which heights it did not judge.
    assert "attribution bands" in ok.get("min_wall").message

    tall = validators.validate(
        mesh, p, attribution_bands=[(0.0, validators.ATTRIBUTION_BAND_MAX_MM + 1.0)]
    )
    assert not tall.get("attribution").passed
    assert "over" in tall.get("attribution").message

    outside = validators.validate(mesh, p, attribution_bands=[(z_hi + 1.0, z_hi + 2.0)])
    assert not outside.get("attribution").passed
    assert "outside the model" in outside.get("attribution").message

    many = validators.validate(mesh, p, attribution_bands=[(z, z + 0.2) for z in range(6)])
    assert not many.get("attribution").passed
    assert "over the 4 allowed" in many.get("attribution").message

    # The two caps together are what bound the exclusion: four bands of 2.5 mm
    # is 10 mm and there is no fifth band and no taller one.
    assert (
        validators.ATTRIBUTION_BAND_MAX_TOTAL_MM
        == validators.ATTRIBUTION_BAND_MAX_COUNT * validators.ATTRIBUTION_BAND_MAX_MM
    )


def test_validator_ignores_a_malformed_attribution_band() -> None:
    """A sidecar is data from another program; a bad field is not a crash."""
    p = params(base_thickness_mm=5.0)
    mesh = lip_model(p)
    report = validators.validate(
        mesh,
        p,
        attribution_bands=[(0.5, 0.0), (float("nan"), 1.0), (0.0, 0.5)],
    )
    row = report.get("attribution")
    assert row is not None and row.passed, row.message
    assert row.value.startswith("1 band")
