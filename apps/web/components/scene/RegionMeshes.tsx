"use client";

import { useEffect, useMemo, useRef } from "react";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { BufferAttribute, BufferGeometry, Color, Raycaster, Vector2, type Group } from "three";

import PerfFrameMark from "@/components/scene/PerfFrameMark";
import { deltaE76 } from "@/lib/colourMap";
import { CONTRAST_THRESHOLD } from "@/lib/contrastCheck";
import { NO_OWNER, type BuildingTint, type RecessBand, type RegionMesh } from "@/lib/engine/types";
import { isBuildingRegion, isPickableRegion, ownerAt, type HoverHit } from "@/lib/objectInfo";
import { perfSpan } from "@/lib/perf";

/**
 * The model, and since v3.1 the ONLY thing the viewport draws.
 *
 * Every `RegionMesh` here is a solid the pipeline finished and streamed as its
 * `finish-<region>` stage completed: the exact triangles the export writes, at
 * the export's own resolution, with the export's own per-region filament
 * colour. There is no approximate stack behind it any more, so a run in
 * flight no longer takes the model off the screen -- the previous meshes stay
 * up, dimmed, and each region is replaced on its own the moment a newer one
 * arrives (design rulings 1 and 3).
 *
 * Two things follow from that and are worth stating.
 *
 * **A region is rebuilt only when its own mesh changed.** The worker never
 * re-sends a region whose `finish-<region>` key matched the `known` map the
 * store passed it, so a new `RegionMesh` object IS a changed hash, and keying
 * the per-region cache on object identity is exactly "rebuild iff the hash
 * moved". A lettering edit therefore re-uploads the frame and nothing else.
 *
 * **Recess shading is presentation, not geometry.** A band names the BOX a
 * lettering, ornament, underside or surface-label cut occupies in a region and
 * the face it was cut from; a triangle whose centroid falls inside that box,
 * and is not on that face, is given a darker vertex colour, so an engraved
 * line reads at viewing distance instead of disappearing into the single flat
 * colour of the region it was cut into. Not one coordinate moves; the band
 * list is a named exception in `docs/handoff/v3-01-pipeline.md` section 5.
 *
 * The box and the face are both corrections, and both are why the shipped
 * 3.1.0 build showed no lettering on the frame at all: a band used to be a Z
 * SLAB closed at both ends, and its upper end IS the frame's own lip, so the
 * lip and the letters cut into it were darkened by the same amount and the
 * text was invisible at every zoom. How FAR they are darkened is
 * `recessMultiplier` below, and was the other half of the same defect. `CityPreview.tsx:shadingBands` is where the
 * bands are assembled, including the surface labels this file never used to
 * see and the `sit` shift that puts all of them in these meshes' coordinates.
 *
 * **Per-building tint is the same mechanism, keyed by owner.** The buildings,
 * band and hero meshes carry `triangleOwner`/`owners` ([V3.1-P1-18]), so a
 * triangle can be given the colour `EngineResult.buildingTints` assigned to
 * ITS building rather than the one flat colour of the whole region. Before
 * this, `colour.tint` moved nothing a user could see: the engine computed the
 * tints and the OBJ exporter wrote them, and the only preview layer that had
 * ever painted them (`InstancedBuildings.tsx`) had been deleted, while the
 * Issues badge still said tint affected the preview (v3-06 audit, finding C1).
 * Again not one coordinate moves.
 *
 * **Hero picking reads the same owners.** A click on the buildings mesh maps
 * `faceIndex` through `triangleOwner` to a building id, so the invisible
 * `InstancedMesh` of oriented boxes that used to stand in for per-building
 * identity is gone (audit finding C2). Picking is now done against the solid
 * the user is actually looking at, not a dilated proxy of it.
 *
 * `RegionMesh.positions` is double precision (`lib/engine/types.ts`: a
 * consumer that writes a FILE must keep that precision, but a GPU buffer
 * cannot hold one and has to make its own float32 copy) -- WebGL vertex
 * buffers do not support `Float64Array`, so this is that copy, made once here
 * and nowhere else in the render path.
 */

