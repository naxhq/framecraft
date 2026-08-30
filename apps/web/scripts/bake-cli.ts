// FrameCraft browser-engine bake, from the command line.
//
//   npm run bake:cli -- --scene ../../fixtures/chicago-scene.json \
//       --params ../../fixtures/print-params-default.json \
//       --target bambu-3mf --out ../../artifacts/chicago-web.3mf
//
// Runs the TypeScript engine (lib/engine/engine.ts) on a SceneGraph JSON and
// a PrintParams JSON, then writes the export for `--target` (any
// PrintParams.export_target value; defaults to the params' own export_target)
// plus a `<stem>.json` sidecar shaped like the Python bake's, so
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
import { buildSidecarJson, sanitizeStem } from "../lib/engine/export/common";
import { EXPORT_TARGETS, exportForTarget, isExportTarget, type ExportTarget } from "../lib/engine/export/index";
import { CREDITS_TEXT } from "../lib/engine/export/stl";
import type { EngineInput, EngineResult } from "../lib/engine/types";
import { resolveProfile } from "../lib/printers";

interface Args {
  scene: string;
  params: string;
  target: ExportTarget | null;
  out: string;
  title: string | null;
}

const USAGE =
  "usage: bake-cli --scene <scene.json> --params <print-params.json> [--target <export_target>] --out <file> [--title <text>]\n" +
  `  targets: ${EXPORT_TARGETS.join(", ")}`;

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
  const scene = values.get("scene");
  const params = values.get("params");
  const out = values.get("out");
  if (!scene || !params || !out) {
    throw new Error(USAGE);
  }
  const target = values.get("target") ?? null;
  if (target !== null && !isExportTarget(target)) {
    throw new Error(`unknown --target ${target}\n${USAGE}`);
  }
  return { scene, params, target, out, title: values.get("title") ?? null };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** The engine's entry point, whichever name lib/engine/engine.ts exports it under. */
type EngineRunner = (input: EngineInput) => Promise<EngineResult> | EngineResult;

interface EngineModule {
  runEngine?: EngineRunner;
  bake?: EngineRunner;
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
      mod.bake ??
      mod.buildEngineResult ??
      (typeof mod.default === "function" ? mod.default : mod.default?.runEngine);
    if (typeof runner === "function") {
      return runner;
    }
    lastError = new Error(`${candidate} exports none of runEngine, bake, buildEngineResult or a default function`);
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    "the browser engine (apps/web/lib/engine/engine.ts) is not available yet, so nothing can be baked from the command line: " + reason,
  );
}

function sidecar(args: Args, result: EngineResult, files: Array<{ name: string; bytes: Uint8Array }>, notes: string[], scene: SceneGraph, elapsedS: number, created: Date) {
  return buildSidecarJson({
    result,
    target: args.target ?? result.params.export_target ?? "bambu-3mf",
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
  const scene = readJson<SceneGraph>(resolve(args.scene));
  const params: PrintParams = { ...defaultPrintParams(), ...readJson<Partial<PrintParams>>(resolve(args.params)) };
  const target: ExportTarget = args.target ?? params.export_target ?? "bambu-3mf";

  const run = await loadEngine();
  const result = await run({ scene, params });

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
  for (const file of output.files) {
    // The first file takes the requested name; companions (MTL) keep their own.
    const path = file === output.files[0] ? outPath : resolve(outDir, file.name);
    writeFileSync(path, file.bytes);
    written.push(path);
  }
  const sidecarPath = resolve(outDir, `${stem}.json`);
  writeFileSync(sidecarPath, JSON.stringify(sidecar(args, result, output.files, output.notes, scene, (Date.now() - started) / 1000, created), null, 2) + "\n");
  writeFileSync(resolve(outDir, "CREDITS.txt"), CREDITS_TEXT);

  console.log(`target ${target}: ${result.regions.length} regions, ${result.stats.triangles} triangles, ${result.stats.widthMm.toFixed(1)} x ${result.stats.depthMm.toFixed(1)} x ${result.stats.heightMm.toFixed(1)} mm`);
  for (const path of written) console.log(`wrote ${path}`);
  console.log(`wrote ${sidecarPath}`);
  for (const note of output.notes) console.log(`note: ${note}`);
  for (const finding of result.findings) console.log(`${finding.severity}: ${finding.title} (${finding.detail})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
