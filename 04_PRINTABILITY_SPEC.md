# 04 PRINTABILITY SPEC

This is the file that decides whether the product is good. Read it twice.

## Scale math

```
span_m   = 2 * radius_m
usable   = plate_mm - (2 * frame_width_mm if frame else 0)
scale    = usable / (span_m * 1000)        # mm per mm, e.g. 1/15000
```

Derived thresholds, all in **ground meters**:

```
nozzle          = params.nozzle_mm            # 0.4 default
min_wall_mm     = 2 * nozzle                  # 0.8, two perimeters
min_gap_mm      = 1.5 * nozzle                # 0.6, below this, gaps close up
min_detail_mm   = 1.0 * nozzle                # 0.4, below this, drop it

min_wall_ground   = min_wall_mm   / scale
min_gap_ground    = min_gap_mm    / scale
min_detail_ground = min_detail_mm / scale
```

At a 1.8 km span on a 180 mm plate, scale is 1:10000, so `min_wall_ground` is
8 m. Most residential buildings are wider than that; most alleys are not. This
is exactly why naive extrusion prints as mush, and why the next section exists.

## Stage 1: minimum-feature repair, 2D

Run per layer, before any extrusion. Order matters.

**Buildings**

1. Estimate each footprint's characteristic width as
   `w = 4 * area / perimeter` (hydraulic diameter). This is cheap and good
   enough.
2. If `w < min_wall_ground`, dilate by `d = (min_wall_ground - w) / 2` using
   `buffer(d, join_style=2)`. Count these and report in `warnings`.
3. If after dilation `area < (min_detail_ground ** 2)`, drop the building.
4. Close the whole building layer: `union.buffer(g).buffer(-g)` with
   `g = min_gap_ground / 2`. This merges buildings separated by unprintable
   slivers into one solid mass, which is what a real printed city block looks
   like, and it removes a huge class of boolean failures.
5. Re-split the closed union into components and assign each the maximum height
   of the originals it swallowed, weighted so a single tall tower does not raise
   an entire block. Rule: take the 80th percentile of contributing heights by
   footprint area, and preserve any contributing footprint whose height exceeds
   1.5x that value as a separate solid stacked on top.

**Roads**

1. Buffer each centerline by `max(width_m, min_wall_ground) / 2`, flat caps,
   round joins.
2. Union all road polygons, then subtract the building layer. Roads must not
   tunnel through buildings.
3. Engrave depth is `min(0.6 mm, base_thickness_mm / 3)` in print units.
   Emboss height is 0.4 mm.

**Water and green**

Buffer-clean the same way, subtract buildings, and recess water by 0.5 mm,
raise green by 0.3 mm. Anything under `min_detail_ground ** 2` in area is
dropped.

**Trees**

Only emit a tree if the site radius scaled up is at least 0.5 mm and the tree
does not intersect a building or road footprint. Model as an 8-sided cone,
height 3x radius. Cap tree count at 2000 by keeping the largest.

## Stage 2: extrusion and assembly

Work in **print millimeters** from here on. Convert once, at the boundary.

1. Base plate: the crop square extruded from `z = 0` to `z = base_thickness_mm`.
   Chamfer the bottom outer edge 0.6 mm at 45 degrees to kill elephant foot.
2. Frame, if enabled: a border lip of width 6 mm rising 2 mm above the base top.
3. Buildings: extrude each footprint from `base_top - 0.2` (a deliberate
   overlap, so the union is unambiguous) to
   `base_top + height_m * scale * 1000 * (large_scale if is_tall else small_scale)`.
   Clamp the printed height to a minimum of 0.6 mm.
4. Roads, water, green: extrude thin slabs and boolean into the base top.
5. Union in **batches**. Do not union 2000 solids sequentially into one
   accumulator, that is quadratic in practice. Batch into groups of roughly 200,
   union each group, then union the groups pairwise in a tree. This is the
   difference between a 20 second bake and a 20 minute one.
6. Final union of base, frame, buildings, and surface features into one Manifold.
7. Translate so the mesh sits with its minimum Z at exactly 0.0 and is centered
   on X and Y.

Use `manifold3d`'s `Manifold` throughout. Convert to `trimesh` only at export.
Never round-trip through STL mid-pipeline.

## Stage 3: export

**3MF is the primary format.** Write it directly: a 3MF file is a zip
containing `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`. The
model XML needs `unit="millimeter"`, a `<resources>` block with one `<object>`
of type `model` holding `<vertices>` and `<triangles>`, and a `<build>` block
with one `<item>`. Add a `<metadata name="Description">` carrying the OSM
attribution, the location, and the parameter set used, so a file found later is
self-describing.

STL binary is the fallback, written by trimesh.

Also write a sidecar `<name>.json` with the full `BakeResult` stats and the
exact `SceneRequest` and `PrintParams`, so any output is reproducible.

## Stage 4: validators, these are the gate

`app/validate/checks.py` exposes `validate(mesh, params) -> ValidationReport`.
All must pass for the job to be marked `done`.

| Check | Rule |
|---|---|
| Manifold | `manifold.status == NoError` and `is_manifold` |
| Watertight | trimesh `is_watertight` and `euler_number` consistent |
| Volume | `> 0` and volume equals `abs(volume)`, catching inverted normals |
| Self-intersection | zero after assembly, manifold3d guarantees this if inputs were valid |
| Bounding box | X and Y within `plate_mm + 0.01`, Z under 60 mm |
| Sits at zero | `bounds[0][2]` within 0.001 of 0.0 |
| Min wall | sample the mesh with a 0.4 mm probe on 12 random Z slices; report the smallest solid-region width and fail under `min_wall_mm * 0.9` |
| Triangle budget | under 2,000,000, else decimate to 1.5M with `trimesh.simplify_quadric_decimation` and re-validate |
| Degenerate faces | zero faces with area under 1e-9 |

On failure, do not silently ship. Return `status: failed` with the failing
check named, and log the intermediate solids to `artifacts/debug/<job_id>/` so
the failure can be inspected.

## Filament estimate

`grams = volume_mm3 / 1000 * 1.24 * infill_factor` with `infill_factor = 0.35`
for a 15% infill with 3 walls. Label it clearly as an estimate.

## Known trap list, do not rediscover these

- Shapely `buffer(0)` is not a reliable validity fix. Use `make_valid`.
- Interior rings must have opposite winding or manifold3d produces inside-out
  solids that pass a naive volume check.
- Extruding a polygon whose exterior touches its own hole produces a non-manifold
  edge. `make_valid` plus a 1e-6 negative buffer on holes avoids this.
- A building footprint that is exactly coincident with the base plate edge
  creates a zero-thickness wall. Inset the crop square by 0.05 mm before the
  final clip.
- Do not `union` a solid with itself. Deduplicate before the batch step.
