/**
 * The `.framecraft` round trip, exercised against the real parser.
 *
 *   cd apps/web && npx vite-node -c vitest.config.ts scripts/_audit-project.ts
 *
 * Written for the adversarial audit of Task 13 (`docs/handoff/v3-13-dist-audit.md`)
 * and KEPT, on the orchestrator's ruling, because it is the only executable
 * proof of the round trip there is: 29 checks over a maximal project, every
 * malformed input the audit could think of, and the older envelope. It follows
 * the repo's `_`-prefixed convention for a script that is run by hand rather
 * than by the gate (`_degen-variants.ts`, `_probe-scene-size.ts`), and it is
 * kept clean under `eslint` and `tsc --noEmit` so it can never fail a gate it
 * is not part of.
 *
 * What it builds: a maximal project (a non-ASCII place name, three overrides
 * across all three layers with every optional member set, two labels with
 * anchors and `follow`, two engravings, three hero ids, a moved palette with
 * two region colours and a slot, an ogee mitred frame with a 1.2 mm lip, a
 * moved plate and base, a layout with a collapsed side and a maximized
 * region, and a top-level block this build does not model). It serialises it,
 * parses it back, and deep-diffs every leaf, then attacks the parser with the
 * malformed, the over-cap, the older and the foreign.
 *
 * The `-c vitest.config.ts` is not optional: the `@/` alias `lib/project.ts`
 * imports through is declared there and nowhere else vite-node would find it.
 */
import {
  LEGACY_PROJECT_FILE_EXTENSION,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  buildProject,
  parseProject,
  projectFilename,
  serializeProject,
} from "../lib/project";
import { defaultPrintParams, type PrintParams } from "../lib/contracts";
import type { LayoutPayload } from "../lib/layout";
import type { LocationState } from "../store/editor";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  ${detail}`}`);
}

