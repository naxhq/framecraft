# 01 PRODUCT SPEC: FrameCraft MVP

## One-line

Pick any spot on a map, tune it in a live 3D editor, download a watertight,
print-ready framed miniature of that place.

## Why this shape

Existing products in this space ship a fixed catalog of roughly 20
hand-modeled cities. The wedge here is **anywhere**: a user's own
neighborhood, campus, or the block where they got married. The MVP must prove
the arbitrary-location pipeline end to end. Curated hand-modeled landmarks are
a later moat, not an MVP requirement.

## Primary user flow

1. Land on `/`. See a map (MapLibre GL, OSM raster tiles) plus a row of six
   preset cities.
2. Either click a preset or drop a pin and drag a radius handle (250m to 3000m).
3. Click Generate. The app fetches the scene graph and renders an interactive
   3D preview in the browser within a few seconds.
4. Adjust parameters in a right-hand panel. The preview updates live, with no
   round trip to the server for anything except a change of location or radius.
5. Click Bake. A job runs server-side. Progress is shown. On completion the user
   gets download links plus printed stats: triangle count, volume, bounding box,
   estimated filament grams, and whether it is manifold.
6. Download `.3mf` (primary) or `.stl` (fallback).

## Editor parameters, MVP set

Each maps to a field in `PrintParams` (see `02`).

| Control | Range | Default | Effect |
|---|---|---|---|
| Plate size | 100 to 256 mm | 180 | Sets scale from ground span to print |
| Base thickness | 2 to 8 mm | 3 | Solid slab under everything |
| Small building scale | 50 to 150 % | 100 | Height multiplier, buildings under 40 m |
| Large building scale | 50 to 200 % | 100 | Height multiplier, buildings 40 m and over |
| Terrain exaggeration | 0 to 300 % | 100 | Ignored if terrain disabled |
| Road mode | engrave / emboss / off | engrave | Recess or raise road ribbons |
| Road scale | 50 to 200 % | 100 | Width multiplier before min-feature clamp |
| Trees | on / off | on | Instanced low-poly cones on green areas |
| Water | on / off | on | Recessed water polygons |
| Frame | on / off | on | Raised border lip around the plate |
| Rotation | 0 to 360 deg | 0 | Rotate the crop before squaring it |

Every parameter must be reflected in the live preview **and** honored by the
bake. Preview and bake read the same scene graph and the same parameter object.
Divergence between preview and printed result is the single worst failure mode
in this product. Treat any mismatch as a bug.

## Preset cities for the MVP

Chicago (Loop), New York (Midtown), Paris (Tour Eiffel), Tokyo (Shinjuku),
London (City), San Francisco (Financial District). Each is a stored center,
radius, and rotation. Cache their Overpass responses as fixtures so demos and
tests never depend on a live API.

## Acceptance criteria

- A1: Preset city loads and previews in under 5 seconds on a warm cache.
- A2: An arbitrary pin anywhere with OSM building coverage produces a preview.
  A location with fewer than 20 buildings in radius shows a clear low-coverage
  warning rather than an empty scene or a crash.
- A3: Every slider updates the preview at 30 fps or better on a 3000-building
  scene. No server call on slider change.
- A4: Bake of the Chicago preset returns a `.3mf` in under 90 seconds.
- A5: The baked mesh passes all validators in `04`: manifold, watertight,
  positive volume, zero self-intersections after repair, bbox inside the
  selected plate size, minimum wall thickness respected.
- A6: The file opens in Bambu Studio or PrusaSlicer as one object, sits flat on
  the bed at Z=0, and slices without errors.
- A7: `make up` from a clean clone brings the whole stack up.

## Explicitly out of scope for the MVP

Stub or omit these, and say so in `RUNBOOK.md`:

- Accounts, auth, payments, order history
- Hand-modeled landmark library and landmark substitution
- Terrain from DEM (build the parameter and the code path, feed it a flat
  heightmap, and leave the fetcher behind a feature flag)
- Multi-tile snap-together districts, magnet pockets, magnetic skyline
- Multi-color and per-material assignment beyond a single base material
- Any Google Maps, Google Earth, or Photorealistic 3D Tiles data. Their terms
  forbid derived works and 3D printing. Do not use them, not even for preview
  imagery. OSM raster tiles only.
- Server-side rendering of thumbnails, email, analytics, mobile layout polish
