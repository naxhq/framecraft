/**
 * The browser bake: a SceneGraph and a PrintParams in, watertight region solids
 * out.
 *
 * `bake()` is `04_PRINTABILITY_SPEC.md` end to end, with one structural change
 * from the reference implementation in `services/bake`: the output is not one
 * welded solid but one solid per colourable region, and those regions PARTITION
 * the model. They touch on shared faces, never overlap, and their union is a
 * single connected body - which is what lets the same geometry drive the
 * preview, the filament mapper and every exporter without any of them
 * disagreeing.
 *
 * Order of work, and why:
 *
 * 1. Stage 1 repair in 2D (`solid/repair.ts`), because extruding before the
 *    minimum-feature repair is what makes a printed city come out as mush.
 * 2. Buildings, then the four surface layers in precedence order, so a road
 *    never tunnels through a building and water always wins a river bank.
 * 3. Lettering and ornaments, which are cutters into the frame and the base and
 *    therefore have to exist before either is finished.
 * 4. The plate, carved by every cutter at once.
 * 5. Measure, validate, convert to meshes.
 *
 * Every WASM handle lives in one `Arena` that is disposed in a `finally`, so a
 * failed bake leaks nothing.
 */

import type { Engraving, PrintParams } from "../contracts";
import * as T from "../transform";
import { textTokenContext } from "../previewText";
import type {
  AuditFinding,
  EngineInput,
  EngineResult,
  EngineStats,
  RegionMesh,
  RegionName,
  ResolvedLine,
} from "./types";
import { REGION_NAMES } from "./types";
import { buildSurfaceRegions } from "./solid/areas";
import { buildPlate, carveBase, cutterTopMm } from "./solid/base";
import { buildBuildings } from "./solid/buildings";
import {
  addFinding,
  finding,
  makeContext,
  regionColor,
  regionSlot,
} from "./solid/context";
import type { BakeContext } from "./solid/context";
import { buildFrameLip, reportUnbuiltFrameStyle } from "./solid/frame";
import { buildLettering, loadFaces } from "./solid/lettering";
import {
  Arena,
  UNION_DEBRIS_MM3,
  batchedUnion,
  extrudeSection,
  loadManifold,
  countBodies,
  pruneDebris,
  subtractSolids,
  toRegionMesh,
} from "./solid/manifold";
import type { Manifold } from "./solid/manifold";
import { measureMinWall, regionBounds, triangleCount } from "./solid/measure";
import { buildOrnaments } from "./solid/ornaments";
import { repairBuildings } from "./solid/repair";
import { reportRoadModeConflict } from "./solid/roads";
import { validate, type BuiltRegion } from "./solid/validate";

/** How far the assembly may sit off z = 0 before it is nudged back, mm. */
const SIT_EPS_MM = 1e-9;

export interface BakeOptions {
  /**
   * Called with the finished region solids while they are still alive.
   *
   * The seam the partition test measures through. A `RegionMesh` is a float32
   * rendering of a solid manifold3d built in double, so two regions that share
   * a face exactly can appear to interpenetrate by a 15 nanometre band once
   * they have been re-imported from their meshes - a real property of the
   * exported files, and the wrong thing to measure when the question is whether
   * the ENGINE partitioned the model. Nothing but a test should use this: the
   * handles are freed as soon as it returns.
   */
  onSolids?: (regions: readonly BuiltRegion[]) => void;
}

/**
 * Build every region for one scene.
 *
 * Never throws for a printability problem: a refused engraving, a hanger that
 * does not fit, a wall that came out too thin are all reported through
 * `findings` and `resolvedText`. It does throw for a broken input (a scene with
 * no bounds, a zero radius), because that is a bug in the caller.
 */
