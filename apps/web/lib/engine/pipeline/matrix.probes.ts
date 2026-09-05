/**
 * The V3-1 acceptance matrix: one probe per `PrintParams` leaf.
 *
 * A probe is a leaf path, a value to write, whatever `base` the field needs so
 * it has something to act on, the scene to build, and two assertions: what
 * moved on the `EngineResult` the preview draws, and what moved inside the
 * bytes the export stage wrote. `why` is the one line printed when a probe
 * fails, and it says what the field physically does; "the hash moved" is not an
 * assertion and does not appear here.
 *
 * The four exemptions are at the bottom with their `DECISIONS.md` reasons.
 * `matrix.test.ts` walks `PRINT_PARAM_LEAF_PATHS` and fails if any leaf is
 * neither probed nor exempt, so a schema addition cannot slip through.
 *
 * Not a test file: `matrix.test.ts` imports it.
 */

import { expect } from "vitest";

import type { ObjectOverride, PrintParams } from "../../contracts";
import * as T from "../../transform";
import type { Bbox3, RegionMesh, RegionName } from "../types";
import {
  bambuMetadata,
  bambuParts,
  bambuPartsOf,
  bambuProject,
  colorChangeLayers,
  fileNames,
  findingOf,
  generic3mf,
  maxXPlusY,
  maxZOverFootprint,
  mtlNames,
  mustPart,
  mustRegion,
  objGroups,
  partExtentAtZ,
  recessBandsOf,
  regionNames,
  resolvedLine,
  sidecarNumber,
  sidecarRegions,
  sidecarString,
  sidecarValue,
  sidecarWarnings,
  stlTriangles,
  triangleCount,
  verticesAtZ,
  zipEntry,
  zipNames,
  type FilePart,
  type PlanWindow,
  type Snapshot,
} from "./matrix.assert";
import { OSM_BUILDING_SIZE_M, OSM_FOOTPRINTS, OSM_LEVELS } from "./fixtures/overpassBlock";
import type { MatrixScene } from "./matrix.run";
import type { ParamPath } from "./paths";

export interface Probe {
  path: ParamPath;
  value: unknown;
  base?: Partial<PrintParams>;
  scene: MatrixScene;
  /** What the field physically does, in one line. Printed when the probe fails. */
  why: string;
  /**
   * Export this probe's `after` build past the printability gate.
   *
   * Set ONLY on a probe whose value deliberately trips a Stage 4 row, with the
   * row named in the comment beside it. Every other probe exports through the
   * gate the product ships, so a change that starts breaking a gate row fails
   * the matrix instead of being written and asserted as if nothing happened.
   */
  forceExport?: true;
  assertPreview(before: Snapshot, after: Snapshot): void;
  assertExport(before: Snapshot, after: Snapshot): void;
}

// ---------------------------------------------------------------------------
// Readers, short enough to keep a probe to a few lines
// ---------------------------------------------------------------------------

const R = (snapshot: Snapshot, name: RegionName): RegionMesh => mustRegion(snapshot.result, name);
const P = (snapshot: Snapshot, name: string): FilePart => mustPart(snapshot.files, name);
const N = (snapshot: Snapshot): RegionName[] => regionNames(snapshot.result);
const spanOf = (box: Bbox3, axis: 0 | 1 | 2): number => box.max[axis] - box.min[axis];
const warnings = (snapshot: Snapshot): string => sidecarWarnings(snapshot.sidecar).join(" ");

/** Printed millimetres per ground metre, from the scale the build reports. */
const mmPerM = (snapshot: Snapshot): number => 1000 / snapshot.result.stats.scaleDenominator;

/**
 * The translation between the engine frame (plate centred on the origin) and
 * the build frame the file is written in, read from the base region and the
 * base part of the same snapshot rather than assumed.
 */
function buildOffset(snapshot: Snapshot): [number, number] {
  const region = R(snapshot, "base");
  const part = P(snapshot, "base");
  return [part.bbox.min[0] - region.bbox.min[0], part.bbox.min[1] - region.bbox.min[1]];
}

/** `#RRGGBB` as the three 0-to-1 components an MTL `Kd` row carries. */
function unitRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/** The `Kd` row of one named material of the MTL beside an OBJ. */
function mtlKd(files: Snapshot["files"], material: string): [number, number, number] {
  const mtl = files.find((file) => file.name.endsWith(".mtl"));
  if (mtl === undefined) throw new Error("this build wrote no MTL");
  const lines = new TextDecoder().decode(mtl.bytes).split("\n");
  const at = lines.findIndex((line) => line.trim() === `newmtl ${material}`);
  if (at === -1) throw new Error(`the MTL has no ${material} material (it has ${mtlNames(files).join(", ")})`);
  const kd = lines.slice(at + 1).find((line) => line.startsWith("Kd "));
  if (kd === undefined) throw new Error(`the MTL's ${material} carries no Kd row`);
  const parts = kd.slice(3).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`the MTL's ${material} Kd row is ${JSON.stringify(kd)}`);
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * The x span of the glyph pocket floors of the lettering cut into ONE edge of
 * the frame, in the preview or in the written file.
 *
 * A longer string cuts a wider pocket at a centred alignment, and a different
 * face cuts a differently proportioned one, so this is the number a probe that
 * changes what a line SAYS can point at. The y window picks the edge, because
 * both frame edges share the pocket floor's z.
 */
function letteringSpan(snapshot: Snapshot, where: "preview" | "file", edge: "top" | "bottom"): number {
  const bands = recessBandsOf(snapshot.result, "frame", "lettering");
  if (bands.length === 0) throw new Error("this build cut no lettering into the frame");
  const low = Math.min(...bands.map((band) => band.zMm[0]));
  const centre: [number, number] = where === "file" ? buildOffset(snapshot) : [0, 0];
  const positions = where === "file" ? P(snapshot, "frame").positions : R(snapshot, "frame").positions;
  const window: PlanWindow = edge === "top" ? { yMin: centre[1] } : { yMax: centre[1] };
  const extent = flatFaceExtentAtZ(positions, low, centre, flatFaceFromMm(snapshot.result.params), window);
  if (extent === null) throw new Error(`no ${edge}-edge lettering pocket floor in the ${where}`);
  return extent[1] - extent[0];
}

/**
 * Where the lip's FLAT top face begins, measured from the plate centre along
 * the axis that crosses the lip, mm: the opening, plus the sight-edge rebate,
 * plus half the text margin, so the boundary sits between the two features
 * that share a plane rather than on either.
 *
 * Why a plane read on the frame has to be banded at all: the contract's
 * default engraving depth and default rebate depth are both 0.4 mm
 * (`[V3.1-P2-2]`), so a lettering pocket's floor and the rebate's floor are
 * the same z, and a read of every vertex on that plane picks up the rebate
 * floor's corners at 84 and 85 mm on both axes and calls a pocket 170 mm wide.
 * Ink is laid out on the flat face and never on the rebate
 * (`transform.lip_face_width_mm`), so a pocket read restricted to the face is
 * the same question asked of the feature that carries the pocket and no other.
 * It is not a tolerance: the band is a hard boundary in plan, and a pocket that
 * moved off the face would vanish from the read and fail the probe.
 */
function flatFaceFromMm(params: PrintParams): number {
  return T.frame_geometry_mm(params).inner_half_mm + T.FRAME_SIGHT_EDGE_MM + T.LIP_TEXT_MARGIN_MM / 2;
}

/**
 * Plan extent `[minX, maxX, minY, maxY]` of the vertices at height `z` that
 * lie on the lip's flat face of any edge (`max(|x - cx|, |y - cy|)` at least
 * `fromMm`), further limited by `window`; null when there are none.
 */
function flatFaceExtentAtZ(
  positions: ArrayLike<number>,
  z: number,
  centre: [number, number],
  fromMm: number,
  window?: PlanWindow,
  tol = 1e-6,
): [number, number, number, number] | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let seen = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2] - z) > tol) continue;
    const x = positions[i];
    const y = positions[i + 1];
    if (Math.max(Math.abs(x - centre[0]), Math.abs(y - centre[1])) < fromMm) continue;
    if (window !== undefined) {
      if (window.xMin !== undefined && x < window.xMin) continue;
      if (window.xMax !== undefined && x > window.xMax) continue;
      if (window.yMin !== undefined && y < window.yMin) continue;
      if (window.yMax !== undefined && y > window.yMax) continue;
    }
    seen += 1;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return seen === 0 ? null : [minX, maxX, minY, maxY];
}

/**
 * How far a cut face may sit from the height that was asked for, mm.
 *
 * The kernel quantises a slice: a channel cut 0.8 mm under a 6 mm plate top
 * comes back at z = 5.199951, not 5.2. A hundredth of a millimetre is far below
 * any depth the matrix probes and far above that quantisation.
 */
const SLICE_TOL_MM = 0.01;

/** A rectangular ring read off one z level: how many vertices, and its two edges. */
interface Ring {
  count: number;
  /** Distance from the plate centre to the ring's inner edge, mm. */
  inner: number;
  /** Distance from the plate centre to its outer edge, mm. */
  outer: number;
}

/**
 * The ring of vertices at one height, measured from the plate centre.
 *
 * A shadow gap, a sight-edge rebate and a frame lip are all rectangular rings
 * cut concentrically into a square plate, so their two edges and their width are
 * the numbers a probe for one of those fields can name. `centreX` is 0 in the
 * engine frame and the build offset in a written file; `minAbsX` drops geometry
 * nearer the middle, which is how the gap ring is separated from the surface
 * recesses that share its z.
 */
/**
 * `ringAt` restricted to the plate's four CORNER squares: vertices at least
 * `minAbsMm` from the centre on BOTH axes.
 *
 * The sight-edge rebate's floor is a rectangular ring whose vertices are its
 * eight corners, at the opening's half-width and one millimetre further out on
 * both axes, so the corner squares hold the whole ring and nothing is lost.
 * What they exclude is the mandatory inner-wall attribution: its glyphs are
 * engraved into the four walls of the opening, centred along each wall and
 * kept 1.5 mm from its ends, so their vertices sit at the opening's half-width
 * on ONE axis and well inside it on the other. A read banded on x alone would
 * still count the east and west walls' glyphs, whose x is the opening's, which
 * is why both axes are banded. Nothing about the tolerance changes: the ring
 * still has to be on the plane to `SLICE_TOL_MM`.
 */
function cornerRingAt(positions: ArrayLike<number>, z: number, centre: [number, number], minAbsMm: number, tol = SLICE_TOL_MM): Ring {
  let inner = Infinity;
  let outer = -Infinity;
  let count = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2] - z) > tol) continue;
    const dx = Math.abs(positions[i] - centre[0]);
    const dy = Math.abs(positions[i + 1] - centre[1]);
    if (dx < minAbsMm || dy < minAbsMm) continue;
    count += 1;
    inner = Math.min(inner, dx);
    outer = Math.max(outer, dx);
  }
  return { count, inner, outer };
}

function ringAt(positions: ArrayLike<number>, z: number, centreX: number, minAbsX = 0, tol = SLICE_TOL_MM): Ring {
  let inner = Infinity;
  let outer = -Infinity;
  let count = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i + 2] - z) > tol) continue;
    const distance = Math.abs(positions[i] - centreX);
    if (distance < minAbsX) continue;
    count += 1;
    inner = Math.min(inner, distance);
    outer = Math.max(outer, distance);
  }
  return { count, inner, outer };
}

/**
 * One region as ONE TILE's own 3MF carries it.
 *
 * A tiled build writes a zip of per-tile projects, so the tile's file comes out
 * of the zip and goes through the same reader the untiled probes use. Nothing
 * here looks at the zip's byte length.
 */
function tilePart(snapshot: Snapshot, label: string, region: string): FilePart {
  const inner = zipEntry(snapshot.files[0].bytes, `framecraft-${label}.3mf`);
  const parts = bambuPartsOf(inner);
  const found = parts.get(region);
  if (found === undefined) throw new Error(`tile ${label} has no ${region} part (it has ${[...parts.keys()].join(", ")})`);
  return found;
}

/**
 * The shipped rule for a filament slot's colour
 * (`export/common.ts:slotColors`): the FIRST region on that slot in
 * `REGION_NAMES` order publishes its swatch, and a later region sharing the
 * slot never does. `result.regions` is already in that order.
 *
 * Every colour probe asserts this, which is what makes "this region's colour
 * reached slot N" mean something: the file does not simply carry whatever the
 * last writer said.
 */
function expectSlotColourComesFromTheFirstRegion(snapshot: Snapshot): void {
  const bySlot = new Map<number, RegionMesh[]>();
  for (const region of snapshot.result.regions) {
    const list = bySlot.get(region.slot);
    if (list === undefined) bySlot.set(region.slot, [region]);
    else list.push(region);
  }
  const shared = [...bySlot.entries()].find(([, list]) => list.length > 1 && list[0].colorHex !== list[1].colorHex);
  if (shared === undefined) throw new Error("this build has no slot shared by two regions of different colours");
  const [slot, list] = shared;
  const filament = bambuProject(snapshot.files).filament_colour[slot - 1];
  expect(filament, `slot ${slot} must carry ${list[0].region}'s colour, not ${list[1].region}'s`).toBe(list[0].colorHex);
  expect(filament).not.toBe(list[1].colorHex);
}

/**
 * The roof height the buildings region reaches over ONE fixture footprint.
 *
 * The Overpass fixture puts each building type on its own 46 m square at least
 * 120 m from its neighbours, so this is the height the rule for THAT type
 * produced. `where: "file"` reads the written 3MF's own vertices instead.
 */
function roofOverFootprint(snapshot: Snapshot, name: keyof typeof OSM_FOOTPRINTS, where: "preview" | "file"): number {
  const spot = OSM_FOOTPRINTS[name];
  const scale = mmPerM(snapshot);
  // Half the square plus 5 m of slack for the skirt and the footprint repair;
  // still less than half the 120 m gap to the next square.
  const half = (OSM_BUILDING_SIZE_M / 2 + 5) * scale;
  const [dx, dy] = where === "file" ? buildOffset(snapshot) : [0, 0];
  const positions = where === "file" ? P(snapshot, "buildings").positions : R(snapshot, "buildings").positions;
  const cx = spot.eastM * scale + dx;
  const cy = spot.northM * scale + dy;
  const top = maxZOverFootprint(positions, cx - half, cx + half, cy - half, cy + half);
  if (top === null) throw new Error(`the ${where} buildings carry no geometry over the ${name} footprint`);
  return top;
}

/** The plan extent of the pocket floors of one recess band, engine frame. */
function pocketFloor(snapshot: Snapshot, region: RegionName, kind: "lettering" | "ornament" | "underside"): [number, number, number, number] {
  const bands = recessBandsOf(snapshot.result, region, kind);
  if (bands.length === 0) throw new Error(`no ${kind} recess band on ${region}`);
  const low = Math.min(...bands.map((band) => band.zMm[0]));
  // On the frame the read is banded to the lip's flat face, because the
  // sight-edge rebate's floor shares the plane of a default-depth pocket
  // (see `flatFaceFromMm`); every other region reads the whole plane.
  if (region === "frame") {
    const extent = flatFaceExtentAtZ(R(snapshot, region).positions, low, [0, 0], flatFaceFromMm(snapshot.result.params));
    if (extent === null) throw new Error(`no vertices on the lip's flat face at the ${kind} pocket floor z=${low}`);
    return extent;
  }
  const at = verticesAtZ(R(snapshot, region), low);
  if (at.length === 0) throw new Error(`no vertices at the ${kind} pocket floor z=${low} of ${region}`);
  const xs = at.map((point) => point[0]);
  const ys = at.map((point) => point[1]);
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}

/** The same pocket floor read out of the written 3MF, build frame. */
function filePocketFloor(snapshot: Snapshot, region: RegionName, kind: "lettering" | "ornament" | "underside"): [number, number, number, number] {
  const bands = recessBandsOf(snapshot.result, region, kind);
  if (bands.length === 0) throw new Error(`no ${kind} recess band on ${region}`);
  const low = Math.min(...bands.map((band) => band.zMm[0]));
  const extent =
    region === "frame"
      ? flatFaceExtentAtZ(P(snapshot, region).positions, low, buildOffset(snapshot), flatFaceFromMm(snapshot.result.params))
      : partExtentAtZ(P(snapshot, region), low);
  if (extent === null) throw new Error(`the written ${region} part has no vertices at z=${low}`);
  return extent;
}

/** A `stats` field that is a number on both sides. */
function statOf(snapshot: Snapshot, key: "heightMm" | "widthMm" | "depthMm" | "minWallMm" | "triangles" | "scaleDenominator"): number {
  return snapshot.result.stats[key];
}

// ---------------------------------------------------------------------------
// Shared bases
// ---------------------------------------------------------------------------

/** One frame-edge engraving carrying a token, so lettering has something to cut. */
const LETTERING: Partial<PrintParams> = {
  city_label: "Blockton",
  engravings: [{ edge: "top", align: "center", text: "{city}", mode: "engrave", size_mm: 4, depth_mm: 0.4, font: "sans" }],
};

/** The same line as an inlay, which is the only thing that builds a `lettering` region. */
const INLAY: Partial<PrintParams> = {
  city_label: "Blockton",
  engravings: [{ edge: "top", align: "center", text: "{city}", mode: "inlay", size_mm: 5, depth_mm: 0.4, font: "sans" }],
};

