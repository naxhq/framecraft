/**
 * The gate: 04 stage 4, re-expressed for a model made of separate regions.
 *
 * Every rule 04 states about one welded solid has an equivalent here, and two
 * new ones the region split creates:
 *
 * | 04 | here |
 * |---|---|
 * | manifold / watertight | every region's `status()` is `NoError` |
 * | volume > 0, no inverted normals | every region has positive volume |
 * | self-intersection | guaranteed by manifold3d for valid inputs |
 * | bounding box | the union of the regions fits the plate and the height cap |
 * | sits at zero | the assembly's minimum Z is 0 within 1 um |
 * | min wall | the morphological opening in `measure.ts` |
 * | degenerate faces | manifold3d's own epsilon-validity |
 * | - | every region carries no body under the printable-speck floor |
 * | - | `islandReport` below: what in the assembly is not joined to the rest |
 *
 * The regions deliberately OVERLAP each other at every seam by 0.2 mm
 * (`context.PART_OVERLAP_MM`, DECISIONS `[V3-P2-E2]`), so there is no
 * partition check here and there must not be one. What replaced it is
 * `islandReport` and `engine.test.ts`'s own assertion that the union of the
 * regions is exactly `merged`, which is the property the overlap exists to
 * give.
 *
 * Since phase 4 this module raises the findings that need a live solid and
 * hands the rest to `audit/rules.ts`, which words them: the loose-body COUNT is
 * measured here and named there, so every finding in the product is phrased in
 * one file.
 *
 * Nothing here throws. A failure is an `AuditFinding` with the measured number
 * in it, because the caller has to be able to show the user a model that is
 * wrong and say why.
 */

import * as T from "../../transform";
import type { PrintParams, SceneGraph } from "../../contracts";
import { resolveProfile } from "../../printers";
import type { IslandReport } from "../audit/rules";
import type { AuditFinding, RegionMesh, RegionName } from "../types";
import { finding, type BakeContext } from "./context";
import type { Manifold } from "./manifold";
import { DEBRIS_MM3, UNION_DEBRIS_MM3 } from "./manifold";
import type { MinWallReport } from "./measure";
import { regionBounds } from "./measure";

/** 04 stage 4: X and Y within `plate_mm + 0.01`. */
export const PLATE_TOLERANCE_MM = 0.01;

/** 04 stage 4: the model sits at zero to within a micrometre. */
export const SIT_TOLERANCE_MM = 0.001;

/** 04 stage 4 fails a wall under this fraction of the minimum. */
export const MIN_WALL_FAIL_FACTOR = 0.9;

export interface BuiltRegion {
  mesh: RegionMesh;
  solid: Manifold;
  /** Counted once, when the region was finished, and reused by every check. */
  bodies: { real: number; debris: number; debrisVolume: number; smallestMm3: number };
}

/**
 * The Z ceiling for this parameter set, print mm.
 *
 * The ACTIVE printer's usable height, and nothing else. It is not `min`ed with
 * 04's own 60 mm figure, and that is a deliberate ruling (`[V3-P4-E9]`): the
 * ceiling is a property of the machine, so a P1S with 250 mm of gantry should
 * not refuse a 90 mm model because the reference implementation's product
 * ceiling was written for a different question. The DEFAULT is still 60,
 * because the contract's own `custom_profile.max_height_mm` default is 60 and
 * `printer_profile` defaults to `custom`; every number and every test at
 * defaults is therefore exactly what it was.
 *
 * The same number reaches the reference validator through the bake sidecar's
 * `max_height_mm` (`export/common.ts`), so the engine, the editor and the
 * validator all judge a model against one ceiling instead of three.
 */
export function maxHeightMm(ctx: BakeContext): number {
  return resolveProfile(ctx.params).maxHeightMm;
}

/**
 * The most islands worth attributing to a region.
 *
 * Each attribution is an intersection against every region solid, so a model
 * that came apart into hundreds of pieces would spend a minute describing its
 * own wreckage. The first few name the region; the count is exact regardless,
 * because it comes from the decomposition and not from this loop.
 */
export const MAX_ATTRIBUTED_ISLANDS = 12;

/**
 * Bodies in the assembled model that are not part of the main one.
 *
 * The largest body is the model; everything else is loose. Each loose body is
 * attributed to the region it shares the most volume with, so the finding can
 * say WHICH detail came away rather than "the model is in 4 pieces". Runs only
 * when there is more than one body, so a healthy bake pays one decomposition it
 * was going to pay for the connectivity check anyway.
 */