/** One region's own bands, in the order the engine emitted them. */
export function bandsForRegion(bands: readonly RecessBand[], region: string): RecessBand[] {
  return bands.filter((band) => band.region === region);
}

/**
 * The delta-E a recess must reach against the surface it is cut into before it
 * can be said to read.
 *
 * `lib/contrastCheck.ts:CONTRAST_THRESHOLD`, the number this app already uses
 * for "a careful eye tells them apart across a seam", reused rather than
 * invented: the question a recess asks is the same question two adjacent
 * region colours ask.
 */
export const RECESS_MIN_DELTA_E = CONTRAST_THRESHOLD;

/** The lowest multiplier worth trying. Below this everything is black anyway. */
const RECESS_FLOOR = 0.05;

/** sRGB 0..255 to linear light, the transfer three applies to `material.color`. */
function toLinear(channel: number): number {
  const s = channel / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function toSrgb(linear: number): number {
  const s = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** What the screen shows when a vertex colour of `k` multiplies a material of `hex`. */
export function shadedHex(hex: string, k: number): string {
  const packed = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(packed)) return hex;
  const out = [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255].map((channel) =>
    toSrgb(Math.min(1, toLinear(channel) * k)),
  );
  return `#${((out[0] << 16) | (out[1] << 8) | out[2]).toString(16).padStart(6, "0")}`;
}

/**
 * The multiplier that makes a recess in `colorHex` actually readable.
 *
 * The token's `shade` is the starting point and stays the answer for every
 * region where it already works, which is most of them. It does not work on a
 * DARK region, and the frame is the darkest colour in every built-in palette:
 * measured in the space the renderer multiplies in (linear, not sRGB -- a
 * vertex colour is assumed to be in the working space already and is not
 * converted), the token moves the default frame colour by a delta-E of 5.95,
 * half the threshold above. That is the second half of why the author saw no
 * lettering on the frame: even once the band stopped darkening the lip along
 * with the letters, what it darkened them BY was under the point at which a
 * difference is a difference. Multiplying a dark colour barely moves it. The
 * whole measured table, region by region, is in DECISIONS `[V3.1-U5]`; the
 * colours themselves stay in `app/globals.css`, which is why none is named
 * here.
 *
 * So: step the multiplier down until the result clears `RECESS_MIN_DELTA_E`.
 * The default base and matting colours clear it at the token and keep it, so
 * nothing that reads today is repainted; the frame walks down to about a
 * third. A region that cannot clear it at any multiplier gets the floor --
 * pure black is the honest case, where no MULTIPLIER can move a colour at all,
 * and saying so here is better than pretending a number exists.
 */
export function recessMultiplier(colorHex: string, shade: number): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(colorHex)) return shade;
  let k = shade;
  while (k > RECESS_FLOOR) {
    if (deltaE76(colorHex, shadedHex(colorHex, k)) >= RECESS_MIN_DELTA_E) return k;
    k *= 0.9;
  }
  return RECESS_FLOOR;
}

/**
 * How far a triangle centroid may sit from a band's face and still count as
 * being ON that face, engine mm.
 *
 * The face and the band bound are the same number computed twice (the cutter is
 * clipped to the face the stage passes in), so equality would do on paper; a
 * tolerance is what keeps it true after a boolean rebuilds the surface and
 * leaves a vertex a few ulps off. One micron is three orders of magnitude
 * below the 0.2 mm minimum engrave depth, so it can never swallow a real cut.
 */
const FACE_EPSILON_MM = 1e-3;

