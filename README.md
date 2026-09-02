# FrameCraft

Turn any map location into a 3D-printable framed miniature city.

[![CI](https://github.com/naxhq/framecraft/actions/workflows/ci.yml/badge.svg)](https://github.com/naxhq/framecraft/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/naxhq/framecraft)](https://github.com/naxhq/framecraft/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/naxhq/framecraft/total)](https://github.com/naxhq/framecraft/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Try it now: <https://naxhq.github.io/framecraft/>**

![FrameCraft editor with a framed miniature city](docs/assets/screenshot.png)

## Quick start

**Web.** Open <https://naxhq.github.io/framecraft/>, search for a place or drop
a pin, and press Bake. Download the file your slicer wants.

**Desktop.** Download the installer for your OS from the
[latest release](https://github.com/naxhq/framecraft/releases/latest) and run
it. Same app, with save-to-folder and a larger memory budget.

> The desktop installers are currently unsigned, so Windows SmartScreen and
> macOS Gatekeeper show a publisher warning on first launch (More info, then
> Run anyway). The build is reproducible from this repository.

## Features

- **Bakes in your browser.** The whole solid pipeline runs client side on the
  manifold WASM boolean kernel in a Web Worker. The live preview and the
  exported file are the same meshes.
- **Bambu Studio project export.** A project 3MF with every part assigned to a
  filament slot, so it opens ready to slice. Also: generic 3MF, STL (single or
  per-part zip), OBJ, faceted STEP, and a single-nozzle colour-change 3MF.
- **Terrain.** Real elevation (Mapzen Terrarium tiles) drapes the base, with
  smoothing and exaggeration controls; fails soft to a flat base offline.
- **Hero buildings.** Pick landmarks by hand or let auto-detection score and
  select them; heroes get their own colour region and can feed the lettering.
- **Printer profiles and a printability audit.** Eight named printers (Bambu
  H2S, P1S, X1C, A1, A1 mini, Prusa MK4, Prusa Mini, Ender 3) plus custom.
  Every bake is audited (thin walls, plate and height limits, floating islands,
  overhangs, slot overruns) with one-click safe fixes where one exists.
- **Filament and time estimates.** Per-slot volume, grams, metres, layers, and
  a time figure with stated assumptions.
- **Tiling.** Split a large model into an N by M grid with dovetail or pin
  registration joints, index marks, and one plate (or one file) per tile.
- **Frames.** Seven frame profiles, three corner styles, shadow gap, matting,
  a separate frame part with mounts, face textures, cleat and easel hangers.
- **Colour.** Seven built-in palettes plus saved custom palettes, per-region
  colours and slots, per-building tint, height gradients, and a contrast
  checker for adjacent regions.
![Colour palettes and filament mapping](docs/assets/screenshot-colour.png)

- **Engraved lettering** on the frame and base with live tokens
  (`{city}`, `{coords}`, `{scale}`, `{hero}`, and more) resolved as you type.
- **Projects and sharing.** Save and load `.framecraft.json` project files,
  copy a compressed permalink, recent designs, and undo/redo everywhere.

## How it works

```
Overpass (OSM)  ->  SceneGraph (metres, local ENU)  ->  manifold WASM solids  ->  validated exports
     query             normalise + crop                  extrude, frame,           3MF / STL / OBJ /
                                                         engrave, audit            STEP + sidecar
```

The browser fetches raw OpenStreetMap data from Overpass, normalises it into a
SceneGraph in local metres, builds watertight solids with the manifold boolean
kernel, audits the result against your printer profile, and writes the export
files directly. A Python reference implementation (`services/bake`) validates
every release build: the CLI validator cross-checks exported files, and the
gate keeps the TypeScript and Python transform math in parity.

## Printing

- **Bambu Studio**: open the exported project 3MF; parts arrive on their
  filament slots with printer and plate settings filled in.
- **Other slicers**: use the generic 3MF, STL, or per-part STL zip, or the
  single-nozzle colour-change 3MF if your printer pauses on M600.

## Limitations

- Steep terrain can thin the base walls below printable width; the in-app
  audit warns when it happens and offers the safe fixes.
- Per-building tint is visible in the preview and the OBJ export only; other
  formats colour by region.
- STEP output is a faceted B-rep (triangle faces), not smooth CAD surfaces; a
  mesh model has no others to offer, and the app says so above 50k triangles.

## Map data and attribution

Map data is (c) OpenStreetMap contributors, licensed under the
[ODbL](https://opendatacommons.org/licenses/odbl/1-0/). Every model FrameCraft
bakes carries engraved attribution marks and file metadata naming the source;
when you share a photo or a print, credit "(c) OpenStreetMap contributors".
Details, obligations, and what the marks do and do not achieve:
[LICENSE_AND_ATTRIBUTION.md](LICENSE_AND_ATTRIBUTION.md).

The FrameCraft source code is MIT licensed (see [LICENSE](LICENSE)); the map
data it processes remains under the ODbL.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, and the rules that
keep the contracts and the gate honest. `docs/ARCHITECTURE.md` describes the
system; `DECISIONS.md` records why it is the way it is.

---

Built by Vahid Alizadeh. Map data (c) OpenStreetMap contributors. Terrain from
Mapzen Terrarium tiles on AWS Open Data. Geocoding by Nominatim.
