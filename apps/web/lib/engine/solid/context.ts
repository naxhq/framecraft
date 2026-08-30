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
 * Strictly more than half of `LAYER_SEPARATION_MM`, and that is the whole
 * design. The layers are held 0.02 mm apart so no two of them ever share a
 * vertical face - a boolean across a coincident face leaves zero-area
 * triangles, 721 of them in the Chicago base before the separation went in.
 * But the strip of base that gap leaves BETWEEN TWO GROOVES is a free-standing
 * 0.02 mm wall, which is the narrowest thing on the plate.
 *
 * Growing each pocket by 0.012 mm resolves both at once: two pockets 0.02 mm
 * apart now overlap by 0.004 mm, so their union is one pocket and the wall
 * never exists, while the surfaces the kernel has to intersect are transversal
 * rather than coincident. Where the neighbour is a building or a flush park
 * the strip survives at 0.008 mm - and there it is harmless, because the wall
 * or the park stands right beside it and the two print as one mass.
 *
 * The cost is an 0.012 mm gap between a region's wall and the base around it:
 * a fifth of a layer height, well under the tolerance of any printer this
 * targets. The region still sits on the pocket's floor, so it is welded to the
 * plate exactly as before.
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
  readonly warnings: string[];
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
  const cropHalfMm = T.content_extents_mm(params).max_x;
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
    warnings: [],
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

/** Filament slot for a region, from `params.colour.region_slots`. */
export function regionSlot(params: PrintParams, region: RegionName): number {
  const slots = params.colour?.region_slots;
  if (slots === undefined) return region === "base" ? 1 : 2;
  const table = slots as Record<string, number | undefined>;
  // `easel` has no slot of its own in the contract: it is part of the mount, so
  // it prints in the base filament unless the user says otherwise.
  const key = region === "easel" ? "base" : region;
  return table[key] ?? table.base ?? 1;
}

/** Filament colour for a region, from `params.colour.region_colors`. */
export function regionColor(params: PrintParams, region: RegionName): string {
  const colors = params.colour?.region_colors;
  if (colors === undefined) return "#D8D3C6";
  const table = colors as Record<string, string | undefined>;
  const key = region === "easel" ? "base" : region;
  return table[key] ?? table.base ?? "#D8D3C6";
}

// ---------------------------------------------------------------------------
// Region placement (v3 `params.regions`)
// ---------------------------------------------------------------------------

/** Where a surface region sits relative to the base top, print mm. */
export interface Placement {
  /** Thickness of the region solid. */
  depthMm: number;
  /** Offset of its TOP face from the base top; negative is recessed. */
  proudMm: number;
  /** Z of the solid's underside. */
  bottomMm: number;
  /** Z of the solid's top face. */
  topMm: number;
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
 * Resolve one region's placement, clamped so it always welds and never punches
 * through the plate.
 *
 * The solid spans `[base_top + proud - depth, base_top + proud]`. Two clamps
 * apply: its underside never rises to the base top (or the region would float
 * on the surface with nothing holding it), and it never drops below half the
 * base thickness (or a groove would print with no floor under it).
 */
export function placementOf(
  ctx: BakeContext,
  depthMm: number,
  proudMm: number,
): Placement {
  const baseTop = ctx.baseTopMm;
  const floor = baseTop * (1 - MAX_POCKET_FRACTION);
  const ceiling = baseTop - LAYER_SEPARATION_MM;
  const top = baseTop + proudMm;
  const bottom = Math.min(ceiling, Math.max(floor, top - depthMm));
  return { depthMm, proudMm, bottomMm: bottom, topMm: top };
}
