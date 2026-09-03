/**
 * THE ordered stage registry.
 *
 * Every stage of the build, in execution order, each declaring the parameter
 * leaves it reads, the extras it reads and the upstream outputs it consumes.
 * The order is the topological order: a stage may only name inputs declared
 * above it, which `graph.ts` checks at module load. The `region-*` and
 * `finish-*` stages are generated from `REGION_NAMES`, interleaved per region
 * so the base is finished and posted before the next region is built
 * (progressive delivery, design ruling 3).
 *
 * The geometry is the old `engine.ts` traversal step for step (the inventory's
 * table, `docs/handoff/v3-01-inventory.md` section 1), cut at the places where
 * a cache boundary buys something. Two structural points worth knowing:
 *
 * - The four surface layers are three pass-one stages (the repaired footprints,
 *   each blocked by the ones before it) and a fourth, `surface-parks`, that
 *   repairs its own layer, merges the base ridges and EXTRUDES all four. The
 *   ridge merge needs to know which recessed layers exist, which is only known
 *   once every layer has been repaired, and extrusion is milliseconds; the
 *   expensive repair of each layer stays in its own stage.
 * - `lettering` does not depend on `attribution`: the underside reserve it lays
 *   out around is a pure layout both compute, so the registry keeps the old
 *   traversal's order (lettering, ornaments, attribution) and the resolved text
 *   comes out in the order it always did.
 */

import { perfSpan } from "../../perf";
import * as T from "../../transform";
import { autoHeroIds, heroCandidates } from "../../heroes";
import { textTokenContext } from "../../previewText";
import { expand_tokens } from "../../tokens";
import { resolveProfile } from "../../printers";
import { auditPrintability } from "../audit/rules";
import { buildSidecarJson } from "../export/common";
import { exportForTarget } from "../export/index";
import type { OverpassResponse } from "../osm/normalize";
import { sceneFromOverpass } from "../osm/scene";
import { fetchOverpass, type OverpassFetchError } from "../osm/overpass";
import type { EngineBuilding } from "../osm/types";
import { samplerFromGrid, smoothGrid } from "../terrain/heightfield";
import {
  SURFACE_ORDER,
  buildSurfaceRegion,
  fittedSolid,
  grownPocket,
  mergeRecessRidges,
  solidBottomMm,
  type RepairedSurface,
  type SurfaceRegion,
} from "../solid/areas";
import { buildAttribution, undersideReserveMm, undersideSkipBands } from "../solid/attribution";
import { buildPlate, carveBase, cutterTopMm } from "../solid/base";
import { buildBridges } from "../solid/bridges";
import { buildBuildings } from "../solid/buildings";
import { addFinding, finding, makeContext, regionColor, regionSlot, type BuildContext } from "../solid/context";
import { LOW_RELIEF_MM, drapeSolid, makeDrape, type Drape } from "../solid/drape";
import {
  buildFrameLip,
  buildFrameMating,
  buildFrameTexture,
  buildMatting,
  buildShadowGap,
  frameBottomMm,
  lipTopMm,
  reportNarrowTextBand,
  reportUnbuiltFrameStyle,
} from "../solid/frame";
import { buildHangers } from "../solid/hangers";
import { buildLettering, facesFor, loadFaces } from "../solid/lettering";
import {
  UNION_DEBRIS_MM3,
  batchedUnion,
  extrudeSection,
  pruneDebrisCounted,
  subtractSolids,
  toRegionMesh,
  type Manifold,
} from "../solid/manifold";
import { measureMinWall, regionBounds, triangleCount } from "../solid/measure";
import { buildOrnaments } from "../solid/ornaments";
import { repairBuildings } from "../solid/repair";
import { reportRoadModeConflict } from "../solid/roads";
import { buildTiles, tileGridSpec, type TileSource } from "../solid/tiling";
import { buildTrees } from "../solid/trees";
import { canonicalMesh } from "../solid/mesh";
import { islandReport, validate, type BuiltRegion } from "../solid/validate";
import { hashBytes, hashParts } from "./hash";
import type { AuditFinding, EngineStats, RegionMesh, RegionName } from "../types";
import { REGION_NAMES } from "../types";
import {
  defineStage,
  finishStageId,
  regionStageId,
  type FinishStageId,
  type RecessBand,
  type RegionStageId,
  type StageContext,
  type StageDef,
  type StageId,
} from "./stage";

/** How far the assembly may sit off z = 0 before it is nudged back, mm. */
export const SIT_EPS_MM = 1e-9;

/**
 * The eight placement leaves `areas.placementFor` reads for the four surface
 * layers: what every stage that asks how deep the deepest recess is depends
 * on (`lettering.deepestRecessMm`, `ornaments`, the underside marks, the
 * min-wall skip bands, the tile sliver search). `regions.rail.width_m` and
 * `regions.building_skirt_mm` are not among them.
 */
const PLACEMENT_LEAVES = [
  "regions.roads.depth_mm",
  "regions.roads.proud_mm",
  "regions.water.depth_mm",
  "regions.water.proud_mm",
  "regions.parks.depth_mm",
  "regions.parks.proud_mm",
  "regions.rail.depth_mm",
  "regions.rail.proud_mm",
] as const;