/**
 * True when a triangle centroid lies inside the cut a band describes.
 *
 * Three tests, and the second and third are why this is not the Z-only
 * predicate it used to be:
 *
 *  - Z inside the band, as before.
 *  - NOT on the band's own face (`faceZMm`). A band's bounds are the cut AND
 *    the surface it was cut from, so a Z-only test darkened the frame's whole
 *    top face by the same amount as the letters cut into it, and the lettering
 *    was invisible at every zoom because it was the same colour as its
 *    surround (measured on 3.1.0: 485 of 1888 shaded frame triangles were the
 *    face itself). An emboss names its face at the BOTTOM and an engrave at
 *    the top; excluding `faceZMm` is right for both.
 *  - Inside the cut's own footprint in plan (`xyMm`). Without it the band is a
 *    slab across the whole region, which for a roof label means every unrelated
 *    building passing through that height goes dark too.
 *
 * A band with neither field is one from an older result and keeps the old
 * behaviour rather than being silently dropped.
 */
export function insideBands(
  z: number,
  bands: readonly RecessBand[],
  x = Number.NaN,
  y = Number.NaN,
): boolean {
  for (const band of bands) {
    if (z < band.zMm[0] || z > band.zMm[1]) continue;
    if (band.faceZMm !== undefined && Math.abs(z - band.faceZMm) <= FACE_EPSILON_MM) continue;
    const box = band.xyMm;
    if (box !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
    }
    return true;
  }
  return false;
}

/**
 * Building id -> `#RRGGBB`, from `EngineResult.buildingTints`.
 *
 * `null` (not an empty map) when `colour.tint` is off, which is what keeps the
 * whole tinted path out of the way: a region with no tints takes the exact
 * geometry, the exact colour attribute and the exact material it always did.
 */
export type TintMap = ReadonlyMap<string, string> | null;

/** `EngineResult.buildingTints` as the lookup this file wants, or null when the switch is off. */
export function tintMapOf(tints: readonly BuildingTint[] | undefined): TintMap {
  if (tints === undefined || tints.length === 0) return null;
  return new Map(tints.map((tint) => [tint.id, tint.colorHex]));
}

/**
 * A key that moves when the tints do, so the geometry cache re-shades a region
 * only when it has to.
 *
 * `EngineResult` is a fresh object per run, so the tint ARRAY is a new
 * reference after every build even when nothing about the colours changed;
 * keying on the reference would re-expand 19 000 building triangles on every
 * run. The contents are what matter, and they are cheap to spell out: 289
 * owners on Chicago.
 */
export function tintsKeyOf(tints: TintMap): string {
  if (tints === null) return "";
  const parts: string[] = [];
  for (const [id, hex] of tints) parts.push(`${id}:${hex}`);
  return parts.join("|");
}

/**
 * True when this mesh's triangles should be coloured one by one.
 *
 * Both halves are needed: the tints ([V3.1-P1-18] gives them only to buildings)
 * and the per-triangle identity to key them by. Every other region has neither
 * and is untouched.
 */
export function isTinted(mesh: RegionMesh, tints: TintMap): boolean {
  if (tints === null || mesh.owners === undefined || mesh.triangleOwner === undefined) return false;
  return mesh.owners.some((owner) => tints.has(owner));
}

/**
 * The material colour that leaves an absolute vertex colour alone.
 *
 * three multiplies `material.color` by the vertex colour, so a buffer holding
 * the colour ITSELF needs a material that multiplies by one. This is that
 * identity and NOT a design token: it must be exactly (1, 1, 1) in every theme,
 * because a token redefined under `.dark` would silently scale every building's
 * tint. A CSS colour keyword rather than a hex, for the same reason
 * `palette.ts`'s `MISSING` is one -- `app/globals.css` owns the hexes
 * (`lib/design-tokens.test.ts`), and this is not a colour choice to own.
 */
export const MATERIAL_IDENTITY = "white";

/**
 * What to give the material.
 *
 * The identity above for a tinted mesh, whose colour attribute holds absolute
 * colours; the region's own filament colour otherwise, so an untinted region is
 * rendered by exactly the path it always was.
 */
export function materialColorFor(mesh: RegionMesh, tints: TintMap): string {
  return isTinted(mesh, tints) ? MATERIAL_IDENTITY : mesh.colorHex;
}