export async function bake(
  input: EngineInput,
  options: BakeOptions = {},
): Promise<EngineResult> {
  const started = performance.now();
  const wasm = await loadManifold();
  await loadFaces(input.params);

  const arena = new Arena();
  try {
    const ctx = makeContext({
      wasm,
      arena,
      scene: input.scene,
      params: input.params,
      terrain: input.terrain ?? null,
    });
    reportUnbuiltFrameStyle(ctx);
    reportRoadModeConflict(ctx);

    const solids = new Map<RegionName, Manifold>();

    // --- buildings ------------------------------------------------------
    const heroIds = input.heroIds ?? T.hero_ids(input.params);
    const repaired = repairBuildings(ctx, heroIds);
    reportHeroes(ctx, repaired.heroUnknown, repaired.heroBuried, repaired.heroDropped);

    // --- the four surface layers ----------------------------------------
    // Before the buildings are extruded: the building socket needs to know
    // which layers it borders so its pocket can reach into them
    // (`areas.collaredPocket`), and the layers need the building footprint to
    // give way to.
    const surfaces = buildSurfaceRegions(ctx, repaired.footprint);
    for (const surface of surfaces) solids.set(surface.region, surface.solid);

    const buildings = buildBuildings(ctx, repaired);
    if (buildings.buildings !== null) solids.set("buildings", buildings.buildings);
    if (buildings.hero !== null) solids.set("hero_building", buildings.hero);

    // --- text and ornaments ---------------------------------------------
    const tokens = textTokenContext(
      input.scene,
      input.params,
      input.date ?? new Date().toISOString().slice(0, 10),
    );
    const lettering = buildLettering(ctx, tokens, input.rotationDeg ?? 0);
    const ornaments = buildOrnaments(ctx, lettering.layout);
    const inlay = batchedUnion(wasm, arena, lettering.inlay);
    if (inlay !== null) solids.set("lettering", inlay);

    // --- the plate, carved by everything --------------------------------
    const plate = buildPlate(ctx);
    const base = carveBase(ctx, plate, [
      ...buildings.socket,
      ...surfaces.map((s) => s.cutter),
      ...lettering.baseCut,
      ...ornaments.baseCut,
    ]);
    solids.set("base", base);

    // --- the frame ------------------------------------------------------
    const lip = buildFrameLip(ctx);
    // Additive first, then the cutters, in the reference implementation's
    // order: an embossed letter has to meet the same engraving cutter the rest
    // of the lip does.
    const raisedFrame =
      lip === null ? null : (batchedUnion(wasm, arena, [lip, ...lettering.frameAdd]) ?? lip);
    if (raisedFrame !== null) {
      const frame = subtractSolids(wasm, arena, raisedFrame, [
        ...lettering.frameCut,
        ...lettering.inlayCut,
        ...ornaments.frameCut,
      ]);
      solids.set("frame", frame);
    }

    // --- the single welded solid ----------------------------------------
    //
    // NOT a union of the finished regions. That union crosses a shared face
    // wherever two regions meet, and every such crossing leaves zero-area
    // slivers and zero-volume shells behind: measured on this plate, 40 faces
    // under 1e-9 mm^2 that no mesh repair can remove, because the T-junctions
    // they come from are wedged between other slivers.
    //
    // This is the reference implementation's own recipe instead
    // (`assemble.assemble`): union the ADDITIVE primitives, then subtract only
    // the part of each recess that is actually visible - the groove between the
    // region's top face and the base top. The result is the same set (a region
    // fills exactly the pocket it carved, so carving and refilling is the same
    // as never carving below the groove), 4 000 triangles lighter, and it
    // cleans to zero degenerate faces.
    const additive: Manifold[] = [plate];
    if (raisedFrame !== null) additive.push(raisedFrame);
    if (buildings.buildings !== null) additive.push(buildings.buildings);
    if (buildings.hero !== null) additive.push(buildings.hero);
    const grooves: Manifold[] = [];
    for (const surface of surfaces) {
      if (surface.placement.topMm > ctx.baseTopMm) {
        additive.push(surface.solid);
      } else if (surface.placement.topMm < ctx.baseTopMm) {
        // Grown like the base pockets, and for the same reason: two grooves
        // that meet must overlap, not share a wall (`context.POCKET_GROW_MM`).
        // The collared pocket, for the same reason the base carve uses it: two
        // grooves that meet must overlap, not share a wall.
        const groove = extrudeSection(
          wasm,
          arena,
          surface.pocket,
          surface.placement.topMm,
          cutterTopMm(ctx),
        );
        if (groove !== null) grooves.push(groove);
      }
      // A region flush with the base top (`proud_mm = 0`) is invisible in a
      // single-colour model: it is level with the surface it sits in.
    }
    const raised = batchedUnion(wasm, arena, additive);
    // An inlay is flush too, so its pocket and its plug cancel; neither is here.
    const assembly =
      raised === null
        ? null
        : subtractSolids(wasm, arena, raised, [
            ...grooves,
            ...lettering.frameCut,
            ...ornaments.frameCut,
            ...lettering.baseCut,
            ...ornaments.baseCut,
          ]);

    // --- sanitation, sit at zero, meshes --------------------------------
    const built = finishRegions(ctx, solids);
    const minWall = assembly === null ? null : measureMinWall(ctx, assembly);
    for (const item of validate(
      ctx,
      built,
      assembly,
      minWall ?? { measuredMm: null, atZMm: null, slices: 0 },
    )) {
      addFinding(ctx, item);
    }

    options.onSolids?.(built);

    // The single-object formats need ONE solid, not a pile of touching shells.
    const cleanAssembly =
      assembly === null ? null : pruneDebris(wasm, arena, assembly, UNION_DEBRIS_MM3).solid;
    const merged =
      cleanAssembly === null
        ? emptyRegionMesh()
        : toRegionMesh(
            cleanAssembly,
            "base",
            regionSlot(input.params, "base"),
            regionColor(input.params, "base"),
            countBodies(cleanAssembly, UNION_DEBRIS_MM3).real,
          );

    const regions = built.map((region) => region.mesh);
    const bounds = regionBounds(regions);
    const stats: EngineStats = {
      scaleDenominator: 1000 / ctx.scale,
      minWallMm: T.min_wall_mm(input.params),
      measuredMinWallMm: minWall?.measuredMm ?? null,
      buildings: buildings.count,
      buildingsMerged: repaired.merged,
      buildingsDilated: repaired.dilated,
      heightFallbacks: repaired.heightFallbacks,
      triangles: triangleCount(regions),
      widthMm: bounds === null ? 0 : bounds.max[0] - bounds.min[0],
      depthMm: bounds === null ? 0 : bounds.max[1] - bounds.min[1],
      heightMm: bounds === null ? 0 : bounds.max[2] - bounds.min[2],
      elapsedMs: performance.now() - started,
    };

    return {
      regions,
      merged,
      stats,
      findings: ctx.findings,
      resolvedText: ctx.resolvedText,
      params: resolveParamsEcho(input.params, ctx.resolvedText),
    };
  } finally {
    arena.dispose();
  }
}

