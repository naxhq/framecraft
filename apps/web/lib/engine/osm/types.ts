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
 * Given that, `packages/contracts/schema/scene_graph.json` is untouched:
 * `EngineSceneGraph` below is a structural superset assignable anywhere a
 * plain `SceneGraph` is expected, so it satisfies `EngineInput.scene` (the
 * three engine builders' shared entrypoint) without weakening the contract
 * boundary. Promoting these fields into the frozen schema is a follow-up:
 * regenerate, then extend the same test with the print_params-style key
 * filter.
 */
import type { AreaFeature, Bounds, Building, Center, Road, SceneGraph, Stats } from "../../contracts";

/** `Building` plus name/landmark hints for hero auto-scoring (phase 3 `lib/heroes.ts`). */
export interface EngineBuilding extends Building {
  /** OSM `name` tag, when present. */
  name?: string;
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
