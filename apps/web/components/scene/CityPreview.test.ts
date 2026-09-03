/**
 * The viewport's two rules.
 *
 * **1. Nothing rendered reads a parameter.** This replaces the v3 discipline
 * that this file used to hold (`previewDeps` covering every approximate layer,
 * and a list of ten parameter groups asserted to "rebuild nothing"). That
 * assertion was true and was the defect: those ten groups rebuilt nothing
 * because no preview layer read them, so the frame profile, the matting, the
 * shadow gap, the terrain, the tiling and the region depths were invisible
 * until a build landed seconds later -- and touching one of them REMOVED the
 * only layer that had ever drawn it, which is what "the settings do nothing"
 * was made of.
 *
 * Since v3.1 the viewport draws the pipeline's own solids and nothing else, so
 * the honest form of that assertion is the one below: no file that renders
 * into the canvas may read a `PrintParams` field at all. Then a control that
 * appears to do nothing can only ever be a pipeline stage that did not claim
 * it, which `lib/engine/pipeline/graph.test.ts` makes impossible, and the
 * check here is cross-referenced against the registry so the two cannot drift.
 * Everything drawn comes from `state.pipeline.regions` and
 * `state.pipeline.result`.
 *
 * The exceptions are named, and there are two of them: `BuildingPickProxies`,
 * which places invisible boxes for hero picking and paints nothing (named
 * exception 1, `docs/handoff/v3-01-pipeline.md` section 5), and the two HUD
 * hosts, `CityPreview.tsx` and `PreviewPane.tsx`, whose readouts sit OUTSIDE
 * the canvas and are statements about the settings by design.
 *
 * **2. A region re-uploads if and only if its hash changed.** That half lives
 * in `RegionMeshes.test.tsx`, where the geometry cache can be driven twice
 * with one region moved; the store half (a region's mesh object is replaced
 * only when the worker re-sent it) is in `store/editor.pipeline.test.ts`.
 *
 * What remains of the memo discipline is the HUD's: `store.setParam` rebuilds
 * `params` by spread on every write, so any dependency list naming `params`
 * would re-run the footprint hulls and re-triangulate the glyphs on every tick
 * of a drag. Those lists are still tested below.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import type { PrintParams, SceneGraph } from "@/lib/contracts";
import { claimedPaths, expandClaims, type ParamClaim } from "@/lib/engine/pipeline";
import { previewDeps } from "./CityPreview";

// ===========================================================================
// 1. Nothing rendered reads a parameter
// ===========================================================================

const SCENE_DIR = path.resolve(__dirname);

/** The HUD hosts (outside the canvas) and the one named picking exception. */
const PARAM_READERS_ALLOWED = new Set([
  "CityPreview.tsx",
  "PreviewPane.tsx",
  "BuildingPickProxies.tsx",
]);

/** A read of a PrintParams field: `params.plate_mm`, `params?.colour`, `pickParams.frame`. */
const PARAM_READ = /\b[A-Za-z]*[Pp]arams\??\.[A-Za-z_]/;

function sceneSources(): string[] {
  return readdirSync(SCENE_DIR)
    .filter((name) => (name.endsWith(".tsx") || name.endsWith(".ts")) && !name.includes(".test."))
    .sort();
}

function read(name: string): string {
  return readFileSync(path.join(SCENE_DIR, name), "utf-8");
}

/** The file's code lines, with every comment line dropped. */
function codeLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"));
}

/** Code lines that read a PrintParams field. */
function paramReads(source: string): string[] {
  return codeLines(source).filter((line) => PARAM_READ.test(line));
}

