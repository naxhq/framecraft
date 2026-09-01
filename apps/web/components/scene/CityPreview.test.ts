/**
 * Preview memo keys.
 *
 * 02: "rebuild only the affected instance buffer when a slider moves". The
 * regression this file guards: keying a layer on `params` (or on the
 * `Thresholds` object derived from it) rebuilds it on EVERY PrintParams write,
 * because `store.setParam` re-creates `params` by spread. Moving the height
 * sliders then re-ran earcut over every water/green polygon (711 of them on
 * the 900 m Chicago crop), allocated a fresh BufferGeometry, disposed the old
 * one and re-uploaded it to the GPU on every tick of a drag.
 *
 * The dependency lists tested here are the exact arrays `CityPreview` passes
 * to `useMemo`, replayed through `render()` below, which reproduces React's
 * rule (recompute iff any dep fails `Object.is`).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import type { PrintParams, SceneGraph } from "@/lib/contracts";
import { previewDeps } from "./CityPreview";

const GRAPH: SceneGraph = {
  bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
  center: { lat: 41.8827, lon: -87.6233 },
  buildings: [],
  roads: [],
  water: [],
  green: [],
  trees: [],
  stats: { building_count: 0, coverage: "empty", height_tag_ratio: 0 },
};

type DepList = unknown[];

/** The rotation, date and glyph-asset version the component holds constant. */
const ROTATION_DEG = 0;
const DATE = "2026-08-30";
const FACE_VERSION = 0;
/** The scene's own ground radius, which `detailAdvice` is asked about. */
const RADIUS_M = 900;

/** All ten memo keys for one (graph, scale, params) render. */
function allDeps(
  graph: SceneGraph | null,
  scale: number | null,
  params: PrintParams,
): Record<string, DepList> {
  return {
    scale: previewDeps.scale(graph, params),
    thresholds: previewDeps.thresholds(scale, params),
    layout: previewDeps.layout(graph, params),
    roads: previewDeps.roads(graph, params),
    water: previewDeps.water(graph, scale, params),
    green: previewDeps.green(graph, scale, params),
    trees: previewDeps.trees(graph, params),
    height: previewDeps.height(graph, params),
    text: previewDeps.text(graph, params, ROTATION_DEG, DATE, FACE_VERSION),
    advisor: previewDeps.advisor(graph, params, RADIUS_M),
  };
}

/** React's own rule: a memo recomputes iff any dep fails `Object.is`. */
function changed(before: DepList, after: DepList): boolean {
  if (before.length !== after.length) return true;
  return before.some((value, i) => !Object.is(value, after[i]));
}

/** Which layers a single `setParam` write would rebuild. */
function rebuiltBy<K extends keyof PrintParams>(
  key: K,
  value: PrintParams[K],
): string[] {
  const params = { ...DEFAULT_PRINT_PARAMS };
  // The scale is a number, so it is identity-stable whenever its own deps are.
  const scaleOf = (p: PrintParams): number =>
    (p.plate_mm - (p.frame ? 12 : 0)) / 1800;
  const before = allDeps(GRAPH, scaleOf(params), params);
  // Exactly what `store.setParam` does: a fresh object every write.
  const next: PrintParams = { ...params, [key]: value };
  const after = allDeps(GRAPH, scaleOf(next), next);
  return Object.keys(before).filter((name) => changed(before[name], after[name]));
}

