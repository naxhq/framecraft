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
import { ExportBlockedError, blockingFindings } from "../export/gate";
import { exportForTarget } from "../export/index";
import type { OverpassResponse } from "../osm/normalize";
import { projectOverpass, sceneFromProjected, type ProjectedScene } from "../osm/scene";
import { fetchOverpass, type OverpassFetchError } from "../osm/overpass";
import type { EngineBuilding, EngineSceneGraph } from "../osm/types";
import { samplerFromGrid, smoothGrid } from "../terrain/heightfield";
import {
  SURFACE_ORDER,
  buildOverrideSurfaces,
  buildSurfaceRegion,
  deeperLayers,
  fittedSolid,
  grownPocket,
  mergeRecessRidges,
  solidBottomMm,
  type RepairedSurface,
  type SurfaceRegion,
} from "../solid/areas";
import {
  OVERRIDE_MAX_REGIONS,
  baseOsmIdOfBuilding,
  groupForRegion,
  heroOverrides,
  overrideGroups,
  overrideIndexOf,
  overrideRegionStyle,
  reconcileOverrides,
} from "../solid/overrides";
import { buildAttribution, undersideReserveMm, undersideSkipBands } from "../solid/attribution";
import { buildPlate, carveBase, cutterTopMm } from "../solid/base";
import { buildBridges } from "../solid/bridges";
import { buildBuildings } from "../solid/buildings";
import { attributeTriangleOwners } from "../solid/owners";
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
import {
  applyLabels,
  baseCutters,
  buildLabels,
  groundAdditions,
  groundPiecesFor,
  labelFaces,
  labelMasks,
  roofPiecesFor,
} from "../solid/labels";
import { buildLettering, facesFor, loadFaces } from "../solid/lettering";
import { loadGlyphFace } from "../../fontGlyphs";
import { labelPose } from "../../labelAnchor";
import {
  DEBRIS_MM3,
  UNION_DEBRIS_MM3,
  readMesh,
  batchedUnion,
  extrudeSection,
  pruneDebrisCounted,
  subtractSolids,
  toRegionMesh,
  type CrossSection,
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
import { hashBytes, hashParts, hashString, stableJson } from "./hash";
import type { AuditFinding, EngineStats, RegionMesh, RegionName } from "../types";
import { REGION_NAMES } from "../types";
import {
  defineStage,
  finishStageId,
  regionStageId,
  type FetchOut,
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
 * The colour an override region falls back to, which nothing reachable uses.
 *
 * A region only has a solid when a group claimed it, and a claimed group always
 * resolves a colour, so this is the value of a branch the types need and the
 * program does not take. It is the contract's own `region_colors.base` default,
 * the same literal `merged` uses for an empty scene.
 */
const OVERRIDE_FALLBACK_HEX = "#D8D3C6";

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

/**
 * The scene layers the ground stages read, and nothing else: what the
 * `normalise#ground` part digest stands for.
 *
 * `heights.*` moves a building's `height_m`, `min_height_m` and `is_tall` and
 * nothing outside `buildings` and `stats` (`osm/normalize.ts`: the rules are
 * applied per footprint and the water, green, road, rail and tree emission
 * never reads them). A surface layer, the bridge decks and the grove read only
 * these layers, so they are keyed on this digest and a storey-height change
 * leaves the whole ground of the plate cached (v3-07 section 3's one miss).
 * The runner hands such a stage a view of the scene with every OTHER layer
 * replaced by a getter that throws (`runner.ts:scenePartView`), so a stage
 * keyed on the part cannot quietly read past it.
 */
export const SCENE_GROUND_LAYERS = ["bounds", "center", "roads", "rail", "water", "green", "trees"] as const;

/** The building fields an override reconciliation reads: which objects exist, never how tall they are. */
export const SCENE_BUILDING_IDENTITY = ["id", "osm_id"] as const;

/** What one named part of the scene exposes: whole layers, and optionally the buildings cut down to a few fields. */
export interface ScenePartSpec {
  layers: readonly (keyof EngineSceneGraph)[];
  /** When set, `buildings` is exposed too, each building restricted to these fields. */
  buildingFields?: readonly (keyof EngineSceneGraph["buildings"][number])[];
}

/**
 * Every named part of the scene a stage may key on. `ground` is the six
 * ground stages'; `overrides` is `surface-overrides`', which also has to
 * know which buildings EXIST (`reconcileOverrides` says which override rows
 * name an object outside the crop) and reads nothing else of them.
 */
export const SCENE_PARTS: Readonly<Record<"ground" | "overrides", ScenePartSpec>> = {
  ground: { layers: SCENE_GROUND_LAYERS },
  overrides: { layers: SCENE_GROUND_LAYERS, buildingFields: SCENE_BUILDING_IDENTITY },
};

/**
 * What a reader keyed on a named part of another stage's output is handed:
 * the listed keys, every other key a getter that throws (`runner.inputPartView`).
 * Declared beside the digests so the two cannot drift. A part not listed here
 * is served whole; its digest still stands for what its readers use, but the
 * runner cannot check that they use nothing more.
 */
export const PART_EXPOSURE: Readonly<Record<string, readonly string[]>> = {
  "repair-buildings#footprint": ["footprint"],
  "buildings#overrideBands": ["overrideBands"],
  "buildings#ownerIds": ["ownerIds"],
};

/**
 * A content digest of the ground layers, once per scene object. `JSON.stringify`,
 * not `stableJson`: the normaliser emits every entity with its keys in one
 * fixed order and only finite numbers, strings and booleans in them (an
 * absent optional is `undefined`, which both serialisers treat as absent),
 * and the native serialiser is an order of magnitude faster on a megabyte of
 * coordinates.
 */
const GROUND_DIGESTS = new WeakMap<EngineSceneGraph, string>();

function groundDigest(scene: EngineSceneGraph): string {
  const known = GROUND_DIGESTS.get(scene);
  if (known !== undefined) return known;
  const digest = perfSpan("digest.ground", () => {
    const picked: Partial<Record<(typeof SCENE_GROUND_LAYERS)[number], unknown>> = {};
    for (const layer of SCENE_GROUND_LAYERS) picked[layer] = scene[layer];
    return hashString(JSON.stringify(picked));
  });
  GROUND_DIGESTS.set(scene, digest);
  return digest;
}

/** The ground plus which buildings exist: what `surface-overrides` depends on. */
function overridesDigest(scene: EngineSceneGraph): string {
  const identity = perfSpan("digest.identity", () =>
    hashString(JSON.stringify(scene.buildings.map((building) => SCENE_BUILDING_IDENTITY.map((field) => building[field] ?? null)))),
  );
  return hashParts([groundDigest(scene), identity]);
}

/**
 * A content digest of a cross-section: the constant `none` for nothing, else
 * the polygon lengths and every vertex. Exact, like `solidsDigest`: Clipper2
 * is deterministic, so the same footprints in the same order give the same
 * polygons, and two sections with the same polygons are the same section.
 */
function sectionDigest(section: CrossSection | null): string {
  if (section === null || section.isEmpty()) return "none";
  return perfSpan("digest.section", () => {
    const polygons = section.toPolygons();
    let total = 0;
    for (const polygon of polygons) total += polygon.length;
    const flat = new Float64Array(total * 2);
    const lengths: string[] = [];
    let at = 0;
    for (const polygon of polygons) {
      lengths.push(String(polygon.length));
      for (const [x, y] of polygon) {
        flat[at] = x;
        flat[at + 1] = y;
        at += 2;
      }
    }
    return hashParts([...lengths, hashBytes(new Uint8Array(flat.buffer))]);
  });
}

/**
 * What a ground stage keys on instead of the whole scene and the whole repair:
 * the ground layers, and the footprint the base is socketed with. The repair's
 * footprint is the union of the closed, cropped, widened components, which
 * reads no height (`solid/repair.ts` step 4); the block heights, the stacked
 * towers and the hero bookkeeping live beside it in the same output and are
 * read by `buildings`, `labels` and `audit`, which stay keyed on the whole.
 */
const GROUND_READS = { normalise: "ground", "repair-buildings": "footprint" } as const;

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

/**
 * Say what the per-object overrides did NOT do (v3.1 Task 11).
 *
 * Two silences worth breaking, both raised where they are known, in the stage
 * that resolves the groups, so a memoised build still carries them:
 *
 * - an override whose base OSM id names nothing in this scene. It is kept, not
 *   dropped, because a smaller crop must not destroy a decision a bigger one
 *   recorded, and widening the crop has to bring it back. Info, not a warning:
 *   nothing is wrong with the model.
 * - an override that asked for a printed treatment and did not get one, either
 *   because the four override regions were already spoken for or because it
 *   produced no geometry on this plate (a road that is only a bridge deck). It
 *   prints in its layer's own filament, which is a real difference from what
 *   was asked for, so it is a warning.
 */
function reportOverrides(ctx: StageContext, unbuilt: readonly string[]): void {
  const build = ctx.build;
  const { inactive } = reconcileOverrides(ctx.scene, ctx.params);
  if (inactive.length > 0) {
    addFinding(build, {
      id: "override-unresolved",
      severity: "info",
      title: `${inactive.length} per-object ${inactive.length === 1 ? "change is" : "changes are"} waiting for their object`,
      detail:
        `${inactive.length} ${inactive.length === 1 ? "object was" : "objects were"} given a change ` +
        "that this map area does not reach. They are kept in the project, inactive, and come back " +
        "the moment the area covers them again.",
    });
  }
  const overflow = overrideGroups(ctx.params).overflow.length;
  const unplaced = overflow + unbuilt.length;
  if (unplaced > 0) {
    addFinding(build, {
      id: "override-not-printed",
      severity: "warning",
      title: `${unplaced} per-object ${unplaced === 1 ? "colour is" : "colours are"} printing in the layer's filament`,
      detail:
        (overflow > 0
          ? `${overflow} asked for a filament of their own after all ${OVERRIDE_MAX_REGIONS} per-object ` +
            `slots were taken. ${OVERRIDE_MAX_REGIONS} is the filament count of the default printer, and ` +
            "objects given the SAME colour share one, so re-using a colour you already picked costs nothing. "
          : "") +
        (unbuilt.length > 0
          ? `${unbuilt.length} produced no printed surface here: a road carried entirely on a bridge deck ` +
            "keeps the road region's filament, because the deck is built with the bridge rather than laid " +
            "on the ground."
          : ""),
    });
  }
}

/** The three override counts the stats carry, each absent when it is zero. */
function overrideStats(ctx: StageContext): Partial<EngineStats> {
  const { active, inactive } = reconcileOverrides(ctx.scene, ctx.params);
  const total = active.length + inactive.length;
  if (total === 0) return {};
  const unplaced = overrideGroups(ctx.params).overflow.length + ctx.input("surface-overrides").unbuilt.length;
  return {
    overrides: total,
    ...(inactive.length === 0 ? {} : { overridesUnresolved: inactive.length }),
    ...(unplaced === 0 ? {} : { overridesUnplaced: unplaced }),
  };
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

/**
 * The projected layers of each fetched response, kept beside the response
 * for as long as the `fetch` entry lives.
 *
 * `normalise` claims `heights.*`, correctly: the rules decide every building's
 * height. But they are the LAST step of the ingest and about 5 ms of it; the
 * other 500 to 700 ms on the Chicago Loop (three quarters of it the water
 * and green dissolve) depend on the response and the request only, both of
 * which are the `fetch` key. So the stage projects once per fetch output and
 * applies the rules per run: the same pure function of the same declared
 * inputs, with the height-free part memoised on the input it is a function
 * of. A `WeakMap` on the output object, not a stage of its own, because the
 * stage list is what the HUD, the plan events and the protocol's test seams
 * name, and none of them needs to know (v3-07 section 3, the one miss).
 */
const PROJECTED = new WeakMap<FetchOut, ProjectedScene>();

const normalise = defineStage({
  id: "normalise",
  phase: "scene",
  params: ["heights.*"],
  inputs: ["fetch"],
  extra: ["scene-request"],
  // The ground layers, for the stages that never look at a building; the
  // ground plus the buildings' identity for the override reconciliation.
  digests: { ground: (out) => groundDigest(out.scene), overrides: (out) => overridesDigest(out.scene) },
  run(ctx) {
    const request = ctx.extra("scene-request");
    if (request === null) throw new Error("normalise: the job carries a finished scene, so the runner should have seeded this stage");
    const fetched = ctx.input("fetch");
    const scene = perfSpan("osm.normalize", () => {
      let projected = PROJECTED.get(fetched);
      if (projected === undefined) {
        projected = perfSpan("osm.project", () => projectOverpass(fetched.raw, request));
        PROJECTED.set(fetched, projected);
      }
      return sceneFromProjected(projected, ctx.params);
    });
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

/**
 * The parameter leaves that decide which override belongs to which group, and
 * therefore which region an object prints in.
 *
 * Every stage that partitions objects by group reads exactly these, and no
 * stage reads them for any other reason. `hidden`, `height_scale`, `hero`,
 * `tint` and `width_scale` are NOT here: each is claimed only by the one stage
 * that applies it, so a tint change does not re-run the road repair.
 */
const OVERRIDE_GROUP_LEAVES = [
  "object_overrides[].osm_id",
  "object_overrides[].layer",
  "object_overrides[].slot",
  "object_overrides[].color",
  "object_overrides[].road_mode",
  "object_overrides[].raise_mm",
] as const;

/** What a group's own filament falls back to when the override names none. */
const OVERRIDE_COLOUR_LEAVES = [
  "colour.region_slots.buildings",
  "colour.region_slots.roads",
  "colour.region_slots.water",
  "colour.region_slots.parks",
  "colour.region_colors.buildings",
  "colour.region_colors.roads",
  "colour.region_colors.water",
  "colour.region_colors.parks",
] as const;

const heroes = defineStage({
  id: "heroes",
  phase: "geometry",
  params: [
    "hero_building_ids",
    "hero_auto.enabled",
    "hero_auto.count",
    "object_overrides[].osm_id",
    "object_overrides[].layer",
    "object_overrides[].hero",
  ],
  inputs: ["normalise"],
  extra: ["hero-ids"],
  run(ctx) {
    const override = ctx.extra("hero-ids");
    const base = ((): string[] => {
      if (override !== null) return [...override];
      const manual = (ctx.param("hero_building_ids") ?? []).map((id) => String(id));
      if (ctx.param("hero_auto.enabled") !== true) return manual;
      const count = ctx.param("hero_auto.count") ?? 0;
      return autoHeroIds(heroCandidates(ctx.scene.buildings as EngineBuilding[]), manual, count);
    })();
    // v3.1 Task 11. The per-object marks are applied LAST, including over the
    // caller-resolved `hero-ids` extra: the store resolves that list from
    // `hero_building_ids` and `hero_auto`, which is the same computation this
    // stage would do, and neither of them knows about an override. Marking is
    // by base OSM id, so it is translated back to the scene ids the rest of
    // the build speaks.
    const marks = heroOverrides(ctx.params);
    if (marks.marked.size === 0 && marks.unmarked.size === 0) return { ids: base };
    const ids = new Set(base);
    for (const building of ctx.scene.buildings) {
      const baseId = baseOsmIdOfBuilding(building);
      if (marks.marked.has(baseId)) ids.add(String(building.id));
      if (marks.unmarked.has(baseId)) ids.delete(String(building.id));
    }
    return { ids: [...ids] };
  },
});

const repairBuildingsStage = defineStage({
  id: "repair-buildings",
  phase: "geometry",
  params: [
    "small_scale",
    "large_scale",
    "hero_mode",
    "base_thickness_mm",
    // The stacking decision (a tower taller than its block keeps its own
    // solid) compares printed tops through `T.building_top_mm_for`, which
    // applies the exaggeration first; the footprint union below it does not
    // read it, so `repair-buildings#footprint` leaves the ground cached.
    "height_exaggeration.*",
    "object_overrides[].osm_id",
    "object_overrides[].layer",
    "object_overrides[].hidden",
    "object_overrides[].height_scale",
  ],
  inputs: ["normalise", "context", "heroes"],
  // The footprint the surface layers are blocked by and the base is socketed
  // with; a taller block leaves it where it was.
  digests: { footprint: (out) => sectionDigest(out.footprint) },
  run(ctx) {
    const repaired = repairBuildings(ctx.build, ctx.input("heroes").ids);
    reportHeroes(ctx.build, repaired.heroUnknown, repaired.heroBuried, repaired.heroDropped);
    return repaired;
  },
});

const surfaceOverrides = defineStage({
  id: "surface-overrides",
  phase: "geometry",
  params: [
    ...OVERRIDE_GROUP_LEAVES,
    "object_overrides[].hidden",
    "object_overrides[].width_scale",
    "regions.roads.*",
    "regions.water.*",
    "regions.parks.*",
    "road_scale",
    "bridges.enabled",
    "water",
  ],
  inputs: ["normalise", "context", "repair-buildings"],
  // The override layers are ground layers too (a road, a pond, a park lifted
  // out), and the reconciliation reads which buildings exist: keyed on that
  // part, so a storey-height change leaves them, and everything under them,
  // cached. Its output carries handles when a group is built, so without this
  // one coloured road put every ground stage back on the whole scene's key.
  inputDigests: { normalise: "overrides", "repair-buildings": "footprint" },
  run(ctx) {
    const grouping = overrideGroups(ctx.params);
    if (grouping.groups.length === 0) {
      reportOverrides(ctx, []);
      return { surfaces: [], unbuilt: [] };
    }
    const built = buildOverrideSurfaces(ctx.build, grouping.groups, ctx.input("repair-buildings").footprint);
    const unbuilt = built.unbuilt.map((group) => group.region);
    reportOverrides(ctx, unbuilt);
    return { surfaces: built.surfaces, unbuilt };
  },
});

/** Pass one of a surface layer: its repaired footprint, blocked by the layers before it. */
function repairSurfaceLayer(ctx: StageContext, layer: (typeof SURFACE_ORDER)[number]): RepairedSurface | null {
  const footprint = ctx.input("repair-buildings").footprint;
  const blockers: Array<{ section: RepairedSurface["section"] | null; separate: boolean }> = [
    { section: footprint, separate: false },
  ];
  // The override layers come before every ordinary one: an object the user
  // singled out owns its ground against water, rail, roads and parks alike.
  for (const surface of ctx.input("surface-overrides").surfaces) {
    blockers.push({ section: surface.section, separate: false });
  }
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
  params: [
    "water",
    "regions.water.*",
    ...OVERRIDE_GROUP_LEAVES,
    "object_overrides[].hidden",
  ],
  inputs: ["normalise", "context", "repair-buildings", "surface-overrides"],
  inputDigests: GROUND_READS,
  run(ctx) {
    return repairSurfaceLayer(ctx, "water");
  },
});

const surfaceRail = defineStage({
  id: "surface-rail",
  phase: "geometry",
  params: ["regions.rail.*", "bridges.enabled", "road_scale"],
  inputs: ["normalise", "context", "repair-buildings", "surface-overrides", "surface-water"],
  inputDigests: GROUND_READS,
  run(ctx) {
    return repairSurfaceLayer(ctx, "rail");
  },
});

const surfaceRoads = defineStage({
  id: "surface-roads",
  phase: "geometry",
  params: [
    "road_mode",
    "road_scale",
    "regions.roads.*",
    "bridges.enabled",
    ...OVERRIDE_GROUP_LEAVES,
    "object_overrides[].hidden",
    "object_overrides[].width_scale",
  ],
  inputs: ["normalise", "context", "repair-buildings", "surface-overrides", "surface-water", "surface-rail"],
  inputDigests: GROUND_READS,
  run(ctx) {
    reportRoadModeConflict(ctx.build);
    return repairSurfaceLayer(ctx, "roads");
  },
});

const surfaceParks = defineStage({
  id: "surface-parks",
  phase: "geometry",
  params: [
    "regions.parks.*",
    "frame",
    ...OVERRIDE_GROUP_LEAVES,
    "object_overrides[].hidden",
  ],
  inputs: [
    "normalise",
    "context",
    "repair-buildings",
    "surface-overrides",
    "surface-water",
    "surface-rail",
    "surface-roads",
  ],
  inputDigests: GROUND_READS,
  run(ctx) {
    const build = ctx.build;
    const parks = repairSurfaceLayer(ctx, "parks");
    // The layers in precedence order, each as its own stage repaired it. The
    // ridge merge below may replace a recessed layer's footprint, so the
    // records are copied first: the upstream outputs stay what they were. The
    // override layers are first and are therefore never the merge's SINK, which
    // is what keeps a singled-out object's footprint exactly what the user drew.
    const repaired: RepairedSurface[] = ctx.input("surface-overrides").surfaces.map((surface) => ({ ...surface }));
    for (const layer of SURFACE_ORDER) {
      const built = layer === "parks" ? parks : ctx.input(SURFACE_STAGE[layer]);
      if (built === null || "regions" in built) continue;
      repaired.push({ ...built });
    }
    perfSpan("surface.ridges", () => mergeRecessRidges(build, repaired, ctx.input("repair-buildings").footprint));

    const regions: SurfaceRegion[] = [];
    for (const layer of repaired) {
      const pocket = perfSpan("surface.pocket", () => grownPocket(build, layer.section));
      const fitted = perfSpan("surface.fit", () => fittedSolid(build, layer.solidSection, deeperLayers(build, layer, repaired)));
      const solid = perfSpan("surface.extrude", () =>
        extrudeSection(ctx.wasm, ctx.arena, fitted, solidBottomMm(build, layer.placement), layer.placement.topMm),
      );
      const cutter = perfSpan("surface.extrude", () =>
        extrudeSection(ctx.wasm, ctx.arena, pocket, layer.placement.bottomMm, cutterTopMm(build)),
      );
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
    // v3.1 Task 11: the group leaves decide which buildings leave the band
    // split for an `override_N` region, and `tint` names one building's shade.
    ...OVERRIDE_GROUP_LEAVES,
    "object_overrides[].tint",
  ],
  inputs: ["normalise", "context", "terrain", "repair-buildings"],
  // `socket` for the base; `overrideBands` for an override region, which
  // holds buildings only when a group recoloured some (the constant `none`
  // otherwise, so a green or road override's region does not re-run for a
  // storey change); `ownerIds` for the finish of every building-bearing
  // region. That last one hashes WHICH buildings own a solid, sorted, and
  // not the map's keys: the keys are the kernel's original ids, fresh on
  // every extrusion, so a warm and a cold build of the same model would key
  // differently on them. A finish whose region was served from the cache
  // (the geometry unchanged) is then served too, with the attribution that
  // matches that solid's ids; a region that re-ran has a new key of its own.
  digests: {
    socket: (out) => solidsDigest(out.socket),
    overrideBands: (out) => solidsDigest(out.overrideBands.map((band) => band.solid)),
    ownerIds: (out) => hashString(stableJson(Object.values(out.ownerIds).sort())),
  },
  run(ctx) {
    return buildBuildings(ctx.build, ctx.input("repair-buildings"), ctx.input("terrain").drape);
  },
});

const bridges = defineStage({
  id: "bridges",
  phase: "geometry",
  params: [
    "bridges.*",
    // The only thing a deck asks of `road_mode` is whether the roads exist at
    // all (`roads.roadBridgeWays`); engraved and embossed roads carry the same
    // bridges, so the key is that one test and not the value. Measured: the
    // stage is 220 ms of a `road_mode` change on the Chicago plate, and it
    // built the identical decks before and after.
    { path: "road_mode", label: "off", key: (value) => value === "off" },
    "road_scale",
    "regions.roads.depth_mm",
    "regions.rail.depth_mm",
    "regions.rail.width_m",
    "object_overrides[].osm_id",
    "object_overrides[].layer",
    "object_overrides[].hidden",
    "object_overrides[].road_mode",
    "object_overrides[].width_scale",
  ],
  inputs: ["normalise", "context", "terrain", "repair-buildings"],
  inputDigests: GROUND_READS,
  run(ctx) {
    return buildBridges(ctx.build, ctx.input("repair-buildings").footprint, ctx.input("terrain").drape);
  },
});

const trees = defineStage({
  id: "trees",
  phase: "geometry",
  params: ["trees", "nozzle_mm"],
  inputs: ["normalise", "context", "terrain", "repair-buildings", "surface-parks"],
  inputDigests: GROUND_READS,
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
  params: ["engravings[].edge", "engravings[].font", "labels[].font", "frame", "scale_bar.enabled", "tiling.enabled", "tiling.index_mark"],
  inputs: [],
  async run(ctx) {
    // The surface labels' faces ride along with the lettering's (Task 12).
    const extra = labelFaces(ctx.params);
    await Promise.all([loadFaces(ctx.params), ...extra.map((face) => loadGlyphFace(face))]);
    return { faces: [...new Set([...facesFor(ctx.params), ...extra])] };
  },
});

/**
 * The surface labels (v3.1 Task 12): every `labels[]` entry as a cutter or a
 * raised solid on the roof or the ground surface it names, plus the bands the
 * validator masks and the gizmo places itself on. It sits between `fonts` and
 * `lettering` so the resolved text comes out in parameter order, labels first;
 * its consumers are `base` (the ground engraves that reach into the plate),
 * the building and surface regions, `assembly` and `measure`.
 */
const labels = defineStage({
  id: "labels",
  phase: "geometry",
  params: [
    "labels[].*",
    "plate_mm",
    "nozzle_mm",
    "frame",
    "base_thickness_mm",
    "road_scale",
    "small_scale",
    "large_scale",
    "hero_mode",
    "height_exaggeration.*",
    "regions.building_skirt_mm",
  ],
  inputs: ["normalise", "context", "terrain", "repair-buildings", "surface-parks", "fonts"],
  // What each consumer reads: the ground cutters (the base), the roof pieces
  // (the building regions) and the ground pieces (the surface regions). Empty
  // for a plate with no labels, so nothing re-runs for a text nobody placed.
  digests: {
    base: (out) => solidsDigest(baseCutters(out)),
    roofs: (out) => solidsDigest(out.pieces.filter((piece) => piece.layer === "building").map((piece) => piece.cut ?? piece.add)),
    ground: (out) => solidsDigest(out.pieces.filter((piece) => piece.layer !== "building").map((piece) => piece.cut ?? piece.add)),
  },
  run(ctx) {
    const out = buildLabels(ctx.build, ctx.input("repair-buildings"), ctx.input("surface-parks").regions, ctx.input("terrain").drape);
    // The pose the gizmo draws its handles from (`LabelBand.pose`): the anchor
    // resolved through the same `labelAnchor` maths the cut itself used, so a
    // handle and the groove under it cannot disagree. Resolved here, not in
    // the canvas, because nothing drawn there may read a parameter.
    const { scene, params, scale } = ctx.build;
    for (const band of out.bands) {
      const label = (params.labels ?? [])[band.index];
      if (label === undefined) continue;
      const pose = labelPose(scene, params, label, scale);
      if (pose !== null) band.pose = { xMm: pose.x, yMm: pose.y, angleDeg: pose.angleDeg };
    }
    return out;
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
  inputs: ["context", "terrain", "surface-parks", "buildings", "labels", "lettering", "ornaments", "attribution", "hangers", "frame-cutters"],
  // Of these, the base reads only the cutters and the ridge, so it is keyed on
  // those parts: a frame-edge text, an ornament on the lip, a profile change
  // do not re-carve the plate.
  inputDigests: { buildings: "socket", labels: "base", lettering: "base", ornaments: "base", attribution: "base", hangers: "base", "frame-cutters": "base" },
  run(ctx) {
    const build = ctx.build;
    const cutters = ctx.input("frame-cutters");
    const plate = buildPlate(build);
    const withRidge = batchedUnion(ctx.wasm, ctx.arena, [plate, ...cutters.mating.baseAdd]) ?? plate;
    const carved = carveBase(build, withRidge, [
      ...ctx.input("buildings").socket,
      ...ctx.input("surface-parks").regions.map((s) => s.cutter),
      // A ground label engraved deeper than its surface region is thick
      // reaches the plate under it (Task 12).
      ...baseCutters(ctx.input("labels")),
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
      return ["buildings", "labels"];
    case "roads":
      return ["context", "terrain", "surface-parks", "bridges", "labels"];
    case "rail":
      return ["context", "terrain", "surface-parks", "bridges"];
    case "water":
      return ["context", "terrain", "surface-parks", "labels"];
    case "parks":
      return ["context", "terrain", "surface-parks", "trees", "labels"];
    case "lettering":
      return ["lettering"];
    case "attribution":
      return [];
    case "easel":
    case "cleat":
      return ["hangers"];
    default:
      // The gradient bands come from `buildings`; an `override_N` region can
      // hold buildings AND a surface layer, so it reads both. Both carry the
      // roof labels of the buildings they hold (Task 12).
      return overrideIndexOf(region) === null
        ? ["buildings", "labels"]
        : ["context", "terrain", "surface-parks", "buildings", "labels"];
  }
}

/** The part digest of `labels` a region stage keys on: the roof pieces for a building region, the ground pieces otherwise. */
function labelDigestFor(region: RegionName): "roofs" | "ground" {
  if (region === "roads" || region === "water" || region === "parks") return "ground";
  return "roofs";
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
      return applyLabels(ctx.wasm, ctx.arena, ctx.input("buildings").hero, roofPiecesFor(ctx.input("labels"), "hero_building", null));
    case "roads":
    case "rail":
    case "water":
    case "parks": {
      const surface = ctx.input("surface-parks").regions.find((s) => s.region === region);
      // The ground labels are cut and raised on the FLAT surface, before the
      // drape, exactly as the base carves its own cutters flat (Task 12).
      // `rail` carries no labels and reads no label output.
      const flat =
        surface === undefined
          ? null
          : region === "rail"
            ? surface.solid
            : applyLabels(ctx.wasm, ctx.arena, surface.solid, groundPiecesFor(ctx.input("labels"), region));
      // Each surface region is warped on its own, which is safe here in a way
      // it was not for the assembly: a region overlaps the base laterally as
      // well as vertically, so the two stay welded through any tessellation
      // disagreement smaller than the region's own depth. A region with no
      // grade layer at all can still exist: a road that is only a bridge, a
      // park that is only its trees.
      let solid: Manifold | null =
        flat === null ? null : (drapeSolid(ctx.build, ctx.input("terrain").drape, flat, undefined, false) ?? flat);
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
      if (overrideIndexOf(region) === null) {
        // `buildings` and the gradient bands, each carrying the roof labels of
        // the buildings whose tops fall in its range (Task 12).
        const band = ctx.input("buildings").bands.find((candidate) => candidate.region === region);
        if (band === undefined) return null;
        return applyLabels(ctx.wasm, ctx.arena, band.solid, roofPiecesFor(ctx.input("labels"), region, band.topRangeMm));
      }
      // An override region (v3.1 Task 11) is whatever claimed this group: the
      // buildings the user recoloured, the road or polygon layer they lifted
      // out, or both. Each half is built by the stage that owns its geometry
      // and welded here, the way `parks` welds its own trees in.
      const surface = ctx.input("surface-parks").regions.find((s) => s.region === region);
      let solid: Manifold | null =
        surface === undefined
          ? null
          : (drapeSolid(ctx.build, ctx.input("terrain").drape, surface.solid, undefined, false) ?? surface.solid);
      const band = ctx.input("buildings").overrideBands.find((entry) => entry.region === region);
      if (band !== undefined) {
        // A recoloured building keeps its roof label: every non-hero roof piece
        // is offered, and a cutter over a building this group does not hold
        // removes nothing (Task 12).
        const labelled = applyLabels(ctx.wasm, ctx.arena, band.solid, roofPiecesFor(ctx.input("labels"), region, null));
        solid = batchedUnion(ctx.wasm, ctx.arena, [solid, labelled]) ?? solid;
      }
      return solid;
    }
  }
}

function regionStage(region: RegionName): StageDef<RegionStageId> {
  const inputs = regionInputs(region);
  // A region that carries labels is keyed on the label pieces it can hold,
  // so a roof label leaves the roads cached and the other way round; an
  // override region reads only the bands its group recoloured.
  const inputDigests: Partial<Record<StageId, string>> = {
    ...(inputs.includes("labels") ? { labels: labelDigestFor(region) } : {}),
    ...(overrideIndexOf(region) === null ? {} : { buildings: "overrideBands" }),
  };
  return defineStage({
    id: regionStageId(region),
    phase: "region",
    params: [],
    inputs,
    ...(Object.keys(inputDigests).length === 0 ? {} : { inputDigests }),
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
 * - `override_N` (v3.1 Task 11) takes its filament from the override itself,
 *   falling back per half to the layer the objects came out of, so it reads the
 *   group leaves plus the four layers' slots and colours.
 */
function finishClaims(region: RegionName): StageDef["params"] {
  const claim = (path: string): StageDef["params"][number] => path as StageDef["params"][number];
  if (region === "attribution") return [];
  if (overrideIndexOf(region) !== null) {
    return [...OVERRIDE_GROUP_LEAVES.map(claim), ...OVERRIDE_COLOUR_LEAVES.map(claim)];
  }
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
    // The base carve is lazy in the kernel and this bounding-box read is where
    // it is evaluated, so the row is the carve's cost, not a box lookup.
    const baseMinZ = baseSolid === null ? null : perfSpan("sit.base", () => (baseSolid.isEmpty() ? null : baseSolid.boundingBox().min[2]));
    if (baseMinZ !== null) minZ = Math.min(minZ, baseMinZ);
    for (const part of ctx.input("hangers").parts) {
      if (!part.solid.isEmpty()) minZ = Math.min(minZ, part.solid.boundingBox().min[2]);
    }
    return { shiftMm: Number.isFinite(minZ) && Math.abs(minZ) > SIT_EPS_MM ? -minZ : 0 };
  },
});

/**
 * The regions whose triangles carry a building identity
 * (`RegionMesh.triangleOwner`).
 *
 * An `override_N` region is here because it MAY hold buildings; whether it
 * actually does is a run-time fact about that build's groups, and the finish
 * stage skips the attribution when the group's layer is not `building` rather
 * than walking a road's triangles looking for a building that is not there.
 */
export function ownedRegion(region: RegionName): boolean {
  return (
    region === "buildings" ||
    region === "hero_building" ||
    region.startsWith("buildings_band_") ||
    overrideIndexOf(region) !== null
  );
}

function finishStage(region: RegionName): StageDef<FinishStageId> {
  const owned = ownedRegion(region);
  const isOverride = overrideIndexOf(region) !== null;
  return defineStage({
    id: finishStageId(region),
    phase: "region",
    params: finishClaims(region),
    // A building region reads the `buildings` stage's original-id map to name
    // the owner of every triangle it ships, and is keyed on that map alone.
    inputs: owned ? [regionStageId(region), "sit", "buildings"] : [regionStageId(region), "sit"],
    ...(owned ? { inputDigests: { buildings: "ownerIds" } } : {}),
    run(ctx) {
      const solid = ctx.input(regionStageId(region)).solid;
      // The region stage's booleans are lazy in the kernel and this read is
      // where they are evaluated: the row names that cost rather than letting
      // it hide in the stage's own wall clock.
      if (solid === null || perfSpan("finish.solid", () => solid.isEmpty())) return null;
      // One read of the mesh, in double, for both the body count and the
      // record below: the count's quick path is exact on it, and the record
      // reuses it whenever the solid it ships is this very handle.
      const read = perfSpan("finish.read", () => readMesh(solid));
      const pruned = perfSpan("finish.prune", () => pruneDebrisCounted(ctx.wasm, ctx.arena, solid, DEBRIS_MM3, read));
      if (pruned.solid.isEmpty()) return null;
      const shift = ctx.input("sit").shiftMm;
      const placed = shift === 0 ? pruned.solid : ctx.arena.keep(pruned.solid.translate([0, 0, shift]));
      // An override region reads its filament from the override, never from
      // `colour.region_slots`: there is no `region_slots.override_1` leaf to
      // read, and asking for one is an undeclared read under strict claims.
      // The fallback pair is unreachable (a region with a solid is a region a
      // group claimed) and exists so the types need no assertion.
      const style = isOverride ? overrideRegionStyle(ctx.params, region) : null;
      const twin = isOverride ? region : colourTwin(ctx, region);
      const slot = isOverride ? (style?.slot ?? 1) : regionSlot(ctx.params, twin);
      const colorHex = isOverride ? (style?.colorHex ?? OVERRIDE_FALLBACK_HEX) : regionColor(ctx.params, twin);
      const mesh = perfSpan("finish.mesh", () =>
        toRegionMesh(placed, region, slot, colorHex, pruned.bodies.real + pruned.bodies.debris, {}, placed === solid ? read : undefined),
      );
      const carriesBuildings = !isOverride || groupForRegion(overrideGroups(ctx.params), region)?.layer === "building";
      if (owned && carriesBuildings) {
        const attribution = perfSpan("finish.owners", () => attributeTriangleOwners(placed, mesh, ctx.input("buildings").ownerIds));
        mesh.triangleOwner = attribution.triangleOwner;
        mesh.owners = attribution.owners;
      }
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
    "labels",
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
    const labelsOut = ctx.input("labels");
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
    // The roof labels are applied to the building solids themselves, before
    // they are unioned, so the same cut lands in the merged model whether the
    // buildings join before the drape (flat) or after it (Task 12).
    const rigid: Manifold[] = [];
    for (const band of buildingsOut.bands) {
      const labelled = applyLabels(wasm, arena, band.solid, roofPiecesFor(labelsOut, band.region, band.topRangeMm));
      if (labelled !== null) rigid.push(labelled);
    }
    if (buildingsOut.hero !== null) {
      const labelled = applyLabels(wasm, arena, buildingsOut.hero, roofPiecesFor(labelsOut, "hero_building", null));
      if (labelled !== null) rigid.push(labelled);
    }
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
    // Ground labels: the raised letters join the flat surfaces and the grooves
    // are cut with the other flat cutters, both before the drape (Task 12).
    const raised = batchedUnion(wasm, arena, [...additive, ...groundAdditions(labelsOut), ...(drape === null ? rigid : [])]);
    const carvedAssembly =
      raised === null
        ? null
        : subtractSolids(wasm, arena, raised, [
            ...grooves,
            ...baseCutters(labelsOut),
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
    // The read is where the kernel evaluates the weld; one read serves the
    // body count and, when nothing was pruned or shifted, the record too.
    const read = perfSpan("merged.read", () => readMesh(welded));
    const pruned = perfSpan("merged.prune", () => pruneDebrisCounted(ctx.wasm, ctx.arena, welded, UNION_DEBRIS_MM3, read));
    const shift = ctx.input("sit").shiftMm;
    const clean = shift === 0 ? pruned.solid : ctx.arena.keep(pruned.solid.translate([0, 0, shift]));
    const mesh = perfSpan("merged.mesh", () =>
      toRegionMesh(clean, "base", regionSlot(ctx.params, "base"), regionColor(ctx.params, "base"), pruned.bodies.real, {}, clean === welded ? read : undefined),
    );
    return { clean, mesh };
  },
});

const measure = defineStage({
  id: "measure",
  phase: "audit",
  params: ["nozzle_mm", "terrain_exaggeration", "hanger", "base_thickness_mm", "frame", "underside_mark.enabled", ...PLACEMENT_LEAVES],
  inputs: ["context", "terrain", "assembly", "labels"],
  run(ctx) {
    const welded = ctx.input("assembly").assembly;
    if (welded === null) return null;
    // Each surface label's ink polygon is masked out of the slices inside its
    // own band: text is judged by the lettering rules, not as a wall (Task 12).
    return measureMinWall(ctx.build, welded, undersideSkipBands(ctx.build), labelMasks(ctx.input("labels")));
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
    // v3.1 Task 11: the three override counts the stats carry.
    ...OVERRIDE_GROUP_LEAVES,
  ],
  inputs: [
    "normalise",
    "context",
    "terrain",
    "repair-buildings",
    "surface-overrides",
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
      ...overrideStats(ctx),
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
  inputs: ["audit", "merged", "tiling", "attribution", "buildings", "lettering", "ornaments", "normalise", "validate", ...ALL_FINISH_IDS],
  // `params-echo`: the files persist every leaf, so the key covers every leaf.
  extra: ["export-request", "params-echo"],
  run(ctx) {
    const request = ctx.extra("export-request");
    if (request === null) throw new Error("export: the job carries no export request");
    // A failing export ships nothing: a Stage 4 row the gate failed refuses
    // the files, by name, unless the caller forces it (`export/gate.ts`).
    const blocking = blockingFindings(ctx.input("validate"));
    if (blocking.length > 0 && request.force !== true) throw new ExportBlockedError(blocking);
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
    // A writer's own findings ride with the engine's into the sidecar, so its
    // `findings` list and its `bake_result.warnings` both say what the FILE
    // lost - which the engine's audit cannot know, because it depends on the
    // format (`export/stl.ts`'s `float32-degenerate`).
    const written = output.findings.length === 0 ? result : { ...result, findings: [...result.findings, ...output.findings] };
    // ... and once only. `buildSidecarJson` builds its warnings from the
    // findings AND the notes, and the writer's findings are repeated into
    // `notes` for the OUTPUT panel, so the sidecar's copy of them is dropped
    // from the notes it is given.
    const writerNotes = new Set(output.findings.map((finding) => `${finding.title}: ${finding.detail}`));
    const sidecar = perfSpan("export.sidecar", () =>
      buildSidecarJson({
        result: written,
        target,
        source: request.source ?? null,
        files: output.files,
        notes: output.notes.filter((note) => !writerNotes.has(note)),
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
      findings: output.findings,
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
  surfaceOverrides as StageDef,
  surfaceWater as StageDef,
  surfaceRail as StageDef,
  surfaceRoads as StageDef,
  surfaceParks as StageDef,
  buildings as StageDef,
  bridges as StageDef,
  trees as StageDef,
  tokens as StageDef,
  fonts as StageDef,
  labels as StageDef,
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
