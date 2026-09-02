/**
 * Public entrypoints for the OSM ingest engine: a pure builder over an
 * already-fetched Overpass response, and a network-backed wrapper that fails
 * soft. Everything else in `lib/engine/osm/**` is an implementation detail
 * these two functions assemble.
 */
import type { PrintParams, SceneRequest } from "../../contracts";
import { perfSpan } from "../../perf";
import { heightRulesFrom } from "./heights";
import { sceneFromOverpass as buildEngineScene, type OverpassResponse } from "./normalize";
import { fetchOverpass, type FetchOverpassOptions, type OverpassFetchError } from "./overpass";
import type { EngineSceneGraph } from "./types";

/**
 * Raw Overpass JSON -> `EngineSceneGraph`. Pure: no network, no cache, no
 * clock (deterministic for a fixed `raw`/`request`/`params`). `params` is
 * optional and only its `heights` group is consulted (the v3 height
 * inference tuning, `heightRulesFrom`); omitting it reproduces the frozen 03
 * constants (`services/bake/app/ingest/normalize.py`'s v1/v2 output).
 */
export function sceneFromOverpass(raw: OverpassResponse, request: SceneRequest, params?: PrintParams): EngineSceneGraph {
  return buildEngineScene(raw, request, { heights: heightRulesFrom(params?.heights) });
}

export type BuildSceneResult =
  | { ok: true; scene: EngineSceneGraph; fromCache: boolean }
  | { ok: false; error: OverpassFetchError };

/**
 * `SceneRequest` -> `EngineSceneGraph`, fetching (or serving from cache) the
 * Overpass response first. Fails soft: a network problem resolves to
 * `{ ok: false, error }` with `error.kind` and `error.mirrorsTried`, never a
 * thrown error, so the caller can render a retry/offline state.
 */
export async function buildScene(
  request: SceneRequest,
  params?: PrintParams,
  options: FetchOverpassOptions = {},
): Promise<BuildSceneResult> {
  // The two halves of an ingest, split so a slow preview can be blamed on the
  // right one: `overpass.fetch` is the network (or the IndexedDB cache hit)
  // and `osm.normalize` is the 03 hygiene pipeline over the response. Both are
  // no-ops with perf mode off (`lib/perf.ts`).
  const fetched = await perfSpan("overpass.fetch", () => fetchOverpass(request, options));
  if (!fetched.ok) return fetched;
  const scene = perfSpan("osm.normalize", () =>
    sceneFromOverpass(fetched.data as OverpassResponse, request, params),
  );
  return { ok: true, scene, fromCache: fetched.fromCache };
}
