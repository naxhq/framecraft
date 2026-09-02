# Changelog

All notable changes to FrameCraft are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [3.0.0] - 2026-09-02

First public release.

### Added

- Client-side bake engine: the full OSM-to-solid pipeline (Overpass ingest,
  normalisation, extrusion, booleans on manifold WASM) runs in a Web Worker in
  the browser; preview and export share the same meshes.
- Bambu Studio project 3MF export with per-region filament slot mapping,
  printer and plate settings included.
- Export targets: generic 3MF, STL, per-part STL zip, OBJ, faceted STEP, and a
  single-nozzle colour-change 3MF.
- Terrain elevation from Mapzen Terrarium tiles, with smoothing, exaggeration,
  and fail-soft to a flat base.
- Hero building auto-detection alongside manual picks.
- Printer profiles (eight named printers plus custom), a printability audit
  with one-click safe fixes, and per-slot filament and time estimates.
- Tiling: split large models into a grid with dovetail or pin registration
  joints and index marks, one plate or file per tile.
- Frame system: seven profiles, corner styles, shadow gap, matting, separate
  frame part with mounts, face textures, cleat and easel hangers.
- Colour system: seven built-in palettes, saved custom palettes, per-building
  tint, height gradients, and an adjacent-region contrast checker.
- Address and place search (Nominatim forward geocoding) with sensible radius
  per result type.
- Project files (`.framecraft.json`), compressed share permalinks, and recent
  designs.
- Mandatory engraved attribution marks and a uniform provenance metadata block
  in every export (see `LICENSE_AND_ATTRIBUTION.md`).
- Distribution: static export to GitHub Pages and desktop installers (Windows,
  macOS, Linux) built with Tauri from the same web app.

### Changed

- The Python bake service became the reference implementation and release
  validator; the web app no longer calls it at runtime.
- Contracts schema advanced to version 3 (additive, defaults identical to v2).
- Undo/redo now covers every editor action.

### Fixed

- `{city}` and other lettering tokens resolve from the real place name
  (preset or reverse geocode) instead of an unset label.
- Accessibility issues surfaced by the automated audit (combobox ARIA
  references, unlabelled inputs).

## [2.0.0] - 2026-08-30

Internal milestone, not distributed. Contracts schema version 2; multi-part
colour output with filament slots; engraved lettering with tokens; the
printability advisor; share links; the editor UI redesign.

## [1.0.0] - 2026-08-29

Internal milestone, not distributed. The original MVP: map picker, Overpass
ingest to SceneGraph, server-side manifold3d bake, live preview, 3MF and STL
download.
