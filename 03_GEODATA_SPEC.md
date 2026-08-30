# 03 GEODATA SPEC

## Sources, allowed

| Layer | Source | Notes |
|---|---|---|
| Buildings, roads, water, green, trees | OpenStreetMap via Overpass API | ODbL |
| Basemap raster tiles for the picker | OSM standard tile server | Set a real `User-Agent`, respect the usage policy, cache locally |
| Terrain (flagged off in MVP) | Copernicus GLO-30 via OpenTopography | Requires an API key, so keep it optional |

## Sources, forbidden

Google Maps, Google Earth, Google Photorealistic 3D Tiles, Apple Maps, Bing 3D.
Their terms prohibit derived works, bulk download, and physical reproduction of
the content. Do not add them behind a flag. Do not add them "for preview only."
Any code that touches them fails review.

Mapbox and Cesium are acceptable later as commercial swaps but are not part of
the MVP.

## Attribution, required

The printed model is a Produced Work under ODbL, which means attribution is
required but the share-alike clause does not extend to the STL. Implement:

- A persistent footer credit on the web app: `© OpenStreetMap contributors`.
- The same string embedded in the 3MF metadata `Description` field.
- A `CREDITS.txt` written next to every export.

## Overpass query

Use `https://overpass-api.de/api/interpreter` with a 180 s timeout and a
descriptive `User-Agent`. Query by bounding box computed from center and radius
(add 15% margin so the rotation crop is not starved). One query, all layers:

```
[out:json][timeout:180];
(
  way["building"]({{bbox}});
  relation["building"]({{bbox}});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|service|pedestrian|footway)$"]({{bbox}});
  way["natural"="water"]({{bbox}});
  relation["natural"="water"]({{bbox}});
  way["waterway"="riverbank"]({{bbox}});
  way["landuse"~"^(grass|forest|meadow|recreation_ground)$"]({{bbox}});
  way["leisure"~"^(park|garden|pitch)$"]({{bbox}});
  node["natural"="tree"]({{bbox}});
);
out geom;
```

Cache every response to `fixtures/<sha1-of-query>.json`. In tests and for the
six presets, read the fixture and never hit the network. Commit the six preset
fixtures to the repo. Add a `make refresh-fixtures` target.

Retry policy: 3 attempts, exponential backoff, and fall back to
`https://overpass.kumi.systems/api/interpreter` on 429 or 504.

## Height inference

Buildings without height are the norm. Resolve in this order and record which
rule fired in `height_source`:

1. `height` tag, parse meters, strip units, accept `12.5 m` and `41'`.
2. `building:levels` times 3.2 m, plus `roof:height` if present.
3. `building:min_level` sets `min_height_m` for bridges and overhangs.
4. Type defaults: `skyscraper` 120, `church` or `cathedral` 25, `hospital` 30,
   `apartments` 18, `commercial` or `retail` 12, `industrial` 10,
   `house` or `detached` 7, `garage` or `shed` 3.
5. Global fallback 8.0 m.

Clamp to [2.0, 600.0]. Add small deterministic jitter of plus or minus 6% seeded
by the OSM id for anything resolved by rule 4 or 5, so blocks of default-height
buildings do not print as one flat slab. Seeded means the same input always
gives the same output.

Report `height_tag_ratio` in stats. When it is under 0.15, the UI must warn that
heights are largely estimated.

## Road widths

Highway class to width in meters, before the `road_scale` multiplier and before
the minimum-feature clamp in `04`:

motorway 24, trunk 20, primary 16, secondary 12, tertiary 10, residential 8,
unclassified 8, service 5, pedestrian 6, footway 3.

If `width` or `lanes` is tagged, prefer `width`, else `lanes * 3.5`.

## Geometry hygiene before anything else

OSM polygons are dirty. In `normalize.py`, in this order:

1. Drop ways with fewer than 4 nodes or zero area.
2. Close unclosed rings.
3. `shapely.make_valid` on every polygon, then keep only Polygon and
   MultiPolygon parts, discarding lines and points that fall out.
4. Fix winding: exterior counter-clockwise, holes clockwise.
5. `simplify(0.25, preserve_topology=True)` in meters. This kills a large share
   of triangle count with no visible loss at print scale.
6. Deduplicate buildings whose centroids are within 0.5 m and whose areas are
   within 5%. Multipolygon relations and their member ways often both appear.
7. Union overlapping building footprints that touch, then re-split is not
   needed; keep the union and take the max height of the merged parts.

## Projection and crop

Use `pyproj` to transform WGS84 to the local UTM zone of the center, then
subtract the center so the origin is (0,0). Do not use Web Mercator for
geometry; its scale distortion at high latitude will visibly stretch Toronto and
Berlin models. Web Mercator is fine for the 2D picker only.

Crop: rotate by `rotation_deg` about the origin, then clip everything to the
axis-aligned square of side `2 * radius_m`. Clip buildings by intersection so a
half-building at the edge becomes a clean cut face, not a hole in the solid.

## Coverage classification

- `building_count >= 150` and buildings cover at least 4% of the crop area: good
- `20 <= building_count < 150`: sparse, warn the user
- `< 20`: empty, block the bake with a clear message suggesting a larger radius
  or a different location