/**
 * One region's `BufferGeometry`.
 *
 * With no bands this is the indexed mesh the worker sent, vertex for vertex:
 * manifold3d shares vertices across faces (that is what makes it watertight)
 * and `flatShading` reads per-face normals in the fragment shader through
 * `fwidth`, so nothing has to be duplicated to keep a building's edges sharp.
 *
 * With bands, or with tints, the triangles are expanded, because a vertex
 * colour is per VERTEX and a shared vertex cannot be two colours. The expansion
 * costs three vertices per triangle, and it is paid only where it buys
 * something: the two regions that carry cuts (the base and the frame), and the
 * building regions while `colour.tint` is on. The roads, the water and the
 * parks never pay it.
 *
 * Which colour model the buffer then holds is exactly `isTinted` -- a
 * multiplier on the region's own filament colour, or the per-building colour
 * itself against a white material. The comment inside says why.
 */
export function buildGeometry(
  region: RegionMesh,
  bands: readonly RecessBand[],
  shade: number,
  tints: TintMap = null,
): BufferGeometry {
  const geometry = new BufferGeometry();
  const tinted = isTinted(region, tints);
  if (bands.length === 0 && !tinted) {
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(region.positions), 3));
    geometry.setIndex(new BufferAttribute(region.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  // Two colour models share this buffer, and which one is in use is exactly
  // `tinted`:
  //
  //   * no tint -- the value is a MULTIPLIER on the material's own colour, 1 or
  //     `shade`. Colour-space-neutral, and the material still carries
  //     `mesh.colorHex`, so the region paints in its own filament.
  //   * tinted -- the value is the colour ITSELF, and the material is white
  //     (`materialColorFor`). Absolute, because a per-building colour cannot be
  //     expressed as a multiple of the region's; a multiplier would have to be
  //     tint/region per channel, which divides by zero on any dark region and
  //     cannot exceed 1 at all.
  //
  // `new Color(hex)` converts sRGB to the renderer's working space, which a
  // vertex-colour attribute is assumed to already be in (three does not convert
  // one). Doing it here is what makes the tinted path render the same colour
  // the material would have.
  const triangles = Math.floor(region.indices.length / 3);
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  const owners = region.owners;
  const triangleOwner = region.triangleOwner;
  const base = tinted ? new Color(region.colorHex) : null;
  // Solved once per region, not per triangle: it depends only on the region's
  // own filament colour and the token.
  const recess = recessMultiplier(region.colorHex, shade);
  const cache = new Map<string, Color>();
  for (let t = 0; t < triangles; t += 1) {
    const out = t * 9;
    let xSum = 0;
    let ySum = 0;
    let zSum = 0;
    for (let k = 0; k < 3; k += 1) {
      const source = region.indices[t * 3 + k] * 3;
      positions[out + k * 3] = region.positions[source];
      positions[out + k * 3 + 1] = region.positions[source + 1];
      positions[out + k * 3 + 2] = region.positions[source + 2];
      xSum += region.positions[source];
      ySum += region.positions[source + 1];
      zSum += region.positions[source + 2];
    }
    const multiplier = insideBands(zSum / 3, bands, xSum / 3, ySum / 3) ? recess : 1;
    if (!tinted || base === null) {
      for (let k = 0; k < 9; k += 1) colors[out + k] = multiplier;
      continue;
    }
    let colour = base;
    const ownerIndex = triangleOwner === undefined ? NO_OWNER : triangleOwner[t];
    if (owners !== undefined && ownerIndex !== NO_OWNER && ownerIndex < owners.length) {
      const hex = tints?.get(owners[ownerIndex]);
      if (hex !== undefined) {
        let hit = cache.get(hex);
        if (hit === undefined) {
          hit = new Color(hex);
          cache.set(hex, hit);
        }
        colour = hit;
      }
    }
    for (let k = 0; k < 3; k += 1) {
      colors[out + k * 3] = colour.r * multiplier;
      colors[out + k * 3 + 1] = colour.g * multiplier;
      colors[out + k * 3 + 2] = colour.b * multiplier;
    }
  }
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A region with too few vertices to be a surface is not drawn (and is not an error: an empty region is a real outcome). */
function drawable(mesh: RegionMesh): boolean {
  return mesh.indices.length >= 3 && mesh.positions.length >= 9;
}

export interface BuiltRegion {
  region: string;
  mesh: RegionMesh;
  bands: RecessBand[];
  geometry: BufferGeometry;
  /** True when the geometry carries absolute per-triangle colours (bands or tint). */
  vertexColors: boolean;
  /** What the material paints with: white for a tinted region, its own filament otherwise. */
  materialColor: string;
}

interface CacheEntry extends BuiltRegion {
  /** The band list this geometry was shaded with, by value: bands move without the mesh moving. */
  bandsKey: string;
  shade: number;
  /** The tints this geometry was coloured with, by value: a new run brings a new array of the same colours. */
  tintsKey: string;
}

function bandsKeyOf(bands: readonly RecessBand[]): string {
  // Every field the shading reads, or a band that moved only in plan (a label
  // dragged across a roof at one height) would keep the cached geometry.
  return bands
    .map((band) => `${band.kind}:${band.zMm[0]}:${band.zMm[1]}:${band.faceZMm ?? ""}:${(band.xyMm ?? []).join(",")}`)
    .join("|");
}

export interface ReconcileResult {
  /** Counts up once per pass that built or dropped something: what re-arms the on-screen mark. */
  id: number;
  regions: BuiltRegion[];
}

/**
 * The per-region geometry cache, as a plain object so it can be driven twice
 * in a test without a React renderer.
 *
 * `reconcile` is the whole rule: a region whose `RegionMesh` object, band list
 * and shade are all unchanged keeps the exact `BufferGeometry` it already had,
 * every other region is rebuilt, and a region the worker removed is disposed.
 * Because the worker only re-sends a region whose `finish-<region>` key moved,
 * "same object" IS "same hash", so this rebuilds a region if and only if its
 * hash changed.
 */
export class RegionGeometryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private generation = 0;

  reconcile(
    regions: ReadonlyMap<string, RegionMesh>,
    recessBands: readonly RecessBand[],
    recessShade: number,
    tints: TintMap = null,
  ): ReconcileResult {
    const out: BuiltRegion[] = [];
    const live = new Set<string>();
    const tintsKey = tintsKeyOf(tints);
    let moved = false;
    for (const [name, mesh] of regions) {
      if (!drawable(mesh)) continue;
      live.add(name);
      const bands = bandsForRegion(recessBands, name);
      const bandsKey = bandsKeyOf(bands);
      const hit = this.entries.get(name);
      if (
        hit !== undefined &&
        hit.mesh === mesh &&
        hit.bandsKey === bandsKey &&
        hit.shade === recessShade &&
        hit.tintsKey === tintsKey
      ) {
        out.push(hit);
        continue;
      }
      hit?.geometry.dispose();
      // `preview.region.<name>` is CPU time and only CPU time: the float64 ->
      // float32 copy, the recess pass, the vertex normals and the bounding
      // sphere for THIS region. Nothing here touches the GPU; three.js uploads
      // a buffer lazily, on the first render that binds it.
      const geometry = perfSpan(`preview.region.${name}`, () =>
        buildGeometry(mesh, bands, recessShade, tints),
      );
      const entry: CacheEntry = {
        region: name,
        mesh,
        bands,
        bandsKey,
        shade: recessShade,
        tintsKey,
        geometry,
        vertexColors: bands.length > 0 || isTinted(mesh, tints),
        materialColor: materialColorFor(mesh, tints),
      };
      this.entries.set(name, entry);
      out.push(entry);
      moved = true;
    }
    for (const [name, entry] of this.entries) {
      if (live.has(name)) continue;
      entry.geometry.dispose();
      this.entries.delete(name);
      moved = true;
    }
    if (moved) this.generation += 1;
    return { id: this.generation, regions: out };
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.geometry.dispose();
    this.entries.clear();
  }
}

/** The hover plumbing: what the object popover needs, and nothing else. */
export type HoverHandler = (
  hit: HoverHit | null,
  clientX: number,
  clientY: number,
) => void;

/**
 * The two pointer props one pickable region's mesh carries.
 *
 * `event.faceIndex` is three's triangle ordinal, which is exactly what
 * `RegionMesh.triangleOwner` is indexed by. The hit point arrives in WORLD
 * space and the meshes hang under the one `rotation-x = -90deg` group that
 * turns print space (z up) into three's (y up), so it is converted back
 * through the mesh's own matrix rather than by re-deriving that rotation here:
 * `worldToLocal` is the inverse whatever the group above it is doing.
 *
 * `stopPropagation` keeps the answer to the NEAREST surface. Without it a hit
 * on a building would also be reported for the base underneath it, and the
 * last handler to run would win.
 */
/** How far the pointer may travel between press and release and still be a click, pixels. */
export const PICK_DRAG_SLOP_PX = 4;

/** Where the pointer went down, so an orbit drag that ends on a building is not a pick. */
interface PressPoint {
  current: { x: number; y: number } | null;
}

/**
 * True when a press and a release that far apart is a click rather than an
 * orbit. Exported because it is the whole of the click/drag rule and is worth
 * asserting without a renderer.
 */
export function isClick(from: { x: number; y: number } | null, x: number, y: number): boolean {
  if (from === null) return true;
  return Math.hypot(x - from.x, y - from.y) <= PICK_DRAG_SLOP_PX;
}

/** The pointer props one pickable region's mesh may carry. Spelled out so the spread stays type-checked. */
interface MeshInteraction {
  onPointerMove?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOut?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerOver?: (event: ThreeEvent<PointerEvent>) => void;
  onPointerDown?: (event: ThreeEvent<PointerEvent>) => void;
  onClick?: (event: ThreeEvent<MouseEvent>) => void;
}

/** One region's handlers and exactly what they were built from, so a render that changed none of it reuses them. */
interface HandlerEntry {
  mesh: RegionMesh;
  onHover: HoverHandler | undefined;
  onPick: ((id: string) => void) | undefined;
  handlers: MeshInteraction;
}

/**
 * The `userData` a region's mesh carries, one object per region name for the
 * life of the page. The right-click raycast reads `region` back off the hit
 * object; nothing else does, and a fresh `{ region }` per render would be a
 * prop change to r3f every time this component re-rendered (see the render).
 */
const USER_DATA = new Map<string, { region: string }>();

function userDataFor(region: string): { region: string } {
  let data = USER_DATA.get(region);
  if (data === undefined) {
    data = { region };
    USER_DATA.set(region, data);
  }
  return data;
}

function interactionHandlers(
  region: string,
  mesh: RegionMesh,
  onHover: HoverHandler | undefined,
  onPick: ((id: string) => void) | undefined,
  press: PressPoint,
): MeshInteraction {
  const handlers: MeshInteraction = {};
  // An `override_N` region (v3.1 Task 11) may hold buildings or a road/area
  // layer, and only the finished mesh knows which: the finish stage attributes
  // triangle owners on a building group and leaves them off any other. Asking
  // the MESH rather than the name is what keeps the pointer cursor honest -- a
  // recoloured street is not a hero waiting to be picked.
  const buildings = isBuildingRegion(region) || (mesh.owners !== undefined && mesh.triangleOwner !== undefined);

  if (onHover !== undefined) {
    handlers.onPointerMove = (event) => {
      const faceIndex = event.faceIndex;
      if (faceIndex === undefined || faceIndex === null) return;
      event.stopPropagation();
      const local = event.object.worldToLocal(event.point.clone());
      onHover(
        { region, mesh, faceIndex, xMm: local.x, yMm: local.y },
        event.nativeEvent.clientX,
        event.nativeEvent.clientY,
      );
    };
    handlers.onPointerOut = (event) => {
      if (buildings) document.body.style.cursor = "";
      onHover(null, event.nativeEvent.clientX, event.nativeEvent.clientY);
    };
  } else if (buildings && onPick !== undefined) {
    handlers.onPointerOut = () => {
      document.body.style.cursor = "";
    };
  }

  if (buildings && onPick !== undefined) {
    handlers.onPointerOver = () => {
      document.body.style.cursor = "pointer";
    };
    handlers.onPointerDown = (event) => {
      press.current = { x: event.nativeEvent.clientX, y: event.nativeEvent.clientY };
    };
    handlers.onClick = (event) => {
      const faceIndex = event.faceIndex;
      if (faceIndex === undefined || faceIndex === null) return;
      const from = press.current;
      press.current = null;
      if (!isClick(from, event.nativeEvent.clientX, event.nativeEvent.clientY)) return;
      const id = ownerAt(mesh, faceIndex);
      // A merged block has no SceneGraph building to promote, and neither has a
      // triangle the attribution could not place; both are left alone rather
      // than turned into a hero id nothing else in the app knows.
      if (id === null || id.startsWith("block-")) return;
      event.stopPropagation();
      onPick(id);
    };
  }

  return handlers;
}

/**
 * What a right-click reports: the region under the pointer, or null for a
 * click that hit nothing.
 *
 * Deliberately NOT a mesh handler. r3f raycasts every object that carries any
 * handler on every pointer move, so giving the base and the frame an
 * `onContextMenu` would put a 40 000-triangle plate back into the per-move
 * raycast that v3-10 took it out of. This is one native listener on the canvas
 * that raycasts on the CONTEXTMENU event alone, which costs nothing until the
 * user asks, and can therefore answer for the regions no hover reaches: the
 * base, the frame and the matting.
 */
export type InspectHandler = (hit: HoverHit | null, clientX: number, clientY: number) => void;

export function RegionMeshes({
  regions,
  recessBands,
  dimmed,
  dimOpacity,
  recessShade,
  tints = null,
  onHover,
  onPick,
  onInspect,
}: {
  regions: ReadonlyMap<string, RegionMesh>;
  recessBands: readonly RecessBand[];
  /** True while the meshes describe older parameters than the controls do. */
  dimmed: boolean;
  dimOpacity: number;
  recessShade: number;
  /** Per-building colours from `EngineResult.buildingTints`, or null when `colour.tint` is off. */
  tints?: TintMap;
  /**
   * Called with the raycast hit under the pointer, or null when it leaves. Only
   * the regions `isPickableRegion` names get a handler at all, which is also
   * what keeps three.js from raycasting the base and the frame on every move.
   * The identity of this function must be stable, or every move would re-render
   * the meshes; `useObjectHover` guarantees that.
   */
  onHover?: HoverHandler;
  /**
   * Hero picking, straight off the buildings solid: the clicked triangle's
   * owner. Replaces the invisible proxy layer (v3-06 audit, finding C2).
   */
  onPick?: (id: string) => void;
  /**
   * A right-click anywhere on the model, with the region it landed on. Its
   * identity may change freely: it is held in a ref and never re-binds the
   * listener.
   */
  onInspect?: InspectHandler;
}) {
  // A ref rather than a memo because the unit of work is ONE region: a memo
  // over the whole map would rebuild every region's buffers whenever any
  // single one arrived, which is the cost progressive streaming exists to
  // avoid.
  const cache = useRef<RegionGeometryCache | null>(null);
  cache.current ??= new RegionGeometryCache();
  const store = cache.current;
  const press = useRef<{ x: number; y: number } | null>(null);

  const built = useMemo(
    () => store.reconcile(regions, recessBands, recessShade, tints),
    [store, regions, recessBands, recessShade, tints],
  );

  // --- the right-click path -------------------------------------------------
  const groupRef = useRef<Group>(null);
  const inspectRef = useRef<InspectHandler | undefined>(onInspect);
  inspectRef.current = onInspect;
  const meshesRef = useRef<ReadonlyMap<string, RegionMesh>>(regions);
  meshesRef.current = regions;
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    const canvas = gl.domElement;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const onContextMenu = (event: MouseEvent): void => {
      const report = inspectRef.current;
      const group = groupRef.current;
      if (report === undefined || group === null) return;
      // The browser menu never opens over the model: the app's own menu is
      // what a right-click here is for, and two menus at once is neither.
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) {
        report(null, event.clientX, event.clientY);
        return;
      }
      pointer.x = ((event.clientX - box.left) / box.width) * 2 - 1;
      pointer.y = -((event.clientY - box.top) / box.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(group.children, false);
      for (const hit of hits) {
        const region = (hit.object.userData as { region?: string }).region;
        const mesh = region === undefined ? undefined : meshesRef.current.get(region);
        const faceIndex = hit.faceIndex;
        if (region === undefined || mesh === undefined || faceIndex === undefined || faceIndex === null) continue;
        const local = hit.object.worldToLocal(hit.point.clone());
        report({ region, mesh, faceIndex, xMm: local.x, yMm: local.y }, event.clientX, event.clientY);
        return;
      }
      report(null, event.clientX, event.clientY);
    };
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => canvas.removeEventListener("contextmenu", onContextMenu);
  }, [gl, camera]);

  // Every geometry still in the cache is this component's own to dispose when
  // it unmounts; the reconciliation above owns the rest. The cursor is this
  // component's too: an unmount while the pointer is over a building would
  // otherwise leave the page stuck on `pointer`.
  useEffect(
    () => () => {
      store.dispose();
      document.body.style.cursor = "";
    },
    [store],
  );

  // The pointer props, reused across renders while nothing they close over
  // moved. This component re-renders on every store write the viewport reads
  // (each stage a run starts, each parameter edit), and to r3f a prop that is
  // a fresh function or a fresh object IS a changed prop: it is applied, and
  // in a demand-mode loop an applied prop is a rendered frame. Handed the same
  // handlers and the same `userData` object, r3f finds nothing to apply, and
  // a re-render that changed no mesh asks for no frame. Measured on the smoke
  // test's software-GL host, that was one 60 ms frame per stage event, back to
  // back, for the whole of a lettering run.
  const handlerCache = useRef(new Map<string, HandlerEntry>());
  const handlersFor = (region: string, mesh: RegionMesh): MeshInteraction => {
    const held = handlerCache.current.get(region);
    if (held !== undefined && held.mesh === mesh && held.onHover === onHover && held.onPick === onPick) {
      return held.handlers;
    }
    const handlers = interactionHandlers(region, mesh, onHover, onPick, press);
    handlerCache.current.set(region, { mesh, onHover, onPick, handlers });
    return handlers;
  };
  for (const region of handlerCache.current.keys()) {
    if (!regions.has(region)) handlerCache.current.delete(region);
  }

  // `data-testid` on a react-three-fiber primitive is NOT a DOM attribute --
  // `<group>`/`<mesh>` become real `THREE.Object3D` instances inside the
  // WebGL canvas, not HTML elements, so a Playwright DOM locator can never
  // find these. They are still named for anyone reading the render tree with
  // r3f devtools or the `useThree` state directly; an e2e that needs to prove
  // a region is on screen reads `window.__framecraft` (`CityPreview.tsx`),
  // not a DOM query.
  return (
    <group ref={groupRef} data-testid="region-meshes">
      {/* Perf mode only: the first frame that actually renders these meshes,
          which is where three.js uploads the buffers this component built. */}
      <PerfFrameMark key={built.id} name="preview.geometryOnScreen" />
      {built.regions.map(({ region, mesh, geometry, vertexColors, materialColor }) => (
        <mesh
          key={region}
          data-testid={`region-mesh-${region}`}
          userData={userDataFor(region)}
          geometry={geometry}
          castShadow={!dimmed}
          receiveShadow={!dimmed}
          {...(isPickableRegion(region) ? handlersFor(region, mesh) : {})}
        >
          <meshStandardMaterial
            color={materialColor}
            vertexColors={vertexColors}
            roughness={0.85}
            flatShading
            transparent={dimmed}
            opacity={dimmed ? dimOpacity : 1}
            depthWrite={!dimmed}
          />
        </mesh>
      ))}
    </group>
  );
}

export default RegionMeshes;
