/**
 * `[V3-P3-U]` restated for one worker: a running build must never make an
 * ingest wait for it. Since v3.1 the two are runs of the same pipeline on the
 * same worker, so the guarantee is no longer "a second worker" but "the build
 * stops at its next stage boundary and the ingest goes first"; the build's
 * promise rejects `cancelled`, its completed stages stay cached, and the
 * build that follows the ingest reuses them.
 *
 * Real runs through the inline transport on the small synthetic scene, with
 * Overpass stubbed to answer the committed Chicago Loop fixture: no mock of
 * the engine, because the thing under test is where the engine yields.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import { createEngineClient, type ProgressEvent } from "./client";
import { blockScene } from "./pipeline/testScenes";
import { resetOverpassCacheForTest } from "./protocol";

const here = dirname(fileURLToPath(import.meta.url));
const RAW = JSON.parse(readFileSync(resolve(here, "../../../../tests/fixtures/overpass-tiny-loop.json"), "utf-8")) as unknown;
const REQUEST = { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0, preset_id: "chicago-loop" };

describe("EngineClient: an in-flight build never blocks an ingest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetOverpassCacheForTest();
  });

  it("an ingest requested during a build resolves; the build stops at its next stage boundary and rejects cancelled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => RAW })),
    );
    const client = createEngineClient();
    try {
      const order: string[] = [];
      const states: string[] = [];
      const buildPending = client
        .buildModel({ scene: blockScene(), params: defaultPrintParams(), date: "2026-09-02" }, { onProgress: (m) => states.push(m) })
        .then(
          () => {
            order.push("build");
          },
          (error: unknown) => {
            order.push(`build:${(error as { code?: string }).code ?? "error"}`);
          },
        );
      // Let the build get under way (its first stages reported) before the
      // ingest arrives, so the ingest genuinely interrupts a running job.
      await vi.waitFor(() => {
        expect(states.length).toBeGreaterThan(3);
      });
      const ingestPending = client.ingest(REQUEST).then((result) => {
        order.push("ingest");
        return result;
      });

      const ingested = await ingestPending;
      expect(ingested.ok).toBe(true);
      await buildPending;
      // The build never finished: it was superseded at a stage boundary, and
      // the ingest came back first.
      expect(order).toEqual(["build:cancelled", "ingest"]);
    } finally {
      client.dispose();
    }
  }, 90_000);

  it("the stages a superseded build completed are reused by the next build of the same scene", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => RAW })));
    const client = createEngineClient();
    try {
      const scene = blockScene();
      const first = client.pipeline.run({ source: { kind: "scene", scene, key: "block" }, params: defaultPrintParams(), date: "2026-09-02", mode: "full" });
      // Let it get as far as the repaired buildings, then supersede it:
      // whatever it finished stays in the worker's cache.
      await new Promise<void>((resolveProgress) => {
        first.progress.subscribe((event) => {
          if (event.kind === "stage" && event.stage === "repair-buildings" && event.state === "done") resolveProgress();
        });
      });
      const cached: string[] = [];
      const ran: string[] = [];
      const handle = client.pipeline.run({
        source: { kind: "scene", scene, key: "block" },
        params: defaultPrintParams(),
        date: "2026-09-02",
        mode: "full",
      });
      handle.progress.subscribe((event: ProgressEvent) => {
        if (event.kind !== "stage") return;
        if (event.state === "cached") cached.push(event.stage);
        if (event.state === "done") ran.push(event.stage);
      });
      await expect(first.done).rejects.toMatchObject({ code: "cancelled" });
      const done = await handle.done;
      expect(done.result).not.toBeNull();
      // The second run served the first run's completed stages from the cache
      // (the repair among them) and ran the rest; nothing was run twice.
      expect(cached).toContain("repair-buildings");
      expect(cached.filter((stage) => ran.includes(stage))).toEqual([]);
    } finally {
      client.dispose();
    }
  }, 90_000);
});

describe("cancel latency (audit finding 9)", () => {
  it("an ingest requested during a build on the block scene resolves within the longest stage of that scene, well under 3 s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => RAW })));
    const client = createEngineClient();
    try {
      const states: string[] = [];
      const build = client.buildModel({ scene: blockScene(), params: defaultPrintParams(), date: "2026-09-02" }, { onProgress: (m) => states.push(m) });
      // The build is expected to reject while the ingest is awaited below;
      // settle it through a handler first so the rejection is never unhandled.
      const outcome = build.then(
        () => "done" as const,
        (error: unknown) => error,
      );
      await vi.waitFor(() => {
        expect(states.length).toBeGreaterThan(3);
      });
      const started = Date.now();
      const ingested = await client.ingest(REQUEST);
      // The build yields at its next stage boundary; on the block scene no
      // stage takes longer than the audit's merged (about 0.6 s), so the
      // ingest cannot wait more than that plus its own fetch and normalise.
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(ingested.ok).toBe(true);
      expect(await outcome).toMatchObject({ code: "cancelled" });
    } finally {
      client.dispose();
    }
  }, 60_000);
});
