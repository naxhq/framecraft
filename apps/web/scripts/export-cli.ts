// FrameCraft browser-engine build and export, from the command line.
//
//   npm run export:cli -- --scene ../../fixtures/chicago-scene.json \
//       --params ../../fixtures/print-params-default.json \
//       --target bambu-3mf --out ../../artifacts/chicago-web.3mf
//
// Runs the TypeScript engine (lib/engine/engine.ts) on a SceneGraph JSON and
// a PrintParams JSON, then writes the export for `--target` (any
// PrintParams.export_target value; defaults to the params' own export_target)
// plus a `<stem>.json` sidecar shaped like the Python service's, so
// `make validate FILE=<abs path>` can judge the file against it. CREDITS.txt
// is written beside the output. Relative paths resolve from the working
// directory.
//
// The engine module is loaded dynamically: it is being built in parallel, and
// this script must typecheck and give a clear error while it does not exist.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultPrintParams, type PrintParams, type SceneGraph } from "../lib/contracts";
import { sceneFromOverpass } from "../lib/engine/osm/scene";
import type { TerrainGrid } from "../lib/engine/types";
import { buildSidecarJson, sanitizeStem } from "../lib/engine/export/common";
import { EXPORT_TARGETS, exportForTarget, isExportTarget, resultForTile, tileStem, type ExportTarget } from "../lib/engine/export/index";
import { CREDITS_TEXT } from "../lib/engine/export/stl";
import { estimate } from "../lib/engine/estimate";
import type { EngineInput, EngineResult } from "../lib/engine/types";
import { resolveProfile } from "../lib/printers";

interface Args {
  scene: string | null;
  overpass: string | null;
  params: string;
  target: ExportTarget | null;
  out: string;
  title: string | null;
  terrain: string | null;
  radiusM: number;
  rotationDeg: number;
  /** Raw `--tiling` text; resolved against the parameter file in `main`. */
  tilingSpec: string | null;
  tiling: PrintParams["tiling"] | null;
}

/**
 * `--tiling 2x2`, `--tiling 3x2:pin`, `--tiling 2x2:dovetail:0.2`.
 *
 * The joint and the tolerance are optional and default to the parameter file's
 * own; everything the flag does not name is left exactly as the file had it, so
 * the flag adds a grid to a parameter set rather than replacing its tiling.
 */
function parseTiling(spec: string, base: PrintParams["tiling"]): PrintParams["tiling"] {
  const [grid, joint, tolerance] = spec.split(":");
  const match = /^(\d+)x(\d+)$/i.exec(grid ?? "");
  if (match === null) {
    throw new Error(`--tiling wants COLSxROWS[:joint[:tolerance_mm]], got ${spec}\n${USAGE}`);
  }
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (!(cols >= 1) || !(rows >= 1) || cols > 6 || rows > 6) {
    throw new Error(`--tiling: columns and rows must be 1 to 6, got ${cols}x${rows}`);
  }
  if (joint !== undefined && joint !== "dovetail" && joint !== "pin") {
    throw new Error(`--tiling: the joint is dovetail or pin, got ${joint}`);
  }
  const toleranceMm = tolerance === undefined ? undefined : Number(tolerance);
  if (toleranceMm !== undefined && !Number.isFinite(toleranceMm)) {
    throw new Error(`--tiling: the tolerance must be a number of mm, got ${tolerance}`);
  }
  return {
    ...(base ?? {}),
    enabled: true,
    cols,
    rows,
    ...(joint === undefined ? {} : { joint }),
    ...(toleranceMm === undefined ? {} : { tolerance_mm: toleranceMm }),
  };
}

