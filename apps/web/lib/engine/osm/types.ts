/**
 * Additive, TS-only extensions to the frozen `SceneGraph` contract.
 *
 * DECISIONS.md [V3-P2-E1]: the brief asked for `name`/landmark hints on
 * `Building`, a `rail` layer and `bridge`/`layer` on road-like segments to be
 * added as "optional SceneGraph fields... regenerate contracts". Doing that
 * literally breaks a pinned Python test this task does not own:
 * `services/bake/tests/test_contracts.py::test_scene_graph_dumps_fixture_verbatim_without_by_alias`
 * asserts `SceneGraph(**fixture).model_dump(mode="json") == fixture` with no
 * key filtering (unlike the analogous PrintParams tests, which compare only
 * the original example's keys); pydantic v2 always emits an `Optional` field
 * at its default (`None`) on `model_dump`, so any new optional property
 * turns that equality false the moment `services/bake/app/contracts.py` is
 * regenerated, for every existing SceneGraph fixture, with no owned file to
 * fix it in. Verified directly against pydantic v2's actual dump behavior,
 * not assumed.
 *
 * Given that, `packages/contracts/schema/scene_graph.json` was untouched at the
 * time: `EngineSceneGraph` below is a structural superset assignable anywhere a
 * plain `SceneGraph` is expected, so it satisfies `EngineInput.scene` (the
 * three engine builders' shared entrypoint) without weakening the contract
 * boundary.
 *
 * schema_version 4 (Task 10) closed the `name` half of that follow-up, and the
 * pinned test did NOT have to be relaxed to do it. `name`, `osm_id` and `kind`
 * are optional AND non-nullable in the schema, so `null` is not one of their
 * legal values; `gen_py.py` therefore gives a class with such properties a wrap
 * serializer that omits them when unset, and a v1/v2/v3 SceneGraph still dumps
 * back verbatim. What stays here is what is still genuinely TS-only: the four
 * landmark hints, the `rail` layer, `bridge`/`layer` on road-like segments, and
 * the two additive `stats` counters.
 */
import type { AreaFeature, Bounds, Building, Center, Road, SceneGraph, Stats } from "../../contracts";

/**
 * `Building` plus the landmark hints hero auto-scoring reads (`lib/heroes.ts`).
 *
 * `name`, `osm_id` and `kind` were promoted INTO the frozen contract at
 * schema_version 4 (Task 10) and are inherited from `Building`; the four hints
 * below stay here, because nothing outside hero scoring reads them and each is
 * a raw tag rather than a fact about the printed object.
 */
export interface EngineBuilding extends Building {
  /** True if any landmark heuristic tag is present (see `isLandmark` in normalize.ts). */
  landmark?: boolean;
  /** Raw `tourism` tag value, e.g. "museum". */
  tourism?: string;
  /** Raw `historic` tag value. */
  historic?: string;
  /** Raw `wikidata` QID, when present. */
  wikidata?: string;
}

/** `Road` plus bridge/layer, carried through from the OSM way. */
export interface EngineRoad extends Road {
  bridge?: boolean;
  /** OSM `layer` tag, parsed to an integer; 0 when absent or unparseable. */
  layer?: number;
}

/** A `railway=rail|light_rail|subway|tram` surface segment (tunnels and negative `layer` excluded). */
export interface Rail {
  id: string;
  path: [number, number][];
  width_m: number;
  bridge?: boolean;
  layer?: number;
}

export interface HeightFallbackCounts {
  tag: number;
  levels: number;
  default: number;
}

export interface EngineStats extends Stats {
  height_fallback_counts?: HeightFallbackCounts;
  /**
   * How many OSM names the ingest's name budget dropped from this scene
   * (`normalize.ts:SCENE_NAME_BUDGET_BYTES`). Absent when nothing was dropped,
   * which is every scene inside the budget. `lib/objectInfo.ts:nameBudgetWarning`
   * turns it into the Issues badge's one counted entry.
   */
  names_dropped?: number;
}

/** The SceneGraph this engine actually produces: the frozen contract plus the additive fields above. */
export interface EngineSceneGraph extends SceneGraph {
  bounds: Bounds;
  center: Center;
  buildings: EngineBuilding[];
  roads: EngineRoad[];
  rail: Rail[];
  water: AreaFeature[];
  green: AreaFeature[];
  stats: EngineStats;
}
