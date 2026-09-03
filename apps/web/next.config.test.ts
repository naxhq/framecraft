/**
 * `next.config.ts`'s webpack hook, proved on a real webpack build rather than
 * read off the config (`docs/handoff/v3-08-siteperf.md` sections 3 and 10.5).
 *
 * Two builds of one entry that imports the real `maplibre-gl`, `three`,
 * `@react-three/fiber` and `manifold-3d` out of this app's `node_modules`,
 * through the webpack Next ships, in production mode with the client target:
 * one with the hook applied exactly as `next build` applies it (`dev: false`,
 * `isServer: false`), and a control without it. What the hook claims is then
 * a fact about the files webpack wrote and the chunk webpack's own stats put
 * each module in, not about the shape of a config object:
 *
 *  - every `maplibre-gl` module lands in `vendor-maplibre` and nowhere else,
 *    every `three` and `@react-three` module in `vendor-three` and nowhere
 *    else, and `react` (which `@react-three/fiber` pulls in) in neither, so
 *    the two regexes claim what they say and no more;
 *  - the control build writes `manifold.wasm` as an asset, one file of exactly
 *    the bytes in `node_modules`, and the hook's `emit: false` rule stops it,
 *    while the URL the glue's `new URL("manifold.wasm", import.meta.url)`
 *    was rewritten to is still in the chunk, which is the "kept the URL,
 *    skipped the file" the config comment describes.
 *
 * The control carries the hook's `IgnorePlugin(/^node:/)` by hand, because
 * without it the client target cannot compile `manifold-3d`'s glue at all
 * (the `UnhandledSchemeError` the config comment names): it is the one part
 * of the hook the control needs to exist, and it is not under test here.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import nextConfig from "./next.config";

const require = createRequire(import.meta.url);
const here = resolve(__dirname);

// The webpack `next build` runs: Next bundles its own copy and exposes it
// behind `init()`.
interface BundledWebpack {
  init(): void;
  webpack: WebpackFn;
}
interface WebpackFn {
  (config: Record<string, unknown>, callback: (error: Error | null | undefined, stats: WebpackStats | undefined) => void): void;
  IgnorePlugin: new (options: { resourceRegExp: RegExp }) => unknown;
}
interface WebpackStats {
  hasErrors(): boolean;
  toString(options: Record<string, unknown>): string;
  toJson(options: Record<string, unknown>): StatsJson;
}
interface StatsJson {
  assets?: Array<{ name: string; size: number }>;
  chunks?: Array<{ id: string | number; names?: string[]; files?: string[]; modules?: Array<{ name?: string; nameForCondition?: string }> }>;
}

const bundled = require("next/dist/compiled/webpack/webpack") as BundledWebpack;
bundled.init();
const webpack = bundled.webpack;

/** One build's result: the files webpack wrote and where its stats put every module. */
interface Built {
  dir: string;
  assets: Map<string, number>;
  /** chunk name (or id) -> the `node_modules`-relative or entry-relative module names in it. */
  chunks: Map<string, string[]>;
}

const ENTRY = `
import { getVersion } from "maplibre-gl";
import * as THREE from "three";
import { Canvas } from "@react-three/fiber";
import Module from "manifold-3d";
export const probe = [getVersion(), THREE.REVISION, typeof Canvas, typeof Module];
console.log(probe);
`;

function moduleName(module: { name?: string; nameForCondition?: string }): string {
  return (module.nameForCondition ?? module.name ?? "").replace(/\\/g, "/");
}

async function build(root: string, label: string, withHook: boolean): Promise<Built> {
  const dir = join(root, label);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "entry.mjs");
  writeFileSync(entry, ENTRY);
  const out = join(dir, "out");
  const config: Record<string, unknown> = {
    mode: "production",
    target: "web",
    context: here,
    entry: { app: entry },
    output: { path: out, filename: "[name].js", chunkFilename: "[name].js", publicPath: "" },
    resolve: { modules: [join(here, "node_modules"), "node_modules"], extensions: [".js", ".mjs", ".json"] },
    module: { rules: [] },
    plugins: [],
    // The shape `next build` hands the hook: splitChunks as an object with a
    // cacheGroups map (the hook adds its two groups to whatever is there).
    // Minification and scope hoisting are off so the stats name every module
    // and the source stays readable; deterministic ids so the file set is
    // the same on every run.
    optimization: {
      minimize: false,
      concatenateModules: false,
      moduleIds: "deterministic",
      chunkIds: "deterministic",
      splitChunks: { chunks: "all", cacheGroups: {} },
    },
    // No `stats` preset here: one in the config is merged UNDER the options
    // `toJson` is given and would leave the chunk modules unnamed.
    infrastructureLogging: { level: "error" },
  };
  if (withHook) {
    const hook = nextConfig.webpack;
    if (hook === undefined || hook === null) throw new Error("next.config.ts defines no webpack hook");
    hook(config, { dev: false, isServer: false, webpack } as never);
  } else {
    (config.plugins as unknown[]).push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));
  }
  const stats = await new Promise<WebpackStats>((resolvePromise, reject) => {
    webpack(config, (error, result) => {
      if (error) reject(error);
      else if (result === undefined) reject(new Error("webpack returned no stats"));
      else resolvePromise(result);
    });
  });
  if (stats.hasErrors()) throw new Error(`${label}: webpack reported errors:\n${stats.toString({ all: false, errors: true })}`);
  // Every module of every chunk, named: `chunkModulesSpace` defaults to ten
  // per chunk and folds the rest into a "+N modules" row, and without
  // `dependentModules` a chunk lists only the modules that pulled it in (the
  // `three` files behind `@react-three/fiber` would be missing).
  const json = stats.toJson({
    all: false,
    assets: true,
    ids: true,
    modules: true,
    chunks: true,
    chunkModules: true,
    chunkModulesSpace: Infinity,
    dependentModules: true,
    nestedModules: true,
    nestedModulesSpace: Infinity,
  });
  const assets = new Map<string, number>();
  for (const asset of json.assets ?? []) assets.set(asset.name, asset.size);
  const chunks = new Map<string, string[]>();
  for (const chunk of json.chunks ?? []) {
    const name = chunk.names?.[0] ?? String(chunk.id);
    // Every source module carries a name; a nameless row is webpack's own
    // (a runtime module, or a fold of filtered children).
    const modules = (chunk.modules ?? []).map(moduleName).filter((module) => module !== "");
    if (modules.length === 0) throw new Error(`${label}: chunk ${name} reports no named modules; the stats options are wrong`);
    chunks.set(name, modules);
  }
  return { dir: out, assets, chunks };
}