describe("previewDeps", () => {
  it("never puts the params object (or anything derived from it) in a key", () => {
    const params = { ...DEFAULT_PRINT_PARAMS };
    const deps = allDeps(GRAPH, 0.1, params);
    for (const [name, list] of Object.entries(deps)) {
      for (const value of list) {
        if (value === GRAPH) continue;
        expect(
          value === null || typeof value !== "object",
          `${name} dep must be a primitive or the graph, got ${typeof value}`,
        ).toBe(true);
        expect(value).not.toBe(params);
      }
    }
  });

  /**
   * `height` is not a geometry layer: it is one pass over `buildings[].height_m`
   * (`transform.predicted_top_mm`) feeding the 60 mm guard and the HUD readout,
   * with no hulls, no earcut and no GPU upload. It is the one memo a height
   * slider is *supposed* to invalidate.
   *
   * `advisor` is the same shape of thing -- `transform.detail_report` over the
   * scene, feeding the HUD chip -- and no height slider may reach it either,
   * which is asserted rather than assumed just below.
   */
  const GEOMETRY = (names: string[]): string[] =>
    names.filter((name) => name !== "height" && name !== "advisor").sort();

  it("rebuilds no geometry when a height slider moves", () => {
    expect(GEOMETRY(rebuiltBy("small_scale", 1.5))).toEqual([]);
    expect(GEOMETRY(rebuiltBy("large_scale", 2.0))).toEqual([]);
    expect(GEOMETRY(rebuiltBy("base_thickness_mm", 8))).toEqual([]);
    expect(GEOMETRY(rebuiltBy("terrain_exaggeration", 3.0))).toEqual([]);
    // ... but the predicted model top must follow them, or the Bake button
    // would stay enabled past 04's 60 mm ceiling.
    expect(rebuiltBy("small_scale", 1.5)).toEqual(["height"]);
    expect(rebuiltBy("large_scale", 2.0)).toEqual(["height"]);
    expect(rebuiltBy("base_thickness_mm", 8)).toEqual(["height"]);
    expect(rebuiltBy("terrain_exaggeration", 3.0)).toEqual([]);
  });

  it("still rebuilds the layers a parameter really changes", () => {
    // Not vacuous: the nozzle moves every threshold, so everything that reads
    // one has to come back -- including the trees, whose printed-radius floor
    // is nozzle-aware (DECISIONS [P5-web]), the lettering, whose stroke target
    // and lip margin are both nozzle-derived, and the advisor.
    expect(rebuiltBy("nozzle_mm", 0.6).sort()).toEqual(
      [
        "advisor",
        "green",
        "layout",
        "roads",
        "text",
        "thresholds",
        "trees",
        "water",
      ].sort(),
    );
    // The plate and the frame move the scale, hence every metric layer -- and
    // the lettering, whose edge length and 6 mm band they set.
    expect(rebuiltBy("plate_mm", 256).sort()).toEqual(
      [
        "advisor",
        "green",
        "height",
        "layout",
        "roads",
        "scale",
        "text",
        "thresholds",
        "trees",
        "water",
      ].sort(),
    );
    expect(rebuiltBy("frame", false).sort()).toEqual(
      [
        "advisor",
        "green",
        "height",
        "layout",
        "roads",
        "scale",
        "text",
        "thresholds",
        "trees",
        "water",
      ].sort(),
    );
    // The advisor is NOT in these two. `transform.detail_report` never mentions
    // roads and walks `scene.water` unconditionally, so listing either in
    // `advisorDeps` re-ran a whole-scene walk plus two grid searches for a
    // byte-identical answer -- and this suite pinned that waste as correct
    // until the audit measured it (v2-06 finding 3).
    expect(rebuiltBy("road_scale", 2.0)).toEqual(["roads"]);
    expect(rebuiltBy("road_mode", "emboss")).toEqual(["roads"]);
    // Green has no toggle on the frozen PrintParams (DECISIONS [P4]).
    expect(rebuiltBy("water", false)).toEqual(["water"]);
    // The tree toggle really does reach the advisor: `detail_report` measures
    // the trees it would drop.
    expect(rebuiltBy("trees", false).sort()).toEqual(["advisor", "height", "trees"]);
  });

  /**
   * schema_version 2's personalisation block.
   *
   * The colour half is still pure paint -- `paletteFor` reads it at render time
   * and no layer is rebuilt -- so each of these must rebuild NOTHING. The
   * lettering half is now real geometry and has its own list below; conflating
   * the two would have let a text parameter quietly start rebuilding the water.
   */
  const V2_PAINT_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
    ["schema_version", 2],
    ["color_mode", "parts"],
    [
      "part_colors",
      {
        base: "#111111",
        frame: "#222222",
        buildings: "#333333",
        roads: "#444444",
        water: "#555555",
        green: "#666666",
        trees: "#777777",
      },
    ],
    // No hero is picked in the default params, so the mode alone moves nothing:
    // `heroHeightKey` is empty either way.
    ["hero_mode", "both"],
  ];

  /** The lettering block: it moves the text layer, and ONLY the text layer. */
  const V2_TEXT_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
    ["city_label", "Chicago"],
    // {country}/{state}/{neighbourhood}/{author} all read `place` ([V3-P1]).
    [
      "place",
      { country: "United States", state: "Illinois", neighbourhood: "The Loop", author: "V" },
    ],
    ["engravings", [{ edge: "bottom", text: "{city}" }]],
    ["north_arrow", { enabled: true, corner: "sw", size_mm: 6 }],
    [
      "scale_bar",
      { enabled: true, edge: "top", length_mode: "fixed", length_m: 1000 },
    ],
    ["hanger", "keyhole"],
    ["underside_mark", { enabled: true, template: "{coords}" }],
  ];

  it("rebuilds nothing when a v2 colour or hero-mode parameter moves", () => {
    for (const [key, value] of V2_PAINT_MOVES) {
      expect(rebuiltBy(key, value as never), key).toEqual([]);
    }
  });

  it("rebuilds only the text layer when a lettering parameter moves", () => {
    for (const [key, value] of V2_TEXT_MOVES) {
      expect(rebuiltBy(key, value as never), key).toEqual(["text"]);
    }
  });

  it("rebuilds the predicted height and the text layer when a hero is picked", () => {
    // A hero is drawn at its hero height, so the 60 mm guard and the HUD have
    // to follow it -- but no hull, no earcut, no advisor pass and no glyph
    // asset fetch is touched. (The instance matrices do move;
    // `InstancedBuildings.test.ts` owns that key.) `text` rebuilds too, since
    // [V3-P1]'s `{hero}` token counts `hero_building_ids.length`.
    expect(rebuiltBy("hero_building_ids", ["w1"])).toEqual(["height", "text"]);
  });

  /**
   * schema_version 3's engine block ([V3-P1], landed concurrently with this
   * phase by `v3-01-contracts`; ruling from the team lead recorded verbatim
   * in DECISIONS.md).
   *
   * Twelve of these thirteen groups are STILL not read by the CURRENT
   * (client-side, instanced/flat-fill) fallback preview these `previewDeps`
   * functions describe: the real browser engine
   * (`lib/engine/solid/**`/`lib/transform.ts`, owned this phase by a parallel
   * builder, not this file's) is what will actually drape terrain, cut region
   * recesses, apply an exaggeration curve, split tiles, style the frame
   * profile and place a magnet hanger's pockets -- and it already reruns on
   * every one of these writes regardless (`store/editor.ts`'s
   * `scheduleEngineJob` debounces a fresh WASM bake on EVERY `setParam` call,
   * not a subset), so there is nothing to add there. `regions`, `colour`,
   * `printer_profile`, `custom_profile`, `export_target`, `terrain`,
   * `heights`, `bridges`, `height_exaggeration`, `tiling`, `frame_style` and
   * `hanger_magnet` therefore still rebuild NOTHING in `previewDeps` today,
   * which is what this test asserts -- a real behaviour change, not a
   * checklist -- so a read added later without a matching dep is caught here
   * instead of silently over- or under-invalidating.
   *
   * `hero_auto` is the ONE exception, moved out of this bucket into its own
   * test below: `lib/warnings.ts:predictedTopDeps` (which `previewDeps.height`
   * IS) now composes `lib/heroes.ts:effectiveHeroHeightKey` -- the manual
   * picks plus, once `hero_auto` is on, the auto-promoted ones -- so an
   * auto-promoted hero raises the predicted top and moves `height` exactly
   * like a manual pick already did (`warnings.test.ts` owns the arithmetic;
   * this file only owns the dependency-list claim).
   *
   * `place` is deliberately NOT in this list either: unlike the rest, it
   * already IS live today, in `V2_TEXT_MOVES` above -- `{country}`,
   * `{state}`, `{neighbourhood}` and `{author}` are real engraving tokens
   * this phase wired up, not a future engine's job.
   *
   * `printer_profile` and `custom_profile` are ALSO not in this list, moved
   * out by phase 4 ([V3-P4-U]): `lib/warnings.ts:predictedTopDeps` (which
   * `previewDeps.height` IS) now reads `printer_profile` and
   * `custom_profile?.max_height_mm`, because `heightCeilingMm` -- what the
   * predicted top is compared AGAINST for the HUD tone and the too-tall pill
   * -- moves with them (their own test is below, mirroring the `hero_auto`
   * pattern above).
   */
  const V3_ENGINE_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
    ["regions", { roads: { depth_mm: 1.0 }, building_skirt_mm: 0.6 }],
    ["colour", { palette: "noir", preview_theme: "light" }],
    ["export_target", "stl"],
    ["terrain", { enabled: true, smoothing: 3 }],
    ["heights", { floor_height_m: 3.5 }],
    ["bridges", { enabled: false }],
    ["height_exaggeration", { multiplier: 1.5 }],
    ["tiling", { enabled: true, cols: 2, rows: 2 }],
    ["frame_style", { profile: "chamfer", corner: "mitred" }],
    ["hanger_magnet", { diameter_mm: 8, thickness_mm: 3, count: 4 }],
  ];

  /** Kept out of `V3_ENGINE_MOVES` on purpose; still needed for coverage below. */
  const HERO_AUTO_MOVE: [keyof PrintParams, PrintParams[keyof PrintParams]] = [
    "hero_auto",
    { enabled: true, count: 1 },
  ];

  it("rebuilds nothing for the rest of the v3 engine block: the geometry engine that will read it is a separate rebuild path", () => {
    for (const [key, value] of V3_ENGINE_MOVES) {
      expect(rebuiltBy(key, value as never), key).toEqual([]);
    }
  });

  it("rebuilds only the predicted height when the printer profile or a custom profile's height ceiling moves (phase 4, [V3-P4-U])", () => {
    // No hull, no earcut, no advisor pass, no glyph fetch -- only the height
    // ceiling comparison the HUD tone and the too-tall pill read.
    expect(rebuiltBy("printer_profile", "bambu-x1c")).toEqual(["height"]);
    expect(rebuiltBy("custom_profile", { plate_x_mm: 256, plate_y_mm: 256, max_height_mm: 40 })).toEqual([
      "height",
    ]);
  });

  it("rebuilds the predicted height when hero_auto promotes a real building", () => {
    // A building has to exist for `hero_auto` to promote: the shared `GRAPH`
    // fixture above has none, so this uses its own graph with one tall
    // building, exactly the shape `warnings.test.ts`'s hero_auto describe
    // block already exercises the arithmetic on.
    const graph: SceneGraph = {
      ...GRAPH,
      buildings: [
        {
          id: "w200",
          ring: [[0, 0], [30, 0], [30, 30], [0, 30]],
          holes: [],
          height_m: 200,
          height_source: "tag",
          min_height_m: 0,
          is_tall: true,
        },
      ],
    };
    const params = { ...DEFAULT_PRINT_PARAMS, small_scale: 0.5, large_scale: 0.5 };
    const before = previewDeps.height(graph, params);
    const after = previewDeps.height(graph, { ...params, [HERO_AUTO_MOVE[0]]: HERO_AUTO_MOVE[1] });
    expect(changed(before, after)).toBe(true);
  });

  it("hero_auto still rebuilds only the text layer on the shared empty-building GRAPH fixture, exactly like a manual hero move", () => {
    // No building for it to promote, so `height` does not move (asserted
    // above); `text` still does, same as `hero_building_ids` in
    // `V2_TEXT_MOVES` -- `textParamsKey` embeds `hero_auto` itself
    // (`lib/previewText.ts`) because `{hero}` can read it, whether or not
    // this particular scene has anything for it to say.
    expect(rebuiltBy(HERO_AUTO_MOVE[0], HERO_AUTO_MOVE[1] as never)).toEqual(["text"]);
  });

  it("covers every key of the frozen PrintParams contract", () => {
    const covered = new Set([
      "plate_mm",
      "base_thickness_mm",
      "nozzle_mm",
      "small_scale",
      "large_scale",
      "terrain_exaggeration",
      "road_mode",
      "road_scale",
      "trees",
      "water",
      "frame",
      "hero_building_ids",
      ...V2_PAINT_MOVES.map(([key]) => key),
      ...V2_TEXT_MOVES.map(([key]) => key),
      ...V3_ENGINE_MOVES.map(([key]) => key),
      HERO_AUTO_MOVE[0],
      "printer_profile",
      "custom_profile",
    ]);
    expect([...covered].sort()).toEqual(Object.keys(DEFAULT_PRINT_PARAMS).sort());
  });

  it("rebuilds everything when a new SceneGraph arrives", () => {
    const params = { ...DEFAULT_PRINT_PARAMS };
    const before = allDeps(GRAPH, 0.1, params);
    const after = allDeps({ ...GRAPH }, 0.1, params);
    const rebuilt = Object.keys(before).filter((n) => changed(before[n], after[n]));
    expect(rebuilt.sort()).toEqual(
      [
        "advisor",
        "green",
        "height",
        "layout",
        "roads",
        "scale",
        "text",
        "trees",
        "water",
      ].sort(),
    );
  });

  /**
   * The text layer's own key, spelled out.
   *
   * It is a STRING, not the nested objects, so that the all-primitives rule
   * above can hold; the risk a string key carries in exchange is that it stops
   * noticing a change, which is what these two assert against.
   */
  it("keys the text layer on the layout parameters and nothing else", () => {
    const params = { ...DEFAULT_PRINT_PARAMS };
    // Same values, fresh objects: the key must NOT move, or every `setNested`
    // write would re-triangulate the glyphs.
    const rebuilt = { ...params, north_arrow: { ...params.north_arrow } };
    expect(
      changed(
        previewDeps.text(GRAPH, params, ROTATION_DEG, DATE, FACE_VERSION),
        previewDeps.text(GRAPH, rebuilt, ROTATION_DEG, DATE, FACE_VERSION),
      ),
    ).toBe(false);
    // ...and the three arguments the component holds outside `params`.
    for (const after of [
      previewDeps.text(GRAPH, params, 90, DATE, FACE_VERSION),
      previewDeps.text(GRAPH, params, ROTATION_DEG, "2026-09-01", FACE_VERSION),
      previewDeps.text(GRAPH, params, ROTATION_DEG, DATE, 1),
    ]) {
      expect(
        changed(previewDeps.text(GRAPH, params, ROTATION_DEG, DATE, FACE_VERSION), after),
      ).toBe(true);
    }
  });
});