/** Thrown by `fetch` when Overpass fails soft; the runner turns it into an `error` event carrying the typed error. */
export class OverpassStageError extends Error {
  readonly overpass: OverpassFetchError;
  constructor(error: OverpassFetchError) {
    super(error.message);
    this.name = "OverpassStageError";
    this.overpass = error;
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by several stages
// ---------------------------------------------------------------------------

/** The region whose slot and colour this one borrows (`engine.ts:colourTwin`). */
function colourTwin(ctx: StageContext, region: RegionName): RegionName {
  if (region === "hero_building" && !T.hero_own_color(ctx.params)) return "buildings";
  return region;
}

/** Bounding-box Z range of a cutter, clipped to `[low, high]`; null when nothing survives. */
function bandOf(cutter: Manifold, low: number, high: number): [number, number] | null {
  const box = cutter.boundingBox();
  const lo = Math.max(box.min[2], low);
  const hi = Math.min(box.max[2], high);
  return hi > lo ? [lo, hi] : null;
}

function bandsOf(
  cutters: readonly Manifold[],
  region: RegionName,
  kind: RecessBand["kind"],
  low: number,
  high: number,
): RecessBand[] {
  const out: RecessBand[] = [];
  for (const cutter of cutters) {
    const band = bandOf(cutter, low, high);
    if (band !== null) out.push({ region, kind, zMm: band });
  }
  return out;
}

/**
 * A content digest for a list of cutter solids: the constant `none` for an
 * empty list, else the hash of every solid's canonically ordered mesh. Exact,
 * because two solids with the same mesh are the same solid, and cheap for the
 * cutters this is used on (text pockets, a keyhole, a snap ridge); a mesh with
 * extra vertex properties (nothing in this engine makes one) falls back to the
 * whole output's digest rather than being misread.
 */
function solidsDigest(solids: readonly (Manifold | null)[]): string | null {
  const live = solids.filter((solid): solid is Manifold => solid !== null && !solid.isEmpty());
  if (live.length === 0) return "none";
  const parts: string[] = [];
  for (const solid of live) {
    const mesh = solid.getMesh();
    if (mesh.numProp !== 3) return null;
    const ordered = canonicalMesh({ positions: Float64Array.from(mesh.vertProperties), indices: new Uint32Array(mesh.triVerts) });
    parts.push(hashBytes(new Uint8Array(ordered.positions.buffer)), hashBytes(new Uint8Array(ordered.indices.buffer)));
  }
  return hashParts(parts);
}

/** The finished regions in `REGION_NAMES` order, read from the finish stages a stage declared. */
function builtRegions(ctx: StageContext): BuiltRegion[] {
  const out: BuiltRegion[] = [];
  for (const region of REGION_NAMES) {
    const built = ctx.input(finishStageId(region));
    if (built !== null) out.push(built);
  }
  return out;
}

/** Report the heroes the repair could not honour, one finding each (`engine.ts:reportHeroes`). */
function reportHeroes(ctx: BuildContext, unknown: readonly string[], buried: readonly string[], dropped: readonly string[]): void {
  if (unknown.length > 0) {
    addFinding(
      ctx,
      finding(
        "hero-unknown",
        "warning",
        `${unknown.length} hero building id(s) are not in this scene`,
        "They were ignored. A share link or a saved project can carry ids from " +
          `another location, or from before this area was re-fetched: ${unknown.join(", ")}.`,
        "hero_building",
      ),
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

/** Say so when the hillside is there but too small to see (`engine.ts:reportRelief`). */
function reportRelief(ctx: BuildContext, drape: Drape | null): void {
  if (drape === null || drape.reliefMm >= LOW_RELIEF_MM) return;
  addFinding(ctx, {
    id: "terrain-low-relief",
    severity: "info",
    title: "Terrain will be barely visible",
    detail:
      `The ground rises ${drape.reliefMm.toFixed(2)} mm across the whole plate at this ` +
      `scale, against ${LOW_RELIEF_MM.toFixed(1)} mm for two printed layers. It is in the ` +
      "model, but it will read as flat.",
    region: "base",
    fix: {
      label: "Double the terrain exaggeration",
      safe: true,
      patch: { terrain_exaggeration: Math.min(3, ctx.params.terrain_exaggeration * 2) },
    },
  });
}

const SURFACE_STAGE: Record<(typeof SURFACE_ORDER)[number], "surface-water" | "surface-rail" | "surface-roads" | "surface-parks"> = {
  water: "surface-water",
  rail: "surface-rail",
  roads: "surface-roads",
  parks: "surface-parks",
};

// ---------------------------------------------------------------------------
// Scene phase
// ---------------------------------------------------------------------------

const fetch = defineStage({
  id: "fetch",
  phase: "scene",
  params: [],
  inputs: [],
  extra: ["scene-request"],
  async run(ctx) {
    const request = ctx.extra("scene-request");
    if (request === null) throw new Error("fetch: the job carries a finished scene, so the runner should have skipped this stage");
    const fetched = await perfSpan("overpass.fetch", () => fetchOverpass(request, ctx.overpass));
    if (!fetched.ok) throw new OverpassStageError(fetched.error);
    return { raw: fetched.data as OverpassResponse, fromCache: fetched.fromCache };
  },
});

const normalise = defineStage({
  id: "normalise",
  phase: "scene",
  params: ["heights.*"],
  inputs: ["fetch"],
  extra: ["scene-request"],
  run(ctx) {
    const request = ctx.extra("scene-request");
    if (request === null) throw new Error("normalise: the job carries a finished scene, so the runner should have seeded this stage");
    const raw = ctx.input("fetch").raw;
    const scene = perfSpan("osm.normalize", () => sceneFromOverpass(raw, request, ctx.params));
    return { scene };
  },
});

// ---------------------------------------------------------------------------
// Geometry phase
// ---------------------------------------------------------------------------

const context = defineStage({
  id: "context",
  phase: "geometry",
  params: [
    "plate_mm",
    "base_thickness_mm",
    "nozzle_mm",
    "frame",
    "frame_style.shadow_gap.enabled",
    "frame_style.shadow_gap.width_mm",
    "frame_style.matting.enabled",
    "frame_style.matting.width_mm",
    { path: "frame_style.profile", label: "floating", key: (value) => value === "floating" },
  ],
  inputs: ["normalise"],
  run(ctx) {
    const built = makeContext({ wasm: ctx.wasm, arena: ctx.arena, scene: ctx.scene, params: ctx.params, terrain: null });
    return {
      scale: built.scale,
      radiusM: built.radiusM,
      thresholdsMm: built.thresholdsMm,
      thresholdsGroundM: built.thresholdsGroundM,
      baseTopMm: built.baseTopMm,
      plateHalfMm: built.plateHalfMm,
      cropHalfMm: built.cropHalfMm,
      recessClipHalfMm: built.recessClipHalfMm,
    };
  },
});

const terrain = defineStage({
  id: "terrain",
  phase: "geometry",
  params: ["terrain.enabled", "terrain.smoothing", "terrain_exaggeration"],
  inputs: ["context"],
  extra: ["terrain-grid"],
  run(ctx) {
    const given = ctx.extra("terrain-grid");
    // The store gates the grid on `terrain.enabled` today and the worker gates
    // it again here, so the switch is a worker-side parameter; a grid handed
    // straight to `buildModel()` (tests, the CLI's `--terrain`) is authoritative.
    const gated = given === null || given.gate === "always" || ctx.param("terrain.enabled") === true ? given?.grid ?? null : null;
    // Smoothing is applied HERE, once, to a grid that says how many passes it
    // already carries (`fetchTerrainGrid` stamps 0); a grid with no stamp is
    // taken as final, which is what every direct caller means by it.
    const wanted = ctx.param("terrain.smoothing") ?? 1;
    const grid =
      gated !== null && gated.smoothing !== undefined && wanted > gated.smoothing
        ? smoothGrid(gated, wanted - gated.smoothing)
        : gated;
    const sampler = samplerFromGrid(grid);
    const build = ctx.buildWith(sampler);
    const drape = makeDrape(build);
    reportRelief(build, drape);
    return { sampler, drape };
  },
});

const heroes = defineStage({
  id: "heroes",
  phase: "geometry",
  params: ["hero_building_ids", "hero_auto.enabled", "hero_auto.count"],
  inputs: ["normalise"],
  extra: ["hero-ids"],
  run(ctx) {
    const override = ctx.extra("hero-ids");
    if (override !== null) return { ids: [...override] };
    const manual = (ctx.param("hero_building_ids") ?? []).map((id) => String(id));
    if (ctx.param("hero_auto.enabled") !== true) return { ids: manual };
    const count = ctx.param("hero_auto.count") ?? 0;
    return { ids: autoHeroIds(heroCandidates(ctx.scene.buildings as EngineBuilding[]), manual, count) };
  },
});

const repairBuildingsStage = defineStage({
  id: "repair-buildings",
  phase: "geometry",
  params: ["small_scale", "large_scale", "hero_mode", "base_thickness_mm"],
  inputs: ["normalise", "context", "heroes"],
  run(ctx) {
    const repaired = repairBuildings(ctx.build, ctx.input("heroes").ids);
    reportHeroes(ctx.build, repaired.heroUnknown, repaired.heroBuried, repaired.heroDropped);
    return repaired;
  },
});

/** Pass one of a surface layer: its repaired footprint, blocked by the layers before it. */
function repairSurfaceLayer(ctx: StageContext, layer: (typeof SURFACE_ORDER)[number]): RepairedSurface | null {
  const footprint = ctx.input("repair-buildings").footprint;
  const blockers: Array<{ section: RepairedSurface["section"] | null; separate: boolean }> = [
    { section: footprint, separate: false },
  ];
  for (const earlier of SURFACE_ORDER) {
    if (earlier === layer) break;
    const built = ctx.input(SURFACE_STAGE[earlier]);
    if (built !== null && !("regions" in built)) blockers.push({ section: built.section, separate: false });
  }
  return buildSurfaceRegion(ctx.build, layer, blockers);
}

const surfaceWater = defineStage({
  id: "surface-water",
  phase: "geometry",
  params: ["water", "regions.water.*"],
  inputs: ["normalise", "context", "repair-buildings"],
  run(ctx) {
    return repairSurfaceLayer(ctx, "water");
  },
});

const surfaceRail = defineStage({
  id: "surface-rail",
  phase: "geometry",
  params: ["regions.rail.*", "bridges.enabled", "road_scale"],
  inputs: ["normalise", "context", "repair-buildings", "surface-water"],
  run(ctx) {
    return repairSurfaceLayer(ctx, "rail");
  },
});

const surfaceRoads = defineStage({
  id: "surface-roads",
  phase: "geometry",
  params: ["road_mode", "road_scale", "regions.roads.*", "bridges.enabled"],
  inputs: ["normalise", "context", "repair-buildings", "surface-water", "surface-rail"],
  run(ctx) {
    reportRoadModeConflict(ctx.build);
    return repairSurfaceLayer(ctx, "roads");
  },
});

const surfaceParks = defineStage({
  id: "surface-parks",
  phase: "geometry",
  params: ["regions.parks.*", "frame"],
  inputs: ["normalise", "context", "repair-buildings", "surface-water", "surface-rail", "surface-roads"],
  run(ctx) {
    const build = ctx.build;
    const parks = repairSurfaceLayer(ctx, "parks");
    // The layers in precedence order, each as its own stage repaired it. The
    // ridge merge below may replace a recessed layer's footprint, so the
    // records are copied first: the upstream outputs stay what they were.
    const repaired: RepairedSurface[] = [];
    for (const layer of SURFACE_ORDER) {
      const built = layer === "parks" ? parks : ctx.input(SURFACE_STAGE[layer]);
      if (built === null || "regions" in built) continue;
      repaired.push({ ...built });
    }
    mergeRecessRidges(build, repaired, ctx.input("repair-buildings").footprint);

    const regions: SurfaceRegion[] = [];
    for (const layer of repaired) {
      const pocket = grownPocket(build, layer.section);
      const fitted = fittedSolid(build, layer.solidSection);
      const solid = extrudeSection(ctx.wasm, ctx.arena, fitted, solidBottomMm(build, layer.placement), layer.placement.topMm);
      const cutter = extrudeSection(ctx.wasm, ctx.arena, pocket, layer.placement.bottomMm, cutterTopMm(build));
      if (solid === null || cutter === null) continue;
      regions.push({
        region: layer.region,
        solid,
        cutter,
        section: layer.section,
        pocket,
        placement: layer.placement,
        dropped: layer.dropped,
      });
    }
    return { regions };
  },
});

const buildings = defineStage({
  id: "buildings",
  phase: "geometry",
  params: [
    "small_scale",
    "large_scale",
    "height_exaggeration.*",
    "regions.building_skirt_mm",
    "base_thickness_mm",
    "colour.gradient.*",
    "colour.tint.*",
    "colour.region_colors.buildings",
    "colour.region_colors.hero_building",
  ],
  inputs: ["context", "terrain", "repair-buildings"],
  digests: { socket: (out) => solidsDigest(out.socket) },
  run(ctx) {
    return buildBuildings(ctx.build, ctx.input("repair-buildings"), ctx.input("terrain").drape);
  },
});

const bridges = defineStage({
  id: "bridges",
  phase: "geometry",
  params: ["bridges.*", "road_mode", "road_scale", "regions.roads.depth_mm", "regions.rail.depth_mm", "regions.rail.width_m"],
  inputs: ["normalise", "context", "terrain", "repair-buildings"],
  run(ctx) {
    return buildBridges(ctx.build, ctx.input("repair-buildings").footprint, ctx.input("terrain").drape);
  },
});

const trees = defineStage({
  id: "trees",
  phase: "geometry",
  params: ["trees", "nozzle_mm"],
  inputs: ["normalise", "context", "terrain", "repair-buildings", "surface-parks"],
  run(ctx) {
    const surfaces = ctx.input("surface-parks").regions;
    return buildTrees(
      ctx.build,
      [ctx.input("repair-buildings").footprint, ...surfaces.filter((s) => s.region !== "parks").map((s) => s.section)],
      ctx.input("terrain").drape,
    );
  },
});

const tokens = defineStage({
  id: "tokens",
  phase: "geometry",
  params: ["city_label", "place.*", "hero_building_ids", "hero_auto.*", "plate_mm", "frame"],
  inputs: ["normalise"],
  extra: ["date"],
  run(ctx) {
    return { tokens: textTokenContext(ctx.scene, ctx.params, ctx.extra("date")) };
  },
});

const fonts = defineStage({
  id: "fonts",
  phase: "geometry",
  params: ["engravings[].edge", "engravings[].font", "frame", "scale_bar.enabled", "tiling.enabled", "tiling.index_mark"],
  inputs: [],
  async run(ctx) {
    await loadFaces(ctx.params);
    return { faces: facesFor(ctx.params) };
  },
});

const lettering = defineStage({
  id: "lettering",
  phase: "geometry",
  params: [
    "engravings[].*",
    "frame",
    "hanger",
    "plate_mm",
    "nozzle_mm",
    "base_thickness_mm",
    "scale_bar.*",
    "north_arrow.*",
    "underside_mark.*",
    "frame_style.*",
    // The underside lines and the inlay pockets budget their depth against
    // the deepest surface recess (`lettering.deepestRecessMm`).
    ...PLACEMENT_LEAVES,
  ],
  inputs: ["context", "tokens", "fonts"],
  extra: ["date", "rotation"],
  // What the base reads of the lettering: the underside lines and the inlay
  // pockets from below. Empty for a frame-edge-only text, which is what lets a
  // text change leave the base (and its finish) cached.
  digests: { base: (out) => solidsDigest(out.baseCut) },
  run(ctx) {
    const build = ctx.build;
    const tokenContext = ctx.input("tokens").tokens;
    const expand = (text: string): string => expand_tokens(text, tokenContext);
    const reserve = undersideReserveMm(build, ctx.extra("date"), expand);
    const geometry = buildLettering(build, tokenContext, ctx.extra("rotation"), reserve);
    const lipTop = lipTopMm(build);
    const frameBottom = frameBottomMm(build);
    return {
      ...geometry,
      recessBands: [
        ...bandsOf([...geometry.frameCut, ...geometry.inlayCut], "frame", "lettering", frameBottom, lipTop),
        ...bandsOf(geometry.baseCut, "base", "lettering", 0, build.baseTopMm),
      ],
    };
  },
});

const ornaments = defineStage({
  id: "ornaments",
  phase: "geometry",
  // The arrow and the bar are laid out by `lettering` (one layout, never two);
  // this stage reads what it takes to cut them into the lip and the underside.
  params: ["hanger", "base_thickness_mm", "plate_mm", "frame", "nozzle_mm", "frame_style.*", ...PLACEMENT_LEAVES],
  inputs: ["context", "lettering"],
  digests: { base: (out) => solidsDigest(out.baseCut) },
  run(ctx) {
    const build = ctx.build;
    const geometry = buildOrnaments(build, ctx.input("lettering").layout);
    return {
      ...geometry,
      recessBands: [
        ...bandsOf(geometry.frameCut, "frame", "ornament", frameBottomMm(build), lipTopMm(build)),
        ...bandsOf(geometry.baseCut, "base", "ornament", 0, build.baseTopMm),
      ],
    };
  },
});

const attribution = defineStage({
  id: "attribution",
  phase: "geometry",
  params: ["frame", "hanger", "underside_mark.*", "base_thickness_mm", "plate_mm", "nozzle_mm", "frame_style.*", ...PLACEMENT_LEAVES],
  inputs: ["context", "tokens", "fonts"],
  extra: ["date"],
  digests: { base: (out) => solidsDigest(out.baseCut), frame: (out) => solidsDigest(out.frameCut) },
  run(ctx) {
    const tokenContext = ctx.input("tokens").tokens;
    const expand = (text: string): string => expand_tokens(text, tokenContext);
    return buildAttribution(ctx.build, ctx.extra("date"), expand);
  },
});

const hangers = defineStage({
  id: "hangers",
  phase: "geometry",
  params: ["hanger", "base_thickness_mm", "plate_mm", "road_mode", "water"],
  inputs: ["context"],
  digests: { base: (out) => solidsDigest(out.baseCut) },
  run(ctx) {
    const build = ctx.build;
    const geometry = buildHangers(build);
    return { ...geometry, recessBands: bandsOf(geometry.baseCut, "base", "underside", 0, build.baseTopMm) };
  },
});

const frameCutters = defineStage({
  id: "frame-cutters",
  phase: "geometry",
  params: [
    "frame",
    "plate_mm",
    "nozzle_mm",
    "base_thickness_mm",
    "frame_style.*",
    "hanger_magnet.*",
    "road_mode",
    "water",
  ],
  inputs: ["context", "lettering"],
  // What the base reads of the frame cutters: the snap ridge, the magnet
  // pockets and the shadow gap. Empty for a plain frame, so a profile or
  // texture change leaves the base cached.
  digests: { base: (out) => solidsDigest([...out.mating.baseAdd, ...out.mating.baseCut, out.shadowGap]) },
  run(ctx) {
    const build = ctx.build;
    const shadowGap = buildShadowGap(build);
    const matting = buildMatting(build);
    const mating = buildFrameMating(build);
    const texture = buildFrameTexture(build, ctx.input("lettering").layout);
    return { shadowGap, matting, mating, texture };
  },
});

const base = defineStage({
  id: "base",
  phase: "geometry",
  params: [],
  inputs: ["context", "terrain", "surface-parks", "buildings", "lettering", "ornaments", "attribution", "hangers", "frame-cutters"],
  // Of these, the base reads only the cutters and the ridge, so it is keyed on
  // those parts: a frame-edge text, an ornament on the lip, a profile change
  // do not re-carve the plate.
  inputDigests: { buildings: "socket", lettering: "base", ornaments: "base", attribution: "base", hangers: "base", "frame-cutters": "base" },
  run(ctx) {
    const build = ctx.build;
    const cutters = ctx.input("frame-cutters");
    const plate = buildPlate(build);
    const withRidge = batchedUnion(ctx.wasm, ctx.arena, [plate, ...cutters.mating.baseAdd]) ?? plate;
    const carved = carveBase(build, withRidge, [
      ...ctx.input("buildings").socket,
      ...ctx.input("surface-parks").regions.map((s) => s.cutter),
      ...ctx.input("lettering").baseCut,
      ...ctx.input("ornaments").baseCut,
      ...ctx.input("attribution").baseCut,
      ...ctx.input("hangers").baseCut,
      ...cutters.mating.baseCut,
      cutters.shadowGap,
    ]);
    // Carve flat, then drape: `warp(plate - cutters)` and `warp(plate) - warp(cutters)`
    // are the same set because the drape is a bijection of space.
    const drape = ctx.input("terrain").drape;
    const solid = drape === null ? carved : (drapeSolid(build, drape, carved, undefined, false) ?? carved);
    return { solid };
  },
});

const frame = defineStage({
  id: "frame",
  phase: "geometry",
  params: ["frame", "plate_mm", "nozzle_mm", "base_thickness_mm", "frame_style.*"],
  inputs: ["context", "lettering", "ornaments", "attribution", "frame-cutters"],
  run(ctx) {
    const build = ctx.build;
    reportUnbuiltFrameStyle(build);
    const letteringOut = ctx.input("lettering");
    const ornamentsOut = ctx.input("ornaments");
    reportNarrowTextBand(
      build,
      letteringOut.frameCut.length + letteringOut.frameAdd.length + letteringOut.inlayCut.length + ornamentsOut.frameCut.length > 0,
    );
    const lip = buildFrameLip(build);
    // Additive first, then the cutters, in the reference implementation's
    // order: an embossed letter has to meet the same engraving cutter the rest
    // of the lip does.
    const raisedFrame = lip === null ? null : (batchedUnion(ctx.wasm, ctx.arena, [lip, ...letteringOut.frameAdd]) ?? lip);
    const cutters = ctx.input("frame-cutters");
    const frameSolid =
      raisedFrame === null
        ? null
        : subtractSolids(ctx.wasm, ctx.arena, raisedFrame, [
            ...letteringOut.frameCut,
            ...letteringOut.inlayCut,
            ...ornamentsOut.frameCut,
            ...ctx.input("attribution").frameCut,
            ...cutters.mating.frameCut,
            cutters.texture,
          ]);
    return { frame: frameSolid, raisedFrame };
  },
});

// ---------------------------------------------------------------------------
// Region phase: one region-* and one finish-* per region, interleaved
// ---------------------------------------------------------------------------

/** What feeds each region's final solid (the inputs of its `region-*` stage). */
function regionInputs(region: RegionName): StageId[] {
  switch (region) {
    case "base":
      return ["base"];
    case "frame":
      return ["frame"];
    case "matting":
      return ["frame-cutters"];
    case "buildings":
    case "hero_building":
      return ["buildings"];
    case "roads":
    case "rail":
      return ["context", "terrain", "surface-parks", "bridges"];
    case "water":
      return ["context", "terrain", "surface-parks"];
    case "parks":
      return ["context", "terrain", "surface-parks", "trees"];
    case "lettering":
      return ["lettering"];
    case "attribution":
      return [];
    case "easel":
    case "cleat":
      return ["hangers"];
    default:
      return ["buildings"];
  }
}

function regionSolid(ctx: StageContext, region: RegionName): Manifold | null {
  switch (region) {
    case "base":
      return ctx.input("base").solid;
    case "frame":
      return ctx.input("frame").frame;
    case "matting":
      return ctx.input("frame-cutters").matting;
    case "hero_building":
      return ctx.input("buildings").hero;
    case "roads":
    case "rail":
    case "water":
    case "parks": {
      const surface = ctx.input("surface-parks").regions.find((s) => s.region === region);
      // Each surface region is warped on its own, which is safe here in a way
      // it was not for the assembly: a region overlaps the base laterally as
      // well as vertically, so the two stay welded through any tessellation
      // disagreement smaller than the region's own depth. A region with no
      // grade layer at all can still exist: a road that is only a bridge, a
      // park that is only its trees.
      let solid: Manifold | null =
        surface === undefined ? null : (drapeSolid(ctx.build, ctx.input("terrain").drape, surface.solid, undefined, false) ?? surface.solid);
      if (region === "roads" || region === "rail") {
        for (const bridge of ctx.input("bridges")) {
          if (bridge.region !== region) continue;
          solid = batchedUnion(ctx.wasm, ctx.arena, [solid, bridge.solid]) ?? solid;
        }
      }
      if (region === "parks") {
        const grove = ctx.input("trees").solid;
        if (grove !== null) solid = batchedUnion(ctx.wasm, ctx.arena, [solid, grove]) ?? solid;
      }
      return solid;
    }
    case "lettering":
      return batchedUnion(ctx.wasm, ctx.arena, ctx.input("lettering").inlay);
    case "attribution":
      return null;
    case "easel":
    case "cleat":
      return ctx.input("hangers").parts.find((part) => part.region === region)?.solid ?? null;
    default: {
      // `buildings` and the gradient bands.
      return ctx.input("buildings").bands.find((band) => band.region === region)?.solid ?? null;
    }
  }
}

function regionStage(region: RegionName): StageDef<RegionStageId> {
  return defineStage({
    id: regionStageId(region),
    phase: "region",
    params: [],
    inputs: regionInputs(region),
    run(ctx) {
      return { solid: regionSolid(ctx, region) };
    },
  });
}

/**
 * The colour leaves a finished region reads (`context.regionSlot` and
 * `regionColor` on the region or its twin), measured with the strict proxy:
 *
 * - `buildings` is gradient band 1, so it reads `colour.gradient.*` and, with
 *   the gradient on, the hero colour it ramps towards; band N (2 and up) exists
 *   only with the gradient on, when the slot comes from `gradient.slots`, so
 *   it never reads `region_slots.buildings`.
 * - `hero_building` borrows `buildings` unless `hero_mode` is `own_color`.
 * - `easel` and `cleat` print in the base filament.
 * - `attribution` has no solid today (the marks are cuts, not an inlay), so
 *   its finish stage is always null and reads nothing; its two colour leaves
 *   are therefore claimed by no stage (see the graph test).
 */
function finishClaims(region: RegionName): StageDef["params"] {
  const claim = (path: string): StageDef["params"][number] => path as StageDef["params"][number];
  if (region === "attribution") return [];
  if (region === "easel" || region === "cleat") return [claim("colour.region_slots.base"), claim("colour.region_colors.base")];
  if (region === "hero_building") {
    return [
      "hero_mode",
      claim("colour.region_slots.hero_building"),
      claim("colour.region_colors.hero_building"),
      claim("colour.region_slots.buildings"),
      claim("colour.region_colors.buildings"),
      "colour.gradient.*",
    ];
  }
  if (region === "buildings") {
    return [claim("colour.region_slots.buildings"), claim("colour.region_colors.buildings"), claim("colour.region_colors.hero_building"), "colour.gradient.*"];
  }
  if (region.startsWith("buildings_band_")) {
    return [claim("colour.region_colors.buildings"), claim("colour.region_colors.hero_building"), "colour.gradient.*"];
  }
  return [claim(`colour.region_slots.${region}`), claim(`colour.region_colors.${region}`)];
}

const sit = defineStage({
  id: "sit",
  phase: "region",
  params: [],
  inputs: ["region-base", "hangers"],
  run(ctx) {
    let minZ = Infinity;
    const baseSolid = ctx.input("region-base").solid;
    if (baseSolid !== null && !baseSolid.isEmpty()) minZ = Math.min(minZ, baseSolid.boundingBox().min[2]);
    for (const part of ctx.input("hangers").parts) {
      if (!part.solid.isEmpty()) minZ = Math.min(minZ, part.solid.boundingBox().min[2]);
    }
    return { shiftMm: Number.isFinite(minZ) && Math.abs(minZ) > SIT_EPS_MM ? -minZ : 0 };
  },
});

function finishStage(region: RegionName): StageDef<FinishStageId> {
  return defineStage({
    id: finishStageId(region),
    phase: "region",
    params: finishClaims(region),
    inputs: [regionStageId(region), "sit"],
    run(ctx) {
      const solid = ctx.input(regionStageId(region)).solid;
      if (solid === null || solid.isEmpty()) return null;
      const pruned = perfSpan("finish.prune", () => pruneDebrisCounted(ctx.wasm, ctx.arena, solid));
      if (pruned.solid.isEmpty()) return null;
      const shift = ctx.input("sit").shiftMm;
      const placed = shift === 0 ? pruned.solid : ctx.arena.keep(pruned.solid.translate([0, 0, shift]));
      const twin = colourTwin(ctx, region);
      const mesh = perfSpan("finish.mesh", () =>
        toRegionMesh(placed, region, regionSlot(ctx.params, twin), regionColor(ctx.params, twin), pruned.bodies.real + pruned.bodies.debris),
      );
      return { solid: placed, bodies: pruned.bodies, mesh };
    },
  });
}

// ---------------------------------------------------------------------------
// Audit phase
// ---------------------------------------------------------------------------

const assembly = defineStage({
  id: "assembly",
  phase: "audit",
  params: [],
  inputs: [
    "context",
    "terrain",
    "surface-parks",
    "buildings",
    "bridges",
    "trees",
    "lettering",
    "ornaments",
    "attribution",
    "hangers",
    "frame-cutters",
    "frame",
  ],
  run(ctx) {
    const build = ctx.build;
    const { wasm, arena } = ctx;
    const drape = ctx.input("terrain").drape;
    const cutters = ctx.input("frame-cutters");
    const letteringOut = ctx.input("lettering");
    const ornamentsOut = ctx.input("ornaments");
    const attributionOut = ctx.input("attribution");
    const hangersOut = ctx.input("hangers");
    const buildingsOut = ctx.input("buildings");
    const frameOut = ctx.input("frame");

    // NOT a union of the finished regions: the reference implementation's own
    // recipe, the additive primitives unioned and only the visible part of each
    // recess subtracted (`engine.ts`'s long comment, `[V3-P3-G7]`). The plate
    // is built afresh here: a fresh plate is byte-identical to the one the
    // base was carved from, and the carved one belongs to another stage.
    const plate = buildPlate(build);
    const assemblyPlate = batchedUnion(wasm, arena, [plate, ...cutters.mating.baseAdd]) ?? plate;
    const additive: Manifold[] = [assemblyPlate];
    if (frameOut.raisedFrame !== null) additive.push(frameOut.raisedFrame);
    if (cutters.matting !== null) additive.push(cutters.matting);
    const rigid: Manifold[] = [];
    for (const band of buildingsOut.bands) rigid.push(band.solid);
    if (buildingsOut.hero !== null) rigid.push(buildingsOut.hero);
    const standing: Manifold[] = [];
    for (const bridge of ctx.input("bridges")) standing.push(bridge.solid);
    const grove = ctx.input("trees").solid;
    if (grove !== null) standing.push(grove);
    for (const part of hangersOut.parts) standing.push(part.solid);
    const grooves: Manifold[] = [];
    for (const surface of ctx.input("surface-parks").regions) {
      if (surface.placement.topMm > build.baseTopMm) {
        additive.push(surface.solid);
      } else if (surface.placement.topMm < build.baseTopMm) {
        const groove = extrudeSection(wasm, arena, surface.pocket, surface.placement.topMm, cutterTopMm(build));
        if (groove !== null) grooves.push(groove);
      }
    }
    const raised = batchedUnion(wasm, arena, [...additive, ...(drape === null ? rigid : [])]);
    const carvedAssembly =
      raised === null
        ? null
        : subtractSolids(wasm, arena, raised, [
            ...grooves,
            ...letteringOut.frameCut,
            ...ornamentsOut.frameCut,
            ...attributionOut.frameCut,
            ...letteringOut.baseCut,
            ...ornamentsOut.baseCut,
            ...attributionOut.baseCut,
            ...hangersOut.baseCut,
            ...cutters.mating.frameCut,
            ...cutters.mating.baseCut,
            cutters.shadowGap,
            cutters.texture,
          ]);
    const welded =
      carvedAssembly === null
        ? null
        : batchedUnion(wasm, arena, [
            drape === null ? carvedAssembly : (drapeSolid(build, drape, carvedAssembly, undefined, false) ?? carvedAssembly),
            ...(drape === null ? [] : rigid),
            ...standing,
          ]);
    return { assembly: welded };
  },
});

const merged = defineStage({
  id: "merged",
  phase: "audit",
  params: ["colour.region_slots.base", "colour.region_colors.base"],
  inputs: ["assembly", "sit"],
  run(ctx) {
    const welded = ctx.input("assembly").assembly;
    if (welded === null) {
      return {
        clean: null,
        mesh: {
          region: "base",
          positions: new Float64Array(0),
          indices: new Uint32Array(0),
          volumeMm3: 0,
          bbox: { min: [0, 0, 0], max: [0, 0, 0] },
          bodies: 0,
          slot: 1,
          colorHex: "#D8D3C6",
        },
      };
    }
    const pruned = perfSpan("merged.prune", () => pruneDebrisCounted(ctx.wasm, ctx.arena, welded, UNION_DEBRIS_MM3));
    const shift = ctx.input("sit").shiftMm;
    const clean = shift === 0 ? pruned.solid : ctx.arena.keep(pruned.solid.translate([0, 0, shift]));
    const mesh = perfSpan("merged.mesh", () =>
      toRegionMesh(clean, "base", regionSlot(ctx.params, "base"), regionColor(ctx.params, "base"), pruned.bodies.real),
    );
    return { clean, mesh };
  },
});

const measure = defineStage({
  id: "measure",
  phase: "audit",
  params: ["nozzle_mm", "terrain_exaggeration", "hanger", "base_thickness_mm", "frame", "underside_mark.enabled", ...PLACEMENT_LEAVES],
  inputs: ["context", "terrain", "assembly"],
  run(ctx) {
    const welded = ctx.input("assembly").assembly;
    if (welded === null) return null;
    return measureMinWall(ctx.build, welded, undersideSkipBands(ctx.build));
  },
});

const ALL_FINISH_IDS: readonly FinishStageId[] = REGION_NAMES.map((region) => finishStageId(region));

const validateStage = defineStage({
  id: "validate",
  phase: "audit",
  // `large_scale`, `terrain_exaggeration` and `frame` are read only on the
  // failing branches (the height and thin-wall fixes, the bigger-plate advice).
  params: ["plate_mm", "nozzle_mm", "large_scale", "terrain_exaggeration", "printer_profile", "custom_profile.*", "frame"],
  // `normalise` for the bigger-plate advice, which walks the scene's footprints.
  inputs: ["normalise", "context", "terrain", "assembly", "measure", ...ALL_FINISH_IDS],
  run(ctx) {
    const minWall = ctx.input("measure") ?? { measuredMm: null, atZMm: null, slices: 0, thinRegions: 0 };
    return validate(ctx.build, builtRegions(ctx), ctx.input("assembly").assembly, minWall);
  },
});

const islands = defineStage({
  id: "islands",
  phase: "audit",
  // `expectedBodies` runs only when the assembly is more than one body.
  params: ["hanger", "frame", "frame_style.*"],
  inputs: ["context", "merged", ...ALL_FINISH_IDS],
  run(ctx) {
    return islandReport(ctx.build, ctx.input("merged").clean, builtRegions(ctx));
  },
});

const tiling = defineStage({
  id: "tiling",
  phase: "audit",
  params: ["tiling.*", "frame", "base_thickness_mm", "nozzle_mm", ...PLACEMENT_LEAVES],
  inputs: ["context", "merged", "attribution", ...ALL_FINISH_IDS],
  run(ctx) {
    const sources: TileSource[] = builtRegions(ctx).map((region) => ({
      region: region.mesh.region,
      solid: region.solid,
      slot: region.mesh.slot,
      colorHex: region.mesh.colorHex,
    }));
    return buildTiles(ctx.build, sources, ctx.input("merged").clean);
  },
});

const audit = defineStage({
  id: "audit",
  phase: "audit",
  // `plate_mm`, `trees` and `bridges.enabled` are read on the failing
  // branches (a plate past the profile, an island's one-click fix).
  params: [
    "plate_mm",
    "nozzle_mm",
    "frame",
    "trees",
    "bridges.enabled",
    "tiling.*",
    "printer_profile",
    "custom_profile.*",
    "frame_style.profile",
    "colour.region_slots.*",
  ],
  inputs: [
    "normalise",
    "context",
    "terrain",
    "repair-buildings",
    "buildings",
    "bridges",
    "trees",
    "merged",
    "measure",
    "validate",
    "islands",
    "tiling",
    ...ALL_FINISH_IDS,
  ],
  run(ctx) {
    const built = builtRegions(ctx);
    const regions: RegionMesh[] = built.map((region) => region.mesh);
    const bounds = regionBounds(regions);
    const repaired = ctx.input("repair-buildings");
    const buildingsOut = ctx.input("buildings");
    const treesOut = ctx.input("trees");
    const bridgesOut = ctx.input("bridges");
    const drape = ctx.input("terrain").drape;
    const tiles = ctx.input("tiling");
    const grid = tileGridSpec(ctx.params);
    const minWall = ctx.input("measure");
    const mergedOut = ctx.input("merged");
    const stats: EngineStats = {
      scaleDenominator: 1000 / ctx.input("context").scale,
      minWallMm: T.min_wall_mm(ctx.params),
      measuredMinWallMm: minWall?.measuredMm ?? null,
      buildings: buildingsOut.count,
      buildingsMerged: repaired.merged,
      buildingsDilated: repaired.dilated,
      heightFallbacks: repaired.heightFallbacks,
      triangles: triangleCount(regions),
      widthMm: bounds === null ? 0 : bounds.max[0] - bounds.min[0],
      depthMm: bounds === null ? 0 : bounds.max[1] - bounds.min[1],
      heightMm: bounds === null ? 0 : bounds.max[2] - bounds.min[2],
      elapsedMs: ctx.elapsedMs(),
      ...(drape === null ? {} : { terrainReliefMm: drape.reliefMm }),
      ...(treesOut.kept > 0 || treesOut.dropped > 0 || treesOut.blocked > 0
        ? { trees: treesOut.kept, treesDropped: treesOut.dropped + treesOut.blocked }
        : {}),
      ...(bridgesOut.length === 0 ? {} : { bridges: bridgesOut.reduce((total, b) => total + b.ways, 0) }),
      ...(grid === null ? {} : { tiles: tiles.length, tileCols: grid.cols, tileRows: grid.rows }),
      ...(buildingsOut.bands.length > 1 ? { gradientBands: buildingsOut.bands.length } : {}),
    };
    // Every finding raised while building, in stage order, then the gate's.
    const builtFindings: AuditFinding[] = [...ctx.findingsBefore(), ...ctx.input("validate")];
    const findings = auditPrintability({
      params: ctx.params,
      scene: ctx.scene,
      radiusM: ctx.input("context").radiusM,
      regions,
      merged: mergedOut.mesh,
      stats,
      built: builtFindings,
      islands: ctx.input("islands"),
      ...(tiles.length === 0 ? {} : { tiles }),
    });
    return { findings, stats };
  },
});

// ---------------------------------------------------------------------------
// Export phase
// ---------------------------------------------------------------------------

const exportStage = defineStage({
  id: "export",
  phase: "export",
  params: ["export_target", "color_mode", "printer_profile", "custom_profile.*", "place.author", "city_label", "colour.palette", "colour.preview_theme", "schema_version"],
  inputs: ["audit", "merged", "tiling", "attribution", "buildings", "lettering", "ornaments", "normalise", ...ALL_FINISH_IDS],
  extra: ["export-request"],
  run(ctx) {
    const request = ctx.extra("export-request");
    if (request === null) throw new Error("export: the job carries no export request");
    const result = ctx.assembled();
    const target = request.target ?? ctx.param("export_target") ?? "bambu-3mf";
    const created = new Date(request.createdIso);
    const label = (ctx.param("city_label") ?? "").trim();
    const stem = request.stem ?? (label !== "" ? label.toLowerCase().replace(/\s+/g, "-") : "framecraft");
    const author = (ctx.param("place.author") ?? "").trim();
    const profile = resolveProfile(ctx.params);
    const palette = ctx.param("colour.palette") ?? null;
    const colorMode = ctx.param("color_mode") ?? "single";
    const output = perfSpan("export.run", () =>
      exportForTarget(result, target, {
        stem,
        title: request.title,
        created,
        source: request.source,
        layerHeightMm: request.layerHeightMm,
        profile,
        colorMode,
        palette,
        ...(author === "" ? {} : { designer: author }),
      }),
    );
    const sidecar = perfSpan("export.sidecar", () =>
      buildSidecarJson({
        result,
        target,
        source: request.source ?? null,
        files: output.files,
        notes: output.notes,
        scene: ctx.scene,
        elapsedS: result.stats.elapsedMs / 1000,
        created,
        printerProfileId: profile.id,
        palette,
        previewTheme: ctx.param("colour.preview_theme") ?? null,
        schemaVersion: ctx.param("schema_version"),
      }),
    );
    return {
      target,
      files: output.files,
      sidecar,
      sidecarName: `${stem}.json`,
      notes: output.notes,
      plan: output.plan,
    };
  },
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

function regionPhase(): StageDef[] {
  const out: StageDef[] = [];
  for (const region of REGION_NAMES) {
    out.push(regionStage(region) as StageDef);
    if (region === "base") out.push(sit as StageDef);
    out.push(finishStage(region) as StageDef);
  }
  return out;
}

export const STAGES: readonly StageDef[] = [
  fetch as StageDef,
  normalise as StageDef,
  context as StageDef,
  terrain as StageDef,
  heroes as StageDef,
  repairBuildingsStage as StageDef,
  surfaceWater as StageDef,
  surfaceRail as StageDef,
  surfaceRoads as StageDef,
  surfaceParks as StageDef,
  buildings as StageDef,
  bridges as StageDef,
  trees as StageDef,
  tokens as StageDef,
  fonts as StageDef,
  lettering as StageDef,
  ornaments as StageDef,
  attribution as StageDef,
  hangers as StageDef,
  frameCutters as StageDef,
  base as StageDef,
  frame as StageDef,
  ...regionPhase(),
  assembly as StageDef,
  merged as StageDef,
  measure as StageDef,
  validateStage as StageDef,
  islands as StageDef,
  tiling as StageDef,
  audit as StageDef,
  exportStage as StageDef,
];

const BY_ID: ReadonlyMap<StageId, StageDef> = new Map(STAGES.map((stage) => [stage.id, stage]));

export function stageById(id: StageId): StageDef {
  const stage = BY_ID.get(id);
  if (stage === undefined) throw new Error(`pipeline: unknown stage ${id}`);
  return stage;
}

export function isStageId(value: string): value is StageId {
  return BY_ID.has(value as StageId);
}