/** The chunks that hold a module matching `pattern`, by chunk name. */
function chunksHolding(built: Built, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const [name, modules] of built.chunks) {
    if (modules.some((module) => pattern.test(module))) out.push(name);
  }
  return out.sort();
}

describe("next.config.ts: the webpack hook, on a real production client build", () => {
  let root = "";
  let hooked: Built;
  let control: Built;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "framecraft-next-config-"));
    hooked = await build(root, "hooked", true);
    control = await build(root, "control", false);
  }, 240_000);

  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  it("both builds wrote the entry chunk and resolved every vendor out of this app's node_modules", () => {
    for (const built of [hooked, control]) {
      expect([...built.assets.keys()]).toContain("app.js");
      expect(chunksHolding(built, /node_modules\/maplibre-gl\//).length).toBeGreaterThan(0);
      expect(chunksHolding(built, /node_modules\/three\//).length).toBeGreaterThan(0);
      expect(chunksHolding(built, /node_modules\/@react-three\//).length).toBeGreaterThan(0);
      expect(chunksHolding(built, /node_modules\/manifold-3d\//).length).toBeGreaterThan(0);
      expect(chunksHolding(built, /entry\.mjs$/)).toEqual(["app"]);
    }
  });

  it("puts every maplibre-gl module in vendor-maplibre and nothing else there; the control has no such chunk", () => {
    expect([...hooked.assets.keys()]).toContain("vendor-maplibre.js");
    expect(chunksHolding(hooked, /node_modules\/maplibre-gl\//)).toEqual(["vendor-maplibre"]);
    const others = (hooked.chunks.get("vendor-maplibre") ?? []).filter((module) => !/node_modules\/maplibre-gl\//.test(module));
    expect(others).toEqual([]);
    expect([...control.assets.keys()].filter((name) => name.startsWith("vendor-"))).toEqual([]);
  });

  it("puts every three and @react-three module in vendor-three, and react (which @react-three pulls in) elsewhere", () => {
    expect([...hooked.assets.keys()]).toContain("vendor-three.js");
    expect(chunksHolding(hooked, /node_modules\/three\//)).toEqual(["vendor-three"]);
    expect(chunksHolding(hooked, /node_modules\/@react-three\//)).toEqual(["vendor-three"]);
    const others = (hooked.chunks.get("vendor-three") ?? []).filter((module) => !/node_modules\/(three|@react-three)\//.test(module));
    expect(others).toEqual([]);
    expect(chunksHolding(hooked, /node_modules\/react\//)).not.toContain("vendor-three");
    expect(chunksHolding(hooked, /node_modules\/react\//).length).toBeGreaterThan(0);
  });

  it("the control writes manifold.wasm once, byte for byte the file in node_modules; the hook's emit:false rule writes it not at all", () => {
    const realBytes = statSync(require.resolve("manifold-3d/manifold.wasm")).size;
    const controlWasm = [...control.assets.entries()].filter(([name]) => name.endsWith(".wasm"));
    expect(controlWasm).toHaveLength(1);
    expect(controlWasm[0][1]).toBe(realBytes);
    expect(readdirSync(control.dir).filter((name) => name.endsWith(".wasm"))).toHaveLength(1);

    expect([...hooked.assets.keys()].filter((name) => name.endsWith(".wasm"))).toEqual([]);
    expect(readdirSync(hooked.dir).filter((name) => name.endsWith(".wasm"))).toEqual([]);
  });

  it("keeps the URL the glue's new URL(..., import.meta.url) was rewritten to, so the dead branch still compiles", () => {
    const [chunk] = chunksHolding(hooked, /node_modules\/manifold-3d\/manifold\.js$/);
    expect(chunk).toBeDefined();
    const file = join(hooked.dir, `${chunk}.js`);
    const source = readFileSync(file, "utf-8");
    // webpack rewrites the expression to `new URL(<asset name>, __webpack_require__.p)`
    // (or the equivalent runtime call); the asset name keeps the `.wasm`
    // extension, and there is no such string in the glue's own source.
    expect(source).toMatch(/\.wasm/);
  });
});
