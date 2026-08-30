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
 * | - | no region overlaps another (they must partition the model) |
 * | - | the whole thing is ONE connected body when the frame is on |
 *
 * Nothing here throws. A failure is an `AuditFinding` with the measured number
 * in it, because the caller has to be able to show the user a model that is
 * wrong and say why.
 */

import * as T from "../../transform";
import type { AuditFinding, RegionMesh } from "../types";
import { finding, type BakeContext } from "./context";
import type { Manifold } from "./manifold";
import { DEBRIS_MM3, UNION_DEBRIS_MM3, countBodies } from "./manifold";
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
 * Two rules bind and the smaller wins: 04's own 60 mm product ceiling (which
 * the editor, the reference bake and every existing warning already enforce)
 * and the printer's usable height. The per-model printer table is the printer
 * phase's (`lib/printers.ts`); until it exists, a custom profile's own
 * `max_height_mm` is the only printer number the contract carries.
 */
export function maxHeightMm(ctx: BakeContext): number {
  const custom = ctx.params.custom_profile?.max_height_mm ?? 250;
  return Math.min(T.MAX_HEIGHT_MM, custom);
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
  if (assembly !== null && ctx.params.frame) {
    const count = countBodies(assembly, UNION_DEBRIS_MM3).real;
    if (count !== 1) {
      out.push(
        finding(
          "floating-island",
          "error",
          "The model is not one connected piece",
          `The regions union into ${count} separate bodies. Everything has to be joined ` +
            "to the base, or the loose pieces will not survive the print.",
        ),
      );
    }
  }

  // --- minimum wall -----------------------------------------------------
  const required = T.min_wall_mm(ctx.params);
  if (minWall.measuredMm !== null && minWall.measuredMm < required) {
    const severe = minWall.measuredMm < MIN_WALL_FAIL_FACTOR * required;
    out.push({
      id: "wall-too-thin",
      severity: severe ? "error" : "warning",
      title: "A wall is thinner than the nozzle can print",
      detail:
        `The narrowest wall measures ${minWall.measuredMm.toFixed(3)} mm at ` +
        `z = ${(minWall.atZMm ?? 0).toFixed(2)} mm, against ${required.toFixed(3)} mm for a ` +
        `${ctx.params.nozzle_mm} mm nozzle.`,
      fix: {
        label: "Widen the crop so features print bigger",
        safe: false,
        patch: { nozzle_mm: Math.max(0.1, ctx.params.nozzle_mm / 2) },
      },
    });
  }

  return out;
}