export function islandReport(
  ctx: BakeContext,
  assembly: Manifold | null,
  regions: readonly BuiltRegion[],
): IslandReport[] {
  if (assembly === null) return [];
  const bodies = ctx.arena.keepAll(assembly.decompose());
  try {
    const real = bodies.filter((body) => body.volume() >= UNION_DEBRIS_MM3);
    if (real.length <= 1) return [];
    let main = real[0];
    for (const body of real) {
      if (body.volume() > main.volume()) main = body;
    }
    const loose = real.filter((body) => body !== main);
    const groups = new Map<RegionName | null, { count: number; volume: number; floating: boolean }>();
    loose.forEach((body, index) => {
      const region =
        index < MAX_ATTRIBUTED_ISLANDS ? attributeIsland(ctx, body, regions) : null;
      const entry = groups.get(region) ?? { count: 0, volume: 0, floating: true };
      entry.count += 1;
      entry.volume += body.volume();
      if (body.boundingBox().min[2] <= SIT_TOLERANCE_MM) entry.floating = false;
      groups.set(region, entry);
    });
    return [...groups.entries()].map(([region, entry]) => ({
      region,
      count: entry.count,
      volumeMm3: entry.volume,
      floating: entry.floating,
    }));
  } finally {
    ctx.arena.dropAll(bodies);
  }
}

/** The region a loose body shares the most volume with, or null. */
function attributeIsland(
  ctx: BakeContext,
  body: Manifold,
  regions: readonly BuiltRegion[],
): RegionName | null {
  let best: RegionName | null = null;
  let bestVolume = 0;
  const box = body.boundingBox();
  for (const region of regions) {
    // Cheap rejection first: a region whose bounds miss the body entirely
    // cannot own it, and most regions miss most islands.
    const bounds = region.mesh.bbox;
    let apart = false;
    for (let axis = 0; axis < 3; axis += 1) {
      if (box.max[axis] < bounds.min[axis] || box.min[axis] > bounds.max[axis]) apart = true;
    }
    if (apart) continue;
    const shared = ctx.wasm.Manifold.intersection([body, region.solid]);
    const volume = shared.volume();
    shared.delete();
    if (volume > bestVolume) {
      bestVolume = volume;
      best = region.mesh.region;
    }
  }
  return best;
}

/**
 * Every check, in one pass.
 *
 * `assembly` is the union of all regions, which is also what the min wall was
 * measured on; it is null only for an empty scene.
 */
