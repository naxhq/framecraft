# Changelog

All notable changes to FrameCraft are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Nothing yet.

## [3.1.0] - 2026-09-03

The release that made the app feel like one thing: two actions, a model that
keeps itself up to date, and a window you can arrange.

### Added

- The engine is now one incremental pipeline in a single Web Worker: an
  explicit graph of stages rather than one traversal. Ingest, normalisation,
  terrain, every solid stage, the audit and all seven exporters now live
  there together, each stage keyed on the parameters and upstream outputs it
  actually reads. A settings change re-runs only the stages that depend on it
  and reuses the rest from a one-generation cache, finished regions stream to
  the viewport before assembly, and a run in flight is superseded at its next
  stage boundary instead of being waited out. The second worker is gone
  ([V3.1-P1-1] to [V3.1-P1-19]).
- Settings now rebuild the model on their own: every `PrintParams` write
  schedules a live incremental run after 80 ms (was 400 ms). Location (pin,
  radius, rotation, preset) is the exception: it marks the model stale and
  waits for Preview, because it costs a network fetch ([V3.1-P1-3]).
- A resizable three-region shell. Map, viewport and settings are columns
  with draggable dividers, either side hideable, the map or the viewport able
  to take the whole window. Nothing is unmounted when it is hidden, so the map
  keeps its WebGL context and the viewport keeps its model. The layout travels
  in the share link and the project file but stays out of `PrintParams`
  ([V3.1-O6]).
- A settings panel that can be read without scrolling it: eleven of the twelve
  groups start closed, and each one states what it is set to on its own header.
  Added: a search box over every control, a "changes from default" counter that
  lists them, and a per-group reset.
- Place search on Photon: a type-ahead over OpenStreetMap names with kind
  badges, plus a local coordinate parser (decimal and DMS, either order, no
  network), recent places, and a geolocation row. Nominatim keeps only the
  single reverse lookup that names a dropped pin, through its existing 1 rps
  queue. Picking a result moves the pin and applies a radius; it no longer
  builds by itself ([V3.1-P9-1] to [V3.1-P9-3]).
- Objects have names. `SceneGraph` gains optional `name`, `osm_id` and
  `kind` on buildings, roads and areas (schema_version 4, additive), under a
  96 kB name budget with two lossless sparse rules. Hovering the model names
  what is under the pointer: exactly for buildings, from a per-triangle owner
  map that survives the booleans, and by nearest entity in plan for roads,
  water and green areas, which the card says rather than overstating
  ([V3.1-P10-1] to [V3.1-P10-3]).
- Per-object overrides: right-clicking an object opens a menu of decisions
  about that object: hero, height, colour, tint or hidden for a building;
  engraving mode, width or colour for a road; raise, colour or hidden for an
  area. At most 24 rows per design, of which four may claim a filament slot of
  their own, which is the default profile's slot count ([V3.1-P11-1]).
- Surface labels: a name engraved into, or raised off, a building's roof or the
  ground a road, a water body or a green area prints as. Placed from the
  right-click menu, dragged by a gizmo in the viewport, and set in a card
  beside it (text, cap height, engrave or emboss, depth, face, and whether a
  street name follows the centreline). At most 12 per design; each one is
  fitted inside its face eroded by one minimum wall, shrunk on the size grid
  where it does not fit, put through the frame lettering's own glyph repair,
  and refused with the size that would work rather than overhung.
- Per-building tint on the real meshes: the owner map carries each
  triangle's building colour into the preview's colour attribute, so the tint
  is on the actual solids rather than a deleted approximate layer
  ([V3.1-P10-4], [V3.1-O8]).
- Project files are now `.framecraft`, and the desktop app registers the
  extension on Windows, macOS and Linux, so double-clicking a project opens it.
  Opening one while the app is already running reuses the window instead of
  starting a second copy. Older `.framecraft.json` files still load, are
  migrated silently, and say so once ([V3.1-T13]).
- A footer and an About dialog naming the build: product, version, short commit
  and build date, all injected from `apps/web/package.json` and git at build
  time, plus the copyright, the repository and the licence. A build with no git
  available says "source build" rather than inventing a commit ([V3.1-T15]).
- A two-path CI: a required path of five parallel ten-minute jobs on every push
  and pull request, and a nightly path that runs everything the required one
  leaves out (the full Playwright suite, the export and preset matrices, the
  desktop installers). Neither path runs less than CI ran before; what a green
  required run does not prove is written down in `RUNBOOK.md` section 7.
  `make gate-fast` and `make gate-nightly` run each path locally
  ([V3.1-P14-1] to [V3.1-P14-3]).
- Every README screenshot is regenerated from the running app by
  `apps/web/scripts/capture-screenshots.mjs`, against the committed Overpass
  and search fixtures, so a picture cannot outlive the interface it shows.