/**
 * The `PrintParams` echoed on `EngineResult.params`, and from there into every
 * export's persisted `print_params` (the .3mf metadata, the sidecar JSON):
 * every `{city}`-style token already substituted, agreeing with `resolvedText`
 * above, instead of the raw input still carrying the token. A line this bake
 * skipped (frame off, an empty token, a refusal) is dropped rather than left
 * showing text nothing was cut for -- the same rule `lib/bake.ts`'s removed
 * client-side `resolveParamsForBake` used, now applied from the engine's own
 * resolution instead of the client's prediction, so the two can never
 * disagree. See DECISIONS `[V3-P2-E4]`.
 *
 * Mirrors `buildLettering`'s own id scheme (`solid/lettering.ts`) without
 * importing its private split: an engraving on a frame edge is
 * `engraving-<i>`, one on the underside is `underside-<i>`, each `i` counted
 * within its own kind, in array order -- exactly what that function assigns.
 */
function resolveParamsEcho(params: PrintParams, resolvedText: readonly ResolvedLine[]): PrintParams {
  const all = params.engravings ?? [];
  let edgeCursor = 0;
  let undersideCursor = 0;
  const engravings: Engraving[] = [];
  for (const engraving of all) {
    const id =
      engraving.edge === "underside" ? `underside-${undersideCursor++}` : `engraving-${edgeCursor++}`;
    const line = resolvedText.find((l) => l.id === id);
    if (line !== undefined && line.status === "cuts") {
      engravings.push({ ...engraving, text: line.text });
    }
  }

  const mark = params.underside_mark;
  const markLine = resolvedText.find((l) => l.id === "underside-mark");
  const underside_mark =
    mark?.enabled === true
      ? markLine?.status === "cuts"
        ? { ...mark, template: markLine.text }
        : { ...mark, enabled: false }
      : mark;

  return { ...params, engravings, underside_mark };
}

