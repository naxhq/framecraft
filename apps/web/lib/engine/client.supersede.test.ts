/**
 * `[V3-P3-U]`: a running build must never block an ingest request, however
 * long the build takes. `EngineClient` now runs ingest and build on two
 * entirely separate transports/workers (`client.ts`'s own module docstring
 * explains why); this file proves the CLIENT-LEVEL half of that guarantee --
 * that `EngineClient.ingest()` never waits on a build promise, running or
 * queued -- through the in-page fallback transport, using a "slow fake" build
 * handler (a real `await`ed delay, not a synchronous CPU spin, so a
 * single-threaded test runner can still observe the race).
 *
 * The WORKER-LEVEL half (a real `Worker` running manifold3d with no yield
 * points genuinely cannot process a second message until it returns) is not
 * reproducible in Node at all; that half is proven by `e2e/ui.spec.ts`'s
 * "the detail chip follows the plate, and names a radius that would fix it",
 * unmodified, against a real browser.
 *
 * A dedicated file, not added to `client.test.ts`: `vi.mock("./engine", ...)`
 * is file-scoped but still replaces `buildModel()` for every test in whichever file
 * calls it, and `client.test.ts`'s own "really runs a build end to end" tests
 * need the REAL engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPrintParams } from "../contracts";
import { scene } from "./solid/fixture";

const buildModelMock = vi.fn();
vi.mock("./engine", () => ({ buildModel: (input: unknown) => buildModelMock(input) }));

/** Resolves after `ms`, so the fake build genuinely yields to the event loop instead of spinning the one JS thread the test itself runs on. */
function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fakeBuildResult(regions: unknown[] = []): unknown {
  return {
    regions,
    merged: null,
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

const REQUEST = { lat: 41.8827, lon: -87.6233, radius_m: 900, rotation_deg: 0, preset_id: "chicago-loop" };

describe("EngineClient: an in-flight build never blocks an ingest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    buildModelMock.mockReset();
  });

  it("ingest resolves before a slow build started earlier does", async () => {
    const { createEngineClient } = await import("./client");
    // A single successful attempt, not a thrown network error: `fetchOverpass`
    // retries a THROWN error up to 4 times with real (setTimeout) backoff --
    // 3.5 s minimum -- which would make this test's own timing assertion
    // measure the retry loop instead of the thing it is testing for.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) })),
    );
    // The build will not settle until well after the ingest below does.
    buildModelMock.mockImplementation(() => delay(2_000, fakeBuildResult()));

    const client = createEngineClient();
    try {
      const order: string[] = [];
      const buildPending = client
        .buildModel({ scene: scene(), params: defaultPrintParams() })
        .then((result) => {
          order.push("build");
          return result;
        });

      // Started AFTER the build, still resolves first: nothing in the client
      // makes it wait on the build's promise.
      const ingestPending = client.ingest(REQUEST).then((result) => {
        order.push("ingest");
        return result;
      });

      await ingestPending;
      expect(order).toEqual(["ingest"]);

      await buildPending;
      expect(order).toEqual(["ingest", "build"]);
    } finally {
      client.dispose();
    }
  });

  it("a build superseded while another is still running does not delay a subsequent ingest either", async () => {
    const { createEngineClient } = await import("./client");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) })));
    buildModelMock.mockImplementation(() => delay(2_000, fakeBuildResult()));

    const client = createEngineClient();
    try {
      const firstBuild = client.buildModel({ scene: scene(), params: defaultPrintParams() });
      const secondBuild = client.buildModel({ scene: scene(), params: defaultPrintParams() });
      await expect(firstBuild).rejects.toMatchObject({ code: "cancelled" });

      const started = Date.now();
      await client.ingest(REQUEST);
      // Generous relative to the 2 s fake builds: this only fails if ingest
      // was ever made to wait on either build settling.
      expect(Date.now() - started).toBeLessThan(1_000);

      await secondBuild;
    } finally {
      client.dispose();
    }
  });
});
