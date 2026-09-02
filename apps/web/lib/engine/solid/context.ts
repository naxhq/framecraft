/**
 * The values every solid module needs and none of them may re-derive.
 *
 * `lib/transform.ts` owns the maths (scale, thresholds, printed heights, the
 * lettering layout); this file owns nothing but the act of calling it once and
 * passing the answers around, so a scale computed in `buildings.ts` and a scale
 * computed in `roads.ts` cannot differ. It also carries the two output
 * channels - `findings` and `resolvedText` - because a refusal is a first class
 * result of the bake, never a thrown error.
 */

import type { PrintParams, SceneGraph } from "../../contracts";
import * as T from "../../transform";
import type {
  AuditFinding,
  RegionName,
  ResolvedLine,
  Severity,
  TerrainSampler,
} from "../types";
import { bandIndexOf } from "../types";
import type { Arena, ManifoldToplevel } from "./manifold";

/**
 * The smallest gap this engine ever leaves between two horizontal planes, mm.
 *
 * It is `thicken.LAYER_SEPARATION_MM`, but used for one thing only: keeping a
 * surface region's underside strictly below the base top, so the region always
 * has base beside it to weld to. It is NOT used between layers in plan.
 * Regions there are supposed to meet, and a 0.02 mm gap between two pockets is
 * a 0.02 mm rind of base standing between them, which is an unprintable wall
 * the separation itself created (DECISIONS `[V3-P2-E2]`).
 */
export const LAYER_SEPARATION_MM = 0.02;

/**
 * How far a POCKET is grown past the region that fills it, print mm.
 *
 * The surface layers ABUT: they tile the plate, and nothing holds them apart
 * in plan (holding them apart leaves a free-standing rind of base between two
 * grooves, which is the narrowest thing on the plate - see
 * {@link LAYER_SEPARATION_MM}, which is used for Z only). Extruding two
 * abutting pockets as they are therefore gives two COINCIDENT vertical faces,
 * and a boolean across a coincident face leaves zero-area triangles: 721 of
 * them in the Chicago base, 602 from the buildings/roads boundary alone.
 *
 * Growing every pocket by two micrometres makes neighbouring pockets OVERLAP
 * instead, so every surface the kernel has to intersect is transversal. The
 * cost is a two micrometre gap between a region's wall and the base around it,
 * a hundredth of a layer height, filled by the first perimeter the slicer
 * lays; the region still sits on the pocket's FLOOR, which is what welds it.
 *
 * This is a different problem, at a different place, from the seam
 * interpenetration of {@link PART_OVERLAP_MM}: the pockets carved into the
 * base still tile it exactly, while the region SOLIDS are grown past their own
 * pockets by a hundred times this. The two growths never interact.
 */
export const POCKET_GROW_MM = 0.002;

/**
 * How far every region reaches into the one beside it, print mm.
 *
 * The reference implementation's own `extrude.PART_OVERLAP_MM`, which is 04's
 * building/base overlap and 04's reason for it: "a deliberate overlap, so the
 * union is unambiguous". Two colour parts that met on an exactly coincident
 * face would leave the slicer to arbitrate which filament owns it, and a
 * boolean across that face leaves zero-area triangles - which is what the
 * reference validator reported when it unioned six flush regions (74 faces
 * under 1e-9 mm^2 and two regions under the minimum wall).
 *
 * So the regions are separate watertight BODIES that interpenetrate at their
 * seams rather than a flush partition: a surface region reaches 0.2 mm into
 * the base below and around it, the frame lip reaches 0.2 mm down into the
 * plate, and a building reaches `regions.building_skirt_mm` down through the
 * base top. Their union is still exactly `EngineResult.merged`, because every
 * one of those extras lies inside material the merged solid already has.
 * Per-region volumes are reported AS BUILT and therefore include the overlap;
 * `merged` is what the total volume and the filament estimate come from.
 */
export const PART_OVERLAP_MM = T.BUILDING_OVERLAP_MM;

/**
 * How far above the base top a cutter reaches, print mm.
 *
 * A pocket has to clear every raised feature standing on the same patch of
 * plate, or a recess cut under an embossed road would leave a lid on it
 * (`extrude.SUBTRACT_OVERSHOOT_MM`).
 */
export const CUTTER_OVERSHOOT_MM = 0.5;

/** Vertex-simplification tolerance for repaired 2D layers, print mm. */
export const SIMPLIFY_EPS_MM = 0.001;

/** Segments per full circle for a round join in a road buffer or an ornament. */
export const CIRCLE_SEGMENTS = 16;

/** Minimum-feature thresholds in PRINT millimetres. */
export interface ThresholdsMm {
  minWall: number;
  minGap: number;
  minDetail: number;
}

