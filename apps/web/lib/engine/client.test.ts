import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import {
  EngineClient,
  EngineClientError,
  PipelineClient,
  createEngineClient,
  createWorkerTransportForTest,
  type WorkerLike,
} from "./client";
import { blockScene } from "./pipeline/testScenes";
import type { RunJobMessage, WorkerRequest, WorkerResponse } from "./protocol";
import { building, scene } from "./solid/fixture";
import type { EngineResult, RegionMesh } from "./types";

/**
 * A fake `Worker`: records every `postMessage` call and lets the test push
 * `onmessage`/`onerror` events back, so `WorkerTransport`'s wiring (and
 * therefore the clients' protocol logic on top of it) is exercised without a
 * real worker thread.
 */
class MockWorker implements WorkerLike {
  readonly sent: WorkerRequest[] = [];
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(message: unknown): void {
    this.sent.push(message as WorkerRequest);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function clientOverMockWorker(): { client: EngineClient; worker: MockWorker } {
  const worker = new MockWorker();
  const client = new EngineClient({ transport: createWorkerTransportForTest(worker) });
  return { client, worker };
}

const REQUEST = { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0, preset_id: "chicago-loop" };

function lastRun(worker: MockWorker): RunJobMessage {
  const runs = worker.sent.filter((m): m is RunJobMessage => m.kind === "run");
  return runs[runs.length - 1];
}

function fakeMesh(region: RegionMesh["region"], filled: boolean): RegionMesh {
  return {
    region,
    positions: filled ? new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) : new Float64Array(0),
    indices: filled ? new Uint32Array([0, 1, 2]) : new Uint32Array(0),
    volumeMm3: 1,
    bbox: { min: [0, 0, 0], max: [1, 1, 0] },
    bodies: 1,
    slot: 1,
    colorHex: "#D8D3C6",
  };
}

function fakeResult(regions: RegionMesh[]): EngineResult {
  return {
    regions,
    merged: fakeMesh("base", true),
    stats: {
      scaleDenominator: 1,
      minWallMm: 0.8,
      measuredMinWallMm: null,
      buildings: 0,
      buildingsMerged: 0,
      buildingsDilated: 0,
      heightFallbacks: 0,
      triangles: 0,
      widthMm: 0,
      depthMm: 0,
      heightMm: 0,
      elapsedMs: 1,
    },
    findings: [],
    resolvedText: [],
    params: defaultPrintParams(),
  };
}

describe("EngineClient over a mock Worker (protocol wiring)", () => {
  it("ingest posts a scene-mode run for the request and resolves with the scene the worker streams back", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.ingest(REQUEST);
    expect(worker.sent).toHaveLength(1);
    const run = lastRun(worker);
    expect(run).toMatchObject({ kind: "run", mode: "scene", source: { kind: "request", request: REQUEST } });
    // Perf off: no `perf` key on the wire at all (v3-00 audit finding 7).
    expect(run).not.toHaveProperty("perf");

    const fakeScene = scene({ buildings: [building("w1", [[0, 0], [10, 0], [10, 10], [0, 10]])] });
    worker.emit({ kind: "scene-ready", id: run.id, scene: fakeScene as never, hash: "h1", fromCache: true });
    worker.emit({ kind: "done", id: run.id, result: null, regionHashes: {}, elapsedMs: 3 });

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromCache).toBe(true);
      expect(result.scene.buildings).toHaveLength(1);
    }
  });

  it("resolves ingest with ok:false when the fetch stage reports a fail-soft Overpass error", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.ingest(REQUEST);
    const run = lastRun(worker);
    worker.emit({
      kind: "error",
      id: run.id,
      stage: "fetch",
      message: "boom",
      detail: { overpass: { kind: "network", mirrorsTried: ["https://overpass-api.de/api/interpreter"], message: "boom" } },
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });

  it("buildModel posts a full run carrying the scene, and re-attaches the streamed region meshes to the stripped result", async () => {
    const { client, worker } = clientOverMockWorker();
    const input = { scene: scene(), params: defaultPrintParams() };
    const pending = client.buildModel(input);
    const run = lastRun(worker);
    expect(run).toMatchObject({ kind: "run", mode: "full", source: { kind: "scene" } });
    expect(run.source.kind === "scene" ? run.source.key.length : 0).toBe(40);

    worker.emit({ kind: "region-ready", id: run.id, regions: [fakeMesh("base", true)], removed: [] });
    worker.emit({ kind: "done", id: run.id, result: fakeResult([fakeMesh("base", false)]), regionHashes: { base: "k" }, elapsedMs: 5 });

    const result = await pending;
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].positions.length).toBe(9);
    expect(result.regions[0].indices.length).toBe(3);
  });

  it("a second build with the scene the last ingest returned sends a key, not the scene", async () => {
    const { client, worker } = clientOverMockWorker();
    const ingest = client.ingest(REQUEST);
    const first = lastRun(worker);
    const fakeScene = scene();
    worker.emit({ kind: "scene-ready", id: first.id, scene: fakeScene as never, hash: "scene-hash", fromCache: false });
    worker.emit({ kind: "done", id: first.id, result: null, regionHashes: {}, elapsedMs: 1 });
    const outcome = await ingest;
    if (!outcome.ok) throw new Error("ingest failed");

    void client.buildModel({ scene: outcome.scene, params: defaultPrintParams() });
    expect(lastRun(worker).source).toEqual({ kind: "cached", key: "scene-hash" });
  });

  it("a build requested while an ingest is in flight waits for the ingest instead of superseding it", async () => {
    const { client, worker } = clientOverMockWorker();
    const ingest = client.ingest(REQUEST);
    const ingestId = lastRun(worker).id;
    const build = client.buildModel({ scene: scene(), params: defaultPrintParams() });
    // No cancel for the ingest, no second run yet.
    await Promise.resolve();
    expect(worker.sent.filter((m) => m.kind === "run")).toHaveLength(1);
    expect(worker.sent.some((m) => m.kind === "cancel")).toBe(false);
    worker.emit({ kind: "scene-ready", id: ingestId, scene: scene() as never, hash: "h", fromCache: false });
    worker.emit({ kind: "done", id: ingestId, result: null, regionHashes: {}, elapsedMs: 1 });
    await expect(ingest).resolves.toMatchObject({ ok: true });
    // The build goes out once the ingest has settled.
    await vi.waitFor(() => {
      expect(worker.sent.filter((m) => m.kind === "run")).toHaveLength(2);
    });
    const buildId = lastRun(worker).id;
    worker.emit({ kind: "done", id: buildId, result: fakeResult([]), regionHashes: {}, elapsedMs: 1 });
    await expect(build).resolves.toMatchObject({ regions: [] });
  });

  it("rejects a build with the stage's message on an error event", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.buildModel({ scene: scene(), params: defaultPrintParams() });
    worker.emit({ kind: "error", id: lastRun(worker).id, stage: "context", message: "the scene has no extent" });
    await expect(pending).rejects.toThrow("the scene has no extent");
  });

  it("routes stage progress to the right job's onProgress callback only", async () => {
    const { client, worker } = clientOverMockWorker();
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const pendingA = client.ingest(REQUEST, undefined, { onProgress: (m) => messagesA.push(m) });
    const idA = lastRun(worker).id;
    worker.emit({ kind: "stage", id: idA, stage: "fetch", phase: "scene", index: 0, total: 2, state: "start", elapsedMs: 0 });
    worker.emit({ kind: "scene-ready", id: idA, scene: scene() as never, hash: "h", fromCache: false });
    worker.emit({ kind: "done", id: idA, result: null, regionHashes: {}, elapsedMs: 1 });
    await pendingA;

    const pendingB = client.buildModel({ scene: scene(), params: defaultPrintParams() }, { onProgress: (m) => messagesB.push(m) });
    const idB = lastRun(worker).id;
    worker.emit({ kind: "stage", id: idB, stage: "lettering", phase: "geometry", index: 15, total: 70, state: "start", elapsedMs: 0 });
    worker.emit({ kind: "error", id: idB, stage: "lettering", message: "stop" });
    await pendingB.catch(() => undefined);

    expect(messagesA).toEqual(["Fetching from OpenStreetMap...", "Building fetch (1/2)"]);
    expect(messagesB).toEqual(["Building...", "Building lettering (16/70)"]);
  });

  it("superseding an in-flight ingest rejects the old promise as cancelled and posts a cancel for it", async () => {
    const { client, worker } = clientOverMockWorker();
    const first = client.ingest(REQUEST);
    const firstId = lastRun(worker).id;

    const second = client.ingest({ ...REQUEST, lat: 40 });
    expect(worker.sent).toContainEqual(expect.objectContaining({ kind: "cancel", id: firstId }));

    await expect(first).rejects.toBeInstanceOf(EngineClientError);
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    const secondId = lastRun(worker).id;
    worker.emit({ kind: "scene-ready", id: secondId, scene: scene() as never, hash: "h2", fromCache: false });
    worker.emit({ kind: "done", id: secondId, result: null, regionHashes: {}, elapsedMs: 1 });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("a superseded job's late worker messages are dropped, not resolved twice", async () => {
    const { client, worker } = clientOverMockWorker();
    const first = client.ingest(REQUEST);
    const firstId = lastRun(worker).id;
    void client.ingest({ ...REQUEST, lat: 40 });
    await expect(first).rejects.toBeInstanceOf(EngineClientError);
    expect(() => {
      worker.emit({ kind: "cancelled", id: firstId, atStage: "normalise" });
      worker.emit({ kind: "done", id: firstId, result: null, regionHashes: {}, elapsedMs: 1 });
    }).not.toThrow();
  });

  it("a worker cancelled event rejects the pending job as cancelled", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.buildModel({ scene: scene(), params: defaultPrintParams() });
    worker.emit({ kind: "cancelled", id: lastRun(worker).id, atStage: "assembly" });
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });

  it("a worker onerror rejects every pending job with a transport error", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.buildModel({ scene: scene(), params: defaultPrintParams() });
    worker.fail("the engine worker script threw");
    await expect(pending).rejects.toMatchObject({ code: "transport" });
  });

  it("dispose() rejects the pending job and terminates the worker; later calls reject without posting; a second dispose is a no-op", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.buildModel({ scene: scene(), params: defaultPrintParams() });
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    expect(worker.terminated).toBe(true);
    const before = worker.sent.length;
    await expect(client.ingest(REQUEST)).rejects.toMatchObject({ code: "disposed" });
    await expect(client.buildModel({ scene: scene(), params: defaultPrintParams() })).rejects.toMatchObject({ code: "disposed" });
    expect(worker.sent.length).toBe(before);
    expect(() => client.dispose()).not.toThrow();
  });
});