- The frame lip carries a sight-edge rebate: a step `frame_style.lip_depth_mm`
  deep (0.4 mm by default, 0 for a flat lip) and 1.0 mm wide along the inner
  top edge of the opening, on every profile and corner style. The lettering,
  the ornaments and the face texture keep to the flat 5 mm face outside it,
  and the inner-wall attribution is engraved below it ([V3.1-P2-2]).

### Fixed

- `regions.rail.width_m` now sets the ground width of every rail ribbon, on the
  plate and on a bridge deck. It used to be a fallback behind a per-type width
  the normaliser fills on every way, so the control never moved anything
  ([V3.1-P2-1]).
- Binary STL is written on a float32 grid, so the exporter now hardens the
  placed mesh for it: a needle whose three vertices agree to within one float32
  step is split at its T-junction, no vertex moves and no face is dropped. The
  Chicago STL used to fail the validator's degenerate-face row with one face
  the 3MF of the same build carried perfectly ([V3.1-P7-1], [V3.1-P7-6]).
- Two distinct vertices at exactly one point, welded by the STL's unavoidable
  triangle-soup indexing, used to hand one edge to four faces and fail
  `manifold`, `watertight` and `self_intersection` on the Paris, Tokyo and
  London presets. Both pipelines now separate such a pinch by one float32 step
  along the vertex normal, with a parity fixture holding the TypeScript and
  Python halves to zero difference ([V3.1-P7-3], [V3.1-P7-5]).
- Tiling: a sliver the seam cutter stranded is measured again rather than
  dropped for being under 0.01 mm2 (it read 0.037 mm on the minimum-wall row),
  and every tile solid is pruned of debris after the cut (a 0.000458 mm3
  splinter counted as a second body). All four tiles of a Chicago 2x2 pass
  ([V3.1-P7-2]).
- A skeleton is shown only while a request is genuinely in flight and there is
  no previous value: every rebuild now keeps the previous figures on screen,
  dimmed and labelled, because a superseded number beats a grey bar. A
  cancelled export reads as cancelled rather than as a refusal, and keeps the
  previous export's files ([V3.1-T6-1], [V3.1-T6-2]).

### Changed

- The copyright holder is NAXHQ, consistently across `LICENSE`, `README.md`,
  the footer, the About dialog, the package metadata and the installer's
  publisher and copyright fields. The licence itself is unchanged: still MIT,
  same terms, only the holder string ([V3.1-T15]).

- The engine's mesh repair (`cleanMesh`) finds coincident vertices with one
  sort and a sweep instead of a string-keyed grid scan, indexes only the edges
  a needle can ask about, and counts open edges in typed arrays. Same meshes
  to the last index, 7 to 10 times faster: the Chicago export drops from 5.1 s
  to 3.0 s of engine time and the merged solid's repair from 2.0 s to 0.3 s.

- The app now has exactly two primary actions, **Preview** and **Export**. The
  word "bake" is retired from the interface, the documentation and the
  TypeScript in `apps/web`: Generate became Preview, Bake became Export, the
  engine's whole-model entry point is `buildModel()`, the export flow lives in
  `apps/web/lib/exportFlow.ts`, and the browser-engine CLI is
  `apps/web/scripts/export-cli.ts`. Playwright test ids follow
  (`preview-button`, `export-button`, `export-status`, `export-progress`,
  `export-notes`, `export-stale-note`, `export-block-reason`).
- Export copy no longer implies the app slices or prints. The Bambu Studio
  project 3MF is described as opening ready to slice; every other statement
  about a printed result now says what the exported file carries.
- `make export-fixture` replaces `make bake-fixture`, and `npm run export:cli`
  replaces `npm run bake:cli`. Both old names are kept as aliases: the make
  target prints "bake-fixture is now export-fixture" and runs the new one, and
  the npm script forwards to `export:cli`.
- Unchanged by design ([V3.1-O3]): the Python reference package directory
  `services/bake`, its `/bake` HTTP routes and `python -m app.cli bake`, and
  the frozen `BakeResult` contract schema with its generated types.

### Known issues

Open at this release, tracked with measurements in `docs/handoff/FAILURES.md`:

- The browser engine fails the reference validator on five of the six preset
  cities: New York, Tokyo, London and San Francisco on the minimum-wall row,
  Paris on degenerate faces. Chicago passes, and the Python reference pipeline
  builds all six cleanly. The gap became visible only when the browser-engine
  CLI learned `--center`, which is what let the nightly preset matrix build
  each city where it actually is instead of cropping around the Chicago Loop.
- A 256 mm plate still carries a handful of degenerate faces on Chicago, and
  one thin lobe in frame-off parts mode. The default 180 mm plate is
  unaffected.
- The STEP writer formats coordinates to six decimals and loses the same near
  degenerate faces the STL writer now hardens against. STEP is a faceted B-rep
  whose consumers re-mesh, and the reference validator does not read it.

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