/**
 * Prune boolean debris, sit the model at z = 0, and convert to meshes.
 *
 * The translation is computed once, from the union of every region's bounds,
 * and applied to all of them, so the regions cannot drift apart. It is a no-op
 * for a normal bake: the plate is built from z = 0 up and centred on the
 * origin, and nothing but an underside pocket ever reaches below it.
 */
function finishRegions(
  ctx: BakeContext,
  solids: Map<RegionName, Manifold>,
): BuiltRegion[] {
  const { wasm, arena, params } = ctx;
  const cleaned = new Map<RegionName, Manifold>();
  for (const [region, solid] of solids) {
    if (solid.isEmpty()) continue;
    const { solid: pruned } = pruneDebris(wasm, arena, solid);
    if (!pruned.isEmpty()) cleaned.set(region, pruned);
  }

  let minZ = Infinity;
  for (const solid of cleaned.values()) {
    minZ = Math.min(minZ, solid.boundingBox().min[2]);
  }
  const shift = Number.isFinite(minZ) && Math.abs(minZ) > SIT_EPS_MM ? -minZ : 0;

  const out: BuiltRegion[] = [];
  for (const region of REGION_NAMES) {
    const solid = cleaned.get(region);
    if (solid === undefined) continue;
    const placed = shift === 0 ? solid : arena.keep(solid.translate([0, 0, shift]));
    if (placed !== solid) arena.drop(solid);
    const bodies = countBodies(placed);
    out.push({
      solid: placed,
      bodies,
      mesh: toRegionMesh(
        placed,
        region,
        regionSlot(params, colourTwin(params, region)),
        regionColor(params, colourTwin(params, region)),
        bodies.real + bodies.debris,
      ),
    });
  }
  return out;
}

/**
 * The region whose slot and colour this one borrows.
 *
 * A hero is always split into its own region so it CAN be coloured, but
 * `hero_mode` decides whether it actually is: without `own_color` it prints in
 * the buildings filament, which is exactly what the same parameter set does in
 * the reference implementation (DECISIONS `[V3-P2-E2]`).
 */
function colourTwin(params: EngineInput["params"], region: RegionName): RegionName {
  if (region === "hero_building" && !T.hero_own_color(params)) return "buildings";
  return region;
}

/** Report the heroes the repair could not honour, one finding each. */
function reportHeroes(
  ctx: BakeContext,
  unknown: readonly string[],
  buried: readonly string[],
  dropped: readonly string[],
): void {
  if (unknown.length > 0) {
    ctx.warnings.push(
      `${unknown.length} hero building id(s) are not in this scene: ${unknown.join(", ")}`,
    );
  }
  if (buried.length > 0) {
    addFinding(
      ctx,
      finding(
        "hero-buried",
        "warning",
        `${buried.length} hero building(s) are shorter than their block`,
        `They merged into a taller block and cannot be shown separately: ${buried.join(", ")}.`,
        "hero_building",
      ),
    );
  }
  if (dropped.length > 0) {
    addFinding(
      ctx,
      finding(
        "hero-dropped",
        "warning",
        `${dropped.length} hero building(s) were dropped`,
        "The minimum-feature repair removed them: they are smaller than this nozzle can " +
          `print at this scale (${dropped.join(", ")}).`,
        "hero_building",
      ),
    );
  }
}

/** The `merged` mesh for a scene with nothing in it at all. */
function emptyRegionMesh(): RegionMesh {
  return {
    region: "base",
    positions: new Float64Array(0),
    indices: new Uint32Array(0),
    volumeMm3: 0,
    bbox: { min: [0, 0, 0], max: [0, 0, 0] },
    bodies: 0,
    slot: 1,
    colorHex: "#D8D3C6",
  };
}

/** Findings a caller can show without running a bake. Re-exported for the UI. */
export type { AuditFinding, EngineResult, RegionMesh };