const USAGE =
  "usage: export-cli (--scene <scene.json> | --overpass <overpass.json>) --params <print-params.json>\n" +
  "                [--target <export_target>] [--terrain <grid.json|demo|demo:<relief_m>>]\n" +
  "                [--radius <m>] [--rotation <deg>] [--tiling COLSxROWS[:joint[:tol]]]\n" +
  "                --out <file> [--title <text>]\n" +
  `  targets: ${EXPORT_TARGETS.join(", ")}\n` +
  "  --tiling   split the model over COLS x ROWS beds, joint `dovetail` (default) or\n" +
  "             `pin`, tolerance in mm. Writes the tiled export AND every tile as its\n" +
  "             own file with its own sidecar, so `make validate` can judge one tile.\n" +
  "  --overpass ingests a raw Overpass response through lib/engine/osm, which is the\n" +
  "             scene the app itself builds from: it carries the rail layer and the\n" +
  "             bridge/layer tags that a SceneGraph from the Python service does not.\n" +
  "  --terrain  a TerrainGrid JSON, or `demo` / `demo:<relief_m>` for a synthetic\n" +
  "             west-to-east ramp over the crop (default 60 m of relief), so a DRAPED\n" +
  "             build can be put through `make validate` without a network fetch.\n" +
  "  --radius   ground radius in metres for --overpass (default 900).";

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      throw new Error(`unexpected argument ${key}\n${USAGE}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${key} needs a value\n${USAGE}`);
    }
    values.set(key.slice(2), value);
    i += 1;
  }
  const scene = values.get("scene") ?? null;
  const overpass = values.get("overpass") ?? null;
  const params = values.get("params");
  const out = values.get("out");
  if ((scene === null) === (overpass === null) || !params || !out) {
    throw new Error(USAGE);
  }
  const target = values.get("target") ?? null;
  if (target !== null && !isExportTarget(target)) {
    throw new Error(`unknown --target ${target}\n${USAGE}`);
  }
  const radius = Number(values.get("radius") ?? 900);
  const rotation = Number(values.get("rotation") ?? 0);
  if (!Number.isFinite(radius) || radius <= 0) throw new Error(`--radius must be positive\n${USAGE}`);
  if (!Number.isFinite(rotation)) throw new Error(`--rotation must be a number\n${USAGE}`);
  const tiling = values.get("tiling") ?? null;
  return {
    scene,
    overpass,
    params,
    target,
    out,
    title: values.get("title") ?? null,
    terrain: values.get("terrain") ?? null,
    radiusM: radius,
    rotationDeg: rotation,
    tilingSpec: tiling,
    tiling: null,
  };
}

/**
 * The terrain grid for `--terrain`, or null.
 *
 * `demo` builds a synthetic west-to-east ramp over the crop rather than
 * fetching DEM tiles: the point of the flag is to put a DRAPED model through
 * the reference validator reproducibly, and a build whose geometry depends on
 * what a remote elevation service served that minute is not reproducible. A
 * real `TerrainGrid` JSON (what `fetchTerrainGrid` returns, `elevations` as a
 * plain array) is accepted too, for checking a specific place.
 */