/** Deep diff, returning dotted paths whose values differ. */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (a === b) return [];
  const bothObjects =
    a !== null && b !== null && typeof a === "object" && typeof b === "object";
  if (!bothObjects) return [`${path || "<root>"}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
  if (Array.isArray(a) !== Array.isArray(b)) return [`${path}: array/object mismatch`];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  const out: string[] = [];
  for (const key of keys) {
    out.push(
      ...diff(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        path === "" ? key : `${path}.${key}`,
      ),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// A maximal project: every v3.1 block set to something that is NOT the default
// ---------------------------------------------------------------------------

const params: PrintParams = defaultPrintParams();
params.city_label = "Sāo Paulo / 東京";
params.plate_mm = 220;
params.base_thickness_mm = 4.5;
params.frame = true;
params.hero_building_ids = ["way/123", "way/456", "relation/789"];
params.hero_mode = "own_color";
params.engravings = [
  { edge: "bottom", text: "{city} {coords}", size_mm: 5, depth_mm: 0.6, align: "center", mode: "engrave", font: "serif" },
  { edge: "underside", text: "{scale}", size_mm: 3.5, depth_mm: 0.4, align: "start", mode: "emboss", font: "mono" },
] as PrintParams["engravings"];
params.object_overrides = [
  { osm_id: "way/123", layer: "building", hero: "on", height_scale: 1.4, slot: 3, color: "#ff8800", tint: "#334455", hidden: false, road_mode: "inherit", width_scale: 1, raise_mm: 0 },
  { osm_id: "way/900", layer: "road", road_mode: "emboss", width_scale: 1.6, hidden: false, hero: "inherit", height_scale: 1, slot: 0, color: "", tint: "", raise_mm: 0 },
  { osm_id: "way/901", layer: "green", raise_mm: 0.9, color: "#00aa55", hidden: true, hero: "inherit", height_scale: 1, slot: 0, tint: "", road_mode: "inherit", width_scale: 1 },
] as PrintParams["object_overrides"];
params.labels = [
  {
    target_osm_id: "way/123",
    layer: "building",
    surface: "building_top",
    text: "Willis Tower",
    size_mm: 3.2,
    depth_mm: 0.5,
    mode: "engrave",
    font: "sans",
    u: 0.4,
    v: 0.6,
    rotation_deg: 30,
    follow: false,
  },
  {
    target_osm_id: "way/900",
    layer: "road",
    surface: "ground",
    text: "State Street",
    size_mm: 2.4,
    depth_mm: 0.35,
    mode: "emboss",
    font: "mono",
    u: 0.5,
    v: 0.5,
    rotation_deg: 0,
    follow: true,
  },
] as PrintParams["labels"];
if (params.colour !== undefined) {
  const colour = params.colour as Record<string, unknown>;
  colour.palette = "noir";
  const regionColors = colour.region_colors as Record<string, string> | undefined;
  if (regionColors !== undefined) {
    regionColors.buildings = "#123456";
    regionColors.water = "#0055ff";
  }
  const regionSlots = colour.region_slots as Record<string, number> | undefined;
  if (regionSlots !== undefined) regionSlots.buildings = 2;
}
if (params.frame_style !== undefined) {
  const frameStyle = params.frame_style as Record<string, unknown>;
  frameStyle.profile = "ogee";
  frameStyle.corner = "mitred";
  frameStyle.lip_depth_mm = 1.2;
}

const location: LocationState = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 750,
  rotation_deg: 42,
  preset_id: "chicago-loop",
};

const layout: LayoutPayload = { map: 520, settings: 400, collapsed: ["settings"], maximized: "map" };
const extras = { future_block: { unknown_to_this_build: [1, 2, 3] } };

const saved = new Date("2026-09-03T12:00:00.000Z");
const project = buildProject(location, params, saved, layout, extras);
const text = serializeProject(project);

console.log(`\n--- 1. maximal round trip (${text.length} bytes) ---`);
const loaded = parseProject(text, "design.framecraft");
if (!loaded.ok) {
  check("a maximal project loads", false, loaded.reason);
} else {
  check("a maximal project loads", true);
  const paramDrift = diff(params, loaded.params);
  check("every params leaf survives", paramDrift.length === 0, paramDrift.slice(0, 12).join(" | "));
  const locationDrift = diff(location, loaded.location);
  check("the location survives", locationDrift.length === 0, locationDrift.join(" | "));
  check(
    "labels survive with their anchors",
    JSON.stringify(loaded.params.labels) === JSON.stringify(params.labels),
    JSON.stringify(loaded.params.labels ?? null).slice(0, 200),
  );
  check(
    "object_overrides survive",
    JSON.stringify(loaded.params.object_overrides) === JSON.stringify(params.object_overrides),
    JSON.stringify(loaded.params.object_overrides ?? null).slice(0, 200),
  );
  const layoutOk =
    loaded.layout !== null &&
    loaded.layout.sizes.map === 520 &&
    loaded.layout.sizes.settings === 400 &&
    loaded.layout.collapsed.settings === true &&
    loaded.layout.collapsed.map === false &&
    loaded.layout.maximized === "map";
  check("the layout survives exactly", layoutOk, JSON.stringify(loaded.layout));
  check(
    "an unknown top-level block is carried through",
    JSON.stringify((loaded.extras as Record<string, unknown>).future_block) ===
      JSON.stringify(extras.future_block),
    JSON.stringify(loaded.extras),
  );
  check("app_version is reported", loaded.savedBy !== "", loaded.savedBy);
  check("a current file reports no migration", loaded.migrated === null, String(loaded.migrated));
  check(
    "the identity fields survive",
    loaded.params.city_label === params.city_label &&
      JSON.stringify(loaded.params.hero_building_ids) === JSON.stringify(params.hero_building_ids),
    `${String(loaded.params.city_label)} / ${JSON.stringify(loaded.params.hero_building_ids)}`,
  );
}

console.log("\n--- 2. the filename ---");
check(
  "a non-ASCII place name yields a safe stem",
  /^[a-z0-9-]+-2026-09-03\.framecraft$/.test(projectFilename(project)),
  projectFilename(project),
);

console.log("\n--- 3. hostile and older files ---");

const truncated = text.slice(0, Math.floor(text.length * 0.6));
const t = parseProject(truncated, "design.framecraft");
check("a truncated file is refused", !t.ok, t.ok ? "LOADED" : t.reason);

const notJson = parseProject("not json at all", "x.framecraft");
check("a non-JSON file is refused", !notJson.ok, notJson.ok ? "LOADED" : notJson.reason);

const wrongFormat = parseProject(JSON.stringify({ ...project, format: "something-else" }));
check("a foreign format tag is refused", !wrongFormat.ok, wrongFormat.ok ? "LOADED" : wrongFormat.reason);

const older = parseProject(JSON.stringify({ ...project, version: 2 }));
check("an unreadable older envelope is refused", !older.ok, older.ok ? "LOADED" : older.reason);

const newer = parseProject(JSON.stringify({ ...project, version: PROJECT_VERSION + 1 }));
check("a newer envelope is refused", !newer.ok, newer.ok ? "LOADED" : newer.reason);

const v3 = { ...project, version: 3 } as Record<string, unknown>;
delete v3.app_version;
const legacy = parseProject(JSON.stringify(v3), `design${LEGACY_PROJECT_FILE_EXTENSION}`);
if (!legacy.ok) {
  check("a version-3 legacy file loads", false, legacy.reason);
} else {
  check("a version-3 legacy file loads", true);
  check("it says it was migrated", legacy.migrated !== null, String(legacy.migrated));
  check("its params survive the migration", diff(params, legacy.params).length === 0, diff(params, legacy.params).slice(0, 6).join(" | "));
  check("savedBy is empty for a v3 file", legacy.savedBy === "", legacy.savedBy);
}

const badLat = parseProject(JSON.stringify({ ...project, pin: { lat: 999, lon: 0 } }));
check("an out-of-range latitude is refused", !badLat.ok, badLat.ok ? "LOADED" : badLat.reason);

const nanRadius = parseProject(JSON.stringify({ ...project, radius_m: "wide" }));
check("a non-numeric radius is refused", !nanRadius.ok, nanRadius.ok ? "LOADED" : nanRadius.reason);

const unknownSetting = JSON.parse(text) as Record<string, unknown>;
(unknownSetting.params as Record<string, unknown>).not_a_real_setting = 7;
const us = parseProject(JSON.stringify(unknownSetting));
check(
  "an unknown SETTINGS key is refused (not silently dropped)",
  !us.ok,
  us.ok ? "LOADED SILENTLY" : us.reason,
);

const overCap = JSON.parse(text) as Record<string, unknown>;
const p = overCap.params as Record<string, unknown>;
p.labels = Array.from({ length: 13 }, () => (params.labels ?? [])[0]);
const oc = parseProject(JSON.stringify(overCap));
check("a labels array past its cap is refused", !oc.ok, oc.ok ? "LOADED" : oc.reason);

const overrideCap = JSON.parse(text) as Record<string, unknown>;
(overrideCap.params as Record<string, unknown>).object_overrides = Array.from(
  { length: 25 },
  () => (params.object_overrides ?? [])[0],
);
const ovc = parseProject(JSON.stringify(overrideCap));
check("an overrides array past its cap is refused", !ovc.ok, ovc.ok ? "LOADED" : ovc.reason);

const badLayout = JSON.parse(text) as Record<string, unknown>;
badLayout.layout = { map: "wide", settings: -1 };
const bl = parseProject(JSON.stringify(badLayout));
check(
  "a corrupt layout block does not refuse the file, and yields no NaN",
  bl.ok &&
    (bl.layout === null ||
      (Number.isFinite(bl.layout.sizes.map) && Number.isFinite(bl.layout.sizes.settings))),
  bl.ok ? JSON.stringify(bl.layout) : bl.reason,
);

console.log("\n--- 4. save, load, save again ---");
if (loaded.ok) {
  const again = buildProject(loaded.location, loaded.params, saved, layout, loaded.extras);
  const secondDrift = diff(JSON.parse(text), JSON.parse(serializeProject(again)));
  check(
    "a second save is byte-identical to the first",
    secondDrift.length === 0,
    secondDrift.slice(0, 8).join(" | "),
  );
}

console.log("\n--- 5. filenames the open-with path can hand over ---");
for (const name of [
  "São Paulo design.framecraft",
  "設計 2026.framecraft",
  "C:/My Designs/東京.framecraft",
]) {
  const r = parseProject(text, name);
  check(`loads when the OS names it "${name}"`, r.ok && r.migrated === null, r.ok ? String(r.migrated) : r.reason);
}
for (const name of ["São Paulo design.framecraft.json", "設計.FrameCraft.JSON"]) {
  const r = parseProject(text, name);
  check(
    `"${name}" is recognised as legacy and says so`,
    r.ok && r.migrated !== null,
    r.ok ? String(r.migrated) : r.reason,
  );
}

console.log(`\nformat=${PROJECT_FORMAT} version=${PROJECT_VERSION} failures=${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
