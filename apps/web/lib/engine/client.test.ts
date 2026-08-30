import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import { createEngineClient, EngineClient, EngineClientError, createWorkerTransportForTest, type WorkerLike } from "./client";
import type { BakeWireInput, WorkerRequest, WorkerResponse } from "./protocol";
import { building, scene } from "./solid/fixture";

/**
 * A fake `Worker`: records every `postMessage` call and lets the test push
 * `onmessage`/`onerror` events back, so `WorkerTransport`'s wiring (and
 * therefore `EngineClient`'s protocol logic on top of it) is exercised
 * without a real worker thread -- see the E4 brief's "vitest for the client
 * protocol (mock worker)".
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
  const client = new EngineClient(createWorkerTransportForTest(worker));
  return { client, worker };
}

const REQUEST = { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0, preset_id: "chicago-loop" };

describe("EngineClient over a mock Worker (protocol wiring)", () => {
  it("posts an ingest message and resolves with the ok scene the worker sends back", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.ingest(REQUEST);
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toMatchObject({ kind: "ingest", request: REQUEST });
    const id = (worker.sent[0] as { id: number }).id;

    const fakeScene = scene({ buildings: [building("w1", [[0, 0], [10, 0], [10, 10], [0, 10]])] });
    worker.emit({ kind: "ingest-done", id, ok: true, scene: fakeScene as never, fromCache: true });

    const result = await pending;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fromCache).toBe(true);
      expect(result.scene.buildings).toHaveLength(1);
    }
  });

  it("resolves ingest with ok:false when the worker reports a fail-soft error", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.ingest(REQUEST);
    const id = (worker.sent[0] as { id: number }).id;
    worker.emit({
      kind: "ingest-done",
      id,
      ok: false,
      error: { kind: "network", mirrorsTried: ["https://overpass-api.de/api/interpreter"], message: "boom" },
    });
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("network");
  });

  it("posts a bake message and resolves with the EngineResult the worker sends back", async () => {
    const { client, worker } = clientOverMockWorker();
    const input: BakeWireInput = { scene: scene(), params: defaultPrintParams() };
    const pending = client.bake(input);
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toMatchObject({ kind: "bake" });
    const id = (worker.sent[0] as { id: number }).id;

    const fakeResult = {
      regions: [],
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
      params: input.params,
    };
    worker.emit({ kind: "bake-done", id, result: fakeResult as never });

    const result = await pending;
    expect(result).toBe(fakeResult);
  });

  it("rejects a bake with a plain Error carrying the worker's message on bake-error", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.bake({ scene: scene(), params: defaultPrintParams() });
    const id = (worker.sent[0] as { id: number }).id;
    worker.emit({ kind: "bake-error", id, message: "the scene has no extent" });
    await expect(pending).rejects.toThrow("the scene has no extent");
  });

  it("routes progress messages to the right job's onProgress callback only", async () => {
    const { client, worker } = clientOverMockWorker();
    const messagesA: string[] = [];
    const messagesB: string[] = [];
    const pendingA = client.ingest(REQUEST, undefined, { onProgress: (m) => messagesA.push(m) });
    const idA = (worker.sent[0] as { id: number }).id;
    worker.emit({ kind: "ingest-progress", id: idA, message: "fetching A" });
    worker.emit({ kind: "ingest-done", id: idA, ok: true, scene: scene() as never, fromCache: false });
    await pendingA;

    const pendingB = client.bake({ scene: scene(), params: defaultPrintParams() }, { onProgress: (m) => messagesB.push(m) });
    const idB = (worker.sent[1] as { id: number }).id;
    worker.emit({ kind: "bake-progress", id: idB, message: "baking B" });
    worker.emit({ kind: "bake-error", id: idB, message: "stop" });
    await pendingB.catch(() => undefined);

    expect(messagesA).toEqual(["fetching A"]);
    expect(messagesB).toEqual(["baking B"]);
  });

  it("superseding an in-flight ingest rejects the old promise as cancelled and posts a cancel message", async () => {
    const { client, worker } = clientOverMockWorker();
    const first = client.ingest(REQUEST);
    const firstId = (worker.sent[0] as { id: number }).id;

    const second = client.ingest({ ...REQUEST, lat: 40 });
    const cancelMsg = worker.sent.find((m) => m.kind === "cancel" && m.id === firstId);
    expect(cancelMsg).toMatchObject({ kind: "cancel", id: firstId, jobKind: "ingest" });

    await expect(first).rejects.toBeInstanceOf(EngineClientError);
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    const secondId = (worker.sent.filter((m) => m.kind === "ingest")[1] as { id: number }).id;
    worker.emit({ kind: "ingest-done", id: secondId, ok: true, scene: scene() as never, fromCache: false });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("a superseded ingest's late worker response is dropped, not resolved twice", async () => {
    const { client, worker } = clientOverMockWorker();
    const first = client.ingest(REQUEST);
    const firstId = (worker.sent[0] as { id: number }).id;
    void client.ingest({ ...REQUEST, lat: 40 });
    await expect(first).rejects.toBeInstanceOf(EngineClientError);

    // The worker finishes the superseded fetch anyway and posts late; nothing
    // should throw, and the (already-rejected) first promise stays rejected.
    expect(() =>
      worker.emit({ kind: "ingest-done", id: firstId, ok: true, scene: scene() as never, fromCache: false }),
    ).not.toThrow();
  });

  it("superseding an in-flight bake rejects the old promise as cancelled and posts a cancel message", async () => {
    const { client, worker } = clientOverMockWorker();
    const first = client.bake({ scene: scene(), params: defaultPrintParams() });
    const firstId = (worker.sent[0] as { id: number }).id;
    const second = client.bake({ scene: scene(), params: defaultPrintParams() });

    expect(worker.sent).toContainEqual(expect.objectContaining({ kind: "cancel", id: firstId, jobKind: "bake" }));
    await expect(first).rejects.toMatchObject({ code: "cancelled" });

    const secondId = (worker.sent.filter((m) => m.kind === "bake")[1] as { id: number }).id;
    worker.emit({ kind: "bake-done", id: secondId, result: { regions: [] } as never });
    await expect(second).resolves.toMatchObject({ regions: [] });
  });

  it("a worker onerror rejects every job in flight with a transport EngineClientError", async () => {
    const { client, worker } = clientOverMockWorker();
    const ingestPending = client.ingest(REQUEST);
    const bakePending = client.bake({ scene: scene(), params: defaultPrintParams() });

    worker.fail("the worker script threw");

    await expect(ingestPending).rejects.toMatchObject({ code: "transport" });
    await expect(bakePending).rejects.toMatchObject({ code: "transport" });
  });

  it("dispose() rejects every pending job and terminates the worker", async () => {
    const { client, worker } = clientOverMockWorker();
    const pending = client.ingest(REQUEST);
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    expect(worker.terminated).toBe(true);
  });

  it("ingest/bake after dispose reject immediately without posting anything", async () => {
    const { client, worker } = clientOverMockWorker();
    client.dispose();
    const before = worker.sent.length;
    await expect(client.ingest(REQUEST)).rejects.toMatchObject({ code: "disposed" });
    await expect(client.bake({ scene: scene(), params: defaultPrintParams() })).rejects.toMatchObject({
      code: "disposed",
    });
    expect(worker.sent.length).toBe(before);
  });

  it("dispose() a second time does nothing (idempotent, no double-terminate throw)", () => {
    const { client, worker } = clientOverMockWorker();
    client.dispose();
    expect(() => client.dispose()).not.toThrow();
    expect(worker.terminated).toBe(true);
  });
});

describe("EngineClient's in-page fallback (no Worker: this is what vitest itself uses)", () => {
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
  });

  it("really runs a bake end to end on a tiny synthetic scene", async () => {
    const client = createEngineClient();
    try {
      const tinyScene = scene({ buildings: [building("w1", [[0, 0], [12, 0], [12, 12], [0, 12]], 20)] });
      const params = { ...defaultPrintParams(), frame: false, trees: false, water: false };
      const result = await client.bake({ scene: tinyScene, params });
      expect(result.regions.length).toBeGreaterThan(0);
      expect(result.regions.some((r) => r.region === "base")).toBe(true);
    } finally {
      client.dispose();
    }
  }, 30_000);
});