describe("no rendered layer reads PrintParams", () => {
  it("has scene sources to check, and the exemptions all exist", () => {
    // Guards the guard: a renamed file must not turn this suite vacuous.
    const files = sceneSources();
    expect(files.length).toBeGreaterThan(5);
    for (const name of PARAM_READERS_ALLOWED) {
      expect(files, `${name} is exempt but does not exist`).toContain(name);
    }
  });

  it("finds no parameter read in any file that renders into the canvas", () => {
    for (const name of sceneSources()) {
      if (PARAM_READERS_ALLOWED.has(name)) continue;
      expect(paramReads(read(name)), `${name} reads a PrintParams field`).toEqual([]);
    }
  });

  it("names the PrintParams type in only one rendered file, and only to pass it through", () => {
    // A file that names the type is a file about to read it. The exception is
    // `PreviewScene`, which hands the object to the pick proxies untouched --
    // so it may name the type exactly twice (the import and the prop) and
    // never dereferences it, which the sweep above already proves.
    for (const name of sceneSources()) {
      if (PARAM_READERS_ALLOWED.has(name)) continue;
      const mentions = codeLines(read(name)).filter((line) => /\bPrintParams\b/.test(line));
      if (name === "PreviewScene.tsx") {
        expect(mentions).toEqual([
          'import type { PrintParams } from "@/lib/contracts";',
          "pickParams: PrintParams;",
        ]);
        continue;
      }
      expect(mentions, `${name} names PrintParams`).toEqual([]);
    }
  });

  it("hands the canvas nothing but pipeline output and the pick proxies' own params", () => {
    // The whole `<PreviewScene .../>` element in `CityPreview.tsx`. Every prop
    // it takes has to come from the pipeline, the palette or the scene; the one
    // parameter object crossing the boundary goes straight to the pick proxies
    // without being read on the way.
    const source = read("CityPreview.tsx");
    const start = source.indexOf("<PreviewScene");
    expect(start, "CityPreview no longer mounts PreviewScene").toBeGreaterThan(0);
    const element = source.slice(start, source.indexOf("/>", start));
    // The one parameter object crossing the boundary, handed to the pick
    // proxies by name...
    expect(element).toContain("pickParams={params}");
    // ...and not one field read on the way in.
    expect(paramReads(element)).toEqual([]);
  });

  it("mounts no approximate layer any more", () => {
    // The v3 stack: a constant frame, oriented boxes, flat ribbons, earcut
    // fills and flat lettering. Each one is a place the preview could disagree
    // with the file, and each is gone.
    const files = sceneSources();
    for (const gone of ["BasePlate.tsx", "RoadRibbons.tsx", "AreaSurfaces.tsx", "TreeInstances.tsx"]) {
      expect(files, `${gone} is back`).not.toContain(gone);
    }
    const scene = read("PreviewScene.tsx");
    expect(scene).not.toMatch(/textLayers|buildRoads|buildAreas|buildTrees/);
  });

  it("keeps the pick proxies invisible: visible={false} would take raycasting with them", () => {
    const source = codeLines(read("BuildingPickProxies.tsx")).join("\n");
    // three's Raycaster checks `visible` and stops; it does not consult a
    // material's opacity, so THIS is how a mesh is picked but never painted.
    expect(source).toMatch(/colorWrite={false}/);
    expect(source).toMatch(/depthWrite={false}/);
    expect(source).toMatch(/opacity={0}/);
    expect(source).not.toMatch(/visible={false}/);
    expect(source).toMatch(/castShadow={false}/);
    expect(source).toMatch(/receiveShadow={false}/);
  });
});

// ===========================================================================
// 2. The parameters the HUD does not read are the pipeline's, and it claims them
// ===========================================================================

/**
 * The groups the old suite asserted "rebuild nothing", plus the rest of the
 * contract. The claim is no longer "no preview layer reads them" (that was the
 * defect) but "the MODEL reads them", which is checkable against the stage
 * registry itself.
 */
const MODEL_ONLY_CLAIMS: ParamClaim[] = [
  "regions.*",
  "colour.gradient.*",
  "colour.tint.*",
  "colour.region_colors.base",
  "colour.region_slots.base",
  "terrain.*",
  "heights.*",
  "bridges.*",
  "height_exaggeration.*",
  "tiling.*",
  "frame_style.*",
  "hanger_magnet.*",
  "export_target",
  "printer_profile",
  "custom_profile.*",
];