describe("PipelineClient over a mock Worker", () => {
  it("run() streams progress, regions and the scene, and resolves done with the stripped result and the region hashes", async () => {
    const worker = new MockWorker();
    const client = new PipelineClient(createWorkerTransportForTest(worker));
    const handle = client.run({ source: { kind: "scene", scene: scene(), key: "s" }, params: defaultPrintParams(), mode: "preview" });
    const progress: string[] = [];
    const regions: string[] = [];
    handle.progress.subscribe((event) => progress.push(event.kind === "stage" ? `${event.stage}:${event.state}` : event.kind));
    handle.regions.subscribe((event) => regions.push(...event.regions.map((r) => r.region)));
    worker.emit({ kind: "plan", id: handle.id, total: 3, stages: ["fetch", "normalise", "context"] });
    worker.emit({ kind: "stage", id: handle.id, stage: "fetch", phase: "scene", index: 0, total: 3, state: "skipped", elapsedMs: 0 });
    worker.emit({ kind: "region-ready", id: handle.id, regions: [fakeMesh("base", true)], removed: ["frame"] });
    worker.emit({ kind: "phase", id: handle.id, phase: "region", elapsedMs: 9 });
    worker.emit({ kind: "done", id: handle.id, result: null, regionHashes: { base: "k1" }, elapsedMs: 10 });
    const done = await handle.done;
    expect(progress).toEqual(["plan", "fetch:skipped", "phase"]);
    expect(regions).toEqual(["base"]);
    expect(done.regionHashes).toEqual({ base: "k1" });
    expect(done.result).toBeNull();
  });

  it("exportFiles() posts an export job and resolves with the files the worker returns", async () => {
    const worker = new MockWorker();
    const client = new PipelineClient(createWorkerTransportForTest(worker));
    const pending = client.exportFiles({ target: "stl", createdIso: "2026-09-02T00:00:00Z" });
    const posted = worker.sent[0];
    expect(posted).toMatchObject({ kind: "export", request: { target: "stl" } });
    const id = (posted as { id: number }).id;
    worker.emit({
      kind: "files",
      id,
      output: { target: "stl", files: [{ name: "a.stl", mime: "model/stl", bytes: new Uint8Array(4) }], sidecar: {}, sidecarName: "a.json", notes: [], plan: null },
    });
    const files = await pending;
    expect(files.files[0].name).toBe("a.stl");
  });

  it("handle.cancel() rejects done as cancelled and posts a cancel message", async () => {
    const worker = new MockWorker();
    const client = new PipelineClient(createWorkerTransportForTest(worker));
    const handle = client.run({ source: { kind: "scene", scene: scene(), key: "s" }, params: defaultPrintParams() });
    handle.cancel();
    expect(worker.sent).toContainEqual(expect.objectContaining({ kind: "cancel", id: handle.id }));
    await expect(handle.done).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("the in-page fallback (no Worker: this is what vitest itself uses)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createEngineClient() picks the fallback in this environment (Worker is undefined in Node)", () => {
    expect(typeof Worker).toBe("undefined");
  });

  it("really runs an ingest end to end and fails soft on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    const client = createEngineClient();
    try {
      const result = await client.ingest(REQUEST);
      expect(result.ok).toBe(false);
    } finally {
      client.dispose();
    }
  }, 60_000);

  it("a build superseded while it is still queued is cancelled, and the newest one still resolves", async () => {
    const client = createEngineClient();
    try {
      const tinyScene = scene({ buildings: [building("w1", [[0, 0], [12, 0], [12, 12], [0, 12]], 20)] });
      const params = { ...defaultPrintParams(), frame: false, trees: false, water: false };
      const running = client.buildModel({ scene: tinyScene, params });
      const queued = client.buildModel({ scene: tinyScene, params });
      const latest = client.buildModel({ scene: tinyScene, params });

      await expect(running).rejects.toMatchObject({ code: "cancelled" });
      await expect(queued).rejects.toMatchObject({ code: "cancelled" });
      const result = await latest;
      expect(result.regions.some((r) => r.region === "base")).toBe(true);
    } finally {
      client.dispose();
    }
  }, 60_000);

  it("really runs a build end to end on a tiny synthetic scene, with the streamed positions back on the result", async () => {
    const client = createEngineClient();
    try {
      const tinyScene = scene({ buildings: [building("w1", [[0, 0], [12, 0], [12, 12], [0, 12]], 20)] });
      const params = { ...defaultPrintParams(), frame: false, trees: false, water: false };
      const result = await client.buildModel({ scene: tinyScene, params });
      expect(result.regions.length).toBeGreaterThan(0);
      const base = result.regions.find((r) => r.region === "base");
      expect(base).toBeDefined();
      expect(base!.positions.length).toBeGreaterThan(0);
      expect(result.merged.positions.length).toBeGreaterThan(0);
    } finally {
      client.dispose();
    }
  }, 60_000);

  it("PipelineClient: a preview run streams the regions progressively and an export afterwards returns files", async () => {
    const client = new PipelineClient();
    try {
      const handle = client.run({ source: { kind: "scene", scene: blockScene(), key: "block" }, params: defaultPrintParams(), mode: "preview", date: "2026-09-02" });
      const batches: string[][] = [];
      handle.regions.subscribe((event) => batches.push(event.regions.map((r) => r.region)));
      const states: string[] = [];
      handle.progress.subscribe((event) => {
        if (event.kind === "stage") states.push(event.state);
      });
      const done = await handle.done;
      expect(done.result).toBeNull();
      expect(batches.flat()).toContain("base");
      expect(batches.flat()).toContain("buildings");
      expect(states).toContain("done");
      // The export runs the audit phase over the cached regions and writes the file.
      const files = await client.exportFiles({ target: "stl", createdIso: "2026-09-02T00:00:00Z", stem: "block" });
      expect(files.files.map((f) => f.name)).toEqual(["block.stl"]);
      expect(files.sidecar).toHaveProperty("print_params");
    } finally {
      client.dispose();
    }
  }, 90_000);
});