export interface BakeContext {
  readonly wasm: ManifoldToplevel;
  readonly arena: Arena;
  readonly scene: SceneGraph;
  readonly params: PrintParams;
  readonly terrain: TerrainSampler | null;
  /** Print millimetres per ground metre. */
  readonly scale: number;
  /** The ground radius the SceneGraph was built with, metres. */
  readonly radiusM: number;
  readonly thresholdsMm: ThresholdsMm;
  readonly thresholdsGroundM: T.Thresholds;
  /** Z of the base slab's top face, mm. The slab starts at z = 0. */
  readonly baseTopMm: number;
  /** Half-extent of the printed plate, mm. */
  readonly plateHalfMm: number;
  /** Half-extent of the square city geometry may occupy, mm (04's 0.05 inset). */
  readonly cropHalfMm: number;
  /** Half-extent a SUBTRACTIVE layer may reach, mm. */
  readonly recessClipHalfMm: number;
  readonly findings: AuditFinding[];
  readonly resolvedText: ResolvedLine[];
  /**
   * Z bands the mandatory attribution marks occupy, `[low, high]` mm.
   *
   * Filled by `solid/attribution.ts` while it cuts them and read by everything
   * that measures the finished model: the minimum-wall probe, the tile sliver
   * search and the export sidecar. It is a CHANNEL, like `findings` and
   * `resolvedText`, and for the same reason - the bands depend on the fitted
   * cap height of each mark, so they are known once the marks are laid out and
   * nowhere earlier (`[V3-P7-A8]`).
   */
  readonly markBands: Array<[number, number]>;
}

export interface ContextInit {
  wasm: ManifoldToplevel;
  arena: Arena;
  scene: SceneGraph;
  params: PrintParams;
  terrain?: TerrainSampler | null;
}

/**
 * Everything the pipeline shares, computed once.
 *
 * `recessClipHalfMm` follows `thicken.recess_clip_square`: an additive layer
 * stops at the inset crop square, but a recess clipped 0.05 mm inside the plate
 * edge would leave a 0.05 mm rind of base standing between the groove and the
 * side wall - an unprintable wall the recess itself created. With the frame on
 * the crop is a full 6 mm inside the plate and the two are the same number.
 */
export function makeContext(init: ContextInit): BakeContext {
  const { params, scene } = init;
  const radiusM = T.radius_m_from_bounds(scene.bounds);
  const scale = T.scale_mm_per_m(params, radiusM);
  const plateHalfMm = T.plate_extents_mm(params).max_x;
  // v3 phase 5: a shadow gap and a matting border both live between the lip and
  // the city, so the city gives way to them. Zero at the defaults, so a default
  // bake's crop is exactly the number it always was (`[V3-P5-F2]`).
  const cropHalfMm =
    T.content_extents_mm(params).max_x - T.frame_content_inset_mm(params);
  return {
    wasm: init.wasm,
    arena: init.arena,
    scene,
    params,
    terrain: init.terrain ?? null,
    scale,
    radiusM,
    thresholdsMm: {
      minWall: T.min_wall_mm(params),
      minGap: T.min_gap_mm(params),
      minDetail: T.min_detail_mm(params),
    },
    thresholdsGroundM: T.thresholds_ground_m(params, scale),
    baseTopMm: T.base_top_mm(params),
    plateHalfMm,
    cropHalfMm,
    recessClipHalfMm: params.frame ? cropHalfMm : plateHalfMm + 4 * SIMPLIFY_EPS_MM,
    findings: [],
    resolvedText: [],
    markBands: [],
  };
}

/** Record a finding once; a repeat of the same id and detail is dropped. */
export function addFinding(ctx: BakeContext, finding: AuditFinding): void {
  const already = ctx.findings.some(
    (f) => f.id === finding.id && f.detail === finding.detail,
  );
  if (!already) ctx.findings.push(finding);
}