function loadTerrain(spec: string | null, radiusM: number): TerrainGrid | null {
  if (spec === null) return null;
  if (spec === "demo" || spec.startsWith("demo:")) {
    const reliefM = spec === "demo" ? 60 : Number(spec.slice(5));
    if (!Number.isFinite(reliefM) || reliefM <= 0) {
      throw new Error(`--terrain ${spec}: the relief must be a positive number of metres`);
    }
    const cellM = Math.max(1, (2 * radiusM) / 128);
    const cols = Math.floor((2 * radiusM) / cellM) + 2;
    const elevations = new Float32Array(cols * cols);
    for (let r = 0; r < cols; r += 1) {
      for (let c = 0; c < cols; c += 1) elevations[r * cols + c] = (reliefM * c) / (cols - 1);
    }
    return {
      originEastM: -radiusM,
      originNorthM: -radiusM,
      cellM,
      cols,
      rows: cols,
      elevations,
      rangeM: reliefM,
      source: `synthetic ramp, ${reliefM} m of relief`,
    };
  }
  const raw = readJson<Omit<TerrainGrid, "elevations"> & { elevations: number[] | Float32Array }>(
    resolve(spec),
  );
  return { ...raw, elevations: Float32Array.from(raw.elevations) };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/**
 * Where `--overpass` says the crop is centred, when nothing else does.
 *
 * A raw Overpass response carries no centre of its own - the centre is part of
 * the REQUEST - and the committed fixture is the Chicago Loop, which is also
 * every other Chicago artefact's centre (`fixtures/chicago-scene.json`).
 */
const DEMO_CENTER = { lat: 41.8827, lon: -87.6233 };

/** The engine's entry point, whichever name lib/engine/engine.ts exports it under. */
type EngineRunner = (input: EngineInput) => Promise<EngineResult> | EngineResult;

interface EngineModule {
  runEngine?: EngineRunner;
  buildModel?: EngineRunner;
  buildEngineResult?: EngineRunner;
  default?: EngineRunner | { runEngine?: EngineRunner };
}

async function loadEngine(): Promise<EngineRunner> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = ["engine.ts", "engine.js", "index.ts", "index.js"].map((name) => resolve(here, "..", "lib", "engine", name));
  let lastError: unknown = null;
  for (const candidate of candidates) {
    let mod: EngineModule;
    try {
      mod = (await import(pathToFileURL(candidate).href)) as EngineModule;
    } catch (error) {
      // Keep the first (engine.ts) failure: it names the module that matters.
      lastError = lastError ?? error;
      continue;
    }
    const runner =
      mod.runEngine ??
      mod.buildModel ??
      mod.buildEngineResult ??
      (typeof mod.default === "function" ? mod.default : mod.default?.runEngine);
    if (typeof runner === "function") {
      return runner;
    }
    lastError = new Error(`${candidate} exports none of runEngine, buildModel, buildEngineResult or a default function`);
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    "the browser engine (apps/web/lib/engine/engine.ts) is not available yet, so nothing can be built from the command line: " + reason,
  );
}

function sidecar(args: Args, result: EngineResult, files: Array<{ name: string; bytes: Uint8Array }>, notes: string[], scene: SceneGraph, elapsedS: number, created: Date) {
  return buildSidecarJson({
    result,
    target: args.target ?? result.params.export_target ?? "bambu-3mf",
    // The scene's own centre, so the sidecar's provenance block names the place
    // the exported files name (`[V3-P7-A10]`).
    source: {
      lat: scene.center.lat,
      lon: scene.center.lon,
      radius_m: args.radiusM,
      rotation_deg: args.rotationDeg,
    },
    files,
    notes,
    scene,
    elapsedS,
    created,
    printerProfileId: resolveProfile(result.params).id,
  });
}