export function validate(
  ctx: BakeContext,
  regions: readonly BuiltRegion[],
  assembly: Manifold | null,
  minWall: MinWallReport,
): AuditFinding[] {
  const out: AuditFinding[] = [];

  // --- per region -------------------------------------------------------
  for (const { mesh, solid, bodies } of regions) {
    const status = solid.status();
    if (status !== "NoError") {
      out.push(
        finding(
          "not-manifold",
          "error",
          `The ${mesh.region} region is not a valid solid`,
          `manifold3d reports ${status}. This region cannot be printed or exported.`,
          mesh.region,
        ),
      );
    }
    if (!(mesh.volumeMm3 > 0)) {
      out.push(
        finding(
          "not-manifold",
          "error",
          `The ${mesh.region} region has no volume`,
          `Its volume measures ${mesh.volumeMm3.toFixed(4)} mm3, which means it is ` +
            "empty or inside out.",
          mesh.region,
        ),
      );
    }
    if (mesh.region === "base" && mesh.bodies !== 1) {
      out.push(
        finding(
          "floating-island",
          "error",
          "The base is not a single piece",
          `The base plate came out as ${mesh.bodies} separate bodies; it has to be one.`,
          "base",
        ),
      );
    }
    if (bodies.debris > 0) {
      out.push(
        finding(
          "floating-island",
          "warning",
          `The ${mesh.region} region carries ${bodies.debris} unprintable speck(s)`,
          `${bodies.debris} body/bodies totalling ${bodies.debrisVolume.toFixed(4)} mm3 are ` +
            `under the ${DEBRIS_MM3} mm3 floor and would print as nothing.`,
          mesh.region,
        ),
      );
    }
  }

  // --- the assembled model ---------------------------------------------
  const bounds = regionBounds(regions.map((r) => r.mesh));
  if (bounds !== null) {
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[1] - bounds.min[1];
    const limit = ctx.params.plate_mm + PLATE_TOLERANCE_MM;
    if (width > limit || depth > limit) {
      out.push(
        finding(
          "exceeds-plate",
          "error",
          "The model is wider than the plate",
          `It measures ${width.toFixed(2)} x ${depth.toFixed(2)} mm against a ` +
            `${ctx.params.plate_mm} mm plate.`,
        ),
      );
    }
    const height = bounds.max[2];
    const ceiling = maxHeightMm(ctx);
    if (height >= ceiling) {
      out.push({
        id: "exceeds-height",
        severity: "error",
        title: "The model is too tall to print",
        detail:
          `It reaches ${height.toFixed(2)} mm against a ${ceiling.toFixed(0)} mm ceiling. ` +
          "Lower the building height multipliers or widen the radius.",
        fix: {
          label: "Halve the tall-building multiplier",
          safe: false,
          patch: { large_scale: Math.max(0.5, ctx.params.large_scale / 2) },
        },
      });
    }
    if (Math.abs(bounds.min[2]) > SIT_TOLERANCE_MM) {
      out.push(
        finding(
          "not-manifold",
          "error",
          "The model does not sit on the bed",
          `Its lowest point is at z = ${bounds.min[2].toFixed(4)} mm, not 0.`,
        ),
      );
    }
  }

  // --- connectivity -----------------------------------------------------
  // The COUNT used to be reported here as one anonymous "the model is not one
  // connected piece". It is now `islandReport` above plus `audit/rules.ts`,
  // which says which region the loose material belongs to, how much of it there
  // is, and whether it even reaches the bed - the same defect, named. Nothing
  // is reported twice: this check no longer raises a finding of its own.

  // --- minimum wall -----------------------------------------------------
  const required = T.min_wall_mm(ctx.params);
  if (minWall.measuredMm !== null && minWall.measuredMm < required) {
    const severe = minWall.measuredMm < MIN_WALL_FAIL_FACTOR * required;
    const plate = biggerPlateMm(ctx.scene, ctx.params, ctx.radiusM);
    // On a hillside the count and the remedy are both different. A horizontal
    // slice cuts a sloped feature obliquely, so a groove wall that is a full
    // wall thick measured across itself can present as a sliver in plan; the
    // steeper the terrain the more of them there are, and the thing that
    // actually helps is less relief, not a bigger plate (`[V3-P3-G16]`).
    const hilly = ctx.terrain !== null;
    const softer = Number((ctx.params.terrain_exaggeration / 2).toFixed(3));
    const where =
      minWall.thinRegions > 1
        ? `${minWall.thinRegions} places are under it, the narrowest ` +
          `${minWall.measuredMm.toFixed(3)} mm at z = ${(minWall.atZMm ?? 0).toFixed(2)} mm`
        : `The narrowest wall measures ${minWall.measuredMm.toFixed(3)} mm at ` +
          `z = ${(minWall.atZMm ?? 0).toFixed(2)} mm`;
    const advice = hilly
      ? " Terrain is on, and a level slice through a hillside cuts every groove and ridge " +
        "at an angle, so they read narrower than they are built. Less exaggeration is the " +
        "direct remedy; a bigger plate helps too."
      : plate === null
        ? " A bigger plate would print the same city larger; so would a smaller radius."
        : "";
    const fix =
      hilly && softer > 0
        ? {
            label: `Halve the terrain exaggeration to ${softer}`,
            safe: true,
            patch: { terrain_exaggeration: softer },
          }
        : plate === null
          ? null
          : {
              label: `Print it on a ${plate} mm plate`,
              safe: false,
              patch: { plate_mm: plate },
            };
    out.push({
      id: "wall-too-thin",
      severity: severe ? "error" : "warning",
      title: "A wall is thinner than the nozzle can print",
      detail:
        `${where}, against ${required.toFixed(3)} mm for a ` +
        `${ctx.params.nozzle_mm} mm nozzle.${advice}`,
      ...(fix === null ? {} : { fix }),
    });
  }

  return out;
}

/**
 * The plate that would print this city big enough, mm, or null.
 *
 * The fix for a thin wall is to make the MODEL bigger, not to tell the
 * validator that the printer has a finer nozzle than it has. The previous patch
 * here halved `nozzle_mm`, which changes nothing physical: it only halves the
 * threshold this check compares against, so the warning goes away and the print
 * still fails (v3-02 audit, MINOR 9). `nozzle_mm` describes the hardware and no
 * automatic fix may ever write it.
 *
 * The answer comes from the shared advisor, which already solves for the
 * smallest plate that brings the widened fraction back under its target, and
 * falls back to one step up the plate range when the advisor has nothing to
 * say. Null when the plate is already at the contract's maximum, in which case
 * the finding carries the advice as prose instead of as a button, because a
 * smaller radius is a change to the SceneRequest and not to PrintParams.
 */
export function biggerPlateMm(
  scene: SceneGraph,
  params: PrintParams,
  radiusM: number,
): number | null {
  const recommended = T.recommend_plate_mm(scene, params, radiusM);
  const candidate =
    recommended !== null && recommended > params.plate_mm
      ? recommended
      : params.plate_mm + PLATE_STEP_MM;
  const capped = Math.min(T.PLATE_MAX_MM, candidate);
  return capped > params.plate_mm ? capped : null;
}

/** One step up the plate range when the advisor has no answer of its own, mm. */
export const PLATE_STEP_MM = 20;