/** Shorthand for the common shape of a finding. */
export function finding(
  id: string,
  severity: Severity,
  title: string,
  detail: string,
  region?: RegionName,
): AuditFinding {
  return region === undefined
    ? { id, severity, title, detail }
    : { id, severity, title, detail, region };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/**
 * The contract key a region reads its slot and colour from.
 *
 * `easel` and `cleat` are mount hardware with no entry of their own: they print
 * in the base filament unless the user says otherwise. A gradient band reads
 * `buildings`, and then the band overrides both (see below).
 */
function colourKey(region: RegionName): string {
  if (region === "easel" || region === "cleat") return "base";
  if (bandIndexOf(region) !== null) return "buildings";
  return region;
}

/** Filament slot for a region, from `params.colour.region_slots`. */
export function regionSlot(params: PrintParams, region: RegionName): number {
  const band = bandIndexOf(region);
  if (band !== null && params.colour?.gradient?.enabled === true) {
    const slots = params.colour.gradient.slots ?? [];
    const slot = slots[band - 1];
    if (typeof slot === "number" && slot > 0) return Math.round(slot);
  }
  const slots = params.colour?.region_slots;
  if (slots === undefined) return region === "base" ? 1 : 2;
  const table = slots as Record<string, number | undefined>;
  return table[colourKey(region)] ?? table.base ?? 1;
}

/** Filament colour for a region, from `params.colour.region_colors`. */
export function regionColor(params: PrintParams, region: RegionName): string {
  const colors = params.colour?.region_colors;
  if (colors === undefined) return "#D8D3C6";
  const table = colors as Record<string, string | undefined>;
  const own = table[colourKey(region)] ?? table.base ?? "#D8D3C6";
  const band = bandIndexOf(region);
  if (band === null || params.colour?.gradient?.enabled !== true) return own;
  // A band with no colour of its own is interpolated between the buildings
  // colour and the hero colour, so a two-band gradient reads as a ramp rather
  // than as two arbitrary filaments (`[V3-P5-F7]`).
  const bands = Math.max(1, (params.colour.gradient.slots ?? []).length);
  if (bands < 2) return own;
  const top = table.hero_building ?? own;
  return mixHex(own, top, (band - 1) / (bands - 1));
}

/** Linear blend of two `#RRGGBB` colours, `t` from 0 (a) to 1 (b). */
export function mixHex(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] | null => {
    const match = /^#?([0-9a-f]{6})/i.exec(hex.trim());
    if (match === null) return null;
    const value = parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const from = parse(a);
  const to = parse(b);
  if (from === null || to === null) return a;
  const clamped = Math.min(1, Math.max(0, t));
  const channel = (i: number): string => {
    const value = Math.round(from[i] + (to[i] - from[i]) * clamped);
    return Math.min(255, Math.max(0, value)).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`.toUpperCase();
}

// ---------------------------------------------------------------------------
// Region placement (v3 `params.regions`)
// ---------------------------------------------------------------------------

/** Where a surface region sits relative to the base top, print mm. */
export interface Placement {
  /** Thickness the parameters ASKED for. */
  depthMm: number;
  /** Offset of the TOP face from the base top the parameters ASKED for. */
  proudMm: number;
  /** Z of the solid's underside. */
  bottomMm: number;
  /** Z of the solid's top face. */
  topMm: number;
  /** Thickness actually built, `topMm - bottomMm`. */
  builtDepthMm: number;
  /** Offset actually built, `topMm - base_top`. */
  builtProudMm: number;
  /** True when the plate could not hold what the parameters asked for. */
  clamped: boolean;
}

/**
 * How deep a pocket may go, as a fraction of the base thickness.
 *
 * `extrude.slab` clamps a recess at half the base for the same reason: the
 * contract floors `base_thickness_mm` at 2 mm, and a pocket that ate more than
 * half of it would leave a floor thinner than two layers under the deepest
 * groove on the plate.
 */
export const MAX_POCKET_FRACTION = 0.5;

/**
 * Thinnest slab a surface region may be reduced to, print mm.
 *
 * One layer at the commonest layer height, and the same number as
 * {@link PART_OVERLAP_MM}. Below the contract's own defaults by a factor of two
 * (the thinnest is `parks.depth_mm` at 0.4), so this clamp can never fire on a
 * default-constructed PrintParams: it exists for the deep end of the schema's
 * `proud_mm` range, not for ordinary use.
 */
export const MIN_REGION_DEPTH_MM = 0.2;

/**
 * Resolve one region's placement, clamped so it always welds, never punches
 * through the plate, and is always a PART rather than nothing.
 *
 * The solid spans `[base_top + proud - depth, base_top + proud]`. Three clamps
 * apply, in this order:
 *
 * 1. the underside never rises to the base top, or the region would float on
 *    the surface with nothing holding it;
 * 2. it never drops below half the base thickness, or a groove would print with
 *    no floor under it;
 * 3. the TOP is raised, if it has to be, so at least
 *    {@link MIN_REGION_DEPTH_MM} of slab survives between the two.
 *
 * The third clamp is what the audit's MAJOR 3 was about. The schema allows
 * `proud_mm` down to -2.0, and on a 3 mm base that put the requested top BELOW
 * the deepest legal pocket floor: the extrusion came back with a non-positive
 * height, `areas.ts` dropped the region on a bare `continue`, and a user who
 * asked for deep water got a model with no water in it and no finding to say
 * so. Now the deepest legal thing is built and `clamped` says the request was
 * not honoured, so `buildSurfaceRegion` can name the region, the request and
 * what it actually got.
 */
export function placementOf(
  ctx: BakeContext,
  depthMm: number,
  proudMm: number,
): Placement {
  const baseTop = ctx.baseTopMm;
  const floor = baseTop * (1 - MAX_POCKET_FRACTION);
  const ceiling = baseTop - LAYER_SEPARATION_MM;
  const asked = baseTop + proudMm;
  const bottom = Math.min(ceiling, Math.max(floor, asked - depthMm));
  const top = Math.max(asked, bottom + Math.min(MIN_REGION_DEPTH_MM, depthMm));
  const builtDepth = top - bottom;
  return {
    depthMm,
    proudMm,
    bottomMm: bottom,
    topMm: top,
    builtDepthMm: builtDepth,
    builtProudMm: top - baseTop,
    // A tenth of the print grid: below this the difference is float noise from
    // the clamp arithmetic, not a request the plate refused.
    clamped:
      Math.abs(builtDepth - depthMm) > 1e-6 || Math.abs(top - asked) > 1e-6,
  };
}