async function main(): Promise<void> {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const fromFile: PrintParams = { ...defaultPrintParams(), ...readJson<Partial<PrintParams>>(resolve(args.params)) };
  const params: PrintParams =
    args.tilingSpec === null
      ? fromFile
      : { ...fromFile, tiling: parseTiling(args.tilingSpec, fromFile.tiling) };
  const scene: SceneGraph =
    args.scene !== null
      ? readJson<SceneGraph>(resolve(args.scene))
      : sceneFromOverpass(
          readJson<Parameters<typeof sceneFromOverpass>[0]>(resolve(args.overpass as string)),
          {
            lat: DEMO_CENTER.lat,
            lon: DEMO_CENTER.lon,
            radius_m: args.radiusM,
            rotation_deg: args.rotationDeg,
          },
          params,
        );
  const terrain = loadTerrain(args.terrain, args.radiusM);
  const target: ExportTarget = args.target ?? params.export_target ?? "bambu-3mf";

  const run = await loadEngine();
  const result = await run({ scene, params, terrain, rotationDeg: args.rotationDeg });

  const outPath = resolve(args.out);
  const outDir = dirname(outPath);
  const stem = sanitizeStem(basename(outPath, extname(outPath)));
  mkdirSync(outDir, { recursive: true });
  const created = new Date();
  const output = exportForTarget(result, target, {
    stem,
    title: args.title ?? undefined,
    created,
    source: { lat: scene.center.lat, lon: scene.center.lon },
  });

  const written: string[] = [];
  const outExtension = extname(outPath).toLowerCase();
  for (const file of output.files) {
    // The first file takes the requested name; companions (MTL) keep their own,
    // and so does a file whose format is not the one `--out` named - a tiled
    // build writes a ZIP of per-tile files, and calling that `city.3mf` would be
    // a lie about what is in it.
    const path =
      file === output.files[0] && extname(file.name).toLowerCase() === outExtension
        ? outPath
        : resolve(outDir, file.name);
    writeFileSync(path, file.bytes);
    written.push(path);
  }
  const sidecarPath = resolve(outDir, `${stem}.json`);
  writeFileSync(sidecarPath, JSON.stringify(sidecar(args, result, output.files, output.notes, scene, (Date.now() - started) / 1000, created), null, 2) + "\n");
  writeFileSync(resolve(outDir, "CREDITS.txt"), CREDITS_TEXT);

  // Every tile as its own file too, with its own sidecar. The tiled export is
  // one Bambu project or one zip, and neither is something `make validate` can
  // open; a tile written on its own is exactly what the reference validator
  // judges, and judging one tile is the only way to know the SPLIT geometry is
  // sound rather than the model it came from.
  const tileFiles: string[] = [];
  for (const tile of result.tiles ?? []) {
    const tileResult = resultForTile(result, tile);
    const tileStemName = tileStem(stem, tile);
    const tileOutput = exportForTarget(tileResult, target, {
      stem: tileStemName,
      title: args.title ?? undefined,
      created,
      source: { lat: scene.center.lat, lon: scene.center.lon },
    });
    for (const file of tileOutput.files) {
      const path = resolve(outDir, file.name);
      writeFileSync(path, file.bytes);
      tileFiles.push(path);
    }
    const tileSidecar = resolve(outDir, `${tileStemName}.json`);
    writeFileSync(
      tileSidecar,
      JSON.stringify(
        sidecar(args, tileResult, tileOutput.files, tileOutput.notes, scene, (Date.now() - started) / 1000, created),
        null,
        2,
      ) + "\n",
    );
    tileFiles.push(tileSidecar);
  }

  const cost = estimate(result, result.params);
  console.log(`target ${target}: ${result.regions.length} regions, ${result.stats.triangles} triangles, ${result.stats.widthMm.toFixed(1)} x ${result.stats.depthMm.toFixed(1)} x ${result.stats.heightMm.toFixed(1)} mm`);
  console.log(
    `estimate: ${cost.volumeMm3.toFixed(0)} mm3 of model, ${cost.grams.toFixed(1)} g, ` +
      `${cost.metres.toFixed(1)} m of filament, ${cost.layers} layers, about ${cost.duration}`,
  );
  for (const slot of cost.slots) {
    console.log(`  slot ${slot.slot} ${slot.colorHex}: ${slot.grams.toFixed(1)} g (${slot.regions.join(", ")})`);
  }
  for (const tile of result.tiles ?? []) {
    console.log(
      `tile ${tile.label}: ${tile.regions.length} regions, ` +
        `${(tile.bbox.max[0] - tile.bbox.min[0]).toFixed(1)} x ` +
        `${(tile.bbox.max[1] - tile.bbox.min[1]).toFixed(1)} x ` +
        `${(tile.bbox.max[2] - tile.bbox.min[2]).toFixed(1)} mm, ` +
        `${(tile.merged?.volumeMm3 ?? 0).toFixed(0)} mm3`,
    );
  }
  for (const path of written) console.log(`wrote ${path}`);
  console.log(`wrote ${sidecarPath}`);
  for (const path of tileFiles) console.log(`wrote ${path}`);
  for (const note of output.notes) console.log(`note: ${note}`);
  for (const finding of result.findings) console.log(`${finding.severity}: ${finding.title} (${finding.detail})`);
  console.log(`engine ${(result.stats.elapsedMs / 1000).toFixed(2)} s, total ${((Date.now() - started) / 1000).toFixed(2)} s`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