describe("the parameters the viewport no longer reads are claimed by a stage", () => {
  it("claims every one of them, so the model moves when they do", () => {
    const claimed = claimedPaths();
    const paths = expandClaims(MODEL_ONLY_CLAIMS);
    // Not vacuous: these are real, expanded leaves, not a prefix nobody kept.
    expect(paths.length).toBeGreaterThan(20);
    for (const leaf of paths) {
      expect(claimed.has(leaf), `${leaf} is read by no pipeline stage`).toBe(true);
    }
  });

  it("rebuilds no HUD memo for any of them: they are the model's business, not the readouts'", () => {
    // The old assertion, kept word for word in effect. What changed is the
    // REASON it is safe: the model reads them (asserted just above), so a
    // control that moves one is visible in the viewport within the run, not
    // only in a number under it.
    for (const [key, value] of MODEL_ONLY_HUD_MOVES) {
      expect(rebuiltBy(key, value as never), key).toEqual([]);
    }
  });
});

// ===========================================================================
// 3. The HUD's own memo discipline
// ===========================================================================

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

/** Every memo key for one (graph, scale, params) render. */
function allDeps(
  graph: SceneGraph | null,
  scale: number | null,
  params: PrintParams,
): Record<string, DepList> {
  void scale;
  return {
    scale: previewDeps.scale(graph, params),
    layout: previewDeps.layout(graph, params),
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

/** Which memos a single `setParam` write would rebuild. */
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

/** The `MODEL_ONLY_CLAIMS` groups as contract writes, for the HUD assertion above. */
const MODEL_ONLY_HUD_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
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
   * `height` is not a footprint pass: it is one walk over `buildings[].height_m`
   * (`transform.predicted_top_mm`) feeding the 60 mm guard and the HUD readout,
   * with no hulls and no triangulation. It is the one memo a height slider is
   * *supposed* to invalidate.
   *
   * `advisor` is the same shape of thing -- `transform.detail_report` over the
   * scene, feeding the HUD chip -- and no height slider may reach it either,
   * which is asserted rather than assumed just below.
   */
  const HEAVY = (names: string[]): string[] =>
    names.filter((name) => name !== "height" && name !== "advisor").sort();

  it("rebuilds no footprint or glyph work when a height slider moves", () => {
    expect(HEAVY(rebuiltBy("small_scale", 1.5))).toEqual([]);
    expect(HEAVY(rebuiltBy("large_scale", 2.0))).toEqual([]);
    expect(HEAVY(rebuiltBy("base_thickness_mm", 8))).toEqual([]);
    expect(HEAVY(rebuiltBy("terrain_exaggeration", 3.0))).toEqual([]);
    // ... but the predicted model top must follow them, or the Export button
    // would stay enabled past 04's 60 mm ceiling.
    expect(rebuiltBy("small_scale", 1.5)).toEqual(["height"]);
    expect(rebuiltBy("large_scale", 2.0)).toEqual(["height"]);
    expect(rebuiltBy("base_thickness_mm", 8)).toEqual(["height"]);
    expect(rebuiltBy("terrain_exaggeration", 3.0)).toEqual([]);
  });

  it("still rebuilds the readouts a parameter really changes", () => {
    // Not vacuous: the nozzle moves every threshold, so everything that reads
    // one has to come back -- including the pick footprints, whose dilation is
    // nozzle-derived, the lettering, whose stroke target and lip margin are
    // both nozzle-derived, and the advisor.
    expect(rebuiltBy("nozzle_mm", 0.6).sort()).toEqual(
      ["advisor", "layout", "text"].sort(),
    );
    // The plate and the frame move the scale, hence every metric readout -- and
    // the lettering, whose edge length and 6 mm band they set.
    expect(rebuiltBy("plate_mm", 256).sort()).toEqual(
      ["advisor", "height", "layout", "scale", "text"].sort(),
    );
    expect(rebuiltBy("frame", false).sort()).toEqual(
      ["advisor", "height", "layout", "scale", "text"].sort(),
    );
    // `road_mode`, `road_scale` and `water` used to rebuild the ribbons and the
    // fills. Those layers are gone; the engine draws them, and no readout
    // moves. The advisor is deliberately NOT in these: `detail_report` never
    // mentions roads and walks `scene.water` unconditionally (v2-06 finding 3).
    expect(rebuiltBy("road_scale", 2.0)).toEqual([]);
    expect(rebuiltBy("road_mode", "emboss")).toEqual([]);
    expect(rebuiltBy("water", false)).toEqual([]);
    // The tree toggle really does reach the advisor: `detail_report` measures
    // the trees it would drop, and the height guard counts them.
    expect(rebuiltBy("trees", false).sort()).toEqual(["advisor", "height"]);
  });

  /**
   * The lettering block. It is no longer a rendered layer -- the engine cuts
   * the letters -- but the shared layout still tells the editor how many rings
   * a text produces and what it refused, so the memo has to follow it.
   */
  const TEXT_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
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

  it("rebuilds only the lettering layout when a lettering parameter moves", () => {
    for (const [key, value] of TEXT_MOVES) {
      expect(rebuiltBy(key, value as never), key).toEqual(["text"]);
    }
  });

  /**
   * The v1/v2 colour block. `part_colors` and `color_mode` paint nothing in the
   * viewport any more (the region meshes carry the engine's own colours), and
   * `schema_version` and `hero_mode` were always inert here.
   */
  const INERT_MOVES: Array<[keyof PrintParams, PrintParams[keyof PrintParams]]> = [
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

  it("rebuilds nothing for a colour or hero-mode parameter", () => {
    for (const [key, value] of INERT_MOVES) {
      expect(rebuiltBy(key, value as never), key).toEqual([]);
    }
  });

  it("rebuilds the predicted height and the lettering layout when a hero is picked", () => {
    // A hero stands at its hero height, so the 60 mm guard and the HUD have to
    // follow it -- but no hull and no glyph asset fetch is touched. (The pick
    // proxies' matrices do move; `BuildingPickProxies.test.ts` owns that key.)
    // `text` rebuilds too, since [V3-P1]'s `{hero}` token counts
    // `hero_building_ids.length`.
    expect(rebuiltBy("hero_building_ids", ["w1"])).toEqual(["height", "text"]);
  });

  /** Kept out of `MODEL_ONLY_HUD_MOVES` on purpose; still needed for coverage below. */
  const HERO_AUTO_MOVE: [keyof PrintParams, PrintParams[keyof PrintParams]] = [
    "hero_auto",
    { enabled: true, count: 1 },
  ];

  it("rebuilds only the predicted height when the printer profile or a custom profile's height ceiling moves (phase 4, [V3-P4-U])", () => {
    // `heightCeilingMm` -- what the predicted top is compared AGAINST for the
    // HUD tone and the too-tall pill -- moves with them.
    expect(rebuiltBy("printer_profile", "bambu-x1c")).toEqual(["height"]);
    expect(rebuiltBy("custom_profile", { plate_x_mm: 256, plate_y_mm: 256, max_height_mm: 40 })).toEqual([
      "height",
    ]);
  });

  it("rebuilds the predicted height when hero_auto promotes a real building", () => {
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

  it("hero_auto still rebuilds only the lettering layout on the shared empty-building GRAPH fixture", () => {
    // No building for it to promote, so `height` does not move (asserted
    // above); `text` still does, same as `hero_building_ids` -- `textParamsKey`
    // embeds `hero_auto` itself because `{hero}` can read it, whether or not
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
      ...INERT_MOVES.map(([key]) => key),
      ...TEXT_MOVES.map(([key]) => key),
      ...MODEL_ONLY_HUD_MOVES.map(([key]) => key),
      HERO_AUTO_MOVE[0],
      "printer_profile",
      "custom_profile",
    ]);
    expect([...covered].sort()).toEqual(Object.keys(DEFAULT_PRINT_PARAMS).sort());
  });

  it("rebuilds every readout when a new SceneGraph arrives", () => {
    const params = { ...DEFAULT_PRINT_PARAMS };
    const before = allDeps(GRAPH, 0.1, params);
    const after = allDeps({ ...GRAPH }, 0.1, params);
    const rebuilt = Object.keys(before).filter((n) => changed(before[n], after[n]));
    expect(rebuilt.sort()).toEqual(["advisor", "height", "layout", "scale", "text"].sort());
  });

  /**
   * The lettering memo's own key, spelled out.
   *
   * It is a STRING, not the nested objects, so that the all-primitives rule
   * above can hold; the risk a string key carries in exchange is that it stops
   * noticing a change, which is what these two assert against.
   */
  it("keys the lettering layout on the layout parameters and nothing else", () => {
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