/** Two lines carrying the four `place` tokens. */
const PLACE: Partial<PrintParams> = {
  place: { country: "Landia", state: "Provo", neighbourhood: "Docks", author: "Tess" },
  engravings: [
    { edge: "top", align: "center", text: "{country} {state}", mode: "engrave", size_mm: 4, depth_mm: 0.4, font: "sans" },
    { edge: "bottom", align: "center", text: "{neighbourhood} {author}", mode: "engrave", size_mm: 4, depth_mm: 0.4, font: "sans" },
  ],
};

/** Arrow, bar and underside mark all on, so every ornament leaf has geometry. */
const ORNAMENTS: Partial<PrintParams> = {
  city_label: "Blockton",
  north_arrow: { enabled: true, corner: "ne", size_mm: 6 },
  scale_bar: { enabled: true, edge: "bottom", length_mode: "fixed", length_m: 40 },
  underside_mark: { enabled: true, template: "{city} {scale} {date}" },
};

/** A base thick enough to carry an underside pocket. */
const THICK: Partial<PrintParams> = { base_thickness_mm: 6 };

const HERO_OWN: Partial<PrintParams> = { hero_building_ids: ["b-tall"], hero_mode: "own_color" };
/**
 * A hero plus a large-building multiplier BELOW 1.0, which is the only setting
 * that separates `hero_mode`'s two halves: `hero_height_scale` is
 * `max(1.0, building_height_scale)`, so at the default 1.0 the hero rule and the
 * ordinary rule coincide and the height half of the field is asleep.
 */
const HERO_SHORT: Partial<PrintParams> = { hero_building_ids: ["b-tall"], large_scale: 0.6 };
const HERO_AUTO: Partial<PrintParams> = { hero_auto: { enabled: true, count: 3 } };

const MATTING: Partial<PrintParams> = { frame_style: { matting: { enabled: true, width_mm: 6, proud_mm: 0.4 } } };
const SHADOW: Partial<PrintParams> = { base_thickness_mm: 6, frame_style: { shadow_gap: { enabled: true, width_mm: 1.0, depth_mm: 0.8 } } };
const ROUNDED: Partial<PrintParams> = { frame_style: { corner: "rounded", corner_radius_mm: 3 } };
const SEPARATE: Partial<PrintParams> = {
  frame_style: { separate: { enabled: true, mount: "snap", tolerance_mm: 0.2 } },
  hanger_magnet: { diameter_mm: 3, thickness_mm: 2, count: 2 },
};
const SEPARATE_MAGNET: Partial<PrintParams> = {
  frame_style: { separate: { enabled: true, mount: "magnet", tolerance_mm: 0.2 } },
  hanger_magnet: { diameter_mm: 3, thickness_mm: 2, count: 2 },
};
/** A small plate keeps the knurl cheap: the texture cutter costs by frame length. */
const TEXTURE_OFF: Partial<PrintParams> = { plate_mm: 120, frame_style: { texture: { pattern: "none", scale_mm: 2.5, depth_mm: 0.2 } } };
const TEXTURE_ON: Partial<PrintParams> = { plate_mm: 120, frame_style: { texture: { pattern: "knurl", scale_mm: 2.5, depth_mm: 0.2 } } };

const TILED: Partial<PrintParams> = { tiling: { enabled: true, cols: 2, rows: 2, joint: "dovetail", tolerance_mm: 0.15, index_mark: true } };

/**
 * The sight-edge rebate `DECISIONS.md` `[V3.1-P2-2]` rules for
 * `frame_style.lip_depth_mm`: a step this wide, `lip_depth_mm` deep, on the
 * frame lip's inner top edge, with 0 meaning a flat lip. Read from the shared
 * transform math, which the geometry and the layout both build from.
 */
const FRAME_SIGHT_EDGE_MM = T.FRAME_SIGHT_EDGE_MM;
const LIP_DEFAULT_DEPTH_MM = T.LIP_DEPTH_DEFAULT_MM;
/** Deep enough to be unmistakable, shallow enough to fit the 2.2 mm lip. */
const LIP_REBATE_DEPTH_MM = 1.5;

/**
 * What the lip's text band can hold, mm, for the two size probes.
 *
 * The band is the 5 mm flat face less the 0.5 mm text margin each side, 4 mm
 * (`transform.edge_band_mm`, `[V3.1-P2-2]`; it was 5 mm before the rebate).
 * "Blockton" in sans fits that band at 5.41 mm (its ink height plus the one
 * nozzle an engraved stroke is widened by, floored to the layout's 0.01 mm
 * grid), and the north arrow's circumradius fits it at 3.43 mm
 * (`transform.north_arrow_max_size_mm`, 4.29 on the 5 mm band). Both are the
 * band-limited maximum, so a probe that asks for more must read exactly these.
 */
const BAND_LIMIT_BLOCKTON_SANS_MM = 5.41;
const BAND_LIMIT_NORTH_ARROW_MM = 3.43;

/**
 * The width `testScenes.ts` gives the rail scene's own way. The parameter's
 * default is the same 6 m, which is exactly why the probe drives it the other
 * way: at the default the two candidate semantics are indistinguishable.
 */
const RAIL_WAY_WIDTH_M = 6;

/**
 * One region parked on a slot the 4-slot custom profile cannot reach, so
 * `custom_profile.slots` has something to bring back into range.
 */
const SLOT_SIX: Partial<PrintParams> = { colour: { region_slots: { parks: 6 } } };

/**
 * Frame material a 3 mm to 4 mm magnet bore removes, mm3, measured on this
 * scene: eight pockets (`hanger_magnet.count` per side, four sides), each
 * gaining pi/4 * (4^2 - 3^2) = 5.498 mm2 of bore over the frame's ~1.03 mm share
 * of the magnet's 2 mm thickness. Pinning the number rather than the direction
 * is what makes the probe specific to the DIAMETER.
 */
const MAGNET_BORE_DELTA_MM3 = 45.31;

/** The shadow gap's default depth, and where to look for its ring. */
const GAP_DEFAULT_DEPTH_MM = 0.8;
/**
 * The gap is a ring just inside the frame, and it shares its z with the road and
 * park recesses in the middle of the plate; 80 mm out from the centre is past
 * every one of those on the 180 mm plate and well inside the gap.
 */
const GAP_RING_MIN_ABS_X = 80;
const GRADIENT: Partial<PrintParams> = { colour: { gradient: { enabled: true, slots: [2, 3] } } };
/** The parks region parked on a slot the 4-slot custom profile does not have, so the audit's slot rule fires. */
const SLOT_OVERRUN: Partial<PrintParams> = { colour: { region_slots: { parks: 9 } } };
/** OBJ in parts mode is the one target that writes a material per tinted building. */
const TINT_OBJ: Partial<PrintParams> = {
  export_target: "obj",
  color_mode: "parts",
  colour: { tint: { enabled: true, hue_range_deg: 12, lightness_range: 0.12, seed: 1 } },
};
// --- per-object overrides (v3.1 Task 11) -----------------------------------

/**
 * The objects the override probes name, in the `override` scene.
 *
 * All four are the `testScenes.ts` block's own: the 72 m tower east of the
 * centre, the 18 m block in the west, the road across the middle and the pond
 * in the south-west, which `overrideScene()` gives an `osm_id` so a row can
 * name it at all.
 */
const OVERRIDE_TOWER_ID = "b-tall";
const OVERRIDE_LOW_ID = "b-low";
const OVERRIDE_ROAD_ID = "r-main";
const OVERRIDE_POND_ID = "w-pond";

/** One override row, spelled out so the probe's own leaf is the only thing moving. */
const overrideRow = (row: ObjectOverride): Partial<PrintParams> => ({ object_overrides: [row] });

/** A bare row on the tower: it names an object and asks for nothing yet. */
const OVR_TOWER = overrideRow({ osm_id: OVERRIDE_TOWER_ID, layer: "building" });

/**
 * The same row with the tower already hidden, for the two IDENTITY leaves.
 *
 * `osm_id` and `layer` are the key the row is matched by, and a key on a row
 * that asks for nothing moves nothing; both probes therefore start from a hide
 * and read where the hide went.
 */
const OVR_TOWER_HIDDEN = overrideRow({ osm_id: OVERRIDE_TOWER_ID, layer: "building", hidden: true });

/**
 * The tower already on a slot of its own, so `color` has an override region to
 * colour, plus the water region moved off slot 3.
 *
 * The project loads ONE filament colour per slot, from the first BUILT region
 * on it (`export/common.ts:slotColors`, and `COLOURABLE_REGION_NAMES` puts
 * `water` ahead of every `override_N`). With water left on its default slot 3
 * the override's colour never reaches `filament_colour`, and the probe would
 * have the sidecar row alone. Moving water to the buildings' slot leaves the
 * override the only region on slot 3, which is the case the field is for.
 */
const OVR_TOWER_OWN_SLOT: Partial<PrintParams> = {
  object_overrides: [{ osm_id: OVERRIDE_TOWER_ID, layer: "building", slot: 3 }],
  colour: { region_slots: { water: 2 } },
};

/** A tint is preview-and-OBJ only, exactly as `colour.tint` is. */
const OVR_TOWER_OBJ: Partial<PrintParams> = {
  ...OVR_TOWER,
  export_target: "obj",
  color_mode: "parts",
};

const OVR_ROAD = overrideRow({ osm_id: OVERRIDE_ROAD_ID, layer: "road" });
const OVR_POND = overrideRow({ osm_id: OVERRIDE_POND_ID, layer: "water" });

const OVERRIDE_TINT_HEX = "#B08D57";
const OVERRIDE_COLOR_HEX = "#B00020";

/**
 * What the `override` scene prints, measured on this tree, mm and mm3.
 *
 * The tower's own printed solid, the roof of the tower and of the courtyard
 * block (the tallest thing left when the tower goes), and the west edge of the
 * low block and of the courtyard block (the westmost thing left when the low
 * block goes). A probe that moves ONE object names the number that object owns,
 * so a change that removed a different building fails.
 */
const TOWER_VOLUME_MM3 = 10430.27;
const TOWER_ROOF_MM = 33.24;
const COURT_ROOF_MM = 15.6;
const LOW_WEST_EDGE_MM = -32.76;
const COURT_WEST_EDGE_MM = -29.4;

/** The ground width `testScenes.ts` gives `r-main`, which `width_scale` multiplies. */
const ROAD_WAY_WIDTH_M = 14;

const GENERIC: Partial<PrintParams> = { export_target: "generic-3mf" };
const COLORCHANGE: Partial<PrintParams> = { export_target: "color-change-3mf" };
const TERRAIN_ON: Partial<PrintParams> = { terrain: { enabled: true, smoothing: 0 } };

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const PROBES: readonly Probe[] = [
  // --- plate, base, nozzle -------------------------------------------------
  {
    path: "plate_mm",
    value: 220,
    scene: "block",
    why: "the plate is the printed square, so the base region and every part placed on it grow with it",
    assertPreview: (before, after) => {
      expect(spanOf(R(before, "base").bbox, 0)).toBe(180);
      expect(spanOf(R(after, "base").bbox, 0)).toBe(220);
      expect(statOf(after, "widthMm")).toBe(220);
      expect(statOf(after, "scaleDenominator")).toBeLessThan(statOf(before, "scaleDenominator"));
    },
    assertExport: (before, after) => {
      expect(spanOf(P(before, "base").bbox, 0)).toBe(180);
      expect(spanOf(P(after, "base").bbox, 0)).toBe(220);
      expect(sidecarNumber(after.sidecar, "bake_result.stats.width_mm")).toBe(220);
    },
  },
  {
    path: "base_thickness_mm",
    value: 5,
    scene: "block",
    why: "the plate gets thicker, so the base region is taller and everything standing on it is lifted",
    assertPreview: (before, after) => {
      expect(spanOf(R(before, "base").bbox, 2)).toBeCloseTo(3, 6);
      expect(spanOf(R(after, "base").bbox, 2)).toBeCloseTo(5, 6);
      expect(R(after, "roads").bbox.min[2]).toBeCloseTo(R(before, "roads").bbox.min[2] + 2, 6);
    },
    assertExport: (before, after) => {
      expect(spanOf(P(after, "base").bbox, 2)).toBeCloseTo(5, 6);
      expect(P(after, "base").volumeMm3).toBeGreaterThan(P(before, "base").volumeMm3);
      expect(sidecarNumber(after.sidecar, "bake_result.stats.height_mm")).toBeCloseTo(sidecarNumber(before.sidecar, "bake_result.stats.height_mm") + 2, 3);
    },
  },
  {
    path: "nozzle_mm",
    value: 0.8,
    scene: "block",
    why: "a wider nozzle doubles the minimum wall, which coarsens the plate's cuts and fattens the tree cones",
    assertPreview: (before, after) => {
      expect(statOf(before, "minWallMm")).toBeCloseTo(0.8, 6);
      expect(statOf(after, "minWallMm")).toBeCloseTo(1.6, 6);
      expect(triangleCount(R(after, "base"))).toBeLessThan(triangleCount(R(before, "base")));
      expect(R(after, "parks").volumeMm3).toBeGreaterThan(R(before, "parks").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(sidecarNumber(after.sidecar, "bake_result.stats.min_wall_mm")).toBeCloseTo(1.6, 6);
      expect(P(after, "base").triangles).toBeLessThan(P(before, "base").triangles);
      expect(P(after, "parks").volumeMm3).toBeGreaterThan(P(before, "parks").volumeMm3);
    },
  },
  {
    path: "small_scale",
    value: 1.5,
    scene: "block",
    why: "small footprints are dilated so they survive the nozzle, which adds material to the buildings region without changing its outline",
    assertPreview: (before, after) => {
      expect(R(after, "buildings").volumeMm3).toBeGreaterThan(R(before, "buildings").volumeMm3 * 1.1);
      expect(R(after, "buildings").bbox.max[2]).toBeCloseTo(R(before, "buildings").bbox.max[2], 6);
    },
    assertExport: (before, after) => {
      expect(P(after, "buildings").volumeMm3).toBeGreaterThan(P(before, "buildings").volumeMm3 * 1.1);
      expect(sidecarRegions(after.sidecar).get("buildings")?.volume_mm3).toBeGreaterThan(sidecarRegions(before.sidecar).get("buildings")?.volume_mm3 ?? 0);
    },
  },
  {
    path: "large_scale",
    value: 2.0,
    scene: "block",
    // Trips `exceeds-height`: 63 mm against the 60 mm ceiling, on purpose.
    forceExport: true,
    why: "tall buildings are stretched, so the model's printed height doubles and trips the height ceiling",
    assertPreview: (before, after) => {
      expect(statOf(after, "heightMm")).toBeGreaterThan(statOf(before, "heightMm") * 1.7);
      expect(R(after, "buildings").bbox.max[2]).toBeGreaterThan(R(before, "buildings").bbox.max[2] * 1.7);
      expect(findingOf(after.result, "exceeds-height")).toBeDefined();
    },
    assertExport: (before, after) => {
      expect(P(after, "buildings").bbox.max[2]).toBeGreaterThan(P(before, "buildings").bbox.max[2] * 1.7);
      expect(sidecarNumber(after.sidecar, "bake_result.stats.height_mm")).toBeGreaterThan(sidecarNumber(before.sidecar, "bake_result.stats.height_mm") * 1.7);
      expect(warnings(after)).toContain("too tall to print");
    },
  },
  {
    path: "terrain_exaggeration",
    value: 2.5,
    base: TERRAIN_ON,
    scene: "terrain",
    why: "the hillside's printed relief is multiplied, so the draped plate and everything on it climb",
    assertPreview: (before, after) => {
      expect(after.result.stats.terrainReliefMm ?? 0).toBeGreaterThan((before.result.stats.terrainReliefMm ?? 0) * 2);
      expect(R(after, "base").bbox.max[2]).toBeGreaterThan(R(before, "base").bbox.max[2] * 2);
    },
    assertExport: (before, after) => {
      expect(P(after, "base").bbox.max[2]).toBeGreaterThan(P(before, "base").bbox.max[2] * 2);
      expect(P(after, "base").volumeMm3).toBeGreaterThan(P(before, "base").volumeMm3 * 1.5);
    },
  },
  {
    path: "road_mode",
    value: "off",
    scene: "block",
    why: "roads off removes the roads region entirely and leaves the plate uncarved where they ran",
    assertPreview: (before, after) => {
      expect(N(before)).toContain("roads");
      expect(N(after)).not.toContain("roads");
      expect(R(after, "base").volumeMm3).toBeGreaterThan(R(before, "base").volumeMm3);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).toContain("roads");
      expect([...bambuParts(after.files).keys()]).not.toContain("roads");
      expect(sidecarRegions(after.sidecar).has("roads")).toBe(false);
    },
  },
  {
    path: "road_scale",
    value: 2.0,
    scene: "block",
    why: "the road ribbon is drawn twice as wide, so the roads region widens across the centreline",
    assertPreview: (before, after) => {
      // Not exactly twice: the ribbon is built from the ground width and then
      // clamped up to a printable wall, so the doubling is of the ground width.
      const ratio = spanOf(R(after, "roads").bbox, 1) / spanOf(R(before, "roads").bbox, 1);
      expect(ratio).toBeGreaterThan(1.8);
      expect(ratio).toBeLessThan(2.05);
      expect(R(after, "roads").volumeMm3).toBeGreaterThan(R(before, "roads").volumeMm3 * 1.8);
    },
    assertExport: (before, after) => {
      const ratio = spanOf(P(after, "roads").bbox, 1) / spanOf(P(before, "roads").bbox, 1);
      expect(ratio).toBeGreaterThan(1.8);
      expect(ratio).toBeLessThan(2.05);
      expect(P(after, "roads").volumeMm3).toBeGreaterThan(P(before, "roads").volumeMm3 * 1.8);
    },
  },
  {
    path: "trees",
    value: false,
    scene: "block",
    why: "the tree cones are unioned into the parks region, so switching them off flattens parks to its bare surface",
    assertPreview: (before, after) => {
      expect(before.result.stats.trees).toBe(3);
      expect(after.result.stats.trees).toBeUndefined();
      expect(triangleCount(R(after, "parks"))).toBeLessThan(triangleCount(R(before, "parks")) / 4);
      expect(R(after, "parks").bbox.max[2]).toBeLessThan(R(before, "parks").bbox.max[2]);
    },
    assertExport: (before, after) => {
      expect(P(after, "parks").triangles).toBeLessThan(P(before, "parks").triangles / 4);
      expect(P(after, "parks").bbox.max[2]).toBeLessThan(P(before, "parks").bbox.max[2]);
    },
  },
  {
    path: "water",
    value: false,
    scene: "block",
    why: "the pond stops being built, so the water region and its filament slot leave the file",
    assertPreview: (before, after) => {
      expect(N(before)).toContain("water");
      expect(N(after)).not.toContain("water");
      expect(R(after, "base").volumeMm3).toBeGreaterThan(R(before, "base").volumeMm3);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(after.files).keys()]).not.toContain("water");
      expect(bambuProject(before.files).filament_colour[2]).toBe("#2F7FC1");
      expect(bambuProject(after.files).filament_colour[2]).not.toBe("#2F7FC1");
    },
  },
  {
    path: "frame",
    value: false,
    scene: "block",
    why: "no frame means no frame region, no lip for the mandatory wall mark, and a wider city on the same plate",
    assertPreview: (before, after) => {
      expect(N(after)).not.toContain("frame");
      expect(resolvedLine(before.result, "attribution-frame-wall")?.status).toBe("cuts");
      expect(resolvedLine(after.result, "attribution-frame-wall")?.status).toBe("skipped");
      expect(statOf(after, "scaleDenominator")).toBeLessThan(statOf(before, "scaleDenominator"));
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).toContain("frame");
      expect([...bambuParts(after.files).keys()]).not.toContain("frame");
      expect((sidecarValue(after.sidecar, "attribution_bands") as unknown[]).length).toBeLessThan((sidecarValue(before.sidecar, "attribution_bands") as unknown[]).length);
    },
  },

  // --- lettering -----------------------------------------------------------
  {
    path: "city_label",
    value: "Riverside",
    base: LETTERING,
    scene: "block",
    why: "the label is what `{city}` expands to, and it also names the file and the 3MF title",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "engraving-0")?.text).toBe("Blockton");
      expect(resolvedLine(after.result, "engraving-0")?.text).toBe("Riverside");
      expect(triangleCount(R(after, "frame"))).not.toBe(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(fileNames(before.files)).toEqual(["blockton.3mf"]);
      expect(fileNames(after.files)).toEqual(["riverside.3mf"]);
      expect(bambuMetadata(before.files).get("Title")).toBe("FrameCraft Blockton");
      expect(bambuMetadata(after.files).get("Title")).toBe("FrameCraft Riverside");
    },
  },
  {
    path: "engravings[].text",
    value: "ZZZ",
    base: LETTERING,
    scene: "block",
    why: "a different string cuts different glyphs into the frame lip",
    assertPreview: (before, after) => {
      expect(resolvedLine(after.result, "engraving-0")?.text).toBe("ZZZ");
      expect(triangleCount(R(after, "frame"))).toBeLessThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeLessThan(P(before, "frame").triangles);
      expect(sidecarRegions(after.sidecar).get("frame")?.triangles).toBe(P(after, "frame").triangles);
    },
  },
  {
    path: "engravings[].edge",
    value: "bottom",
    base: LETTERING,
    scene: "block",
    why: "the same glyphs are cut into the opposite edge, so the pocket floors move from the north rail to the south one",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "engraving-0")?.surface).toBe("Frame, top edge");
      expect(resolvedLine(after.result, "engraving-0")?.surface).toBe("Frame, bottom edge");
      expect(pocketFloor(before, "frame", "lettering")[2]).toBeGreaterThan(80);
      expect(pocketFloor(after, "frame", "lettering")[3]).toBeLessThan(-80);
    },
    assertExport: (before, after) => {
      expect(filePocketFloor(before, "frame", "lettering")[2]).toBeGreaterThan(170);
      expect(filePocketFloor(after, "frame", "lettering")[3]).toBeLessThan(10);
      expect(P(after, "frame").triangles).toBe(P(before, "frame").triangles);
    },
  },
  {
    path: "engravings[].align",
    value: "end",
    base: LETTERING,
    scene: "block",
    why: "the line slides to the end of its edge: the same glyph pockets, a different span along x",
    assertPreview: (before, after) => {
      const from = pocketFloor(before, "frame", "lettering");
      const to = pocketFloor(after, "frame", "lettering");
      expect(from[0]).toBeLessThan(0);
      expect(to[0]).toBeGreaterThan(50);
      expect(to[1] - to[0]).toBeCloseTo(from[1] - from[0], 2);
    },
    assertExport: (before, after) => {
      const from = filePocketFloor(before, "frame", "lettering");
      const to = filePocketFloor(after, "frame", "lettering");
      expect(to[0]).toBeGreaterThan(from[0] + 60);
      expect(to[1] - to[0]).toBeCloseTo(from[1] - from[0], 2);
    },
  },
  {
    path: "engravings[].mode",
    value: "inlay",
    base: LETTERING,
    scene: "block",
    why: "an inlay fills the pocket with a second body, which is the only thing that builds a lettering region",
    assertPreview: (before, after) => {
      expect(N(before)).not.toContain("lettering");
      expect(N(after)).toContain("lettering");
      expect(resolvedLine(after.result, "engraving-0")?.mode).toBe("inlay");
      expect(R(after, "lettering").bodies).toBeGreaterThan(1);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).not.toContain("lettering");
      const part = P(after, "lettering");
      expect(part.triangles).toBeGreaterThan(0);
      expect(part.extruder).toBe(4);
    },
  },
  {
    path: "engravings[].size_mm",
    value: 7,
    base: LETTERING,
    scene: "block",
    why: "bigger glyphs are cut, and the engine reports the cap height it could actually fit on the lip",
    assertPreview: (before, after) => {
      // The 4 mm default fits as asked. 7 mm is more than the 4 mm band can
      // hold for this string, so the engine reports the band's own limit:
      // strictly more than the default (a regression that stopped honouring
      // size_mm fails), strictly less than what was asked (one that stopped
      // clamping fails), and exactly BAND_LIMIT_BLOCKTON_SANS_MM (one that
      // clamped to some other band fails). It read over 6 on the 5 mm band.
      const fitted = resolvedLine(after.result, "engraving-0")?.sizeMm ?? 0;
      expect(resolvedLine(before.result, "engraving-0")?.sizeMm).toBeCloseTo(4, 6);
      expect(fitted).toBeGreaterThan(4);
      expect(fitted).toBeLessThan(7);
      expect(fitted).toBeCloseTo(BAND_LIMIT_BLOCKTON_SANS_MM, 2);
      expect(R(after, "frame").volumeMm3).toBeLessThan(R(before, "frame").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3);
      expect(P(after, "frame").triangles).not.toBe(P(before, "frame").triangles);
    },
  },
  {
    path: "engravings[].depth_mm",
    value: 1.0,
    base: LETTERING,
    scene: "block",
    why: "the pocket is cut deeper: the same glyph outline, a floor 0.6 mm lower and that much less frame material",
    assertPreview: (before, after) => {
      expect(recessBandsOf(before.result, "frame", "lettering")[0].zMm[0]).toBeCloseTo(4.6, 1);
      expect(recessBandsOf(after.result, "frame", "lettering")[0].zMm[0]).toBeCloseTo(4.0, 1);
      expect(resolvedLine(after.result, "engraving-0")?.depthMm).toBeCloseTo(1.0, 6);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBe(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3 - 5);
    },
  },
  {
    path: "engravings[].font",
    value: "serif",
    base: LETTERING,
    scene: "block",
    why: "a different face cuts different outlines for the same string: the serif advances are wider, so the pocket is wider at the same cap height",
    assertPreview: (before, after) => {
      // The string is the invariant that isolates the face: it does not change.
      expect(resolvedLine(after.result, "engraving-0")?.text).toBe("Blockton");
      expect(resolvedLine(after.result, "engraving-0")?.sizeMm).toBe(resolvedLine(before.result, "engraving-0")?.sizeMm);
      expect(letteringSpan(after, "preview", "top")).toBeGreaterThan(letteringSpan(before, "preview", "top") + 0.1);
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(letteringSpan(after, "file", "top")).toBeGreaterThan(letteringSpan(before, "file", "top") + 0.1);
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).not.toBe(P(before, "frame").volumeMm3);
    },
  },

  // --- ornaments and the underside mark ------------------------------------
  {
    path: "north_arrow.enabled",
    value: false,
    base: ORNAMENTS,
    scene: "block",
    why: "the arrow is a pocket in the lip, so switching it off removes one resolved line and one ornament band",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "north arrow")?.status).toBe("cuts");
      expect(resolvedLine(after.result, "north arrow")).toBeUndefined();
      expect(recessBandsOf(after.result, "frame", "ornament").length).toBe(recessBandsOf(before.result, "frame", "ornament").length - 1);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeLessThan(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).toBeGreaterThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "north_arrow.corner",
    value: "sw",
    base: ORNAMENTS,
    scene: "block",
    why: "the arrow moves from the north-east corner of the lip to the south-west one",
    assertPreview: (before, after) => {
      expect(pocketFloor(before, "frame", "ornament")[1]).toBeGreaterThan(80);
      expect(pocketFloor(after, "frame", "ornament")[1]).toBeLessThan(0);
      expect(pocketFloor(after, "frame", "ornament")[0]).toBeLessThan(-85);
    },
    assertExport: (before, after) => {
      expect(filePocketFloor(before, "frame", "ornament")[1]).toBeGreaterThan(170);
      expect(filePocketFloor(after, "frame", "ornament")[1]).toBeLessThan(100);
    },
  },
  {
    path: "north_arrow.size_mm",
    value: 2,
    base: ORNAMENTS,
    scene: "block",
    why: "a smaller arrow is cut, and the engine reports the length it used after the lip's own clamp",
    assertPreview: (before, after) => {
      // The base asks for 6 mm, more than the 4 mm band holds, so the default
      // reports the band's cap, BAND_LIMIT_NORTH_ARROW_MM (it read over 4 on
      // the 5 mm band), which is also what the shared layout computes; 2 mm is
      // under the cap and is reported as asked, strictly smaller.
      const clamped = resolvedLine(before.result, "north arrow")?.sizeMm ?? 0;
      expect(clamped).toBeCloseTo(BAND_LIMIT_NORTH_ARROW_MM, 2);
      expect(clamped).toBeCloseTo(T.north_arrow_max_size_mm(before.result.params), 6);
      expect(resolvedLine(after.result, "north arrow")?.sizeMm).toBeCloseTo(2, 6);
      expect(resolvedLine(after.result, "north arrow")?.sizeMm ?? 0).toBeLessThan(clamped);
      expect(pocketFloor(after, "frame", "ornament")[1]).toBeLessThan(pocketFloor(before, "frame", "ornament")[1]);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").volumeMm3).toBeGreaterThan(P(before, "frame").volumeMm3);
      expect(filePocketFloor(after, "frame", "ornament")[1]).toBeLessThan(filePocketFloor(before, "frame", "ornament")[1]);
    },
  },
  {
    path: "scale_bar.enabled",
    value: false,
    base: ORNAMENTS,
    scene: "block",
    why: "the bar and its label are pockets in the lip, so switching them off removes a resolved line and most of the lip's cut geometry",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "scale bar (40 m)")?.status).toBe("cuts");
      expect(after.result.resolvedText.some((line) => line.id.startsWith("scale bar"))).toBe(false);
      expect(triangleCount(R(after, "frame"))).toBeLessThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeLessThan(P(before, "frame").triangles - 300);
      expect(P(after, "frame").volumeMm3).toBeGreaterThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "scale_bar.edge",
    value: "top",
    base: ORNAMENTS,
    scene: "block",
    why: "the bar moves from the south rail of the lip to the north one",
    assertPreview: (before, after) => {
      expect(pocketFloor(before, "frame", "ornament")[2]).toBeLessThan(-85);
      expect(pocketFloor(after, "frame", "ornament")[2]).toBeGreaterThan(80);
    },
    assertExport: (before, after) => {
      expect(filePocketFloor(before, "frame", "ornament")[2]).toBeLessThan(10);
      expect(filePocketFloor(after, "frame", "ornament")[2]).toBeGreaterThan(170);
    },
  },
  {
    path: "scale_bar.length_mode",
    value: "auto",
    base: ORNAMENTS,
    scene: "block",
    why: "auto picks the roundest ground length that prints inside the 15 to 40 mm window instead of the fixed 40 m",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "scale bar (40 m)")?.status).toBe("cuts");
      expect(resolvedLine(after.result, "scale bar (50 m)")?.status).toBe("cuts");
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "scale_bar.length_m",
    value: 90,
    base: ORNAMENTS,
    scene: "block",
    why: "the fixed ground length the bar stands for, and therefore its printed length and its label",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "scale bar (40 m)")?.status).toBe("cuts");
      expect(resolvedLine(after.result, "scale bar (90 m)")?.status).toBe("cuts");
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "underside_mark.enabled",
    value: false,
    base: ORNAMENTS,
    scene: "block",
    why: "the owner's own underside line stops being cut into the plate",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "underside-mark")?.status).toBe("cuts");
      expect(resolvedLine(after.result, "underside-mark")).toBeUndefined();
      expect(triangleCount(R(after, "base"))).toBeLessThan(triangleCount(R(before, "base")) - 2000);
    },
    assertExport: (before, after) => {
      expect(P(after, "base").triangles).toBeLessThan(P(before, "base").triangles - 2000);
      expect(P(after, "base").volumeMm3).toBeGreaterThan(P(before, "base").volumeMm3);
    },
  },
  {
    path: "underside_mark.template",
    value: "{city}",
    base: ORNAMENTS,
    scene: "block",
    why: "the template is the string cut underneath, after token expansion",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "underside-mark")?.text).toBe("Blockton 1:2,381 2026-09-02");
      expect(resolvedLine(after.result, "underside-mark")?.text).toBe("Blockton");
      expect(triangleCount(R(after, "base"))).toBeLessThan(triangleCount(R(before, "base")));
    },
    assertExport: (before, after) => {
      expect(P(after, "base").triangles).toBeLessThan(P(before, "base").triangles);
      expect(P(after, "base").volumeMm3).toBeGreaterThan(P(before, "base").volumeMm3);
    },
  },

  // --- hanger --------------------------------------------------------------
  {
    path: "hanger",
    value: "cleat",
    base: THICK,
    scene: "block",
    why: "a French cleat is a second printable part plus its mating pocket in the plate",
    assertPreview: (before, after) => {
      expect(N(before)).not.toContain("cleat");
      expect(N(after)).toContain("cleat");
      expect(R(after, "base").volumeMm3).toBeLessThan(R(before, "base").volumeMm3);
      expect(recessBandsOf(after.result, "base", "underside").length).toBeGreaterThan(0);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(after.files).keys()]).toContain("cleat");
      expect(P(after, "cleat").volumeMm3).toBeGreaterThan(0);
      expect(sidecarRegions(after.sidecar).has("cleat")).toBe(true);
    },
  },

  // --- heroes --------------------------------------------------------------
  {
    path: "hero_building_ids",
    value: ["b-tall"],
    scene: "block",
    why: "the named building is lifted out of the buildings region into its own hero region",
    assertPreview: (before, after) => {
      expect(N(before)).not.toContain("hero_building");
      expect(R(before, "buildings").bodies).toBe(3);
      expect(R(after, "buildings").bodies).toBe(2);
      expect(R(after, "hero_building").bodies).toBe(1);
      expect(R(after, "hero_building").bbox.max[2]).toBeCloseTo(R(before, "buildings").bbox.max[2], 6);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).not.toContain("hero_building");
      expect(P(after, "hero_building").volumeMm3).toBeGreaterThan(0);
      expect(P(after, "buildings").volumeMm3).toBeLessThan(P(before, "buildings").volumeMm3);
    },
  },
  {
    path: "hero_mode",
    value: "own_color",
    base: HERO_SHORT,
    scene: "block",
    why: "the mode decides BOTH halves: `true_height` holds the hero at its own height while the large-building multiplier shrinks everyone else, and `own_color` drops it into the ordinary rule and gives it its own slot and colour",
    assertPreview: (before, after) => {
      const plate = R(before, "base").bbox.max[2];
      const roof = (snapshot: Snapshot): number => R(snapshot, "hero_building").bbox.max[2] - plate;
      // The height half: at large_scale 0.6, `true_height` keeps the hero at
      // 1.0 and `own_color` lets the 0.6 multiplier reach it.
      expect(roof(after)).toBeCloseTo(roof(before) * 0.6, 3);
      // The colour half, in the same comparison.
      expect(R(before, "hero_building").slot).toBe(2);
      expect(R(after, "hero_building").slot).toBe(4);
      expect(R(before, "hero_building").colorHex).toBe("#D8D3C6");
      expect(R(after, "hero_building").colorHex).toBe("#E3A72F");
    },
    assertExport: (before, after) => {
      const plate = P(before, "base").bbox.max[2];
      expect(P(after, "hero_building").bbox.max[2] - plate).toBeCloseTo((P(before, "hero_building").bbox.max[2] - plate) * 0.6, 3);
      expect(P(before, "hero_building").extruder).toBe(2);
      expect(P(after, "hero_building").extruder).toBe(4);
      expect(bambuProject(after.files).filament_colour[3]).toBe("#E3A72F");
    },
  },
  {
    path: "hero_auto.enabled",
    value: true,
    scene: "block",
    why: "the worker scores the scene's buildings and promotes the top ones, which on this three-building block is all of them",
    assertPreview: (before, after) => {
      expect(N(before)).toContain("buildings");
      expect(N(after)).not.toContain("buildings");
      expect(R(after, "hero_building").bodies).toBe(3);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).toContain("buildings");
      expect([...bambuParts(after.files).keys()]).toContain("hero_building");
      expect(sidecarRegions(after.sidecar).has("buildings")).toBe(false);
    },
  },
  {
    path: "hero_auto.count",
    value: 1,
    base: HERO_AUTO,
    scene: "block",
    why: "how many buildings the automatic pick promotes: three leaves nothing behind, one leaves two ordinary buildings",
    assertPreview: (before, after) => {
      expect(R(before, "hero_building").bodies).toBe(3);
      expect(R(after, "hero_building").bodies).toBe(1);
      expect(R(after, "buildings").bodies).toBe(2);
    },
    assertExport: (before, after) => {
      expect(P(before, "hero_building").volumeMm3).toBeGreaterThan(P(after, "hero_building").volumeMm3);
      expect([...bambuParts(after.files).keys()]).toContain("buildings");
    },
  },

  // --- place tokens --------------------------------------------------------
  {
    path: "place.country",
    value: "Farland",
    base: PLACE,
    scene: "block",
    why: "the country is what `{country}` expands to on the top edge, and 'Farland' is a letter longer than 'Landia', so the pocket it cuts is wider",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "engraving-0")?.text).toBe("Landia Provo");
      expect(resolvedLine(after.result, "engraving-0")?.text).toBe("Farland Provo");
      expect(letteringSpan(after, "preview", "top")).toBeGreaterThan(letteringSpan(before, "preview", "top") + 1);
      expect(letteringSpan(after, "preview", "bottom")).toBeCloseTo(letteringSpan(before, "preview", "bottom"), 6);
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(letteringSpan(after, "file", "top")).toBeGreaterThan(letteringSpan(before, "file", "top") + 1);
      expect(letteringSpan(after, "file", "bottom")).toBeCloseTo(letteringSpan(before, "file", "bottom"), 6);
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
      expect(sidecarRegions(after.sidecar).get("frame")?.triangles).toBe(P(after, "frame").triangles);
    },
  },
  {
    path: "place.state",
    value: "Westia",
    base: PLACE,
    scene: "block",
    why: "the state is what `{state}` expands to on the top edge, and 'Westia' is a letter longer than 'Provo', so the pocket it cuts is wider",
    assertPreview: (before, after) => {
      expect(resolvedLine(after.result, "engraving-0")?.text).toBe("Landia Westia");
      expect(letteringSpan(after, "preview", "top")).toBeGreaterThan(letteringSpan(before, "preview", "top") + 1);
      expect(letteringSpan(after, "preview", "bottom")).toBeCloseTo(letteringSpan(before, "preview", "bottom"), 6);
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(letteringSpan(after, "file", "top")).toBeGreaterThan(letteringSpan(before, "file", "top") + 1);
      expect(letteringSpan(after, "file", "bottom")).toBeCloseTo(letteringSpan(before, "file", "bottom"), 6);
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
    },
  },
  {
    path: "place.neighbourhood",
    value: "Uptown",
    base: PLACE,
    scene: "block",
    why: "the neighbourhood is what `{neighbourhood}` expands to on the BOTTOM edge, and 'Uptown' is a letter longer than 'Docks', so that edge's pocket widens and the top edge's does not",
    assertPreview: (before, after) => {
      expect(resolvedLine(before.result, "engraving-1")?.text).toBe("Docks Tess");
      expect(resolvedLine(after.result, "engraving-1")?.text).toBe("Uptown Tess");
      expect(letteringSpan(after, "preview", "bottom")).toBeGreaterThan(letteringSpan(before, "preview", "bottom") + 1);
      expect(letteringSpan(after, "preview", "top")).toBeCloseTo(letteringSpan(before, "preview", "top"), 6);
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(letteringSpan(after, "file", "bottom")).toBeGreaterThan(letteringSpan(before, "file", "bottom") + 1);
      expect(letteringSpan(after, "file", "top")).toBeCloseTo(letteringSpan(before, "file", "top"), 6);
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
    },
  },
  {
    path: "place.author",
    value: "Bee",
    base: PLACE,
    scene: "block",
    why: "the author is both the `{author}` token on the bottom edge and the Designer every exported file is stamped with",
    assertPreview: (before, after) => {
      expect(resolvedLine(after.result, "engraving-1")?.text).toBe("Docks Bee");
      // "Bee" is shorter than "Tess", so the bottom pocket narrows.
      expect(letteringSpan(after, "preview", "bottom")).toBeLessThan(letteringSpan(before, "preview", "bottom") - 1);
      expect(letteringSpan(after, "preview", "top")).toBeCloseTo(letteringSpan(before, "preview", "top"), 6);
      expect(triangleCount(R(after, "frame"))).toBeLessThan(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(bambuMetadata(before.files).get("Designer")).toBe("Tess");
      expect(bambuMetadata(after.files).get("Designer")).toBe("Bee");
      expect(sidecarString(after.sidecar, "provenance.author")).toBe("Bee");
      expect(letteringSpan(after, "file", "bottom")).toBeLessThan(letteringSpan(before, "file", "bottom") - 1);
    },
  },

  // --- region placement ----------------------------------------------------
  {
    path: "regions.roads.depth_mm",
    value: 1.5,
    scene: "block",
    why: "the road recess is cut deeper into the plate, and the roads solid grows down to fill it",
    assertPreview: (before, after) => {
      expect(R(after, "roads").bbox.min[2]).toBeLessThan(R(before, "roads").bbox.min[2] - 0.5);
      expect(R(after, "roads").volumeMm3).toBeGreaterThan(R(before, "roads").volumeMm3 * 1.5);
      expect(R(after, "base").volumeMm3).toBeLessThan(R(before, "base").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "roads").bbox.min[2]).toBeLessThan(P(before, "roads").bbox.min[2] - 0.5);
      expect(P(after, "roads").volumeMm3).toBeGreaterThan(P(before, "roads").volumeMm3 * 1.5);
    },
  },
  {
    path: "regions.roads.proud_mm",
    value: 0.5,
    scene: "block",
    why: "the roads are lifted above the plate top instead of sunk below it, so they print as ridges",
    assertPreview: (before, after) => {
      expect(R(before, "roads").bbox.max[2]).toBeLessThanOrEqual(3.0);
      expect(R(after, "roads").bbox.max[2]).toBeCloseTo(R(before, "roads").bbox.max[2] + 0.7, 3);
      expect(findingOf(after.result, "road-placement-conflict")).toBeDefined();
    },
    assertExport: (before, after) => {
      expect(P(after, "roads").bbox.max[2]).toBeCloseTo(P(before, "roads").bbox.max[2] + 0.7, 3);
      expect(warnings(after)).toContain("stand proud");
    },
  },
  {
    path: "regions.water.depth_mm",
    value: 0.5,
    scene: "block",
    why: "the pond is a shallower pocket, so the water solid is thinner and the plate keeps more material",
    assertPreview: (before, after) => {
      expect(spanOf(R(after, "water").bbox, 2)).toBeLessThan(spanOf(R(before, "water").bbox, 2) - 0.4);
      expect(R(after, "water").volumeMm3).toBeLessThan(R(before, "water").volumeMm3 * 0.7);
      expect(R(after, "base").volumeMm3).toBeGreaterThan(R(before, "base").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(spanOf(P(after, "water").bbox, 2)).toBeLessThan(spanOf(P(before, "water").bbox, 2) - 0.4);
      expect(P(after, "water").volumeMm3).toBeLessThan(P(before, "water").volumeMm3 * 0.7);
    },
  },
  {
    path: "regions.water.proud_mm",
    value: 0.3,
    scene: "block",
    why: "the pond's top face is raised from 0.5 mm below the plate top to 0.3 mm above it",
    assertPreview: (before, after) => {
      expect(R(after, "water").bbox.max[2]).toBeCloseTo(R(before, "water").bbox.max[2] + 0.8, 3);
      expect(R(after, "water").volumeMm3).toBeCloseTo(R(before, "water").volumeMm3, 3);
    },
    assertExport: (before, after) => {
      expect(P(after, "water").bbox.max[2]).toBeCloseTo(P(before, "water").bbox.max[2] + 0.8, 3);
      expect(P(after, "water").bbox.min[2]).toBeCloseTo(P(before, "water").bbox.min[2] + 0.8, 3);
    },
  },
  {
    path: "regions.parks.depth_mm",
    value: 1.5,
    scene: "block",
    why: "the park sinks further into the plate, so its solid reaches down and the plate loses that material",
    assertPreview: (before, after) => {
      expect(R(after, "parks").bbox.min[2]).toBeLessThan(R(before, "parks").bbox.min[2] - 1.0);
      expect(R(after, "parks").volumeMm3).toBeGreaterThan(R(before, "parks").volumeMm3 * 2);
      expect(R(after, "base").volumeMm3).toBeLessThan(R(before, "base").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "parks").bbox.min[2]).toBeLessThan(P(before, "parks").bbox.min[2] - 1.0);
      expect(P(after, "parks").volumeMm3).toBeGreaterThan(P(before, "parks").volumeMm3 * 2);
    },
  },
  {
    path: "regions.parks.proud_mm",
    value: 0.8,
    scene: "block",
    why: "the park is asked to stand proud of the plate, which a 3 mm base can only partly grant and says so",
    assertPreview: (before, after) => {
      expect(R(after, "parks").volumeMm3).toBeGreaterThan(R(before, "parks").volumeMm3 * 1.4);
      expect(triangleCount(R(after, "parks"))).toBeGreaterThan(triangleCount(R(before, "parks")));
      expect(findingOf(after.result, "region-placement-clamped")).toBeDefined();
    },
    assertExport: (before, after) => {
      expect(P(after, "parks").triangles).toBeGreaterThan(P(before, "parks").triangles);
      expect(warnings(after)).toContain("parks region does not fit");
    },
  },
  {
    path: "regions.rail.depth_mm",
    value: 1.2,
    scene: "rail",
    why: "the rail recess is cut deeper, so the rail solid reaches down into the plate",
    assertPreview: (before, after) => {
      expect(R(after, "rail").bbox.min[2]).toBeLessThan(R(before, "rail").bbox.min[2] - 0.5);
      expect(R(after, "rail").volumeMm3).toBeGreaterThan(R(before, "rail").volumeMm3 * 2);
    },
    assertExport: (before, after) => {
      expect(P(after, "rail").bbox.min[2]).toBeLessThan(P(before, "rail").bbox.min[2] - 0.5);
      expect(P(after, "rail").volumeMm3).toBeGreaterThan(P(before, "rail").volumeMm3 * 2);
    },
  },
  {
    path: "regions.rail.proud_mm",
    value: -0.5,
    scene: "rail",
    why: "the rail drops from 0.3 mm above the plate top to 0.5 mm below it",
    assertPreview: (before, after) => {
      expect(R(before, "rail").bbox.max[2]).toBeGreaterThan(3.0);
      expect(R(after, "rail").bbox.max[2]).toBeCloseTo(R(before, "rail").bbox.max[2] - 0.8, 3);
      expect(R(after, "rail").volumeMm3).toBeCloseTo(R(before, "rail").volumeMm3, 3);
    },
    assertExport: (before, after) => {
      expect(P(after, "rail").bbox.max[2]).toBeCloseTo(P(before, "rail").bbox.max[2] - 0.8, 3);
      expect(P(after, "rail").bbox.min[2]).toBeCloseTo(P(before, "rail").bbox.min[2] - 0.8, 3);
    },
  },
  {
    path: "regions.rail.width_m",
    value: 3,
    scene: "rail",
    why: "the parameter is authoritative for every rail ribbon ([V3.1-P2-1]), so asking for 3 m where the way carries 6 m must NARROW the printed groove by exactly 3 ground metres",
    assertPreview: (before, after) => {
      // The narrowing direction on purpose: a fallback moves nothing, a
      // `max(way, param)` moves nothing, and a sum widens. Only an
      // authoritative parameter shrinks the ribbon by (3 - 6) ground metres.
      const moved = spanOf(R(after, "rail").bbox, 0) - spanOf(R(before, "rail").bbox, 0);
      expect(moved).toBeCloseTo((3 - RAIL_WAY_WIDTH_M) * mmPerM(before), 2);
    },
    assertExport: (before, after) => {
      const moved = spanOf(P(after, "rail").bbox, 0) - spanOf(P(before, "rail").bbox, 0);
      expect(moved).toBeCloseTo((3 - RAIL_WAY_WIDTH_M) * mmPerM(before), 2);
    },
  },
  {
    path: "regions.building_skirt_mm",
    value: 1.5,
    scene: "block",
    why: "the skirt is how far each building's socket sinks into the plate, which is what welds it there",
    assertPreview: (before, after) => {
      expect(R(after, "buildings").bbox.min[2]).toBeLessThan(R(before, "buildings").bbox.min[2] - 1.0);
      expect(R(after, "buildings").volumeMm3).toBeGreaterThan(R(before, "buildings").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "buildings").bbox.min[2]).toBeLessThan(P(before, "buildings").bbox.min[2] - 1.0);
      expect(P(after, "buildings").volumeMm3).toBeGreaterThan(P(before, "buildings").volumeMm3);
    },
  },

  // --- colour: slots -------------------------------------------------------
  ...slotProbe("base", 3, "block", undefined),
  ...slotProbe("frame", 4, "block", undefined),
  ...slotProbe("matting", 3, "block", MATTING),
  ...slotProbe("buildings", 3, "block", undefined),
  ...slotProbe("hero_building", 3, "block", HERO_OWN),
  ...slotProbe("roads", 2, "block", undefined),
  ...slotProbe("water", 2, "block", undefined),
  ...slotProbe("parks", 2, "block", undefined),
  ...slotProbe("rail", 2, "rail", undefined),
  ...slotProbe("lettering", 2, "block", INLAY),
  {
    path: "colour.region_slots.attribution",
    value: 6,
    base: SLOT_OVERRUN,
    scene: "block",
    why: "no stage builds an attribution solid, so the one place this slot is read is the audit's one-click fix, which restates the whole slot table",
    assertPreview: (before, after) => {
      const table = (finding: Snapshot): Record<string, number> => {
        const fix = findingOf(finding.result, "slot-beyond-profile")?.fix;
        if (fix === undefined) throw new Error("the slot-beyond-profile finding carries no fix");
        return (fix.patch as { colour: { region_slots: Record<string, number> } }).colour.region_slots;
      };
      expect(table(before).attribution).toBe(1);
      expect(table(after).attribution).toBe(6);
    },
    assertExport: (before, after) => {
      const patched = (snapshot: Snapshot): number => {
        const findings = sidecarValue(snapshot.sidecar, "findings") as Array<{ id: string; fix?: { patch: { colour: { region_slots: Record<string, number> } } } }>;
        const row = findings.find((finding) => finding.id === "slot-beyond-profile");
        if (row?.fix === undefined) throw new Error("the sidecar carries no slot-beyond-profile fix");
        return row.fix.patch.colour.region_slots.attribution;
      };
      expect(patched(before)).toBe(1);
      expect(patched(after)).toBe(6);
    },
  },

  // --- colour: swatches ----------------------------------------------------
  ...colorProbe("base", "#112233", "block", undefined, 1),
  ...colorProbe("frame", "#445566", "block", undefined, 5, "solo"),
  ...colorProbe("matting", "#334455", "block", MATTING, 7, "solo"),
  ...colorProbe("buildings", "#778899", "block", undefined, 2),
  ...colorProbe("hero_building", "#667788", "block", HERO_OWN, 4),
  ...colorProbe("roads", "#AABBCC", "block", undefined, 4),
  ...colorProbe("water", "#DDEEFF", "block", undefined, 3),
  ...colorProbe("parks", "#102030", "block", undefined, 6, "solo"),
  ...colorProbe("rail", "#203040", "rail", undefined, 6, "solo"),
  ...colorProbe("lettering", "#556677", "block", INLAY, 7, "solo"),

  {
    path: "colour.palette",
    value: "dusk",
    scene: "block",
    why: "the palette names the swatch set the colours came from; it is provenance, written into the 3MF metadata and the sidecar",
    assertPreview: (before, after) => {
      expect(before.result.params.colour?.palette).toBe("default");
      expect(after.result.params.colour?.palette).toBe("dusk");
    },
    assertExport: (before, after) => {
      expect(bambuMetadata(before.files).get("framecraft:palette")).toBe("default");
      expect(bambuMetadata(after.files).get("framecraft:palette")).toBe("dusk");
      expect(sidecarString(after.sidecar, "colour_palette")).toBe("dusk");
    },
  },

  // --- colour: tint --------------------------------------------------------
  {
    path: "colour.tint.enabled",
    value: false,
    base: TINT_OBJ,
    scene: "block",
    why: "the tint gives every building its own shade, which the OBJ writer turns into one material per building",
    assertPreview: (before, after) => {
      expect(before.result.buildingTints?.length).toBe(3);
      expect(after.result.buildingTints ?? []).toHaveLength(0);
    },
    assertExport: (before, after) => {
      expect(mtlNames(before.files)).toContain("buildings_tint_1");
      expect(mtlNames(after.files)).not.toContain("buildings_tint_1");
      expect(mtlNames(after.files)).toContain("buildings");
    },
  },
  ...tintProbe("colour.tint.hue_range_deg", 90, "how far around the hue wheel the per-building shades may wander"),
  ...tintProbe("colour.tint.lightness_range", 0.5, "how far up and down in lightness the per-building shades may wander"),
  ...tintProbe("colour.tint.seed", 9, "the seed that decides which building gets which shade"),

  // --- colour: gradient ----------------------------------------------------
  {
    path: "colour.gradient.enabled",
    value: true,
    scene: "block",
    why: "the buildings are split into height bands, each its own region on its own filament slot",
    assertPreview: (before, after) => {
      expect(before.result.stats.gradientBands).toBeUndefined();
      expect(after.result.stats.gradientBands).toBe(2);
      expect(N(before)).not.toContain("buildings_band_2");
      expect(N(after)).toContain("buildings_band_2");
      expect(R(after, "buildings_band_2").slot).toBe(3);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).not.toContain("buildings_band_2");
      expect(P(after, "buildings_band_2").extruder).toBe(3);
      expect(P(after, "buildings").volumeMm3).toBeLessThan(P(before, "buildings").volumeMm3);
    },
  },
  {
    path: "colour.gradient.slots",
    value: [2, 3, 4, 1],
    base: GRADIENT,
    scene: "block",
    why: "the slot list is the band count: four entries split the buildings into more bands than two, and each band takes its own slot",
    assertPreview: (before, after) => {
      expect(before.result.stats.gradientBands).toBe(2);
      expect(after.result.stats.gradientBands).toBe(3);
      expect(N(after)).toContain("buildings_band_3");
      expect(R(after, "buildings_band_3").slot).toBe(4);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).not.toContain("buildings_band_3");
      expect(P(after, "buildings_band_3").extruder).toBe(4);
    },
  },

  // --- printer and export --------------------------------------------------
  {
    path: "printer_profile",
    value: "prusa-mini",
    scene: "block",
    why: "the profile is the machine the file is written for: its bed, its height and how many filaments it can address",
    assertPreview: (before, after) => {
      expect(findingOf(before.result, "slot-beyond-profile")).toBeUndefined();
      expect(findingOf(after.result, "slot-beyond-profile")?.detail).toContain("Prusa MINI addresses 1 slot");
    },
    assertExport: (before, after) => {
      expect(bambuProject(before.files).printer_settings_id).toBe("Custom printer 0.4 nozzle");
      expect(bambuProject(after.files).printer_settings_id).toBe("Prusa MINI 0.4 nozzle");
      expect(bambuProject(after.files).printable_area).toEqual(["0x0", "180x0", "180x180", "0x180"]);
      expect(sidecarString(after.sidecar, "printer_profile")).toBe("prusa-mini");
    },
  },
  {
    path: "custom_profile.plate_x_mm",
    value: 120,
    scene: "block",
    why: "the custom bed's width: a 180 mm plate no longer fits across it, and the file says the bed is narrower",
    assertPreview: (before, after) => {
      expect(findingOf(before.result, "exceeds-profile-plate")).toBeUndefined();
      expect(findingOf(after.result, "exceeds-profile-plate")?.detail).toContain("120 x 256 mm bed");
    },
    assertExport: (before, after) => {
      expect(bambuProject(before.files).printable_area).toEqual(["0x0", "256x0", "256x256", "0x256"]);
      expect(bambuProject(after.files).printable_area).toEqual(["0x0", "120x0", "120x256", "0x256"]);
    },
  },
  {
    path: "custom_profile.plate_y_mm",
    value: 120,
    scene: "block",
    why: "the custom bed's depth: the same plate no longer fits front to back, and the file says the bed is shallower",
    assertPreview: (before, after) => {
      expect(findingOf(before.result, "exceeds-profile-plate")).toBeUndefined();
      expect(findingOf(after.result, "exceeds-profile-plate")?.detail).toContain("256 x 120 mm bed");
    },
    assertExport: (before, after) => {
      expect(bambuProject(after.files).printable_area).toEqual(["0x0", "256x0", "256x120", "0x120"]);
      expect(bambuProject(before.files).printable_area).not.toEqual(bambuProject(after.files).printable_area);
    },
  },
  {
    path: "custom_profile.max_height_mm",
    value: 20,
    scene: "block",
    // Trips `exceeds-height`: the ceiling is lowered under the model, on purpose.
    forceExport: true,
    why: "the Z ceiling the build is judged against, which the validator reads back out of the sidecar",
    assertPreview: (before, after) => {
      expect(findingOf(before.result, "exceeds-height")).toBeUndefined();
      expect(findingOf(after.result, "exceeds-height")?.detail).toContain("20 mm ceiling");
    },
    assertExport: (before, after) => {
      expect(sidecarNumber(before.sidecar, "max_height_mm")).toBe(60);
      expect(sidecarNumber(after.sidecar, "max_height_mm")).toBe(20);
      expect(bambuProject(after.files).printable_height).toBe("20");
    },
  },
  {
    path: "custom_profile.nozzle_mm",
    value: 0.8,
    scene: "block",
    why: "the nozzle the project file is written for; the model is unchanged and the printer settings say 0.8",
    assertPreview: (before, after) => {
      expect(before.result.params.custom_profile?.nozzle_mm).toBe(0.4);
      expect(after.result.params.custom_profile?.nozzle_mm).toBe(0.8);
    },
    assertExport: (before, after) => {
      expect(bambuProject(before.files).nozzle_diameter).toEqual(["0.4"]);
      expect(bambuProject(after.files).nozzle_diameter).toEqual(["0.8"]);
      expect(bambuProject(after.files).printer_variant).toBe("0.8");
      expect(bambuProject(after.files).printer_settings_id).toBe("Custom printer 0.8 nozzle");
    },
  },
  {
    path: "custom_profile.slots",
    value: 8,
    base: SLOT_SIX,
    scene: "block",
    why: "how many filaments the custom machine can address: the project's filament list is written that long, and a region parked on slot 6 stops being out of reach",
    assertPreview: (before, after) => {
      expect(findingOf(before.result, "slot-beyond-profile")?.detail).toContain("addresses 4 slots");
      expect(findingOf(after.result, "slot-beyond-profile")).toBeUndefined();
    },
    assertExport: (before, after) => {
      // The project settings size their filament arrays by the profile's slot
      // count, so this leaf reaches the file even when no geometry moves.
      expect(bambuProject(before.files).filament_colour).toHaveLength(6);
      expect(bambuProject(after.files).filament_colour).toHaveLength(8);
      expect(bambuProject(after.files).filament_type).toHaveLength(8);
      expect(bambuProject(after.files).filament_settings_id).toHaveLength(8);
      expect(warnings(before)).toContain("The parks region is on a filament slot this printer does not have");
      expect(warnings(after)).not.toContain("filament slot this printer does not have");
    },
  },
  {
    path: "custom_profile.change_gcode",
    value: "M601",
    base: COLORCHANGE,
    scene: "block",
    why: "the command the colour-change project tells the slicer to run at each filament swap",
    assertPreview: (before, after) => {
      expect(before.result.params.custom_profile?.change_gcode).toBe("M600");
      expect(after.result.params.custom_profile?.change_gcode).toBe("M601");
    },
    assertExport: (before, after) => {
      expect(bambuProject(before.files).change_filament_gcode).toBe("M600");
      expect(bambuProject(after.files).change_filament_gcode).toBe("M601");
      // The second place it lands: every row of custom_gcode_per_layer.xml.
      const rows = colorChangeLayers(after.files);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((row) => row.gcode)).toEqual(rows.map(() => "M601"));
      expect(colorChangeLayers(before.files).map((row) => row.gcode)).toEqual(rows.map(() => "M600"));
    },
  },
  {
    path: "color_mode",
    value: "parts",
    base: GENERIC,
    scene: "block",
    why: "single mode writes the welded solid as one object; parts mode writes one object per region with a base material each",
    assertPreview: (before, after) => {
      expect(before.result.params.color_mode).toBe("single");
      expect(after.result.params.color_mode).toBe("parts");
    },
    assertExport: (before, after) => {
      expect(generic3mf(before.files).objects).toHaveLength(1);
      expect(generic3mf(after.files).objects.length).toBeGreaterThan(1);
      expect(generic3mf(before.files).materials).toHaveLength(0);
      expect(generic3mf(after.files).materials.map((material) => material.name)).toContain("water");
    },
  },
  {
    path: "export_target",
    value: "stl",
    scene: "block",
    why: "the target is the file format the export stage writes, and each one writes a different set of files",
    assertPreview: (before, after) => {
      expect(before.result.params.export_target).toBe("bambu-3mf");
      expect(after.result.params.export_target).toBe("stl");
    },
    assertExport: (before, after) => {
      expect(fileNames(before.files)).toEqual(["framecraft.3mf"]);
      expect(fileNames(after.files)).toEqual(["framecraft.stl"]);
      expect(stlTriangles(after.files[0].bytes)).toBeGreaterThan(1000);
      expect(sidecarString(after.sidecar, "export_target")).toBe("stl");
    },
  },

  // --- terrain -------------------------------------------------------------
  {
    path: "terrain.enabled",
    value: true,
    scene: "terrain",
    why: "the hillside is draped over the plate, which lifts the plate top and every surface with it",
    assertPreview: (before, after) => {
      expect(before.result.stats.terrainReliefMm).toBeUndefined();
      expect(after.result.stats.terrainReliefMm ?? 0).toBeGreaterThan(5);
      expect(R(after, "base").bbox.max[2]).toBeGreaterThan(R(before, "base").bbox.max[2] + 5);
    },
    assertExport: (before, after) => {
      expect(P(after, "base").triangles).toBeGreaterThan(P(before, "base").triangles);
      expect(P(after, "base").bbox.max[2]).toBeGreaterThan(P(before, "base").bbox.max[2] + 5);
    },
  },
  {
    path: "terrain.smoothing",
    value: 6,
    base: TERRAIN_ON,
    scene: "terrain",
    why: "the heightfield is blurred before it drapes, so the printed relief drops",
    assertPreview: (before, after) => {
      expect(after.result.stats.terrainReliefMm ?? 0).toBeLessThan(before.result.stats.terrainReliefMm ?? 0);
      expect(R(after, "base").bbox.max[2]).toBeLessThan(R(before, "base").bbox.max[2]);
    },
    assertExport: (before, after) => {
      expect(P(after, "base").bbox.max[2]).toBeLessThan(P(before, "base").bbox.max[2]);
      expect(P(after, "base").volumeMm3).toBeLessThan(P(before, "base").volumeMm3);
    },
  },

  // --- heights (through normalise, from the Overpass fixture) ---------------
  ...heightProbe("levels", "heights.floor_height_m", 8, OSM_LEVELS, "a storey's height, applied to the building tagged with three levels and no height"),
  ...heightProbe("unknown", "heights.unknown_default_m", 40, 1, "the height a building with no height, no storeys and no recognised type is given"),
  ...heightProbe("house", "heights.type_defaults.house", 40, 1, "the height a `building=house` with nothing else is given"),
  ...heightProbe("apartments", "heights.type_defaults.apartments", 45, 1, "the height a `building=apartments` with nothing else is given"),
  ...heightProbe("commercial", "heights.type_defaults.commercial", 50, 1, "the height a `building=commercial` with nothing else is given"),
  ...heightProbe("retail", "heights.type_defaults.retail", 55, 1, "the height a `building=retail` with nothing else is given"),
  ...heightProbe("industrial", "heights.type_defaults.industrial", 60, 1, "the height a `building=industrial` with nothing else is given"),
  ...heightProbe("garage", "heights.type_defaults.garage", 35, 1, "the height a `building=garage` with nothing else is given"),

  // --- bridges -------------------------------------------------------------
  {
    path: "bridges.enabled",
    value: false,
    scene: "bridge",
    why: "with bridges off the elevated road is laid at grade instead of built as a deck over the water",
    assertPreview: (before, after) => {
      expect(before.result.stats.bridges).toBe(1);
      expect(after.result.stats.bridges).toBeUndefined();
      expect(R(before, "roads").bbox.max[2]).toBeGreaterThan(4);
      expect(R(after, "roads").bbox.max[2]).toBeLessThan(3.5);
    },
    assertExport: (before, after) => {
      expect(P(before, "roads").bbox.max[2]).toBeGreaterThan(4);
      expect(P(after, "roads").bbox.max[2]).toBeLessThan(3.5);
      expect(P(after, "roads").triangles).toBeLessThan(P(before, "roads").triangles);
    },
  },
  {
    path: "bridges.clearance_mm",
    value: 3.0,
    scene: "bridge",
    why: "how high the deck stands over what it crosses, so the deck rises by the extra clearance",
    assertPreview: (before, after) => {
      expect(R(after, "roads").bbox.max[2]).toBeCloseTo(R(before, "roads").bbox.max[2] + 2, 3);
      expect(R(after, "roads").volumeMm3).toBeGreaterThan(R(before, "roads").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "roads").bbox.max[2]).toBeCloseTo(P(before, "roads").bbox.max[2] + 2, 3);
      expect(P(after, "roads").triangles).toBe(P(before, "roads").triangles);
    },
  },
  {
    path: "bridges.abutments",
    value: false,
    scene: "bridge",
    // Not forced: the loose deck is raised at `warning` severity, so the gate
    // lets the file through and the probe exports like every other one.
    why: "the ramps that carry the deck down to the ground are dropped, which leaves the deck standing on nothing",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "roads"))).toBeLessThan(triangleCount(R(before, "roads")));
      expect(findingOf(before.result, "bridge-unsupported")).toBeUndefined();
      expect(findingOf(after.result, "bridge-unsupported")).toBeDefined();
    },
    assertExport: (before, after) => {
      expect(P(after, "roads").triangles).toBeLessThan(P(before, "roads").triangles);
      // The `bridge-unsupported` finding's own words with abutments off, not
      // the word "bridge", which every bridge warning carries.
      expect(warnings(after)).toContain("have nothing holding them up");
      expect(warnings(after)).toContain("Abutments are switched off");
      expect(warnings(before)).not.toContain("have nothing holding them up");
    },
  },

  // --- height exaggeration -------------------------------------------------
  {
    path: "height_exaggeration.multiplier",
    value: 1.8,
    scene: "block",
    why: "every building's printed height above the plate is multiplied, so the model gets taller without changing footprint",
    assertPreview: (before, after) => {
      // The multiplier acts on the building's own height, not on the plate it
      // stands on, so the plate top is subtracted from both sides.
      const plateTop = R(before, "base").bbox.max[2];
      const roof = (snapshot: Snapshot): number => R(snapshot, "buildings").bbox.max[2] - plateTop;
      expect(roof(after)).toBeCloseTo(roof(before) * 1.8, 3);
      expect(spanOf(R(after, "buildings").bbox, 0)).toBeCloseTo(spanOf(R(before, "buildings").bbox, 0), 6);
    },
    assertExport: (before, after) => {
      const plateTop = P(before, "base").bbox.max[2];
      expect(P(after, "buildings").bbox.max[2] - plateTop).toBeCloseTo((P(before, "buildings").bbox.max[2] - plateTop) * 1.8, 3);
      expect(sidecarNumber(after.sidecar, "bake_result.stats.height_mm")).toBeGreaterThan(sidecarNumber(before.sidecar, "bake_result.stats.height_mm"));
    },
  },
  {
    path: "height_exaggeration.curve",
    value: 0.8,
    scene: "block",
    why: "the curve compresses tall buildings towards the short ones, so the tallest loses height while the footprints stay",
    assertPreview: (before, after) => {
      expect(statOf(after, "heightMm")).toBeLessThan(statOf(before, "heightMm") - 3);
      expect(R(after, "buildings").volumeMm3).toBeGreaterThan(R(before, "buildings").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "buildings").bbox.max[2]).toBeLessThan(P(before, "buildings").bbox.max[2] - 3);
      expect(sidecarNumber(after.sidecar, "bake_result.stats.height_mm")).toBeLessThan(sidecarNumber(before.sidecar, "bake_result.stats.height_mm"));
    },
  },

  // --- tiling --------------------------------------------------------------
  {
    path: "tiling.enabled",
    value: false,
    base: TILED,
    scene: "block",
    why: "tiling splits the model into printable pieces and writes a zip of them; off, it is one model in one file",
    assertPreview: (before, after) => {
      expect(before.result.tiles).toHaveLength(4);
      expect(after.result.tiles ?? []).toHaveLength(0);
      expect(before.result.stats.tiles).toBe(4);
      expect(after.result.stats.tiles).toBeUndefined();
    },
    assertExport: (before, after) => {
      expect(fileNames(before.files)).toEqual(["framecraft-tiles.zip"]);
      expect(fileNames(after.files)).toEqual(["framecraft.3mf"]);
      expect(zipNames(before.files[0].bytes)).toContain("framecraft-A1.3mf");
    },
  },
  {
    path: "tiling.cols",
    value: 3,
    base: TILED,
    scene: "block",
    why: "how many columns the plate is cut into, so a third column of tiles appears and each tile is narrower",
    assertPreview: (before, after) => {
      expect(before.result.stats.tileCols).toBe(2);
      expect(after.result.stats.tileCols).toBe(3);
      expect((after.result.tiles ?? []).map((tile) => tile.label)).toContain("C1");
      expect(spanOf((after.result.tiles ?? [])[0].bbox, 0)).toBeLessThan(spanOf((before.result.tiles ?? [])[0].bbox, 0));
    },
    assertExport: (before, after) => {
      expect(zipNames(before.files[0].bytes)).not.toContain("framecraft-C1.3mf");
      expect(zipNames(after.files[0].bytes)).toContain("framecraft-C1.3mf");
      expect(warnings(after)).toContain("6 tiles");
    },
  },
  {
    path: "tiling.rows",
    value: 3,
    base: TILED,
    scene: "block",
    why: "how many rows the plate is cut into, so a third row of tiles appears",
    assertPreview: (before, after) => {
      expect(before.result.stats.tileRows).toBe(2);
      expect(after.result.stats.tileRows).toBe(3);
      expect((after.result.tiles ?? []).map((tile) => tile.label)).toContain("A3");
    },
    assertExport: (before, after) => {
      expect(zipNames(before.files[0].bytes)).not.toContain("framecraft-A3.3mf");
      expect(zipNames(after.files[0].bytes)).toContain("framecraft-A3.3mf");
      expect(warnings(after)).toContain("6 tiles");
    },
  },
  {
    path: "tiling.joint",
    value: "pin",
    base: TILED,
    scene: "block",
    why: "the shape cut into the seam so two tiles register with each other: a dovetail and a pin are different geometry",
    assertPreview: (before, after) => {
      const tileOf = (snapshot: Snapshot, label: string): RegionMesh => {
        const tile = (snapshot.result.tiles ?? []).find((candidate) => candidate.label === label);
        const mesh = tile === undefined ? undefined : tile.regions.find((region) => region.region === "base");
        if (mesh === undefined) throw new Error(`no base mesh on tile ${label}`);
        return mesh;
      };
      expect(triangleCount(tileOf(after, "A1"))).toBeGreaterThan(triangleCount(tileOf(before, "A1")));
      expect(tileOf(after, "A1").volumeMm3).not.toBe(tileOf(before, "A1").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(zipNames(after.files[0].bytes)).toEqual(zipNames(before.files[0].bytes));
      // Read out of tile A1's OWN 3MF inside the zip, not off the zip's length.
      expect(tilePart(after, "A1", "base").triangles).toBeGreaterThan(tilePart(before, "A1", "base").triangles);
      expect(tilePart(after, "A1", "base").volumeMm3).not.toBe(tilePart(before, "A1", "base").volumeMm3);
    },
  },
  {
    path: "tiling.tolerance_mm",
    value: 0.6,
    base: TILED,
    scene: "block",
    why: "the clearance left in every joint, so a looser fit removes material from the tiles that carry the sockets",
    assertPreview: (before, after) => {
      const volumeOf = (snapshot: Snapshot, label: string): number => {
        const tile = (snapshot.result.tiles ?? []).find((candidate) => candidate.label === label);
        const mesh = tile === undefined ? undefined : tile.regions.find((region) => region.region === "base");
        if (mesh === undefined) throw new Error(`no base mesh on tile ${label}`);
        return mesh.volumeMm3;
      };
      expect(volumeOf(after, "A1")).toBeLessThan(volumeOf(before, "A1"));
      expect(volumeOf(after, "B1")).toBeLessThan(volumeOf(before, "B1"));
    },
    assertExport: (before, after) => {
      expect(zipNames(after.files[0].bytes)).toEqual(zipNames(before.files[0].bytes));
      for (const label of ["A1", "B1"]) {
        expect(tilePart(after, label, "base").volumeMm3, label).toBeLessThan(tilePart(before, label, "base").volumeMm3);
      }
    },
  },
  {
    path: "tiling.index_mark",
    value: false,
    base: TILED,
    scene: "block",
    why: "the grid reference engraved into each tile's underside, so switching it off removes those pockets from every tile",
    assertPreview: (before, after) => {
      const trianglesOf = (snapshot: Snapshot, label: string): number => {
        const tile = (snapshot.result.tiles ?? []).find((candidate) => candidate.label === label);
        const mesh = tile === undefined ? undefined : tile.regions.find((region) => region.region === "base");
        if (mesh === undefined) throw new Error(`no base mesh on tile ${label}`);
        return triangleCount(mesh);
      };
      for (const label of ["A1", "A2", "B1", "B2"]) {
        expect(trianglesOf(after, label), label).toBeLessThan(trianglesOf(before, label));
      }
    },
    assertExport: (before, after) => {
      expect(zipNames(after.files[0].bytes)).toEqual(zipNames(before.files[0].bytes));
      for (const label of ["A1", "A2", "B1", "B2"]) {
        expect(tilePart(after, label, "base").triangles, label).toBeLessThan(tilePart(before, label, "base").triangles);
      }
    },
  },

  // --- frame style ---------------------------------------------------------
  {
    path: "frame_style.profile",
    value: "chamfer",
    scene: "block",
    why: "the profile is the frame's cross-section, so a chamfer rebuilds the lip with a sloped face",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
      expect(R(after, "frame").volumeMm3).toBeLessThan(R(before, "frame").volumeMm3);
      expect(spanOf(R(after, "frame").bbox, 2)).toBeCloseTo(spanOf(R(before, "frame").bbox, 2), 6);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "frame_style.corner",
    value: "rounded",
    scene: "block",
    why: "the frame's outer corners are filleted, which pulls each corner back along its diagonal by r * (2 - sqrt(2)) and leaves the enclosed volume alone",
    assertPreview: (before, after) => {
      // A fillet of radius r on a square corner moves the outermost point of
      // the diagonal from 2h to 2h - r * (2 - sqrt(2)). The default radius is
      // 3 mm, so the pull-back is 1.7574 mm.
      const pulled = maxXPlusY(R(before, "frame").positions) - maxXPlusY(R(after, "frame").positions);
      expect(pulled).toBeCloseTo(3 * (2 - Math.SQRT2), 3);
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")));
      // An outer fillet and the matching inner one cancel, so the ring's volume
      // is the invariant that says only the corners moved.
      expect(R(after, "frame").volumeMm3).toBeCloseTo(R(before, "frame").volumeMm3, 3);
    },
    assertExport: (before, after) => {
      const pulled = maxXPlusY(P(before, "frame").positions) - maxXPlusY(P(after, "frame").positions);
      expect(pulled).toBeCloseTo(3 * (2 - Math.SQRT2), 3);
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles);
    },
  },
  {
    path: "frame_style.corner_radius_mm",
    value: 9,
    base: ROUNDED,
    scene: "block",
    why: "how big the corner fillet is: going 3 mm to 9 mm pulls the outer corner a further 6 * (2 - sqrt(2)) mm back along its diagonal",
    assertPreview: (before, after) => {
      const pulled = maxXPlusY(R(before, "frame").positions) - maxXPlusY(R(after, "frame").positions);
      expect(pulled).toBeCloseTo((9 - 3) * (2 - Math.SQRT2), 3);
      expect(R(after, "frame").volumeMm3).toBeCloseTo(R(before, "frame").volumeMm3, 3);
    },
    assertExport: (before, after) => {
      const pulled = maxXPlusY(P(before, "frame").positions) - maxXPlusY(P(after, "frame").positions);
      expect(pulled).toBeCloseTo((9 - 3) * (2 - Math.SQRT2), 3);
    },
  },
  {
    path: "frame_style.lip_depth_mm",
    value: LIP_REBATE_DEPTH_MM,
    scene: "block",
    why: `the sight-edge rebate on the frame lip's inner top edge, ${FRAME_SIGHT_EDGE_MM} mm wide and lip_depth_mm deep ([V3.1-P2-2]), so a deeper rebate drops that floor and removes that much frame section`,
    assertPreview: (before, after) => {
      const top = R(before, "frame").bbox.max[2];
      // The rebate runs round the lip's inner opening, so going from the 0.4 mm
      // default to 1.5 mm removes (1.5 - 0.4) mm by FRAME_SIGHT_EDGE_MM of
      // section along a perimeter of roughly 670 mm on the 180 mm plate.
      expect(R(before, "frame").volumeMm3 - R(after, "frame").volumeMm3).toBeGreaterThan(400);
      // The floor moves from top - 0.4 to top - 1.5, and stays exactly
      // FRAME_SIGHT_EDGE_MM wide: a rebate of another width or another depth
      // fails here even though it would move the volume. The ring is read in
      // the plate's corner squares (`cornerRingAt`), which hold all eight of
      // its vertices and none of the inner-wall attribution's glyphs: those
      // are engraved into the opening's walls between z 3.15 and 4.45 on the
      // default lip, so a whole-plane count at top - 1.5 reads 328 of them
      // (88 on the pre-rebate lip, whose mark ran to 4.85) and could never be
      // zero while the mandatory mark exists. The band is on both axes because
      // the east and west walls' glyphs share the rebate's x.
      const corner = T.frame_geometry_mm(before.result.params).inner_half_mm - 1;
      expect(cornerRingAt(R(before, "frame").positions, top - LIP_DEFAULT_DEPTH_MM, [0, 0], corner).count).toBeGreaterThan(0);
      expect(cornerRingAt(R(before, "frame").positions, top - LIP_REBATE_DEPTH_MM, [0, 0], corner).count).toBe(0);
      const floor = cornerRingAt(R(after, "frame").positions, top - LIP_REBATE_DEPTH_MM, [0, 0], corner);
      expect(floor.count).toBeGreaterThan(0);
      expect(floor.outer - floor.inner).toBeCloseTo(FRAME_SIGHT_EDGE_MM, 3);
      // ... and the default's own floor is gone once the step is cut deeper.
      expect(cornerRingAt(R(after, "frame").positions, top - LIP_DEFAULT_DEPTH_MM, [0, 0], corner).count).toBe(0);
    },
    assertExport: (before, after) => {
      const top = P(before, "frame").bbox.max[2];
      const centre = buildOffset(before);
      const corner = T.frame_geometry_mm(before.result.params).inner_half_mm - 1;
      expect(P(before, "frame").volumeMm3 - P(after, "frame").volumeMm3).toBeGreaterThan(400);
      expect(cornerRingAt(P(before, "frame").positions, top - LIP_DEFAULT_DEPTH_MM, centre, corner).count).toBeGreaterThan(0);
      expect(cornerRingAt(P(before, "frame").positions, top - LIP_REBATE_DEPTH_MM, centre, corner).count).toBe(0);
      const floor = cornerRingAt(P(after, "frame").positions, top - LIP_REBATE_DEPTH_MM, centre, corner);
      expect(floor.count).toBeGreaterThan(0);
      expect(floor.outer - floor.inner).toBeCloseTo(FRAME_SIGHT_EDGE_MM, 3);
    },
  },
  {
    path: "frame_style.shadow_gap.enabled",
    value: true,
    scene: "block",
    why: "a recessed channel is cut into the plate all round the city, so the frame reads as floating above it",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "base"))).toBeGreaterThan(triangleCount(R(before, "base")));
      expect(R(after, "base").volumeMm3).toBeLessThan(R(before, "base").volumeMm3 - 300);
    },
    assertExport: (before, after) => {
      expect(P(after, "base").triangles).toBeGreaterThan(P(before, "base").triangles);
      expect(P(after, "base").volumeMm3).toBeLessThan(P(before, "base").volumeMm3 - 300);
    },
  },
  {
    path: "frame_style.shadow_gap.width_mm",
    value: 2.5,
    base: SHADOW,
    scene: "block",
    why: "how wide the channel is: its outer edge stays against the frame and its inner edge moves in by the extra 1.5 mm, at an unchanged floor depth",
    assertPreview: (before, after) => {
      // The channel shares its z with the surface recesses, so the ring is read
      // outside them (`minAbsX`). Its floor does NOT move: that is `depth_mm`.
      const floorZ = R(before, "base").bbox.max[2] - GAP_DEFAULT_DEPTH_MM;
      const from = ringAt(R(before, "base").positions, floorZ, 0, GAP_RING_MIN_ABS_X);
      const to = ringAt(R(after, "base").positions, floorZ, 0, GAP_RING_MIN_ABS_X);
      expect(to.outer).toBeCloseTo(from.outer, 6);
      expect(from.inner - to.inner).toBeCloseTo(2.5 - 1.0, 3);
      expect(triangleCount(R(after, "base"))).toBe(triangleCount(R(before, "base")));
      expect(R(after, "base").volumeMm3).toBeLessThan(R(before, "base").volumeMm3 - 500);
    },
    assertExport: (before, after) => {
      const floorZ = P(before, "base").bbox.max[2] - GAP_DEFAULT_DEPTH_MM;
      const centre = buildOffset(before)[0];
      const from = ringAt(P(before, "base").positions, floorZ, centre, GAP_RING_MIN_ABS_X);
      const to = ringAt(P(after, "base").positions, floorZ, centre, GAP_RING_MIN_ABS_X);
      expect(to.outer).toBeCloseTo(from.outer, 6);
      expect(from.inner - to.inner).toBeCloseTo(2.5 - 1.0, 3);
      expect(P(after, "base").volumeMm3).toBeLessThan(P(before, "base").volumeMm3 - 500);
    },
  },
  {
    path: "frame_style.shadow_gap.depth_mm",
    value: 2.0,
    base: SHADOW,
    scene: "block",
    why: "how deep the channel is cut: its floor drops from 0.8 mm under the plate top to 2.0 mm under it, at an unchanged 1.0 mm width",
    assertPreview: (before, after) => {
      const top = R(before, "base").bbox.max[2];
      // The floor is where it was, and is not where it will be, before; the
      // other way round after. A wider channel would not move either z.
      expect(ringAt(R(before, "base").positions, top - GAP_DEFAULT_DEPTH_MM, 0, GAP_RING_MIN_ABS_X).count).toBeGreaterThan(0);
      expect(ringAt(R(before, "base").positions, top - 2.0, 0, GAP_RING_MIN_ABS_X).count).toBe(0);
      expect(ringAt(R(after, "base").positions, top - GAP_DEFAULT_DEPTH_MM, 0, GAP_RING_MIN_ABS_X).count).toBe(0);
      const floor = ringAt(R(after, "base").positions, top - 2.0, 0, GAP_RING_MIN_ABS_X);
      expect(floor.count).toBeGreaterThan(0);
      expect(floor.outer - floor.inner).toBeCloseTo(1.0, 3);
      expect(R(after, "base").volumeMm3).toBeLessThan(R(before, "base").volumeMm3 - 500);
    },
    assertExport: (before, after) => {
      const top = P(before, "base").bbox.max[2];
      const centre = buildOffset(before)[0];
      expect(ringAt(P(before, "base").positions, top - 2.0, centre, GAP_RING_MIN_ABS_X).count).toBe(0);
      const floor = ringAt(P(after, "base").positions, top - 2.0, centre, GAP_RING_MIN_ABS_X);
      expect(floor.count).toBeGreaterThan(0);
      expect(floor.outer - floor.inner).toBeCloseTo(1.0, 3);
      expect(P(after, "base").volumeMm3).toBeLessThan(P(before, "base").volumeMm3 - 500);
    },
  },
  {
    path: "frame_style.matting.enabled",
    value: true,
    scene: "block",
    why: "a mount board is built between the frame and the city, as its own region on its own filament",
    assertPreview: (before, after) => {
      expect(N(before)).not.toContain("matting");
      expect(N(after)).toContain("matting");
      expect(R(after, "matting").volumeMm3).toBeGreaterThan(0);
    },
    assertExport: (before, after) => {
      expect([...bambuParts(before.files).keys()]).not.toContain("matting");
      expect(P(after, "matting").volumeMm3).toBeGreaterThan(0);
      expect(sidecarRegions(after.sidecar).has("matting")).toBe(true);
    },
  },
  {
    path: "frame_style.matting.width_mm",
    value: 12,
    base: MATTING,
    scene: "block",
    why: "how far the mount board reaches inwards, which also crops the city under it",
    assertPreview: (before, after) => {
      expect(R(after, "matting").volumeMm3).toBeGreaterThan(R(before, "matting").volumeMm3 * 1.7);
      expect(spanOf(R(after, "roads").bbox, 0)).toBeLessThan(spanOf(R(before, "roads").bbox, 0));
    },
    assertExport: (before, after) => {
      expect(P(after, "matting").volumeMm3).toBeGreaterThan(P(before, "matting").volumeMm3 * 1.7);
      expect(spanOf(P(after, "roads").bbox, 0)).toBeLessThan(spanOf(P(before, "roads").bbox, 0));
    },
  },
  {
    path: "frame_style.matting.proud_mm",
    value: 1.2,
    base: MATTING,
    scene: "block",
    why: "how far the mount board stands above the plate, so it gets thicker",
    assertPreview: (before, after) => {
      expect(R(after, "matting").bbox.max[2]).toBeCloseTo(R(before, "matting").bbox.max[2] + 0.8, 3);
      expect(R(after, "matting").volumeMm3).toBeGreaterThan(R(before, "matting").volumeMm3 * 2);
    },
    assertExport: (before, after) => {
      expect(P(after, "matting").bbox.max[2]).toBeCloseTo(P(before, "matting").bbox.max[2] + 0.8, 3);
      expect(P(after, "matting").volumeMm3).toBeGreaterThan(P(before, "matting").volumeMm3 * 2);
    },
  },
  {
    path: "frame_style.separate.enabled",
    value: true,
    scene: "block",
    why: "the frame becomes a separate printed part that mates with the plate, so both bodies are rebuilt around the joint",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "base"))).toBeGreaterThan(triangleCount(R(before, "base")) + 10000);
      expect(R(after, "base").bbox.max[2]).toBeGreaterThan(R(before, "base").bbox.max[2]);
      expect(R(after, "frame").bbox.min[2]).toBeGreaterThan(R(before, "frame").bbox.min[2]);
    },
    assertExport: (before, after) => {
      expect(P(after, "base").triangles).toBeGreaterThan(P(before, "base").triangles + 10000);
      expect(P(after, "frame").triangles).toBeLessThan(P(before, "frame").triangles);
    },
  },
  {
    path: "frame_style.separate.mount",
    value: "magnet",
    base: SEPARATE,
    scene: "block",
    why: "how the separate frame is held on: a snap ridge is one continuous rib, magnets are discrete pockets in both parts",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")) + 400);
      expect(R(after, "base").bbox.max[2]).toBeLessThan(R(before, "base").bbox.max[2]);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles + 400);
      expect(P(after, "base").bbox.max[2]).toBeLessThan(P(before, "base").bbox.max[2]);
    },
  },
  {
    path: "frame_style.separate.tolerance_mm",
    value: 0.6,
    base: SEPARATE,
    scene: "block",
    why: "the clearance in the frame-to-plate joint, so a looser fit lifts the frame's underside and thins it",
    assertPreview: (before, after) => {
      expect(R(after, "frame").bbox.min[2]).toBeCloseTo(R(before, "frame").bbox.min[2] + 0.4, 3);
      expect(R(after, "frame").volumeMm3).toBeLessThan(R(before, "frame").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").bbox.min[2]).toBeCloseTo(P(before, "frame").bbox.min[2] + 0.4, 3);
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "frame_style.texture.pattern",
    value: "knurl",
    base: TEXTURE_OFF,
    scene: "block",
    why: "the pattern milled into the frame's top face, so a knurl replaces a flat face with a field of pyramids",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")) * 1.4);
      expect(R(after, "frame").volumeMm3).toBeLessThan(R(before, "frame").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles * 1.4);
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "frame_style.texture.scale_mm",
    value: 5.0,
    base: TEXTURE_ON,
    scene: "block",
    why: "the pitch of the pattern, so a coarser knurl has fewer, larger cells",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "frame"))).toBeLessThan(triangleCount(R(before, "frame")));
      expect(R(after, "frame").volumeMm3).toBeGreaterThan(R(before, "frame").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeLessThan(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).toBeGreaterThan(P(before, "frame").volumeMm3);
    },
  },
  {
    path: "frame_style.texture.depth_mm",
    value: 0.45,
    base: TEXTURE_ON,
    scene: "block",
    why: "how deep the pattern is cut, so a deeper knurl takes more frame material",
    assertPreview: (before, after) => {
      expect(R(after, "frame").volumeMm3).toBeLessThan(R(before, "frame").volumeMm3 - 100);
      expect(triangleCount(R(after, "frame"))).not.toBe(triangleCount(R(before, "frame")));
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").volumeMm3).toBeLessThan(P(before, "frame").volumeMm3 - 100);
    },
  },

  // --- frame magnets -------------------------------------------------------
  {
    path: "hanger_magnet.diameter_mm",
    value: 4,
    base: SEPARATE_MAGNET,
    scene: "block",
    why: "how wide the magnet pockets are bored: eight pockets (two per side) whose bore area grows by pi/4 * (16 - 9) mm2 each, half the depth in the frame and half in the plate",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "frame"))).toBe(triangleCount(R(before, "frame")));
      // The analytic bore delta, not a direction: 8 pockets by the area
      // difference by the frame's ~1.03 mm share of the 2 mm magnet.
      expect(R(before, "frame").volumeMm3 - R(after, "frame").volumeMm3).toBeCloseTo(MAGNET_BORE_DELTA_MM3, 1);
      expect(R(before, "base").volumeMm3 - R(after, "base").volumeMm3).toBeCloseTo(MAGNET_BORE_DELTA_MM3, 1);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBe(P(before, "frame").triangles);
      expect(P(before, "frame").volumeMm3 - P(after, "frame").volumeMm3).toBeCloseTo(MAGNET_BORE_DELTA_MM3, 1);
    },
  },
  {
    path: "hanger_magnet.thickness_mm",
    value: 1,
    base: SEPARATE_MAGNET,
    scene: "block",
    why: "how deep the magnet pockets are bored, so a thinner magnet leaves more material behind",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "frame"))).toBe(triangleCount(R(before, "frame")));
      expect(R(after, "frame").volumeMm3).toBeGreaterThan(R(before, "frame").volumeMm3 + 10);
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBe(P(before, "frame").triangles);
      expect(P(after, "frame").volumeMm3).toBeGreaterThan(P(before, "frame").volumeMm3 + 10);
    },
  },
  {
    path: "hanger_magnet.count",
    value: 4,
    base: SEPARATE_MAGNET,
    scene: "block",
    why: "how many magnets are set into each side of the joint, so twice as many pockets are bored",
    assertPreview: (before, after) => {
      expect(triangleCount(R(after, "frame"))).toBeGreaterThan(triangleCount(R(before, "frame")) * 1.8);
      expect(triangleCount(R(after, "base"))).toBeGreaterThan(triangleCount(R(before, "base")));
    },
    assertExport: (before, after) => {
      expect(P(after, "frame").triangles).toBeGreaterThan(P(before, "frame").triangles * 1.8);
      expect(P(after, "base").triangles).toBeGreaterThan(P(before, "base").triangles);
    },
  },

  // --- per-object overrides (v3.1 Task 11) ---------------------------------
  //
  // Every probe here runs on the `override` scene, which is the block with an
  // OSM id on its pond and its park: an `object_overrides` row is keyed by the
  // BASE OSM id, and an `AreaFeature` that carries none is a polygon no
  // override can name (`solid/overrides.ts:baseOsmIdOfArea`).
  //
  // The two identity leaves need a base that already DOES something, or moving
  // them moves nothing: both are probed against a hidden tower, so the probe
  // reads where the hide went. Everything else is probed against a bare row.
  {
    path: "object_overrides[].osm_id",
    value: OVERRIDE_LOW_ID,
    base: OVR_TOWER_HIDDEN,
    scene: "override",
    why: "which object in the layer the row acts on, so moving the id carries the hide from the tower to the low block and back",
    assertPreview: (before, after) => {
      // Two bodies on both sides: one building is hidden either way, and the
      // question is which. The roof says the tower came back; the west edge
      // says the low block went in its place.
      expect(R(before, "buildings").bodies).toBe(2);
      expect(R(after, "buildings").bodies).toBe(2);
      expect(R(before, "buildings").bbox.max[2]).toBeCloseTo(COURT_ROOF_MM, 2);
      expect(R(after, "buildings").bbox.max[2]).toBeCloseTo(TOWER_ROOF_MM, 2);
      expect(R(before, "buildings").bbox.min[0]).toBeCloseTo(LOW_WEST_EDGE_MM, 2);
      expect(R(after, "buildings").bbox.min[0]).toBeCloseTo(COURT_WEST_EDGE_MM, 2);
      // `b-low` is a building too, so the row still resolves.
      expect(after.result.stats.overridesUnresolved).toBeUndefined();
    },
    assertExport: (before, after) => {
      expect(P(before, "buildings").bbox.max[2]).toBeCloseTo(COURT_ROOF_MM, 2);
      expect(P(after, "buildings").bbox.max[2]).toBeCloseTo(TOWER_ROOF_MM, 2);
      expect(P(before, "buildings").bbox.min[0] - buildOffset(before)[0]).toBeCloseTo(LOW_WEST_EDGE_MM, 2);
      expect(P(after, "buildings").bbox.min[0] - buildOffset(after)[0]).toBeCloseTo(COURT_WEST_EDGE_MM, 2);
      expect(sidecarRegions(before.sidecar).get("buildings")?.bodies).toBe(2);
      expect(sidecarRegions(after.sidecar).get("buildings")?.bodies).toBe(2);
    },
  },
  {
    path: "object_overrides[].layer",
    value: "road",
    base: OVR_TOWER_HIDDEN,
    scene: "override",
    why: "which layer's objects the row is keyed against, so the same id and the same hide reach the buildings or nothing at all",
    assertPreview: (before, after) => {
      expect(R(before, "buildings").bodies).toBe(2);
      expect(R(after, "buildings").bodies).toBe(3);
      expect(R(after, "buildings").volumeMm3 - R(before, "buildings").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      // The low block never moved: this is the hide leaving the layer, not the
      // hide moving to another object, which is what `osm_id` does.
      expect(R(after, "buildings").bbox.min[0]).toBeCloseTo(LOW_WEST_EDGE_MM, 2);
      expect(before.result.stats.overridesUnresolved).toBeUndefined();
      expect(after.result.stats.overridesUnresolved).toBe(1);
      // No ROAD is called `b-tall`, so the roads layer is untouched.
      expect(N(after)).toEqual(N(before));
      expect(R(after, "roads").volumeMm3).toBeCloseTo(R(before, "roads").volumeMm3, 6);
    },
    assertExport: (before, after) => {
      expect(P(after, "buildings").volumeMm3 - P(before, "buildings").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(P(after, "buildings").bbox.max[2]).toBeCloseTo(TOWER_ROOF_MM, 2);
      expect(sidecarRegions(before.sidecar).get("buildings")?.bodies).toBe(2);
      expect(sidecarRegions(after.sidecar).get("buildings")?.bodies).toBe(3);
      expect(P(after, "roads").volumeMm3).toBeCloseTo(P(before, "roads").volumeMm3, 6);
    },
  },
  {
    path: "object_overrides[].hidden",
    value: true,
    base: OVR_TOWER,
    scene: "override",
    why: "takes one object out of the model, so the buildings region loses exactly that one solid and nothing takes its place",
    assertPreview: (before, after) => {
      expect(R(before, "buildings").bodies).toBe(3);
      expect(R(after, "buildings").bodies).toBe(2);
      expect(R(before, "buildings").volumeMm3 - R(after, "buildings").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(R(after, "buildings").bbox.max[2]).toBeCloseTo(COURT_ROOF_MM, 2);
      // A hide, not a move: no override region caught it.
      expect(N(after)).toEqual(N(before));
    },
    assertExport: (before, after) => {
      expect(P(before, "buildings").volumeMm3 - P(after, "buildings").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(P(after, "buildings").bbox.max[2]).toBeCloseTo(COURT_ROOF_MM, 2);
      expect([...bambuParts(after.files).keys()]).toEqual([...bambuParts(before.files).keys()]);
      expect(sidecarRegions(before.sidecar).get("buildings")?.bodies).toBe(3);
      expect(sidecarRegions(after.sidecar).get("buildings")?.bodies).toBe(2);
    },
  },
  {
    path: "object_overrides[].height_scale",
    value: 0.5,
    base: OVR_TOWER,
    scene: "override",
    why: "multiplies one building's OSM height, so the tower's printed roof above the plate is scaled by exactly that factor and its footprint is not",
    assertPreview: (before, after) => {
      const plate = R(before, "base").bbox.max[2];
      const roofBefore = R(before, "buildings").bbox.max[2] - plate;
      const roofAfter = R(after, "buildings").bbox.max[2] - plate;
      expect(roofAfter).toBeCloseTo(roofBefore * 0.5, 2);
      // Still three bodies over the same plan: a height, not a hide.
      expect(R(after, "buildings").bodies).toBe(3);
      expect(R(after, "buildings").bbox.min[0]).toBeCloseTo(R(before, "buildings").bbox.min[0], 6);
      expect(R(after, "buildings").bbox.max[0]).toBeCloseTo(R(before, "buildings").bbox.max[0], 6);
      expect(R(after, "buildings").volumeMm3).toBeLessThan(R(before, "buildings").volumeMm3);
    },
    assertExport: (before, after) => {
      const roofBefore = P(before, "buildings").bbox.max[2] - P(before, "base").bbox.max[2];
      const roofAfter = P(after, "buildings").bbox.max[2] - P(after, "base").bbox.max[2];
      expect(roofAfter).toBeCloseTo(roofBefore * 0.5, 2);
      expect(sidecarRegions(after.sidecar).get("buildings")?.bodies).toBe(3);
      expect(P(after, "buildings").volumeMm3).toBeLessThan(P(before, "buildings").volumeMm3);
    },
  },
  {
    path: "object_overrides[].hero",
    value: "on",
    base: OVR_TOWER,
    scene: "override",
    why: "marks one building a hero from the right-click menu rather than from hero_building_ids, so its solid moves into the hero region whole",
    assertPreview: (before, after) => {
      // `hero_building_ids` is empty on both sides: the marking came from the
      // override row and from nothing else.
      expect(before.result.params.hero_building_ids ?? []).toEqual([]);
      expect(after.result.params.hero_building_ids ?? []).toEqual([]);
      expect(N(before)).not.toContain("hero_building");
      expect(R(after, "hero_building").bodies).toBe(1);
      expect(R(after, "hero_building").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(R(after, "hero_building").bbox.max[2]).toBeCloseTo(TOWER_ROOF_MM, 2);
      // Moved, not added: the buildings region lost exactly the same solid.
      expect(R(before, "buildings").volumeMm3 - R(after, "buildings").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(R(after, "buildings").bodies).toBe(2);
    },
    assertExport: (before, after) => {
      expect(bambuParts(before.files).has("hero_building")).toBe(false);
      expect(P(after, "hero_building").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(P(after, "hero_building").bbox.max[2]).toBeCloseTo(TOWER_ROOF_MM, 2);
      expect(sidecarRegions(before.sidecar).has("hero_building")).toBe(false);
      expect(sidecarRegions(after.sidecar).get("hero_building")?.bodies).toBe(1);
    },
  },
  {
    path: "object_overrides[].tint",
    value: OVERRIDE_TINT_HEX,
    base: OVR_TOWER_OBJ,
    scene: "override",
    why: "a shade of one building's own filament, which the print path ignores by design and the parts-mode OBJ writes as that body's material",
    assertPreview: (before, after) => {
      expect(before.result.buildingTints ?? []).toHaveLength(0);
      const tints = after.result.buildingTints ?? [];
      expect(tints).toHaveLength(1);
      expect(tints[0].id).toBe(OVERRIDE_TOWER_ID);
      expect(tints[0].colorHex).toBe(OVERRIDE_TINT_HEX);
      // A shade, not a solid: the region it shades did not move at all.
      expect(R(after, "buildings").volumeMm3).toBeCloseTo(R(before, "buildings").volumeMm3, 6);
      expect(triangleCount(R(after, "buildings"))).toBe(triangleCount(R(before, "buildings")));
    },
    assertExport: (before, after) => {
      expect(mtlNames(before.files)).toContain("buildings");
      expect(mtlNames(before.files)).not.toContain("buildings_tint_1");
      expect(mtlNames(after.files)).toContain("buildings_tint_1");
      // The Kd row IS the hex the row asked for, not merely a different one.
      const kd = mtlKd(after.files, "buildings_tint_1");
      const want = unitRgb(OVERRIDE_TINT_HEX);
      expect(kd[0]).toBeCloseTo(want[0], 3);
      expect(kd[1]).toBeCloseTo(want[1], 3);
      expect(kd[2]).toBeCloseTo(want[2], 3);
      // The buildings group is split per body so the shade can land on one.
      expect(objGroups(before.files)).toContain("buildings");
      expect(objGroups(after.files)).toContain("buildings_1");
    },
  },
  {
    path: "object_overrides[].slot",
    value: 3,
    base: OVR_TOWER,
    scene: "override",
    why: "puts one object on a filament slot of its own, which a region carries one of, so the solid moves whole into override_1 on that extruder",
    assertPreview: (before, after) => {
      expect(N(before)).not.toContain("override_1");
      const own = R(after, "override_1");
      expect(own.slot).toBe(3);
      // `[V3.1-P11-1]`: the colour half was not asked for, so it falls back to
      // the parent layer's rather than to anything of the override's own.
      expect(own.colorHex).toBe(R(before, "buildings").colorHex);
      expect(own.bodies).toBe(1);
      expect(own.volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(R(before, "buildings").volumeMm3 - R(after, "buildings").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
    },
    assertExport: (before, after) => {
      expect(bambuParts(before.files).has("override_1")).toBe(false);
      expect(P(after, "override_1").extruder).toBe(3);
      expect(P(after, "override_1").volumeMm3).toBeCloseTo(TOWER_VOLUME_MM3, 2);
      expect(P(after, "buildings").extruder).toBe(P(before, "buildings").extruder);
      expect(sidecarRegions(after.sidecar).get("override_1")?.slot).toBe(3);
    },
  },
  {
    path: "object_overrides[].color",
    value: OVERRIDE_COLOR_HEX,
    base: OVR_TOWER_OWN_SLOT,
    scene: "override",
    why: "the filament colour one object prints in, which the project loads into that object's own slot",
    assertPreview: (before, after) => {
      // Before, the colour half is unasked and falls back to the buildings
      // layer's (`[V3.1-P11-1]`); after, it is the row's own.
      expect(R(before, "override_1").colorHex).toBe(R(before, "buildings").colorHex);
      expect(R(after, "override_1").colorHex).toBe(OVERRIDE_COLOR_HEX);
      // A colour, not a shape: same slot, same solid.
      expect(R(after, "override_1").slot).toBe(3);
      expect(R(after, "override_1").volumeMm3).toBeCloseTo(R(before, "override_1").volumeMm3, 6);
      expect(triangleCount(R(after, "override_1"))).toBe(triangleCount(R(before, "override_1")));
    },
    assertExport: (before, after) => {
      expect(sidecarRegions(before.sidecar).get("override_1")?.color).not.toBe(OVERRIDE_COLOR_HEX);
      expect(sidecarRegions(after.sidecar).get("override_1")?.color).toBe(OVERRIDE_COLOR_HEX);
      expect(bambuProject(before.files).filament_colour[2]).not.toBe(OVERRIDE_COLOR_HEX);
      expect(bambuProject(after.files).filament_colour[2]).toBe(OVERRIDE_COLOR_HEX);
      expect(P(after, "override_1").triangles).toBe(P(before, "override_1").triangles);
    },
  },
  {
    path: "object_overrides[].road_mode",
    value: "emboss",
    base: OVR_ROAD,
    scene: "override",
    why: "whether one road is a groove in the plate or a ridge on it, so the same ribbon crosses the plate top to the other side",
    assertPreview: (before, after) => {
      const plate = R(before, "base").bbox.max[2];
      expect(N(before)).toContain("roads");
      expect(N(after)).not.toContain("roads");
      const ridge = R(after, "override_1");
      // The same ribbon: same triangles, same volume, same plan.
      expect(triangleCount(ridge)).toBe(triangleCount(R(before, "roads")));
      expect(ridge.volumeMm3).toBeCloseTo(R(before, "roads").volumeMm3, 6);
      expect(ridge.bbox.min[1]).toBeCloseTo(R(before, "roads").bbox.min[1], 6);
      expect(ridge.bbox.max[1]).toBeCloseTo(R(before, "roads").bbox.max[1], 6);
      // Engraved, its top face sits under the plate; embossed, exactly as far
      // over it. A mirror about the plate top, not merely a lift.
      expect(plate - R(before, "roads").bbox.max[2]).toBeGreaterThan(0);
      expect(ridge.bbox.max[2] - plate).toBeCloseTo(plate - R(before, "roads").bbox.max[2], 3);
      // And the plate keeps the material the groove used to take out.
      expect(R(after, "base").volumeMm3).toBeGreaterThan(R(before, "base").volumeMm3);
    },
    assertExport: (before, after) => {
      expect(bambuParts(before.files).has("override_1")).toBe(false);
      expect(bambuParts(after.files).has("roads")).toBe(false);
      const plate = P(after, "base").bbox.max[2];
      const ridge = P(after, "override_1");
      expect(ridge.triangles).toBe(P(before, "roads").triangles);
      expect(ridge.volumeMm3).toBeCloseTo(P(before, "roads").volumeMm3, 6);
      expect(ridge.bbox.max[2] - plate).toBeCloseTo(plate - P(before, "roads").bbox.max[2], 3);
      expect(sidecarRegions(before.sidecar).has("override_1")).toBe(false);
      expect(sidecarRegions(after.sidecar).has("roads")).toBe(false);
    },
  },
  {
    path: "object_overrides[].width_scale",
    value: 2,
    base: OVR_ROAD,
    scene: "override",
    why: "multiplies one road's ground width where road_scale itself applies, so the printed ribbon widens by that road's own tagged width",
    assertPreview: (before, after) => {
      const widened = spanOf(R(after, "roads").bbox, 1) - spanOf(R(before, "roads").bbox, 1);
      // Doubling a 14 m way adds exactly 14 more ground metres of ribbon.
      expect(widened).toBeCloseTo(ROAD_WAY_WIDTH_M * mmPerM(before), 2);
      // Wider, not longer, and still one ribbon.
      expect(R(after, "roads").bbox.max[0]).toBeCloseTo(R(before, "roads").bbox.max[0], 6);
      expect(triangleCount(R(after, "roads"))).toBe(triangleCount(R(before, "roads")));
      expect(R(after, "base").volumeMm3).toBeLessThan(R(before, "base").volumeMm3);
    },
    assertExport: (before, after) => {
      const widened = spanOf(P(after, "roads").bbox, 1) - spanOf(P(before, "roads").bbox, 1);
      expect(widened).toBeCloseTo(ROAD_WAY_WIDTH_M * mmPerM(before), 2);
      expect(P(after, "roads").triangles).toBe(P(before, "roads").triangles);
      expect(sidecarRegions(after.sidecar).get("roads")?.volume_mm3).toBeGreaterThan(
        sidecarRegions(before.sidecar).get("roads")?.volume_mm3 ?? 0,
      );
    },
  },
  {
    path: "object_overrides[].raise_mm",
    value: 1,
    base: OVR_POND,
    scene: "override",
    why: "offsets one water or green polygon from its layer's own proud_mm, so the whole slab moves that far up the z axis",
    assertPreview: (before, after) => {
      expect(N(before)).toContain("water");
      expect(N(after)).not.toContain("water");
      const lifted = R(after, "override_1");
      // The same slab, moved: both faces up by exactly the millimetre asked
      // for, at an unchanged volume and triangle count.
      expect(triangleCount(lifted)).toBe(triangleCount(R(before, "water")));
      expect(lifted.volumeMm3).toBeCloseTo(R(before, "water").volumeMm3, 6);
      expect(lifted.bbox.min[2] - R(before, "water").bbox.min[2]).toBeCloseTo(1.0, 3);
      expect(lifted.bbox.max[2] - R(before, "water").bbox.max[2]).toBeCloseTo(1.0, 3);
      // Slot and colour were not asked for, so both fall back to the layer's.
      expect(lifted.slot).toBe(R(before, "water").slot);
      expect(lifted.colorHex).toBe(R(before, "water").colorHex);
    },
    assertExport: (before, after) => {
      expect(bambuParts(after.files).has("water")).toBe(false);
      const lifted = P(after, "override_1");
      expect(lifted.triangles).toBe(P(before, "water").triangles);
      expect(lifted.volumeMm3).toBeCloseTo(P(before, "water").volumeMm3, 6);
      expect(lifted.bbox.min[2] - P(before, "water").bbox.min[2]).toBeCloseTo(1.0, 3);
      expect(lifted.bbox.max[2] - P(before, "water").bbox.max[2]).toBeCloseTo(1.0, 3);
      expect(sidecarRegions(after.sidecar).get("override_1")?.color).toBe(
        sidecarRegions(before.sidecar).get("water")?.color,
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Probe families
// ---------------------------------------------------------------------------

/**
 * `colour.region_slots.<region>`: the filament slot the region prints on, which
 * the Bambu project writes as that part's extruder.
 */
function slotProbe(region: RegionName, value: number, scene: MatrixScene, base: Partial<PrintParams> | undefined): Probe[] {
  return [
    {
      path: `colour.region_slots.${region}` as ParamPath,
      value,
      base,
      scene,
      why: `the filament slot the ${region} region prints on, written into the file as that part's extruder`,
      assertPreview: (before, after) => {
        expect(R(before, region).slot).not.toBe(value);
        expect(R(after, region).slot).toBe(value);
        expect(triangleCount(R(after, region))).toBe(triangleCount(R(before, region)));
      },
      assertExport: (before, after) => {
        expect(P(before, region).extruder).not.toBe(value);
        expect(P(after, region).extruder).toBe(value);
        expect(sidecarRegions(after.sidecar).get(region)?.slot).toBe(value);
      },
    },
  ];
}

/**
 * `colour.region_colors.<region>`: the swatch the region carries, and the
 * filament colour the Bambu project loads into the slot it publishes to.
 *
 * `slot` is the slot whose `filament_colour` entry must move. Five regions are
 * first on their default slot and publish there; the other five are not
 * (`base` holds slot 1 ahead of `frame` and `matting`, `roads` holds slot 4
 * ahead of `parks`, `rail` and `lettering`), so their probe's base parks them on
 * a slot of their own with `solo` and the file's filament list carries the
 * swatch there. Either way the probe also asserts the shipped rule that decides
 * which region publishes to a shared slot.
 */
function colorProbe(
  region: RegionName,
  value: string,
  scene: MatrixScene,
  base: Partial<PrintParams> | undefined,
  slot: number,
  solo?: "solo",
): Probe[] {
  const probeBase: Partial<PrintParams> =
    solo === undefined
      ? { ...(base ?? {}) }
      : { ...(base ?? {}), colour: { ...(base?.colour ?? {}), region_slots: { ...(base?.colour?.region_slots ?? {}), [region]: slot } } };
  return [
    {
      path: `colour.region_colors.${region}` as ParamPath,
      value,
      base: base === undefined && solo === undefined ? undefined : probeBase,
      scene,
      why: `the colour the ${region} region carries into the preview, the sidecar's region table and slot ${slot}'s filament`,
      assertPreview: (before, after) => {
        expect(R(before, region).colorHex).not.toBe(value);
        expect(R(after, region).colorHex).toBe(value);
        expect(R(after, region).slot).toBe(slot);
        expect(triangleCount(R(after, region))).toBe(triangleCount(R(before, region)));
      },
      assertExport: (before, after) => {
        expect(sidecarRegions(before.sidecar).get(region)?.color).not.toBe(value);
        expect(sidecarRegions(after.sidecar).get(region)?.color).toBe(value);
        expect(bambuProject(before.files).filament_colour[slot - 1]).not.toBe(value);
        expect(bambuProject(after.files).filament_colour[slot - 1]).toBe(value);
        expectSlotColourComesFromTheFirstRegion(before);
        expectSlotColourComesFromTheFirstRegion(after);
      },
    },
  ];
}

/** `colour.tint.*`: the per-building shades, which only the OBJ writer puts in a file. */
function tintProbe(path: ParamPath, value: number, why: string): Probe[] {
  return [
    {
      path,
      value,
      base: TINT_OBJ,
      scene: "block",
      why,
      assertPreview: (before, after) => {
        const from = (before.result.buildingTints ?? []).map((tint) => tint.colorHex);
        const to = (after.result.buildingTints ?? []).map((tint) => tint.colorHex);
        expect(from).toHaveLength(3);
        expect(to).toHaveLength(3);
        expect(to).not.toEqual(from);
      },
      assertExport: (before, after) => {
        const kd = (snapshot: Snapshot): string[] =>
          new TextDecoder()
            .decode(snapshot.files.filter((file) => file.name.endsWith(".mtl"))[0].bytes)
            .split("\n")
            .filter((line) => line.startsWith("Kd "));
        expect(mtlNames(after.files)).toEqual(mtlNames(before.files));
        expect(kd(after)).not.toEqual(kd(before));
      },
    },
  ];
}

/**
 * `heights.*`: read by `normalise` alone, so these run from the Overpass
 * fixture, and each one reads the roof over ITS OWN building.
 *
 * The eight leaves would otherwise be indistinguishable: every one of them
 * makes its building the tallest in the fixture, so an assertion on
 * `stats.heightMm` is satisfied by any of the other seven. Here the probe names
 * the 46 m square its type occupies, asserts the roof over that square rises by
 * the metres the leaf moved (times the printed scale, within the +/- 6 percent
 * height jitter `osm/heights.ts` applies to a defaulted height), and asserts the
 * roof over a CONTROL square did not move at all. A rule that read the wrong
 * type's default fails both halves.
 *
 * `levelsFactor` is how many metres of building one metre of the leaf buys: 1
 * for a height in metres, `OSM_LEVELS` for the storey height.
 */
function heightProbe(
  footprint: keyof typeof OSM_FOOTPRINTS,
  path: ParamPath,
  value: number,
  levelsFactor: number,
  why: string,
): Probe[] {
  const control: keyof typeof OSM_FOOTPRINTS = footprint === "unknown" ? "house" : "unknown";
  const risenM = (value - OSM_FOOTPRINTS[footprint].defaultM) * levelsFactor;
  const check = (before: Snapshot, after: Snapshot, where: "preview" | "file"): void => {
    const expected = risenM * mmPerM(before);
    const rose = roofOverFootprint(after, footprint, where) - roofOverFootprint(before, footprint, where);
    // The jitter is deterministic per OSM id but not predictable here, so the
    // bound is the printed rise plus or minus the jitter's own 6 percent.
    expect(rose, `${footprint} roof (${where})`).toBeGreaterThan(expected * 0.93);
    expect(rose, `${footprint} roof (${where})`).toBeLessThan(expected * 1.07);
    expect(roofOverFootprint(after, control, where), `${control} roof (${where}) must not move`).toBeCloseTo(
      roofOverFootprint(before, control, where),
      6,
    );
  };
  return [
    {
      path,
      value,
      scene: "osm",
      why,
      assertPreview: (before, after) => {
        check(before, after, "preview");
        expect(R(after, "buildings").bodies).toBe(R(before, "buildings").bodies);
        expect(R(after, "buildings").volumeMm3).toBeGreaterThan(R(before, "buildings").volumeMm3);
      },
      assertExport: (before, after) => {
        check(before, after, "file");
        expect(sidecarNumber(after.sidecar, "bake_result.stats.height_mm")).toBeGreaterThan(
          sidecarNumber(before.sidecar, "bake_result.stats.height_mm"),
        );
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Exemptions
// ---------------------------------------------------------------------------

/**
 * The four leaves the matrix does not probe, each with its `DECISIONS.md`
 * ruling and the test that stands in its place. `matrix.test.ts` asserts the
 * compensating claim for the first two here; the `part_colors` migration is
 * the integration wave's own test.
 */
export const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "schema_version",
    "[V3.1-P1-2] payload metadata with no physical meaning. Compensated here: the sidecar echoes it at the top level, and share.test.ts pins the version gate.",
  ],
  [
    "colour.preview_theme",
    "[V3.1-P1-2] a viewer setting that lives in the viewport HUD, not in the model. Compensated here: the sidecar echoes it at the top level.",
  ],
  [
    "part_colors.base",
    "[V3.1-P1-2] the v1 colour block, migrated into colour.region_colors at parse time; the migration is the integration wave's test.",
  ],
  ["part_colors.frame", "[V3.1-P1-2] as part_colors.base."],
  ["part_colors.buildings", "[V3.1-P1-2] as part_colors.base."],
  ["part_colors.roads", "[V3.1-P1-2] as part_colors.base."],
  ["part_colors.water", "[V3.1-P1-2] as part_colors.base."],
  ["part_colors.green", "[V3.1-P1-2] as part_colors.base."],
  ["part_colors.trees", "[V3.1-P1-2] as part_colors.base."],
  [
    "colour.region_colors.attribution",
    "[V3.1-P1-13] the mandatory attribution marks are engraved cuts and never a body, so no colour can reach a file. Compensated here: the graph test pins that no stage claims it.",
  ],
]);

/**
 * Probes that are expected to fail because the engine, not the test, is wrong.
 *
 * Empty since the Task 7 geometry wave: `regions.rail.width_m` is authoritative
 * for every rail ribbon (`[V3.1-P2-1]`, `solid/roads.ts:railWidthGroundM`) and
 * `frame_style.lip_depth_mm` is the sight-edge rebate (`[V3.1-P2-2]`,
 * `solid/frame.ts:buildSightEdgeRebate`), and both probes pass on their own.
 * `lib/controlCatalog.test.ts` reads this map to refuse a control for a field
 * it names, so a row here is a slider held back.
 */
export const KNOWN_DEFECTS: ReadonlyMap<string, string> = new Map([]);

/** Exported for the note and for the coverage test. */
export function probeFor(path: string): Probe | undefined {
  return PROBES.find((probe) => probe.path === path);
}
