/**
 * Bake polling reducer tests.
 *
 * The `/bake` endpoints are mesh-bake's phase-3 deliverable and do not exist
 * yet, so the state machine is tested against canned `BakeResult` objects that
 * conform to the FROZEN contract. These canned objects live in the TEST only:
 * no app-code path ever fabricates a BakeResult.
 */

import { describe, expect, it } from "vitest";

import { BAKE_API_URL } from "./api";
import {
  bakeDownloadLinks,
  bakeFailedLocally,
  bakeStarted,
  bakeStatusLabel,
  downloadLinks,
  initialBakeState,
  isTerminal,
  markBakeStale,
  reduceBake,
  resolveParamsForBake,
  shouldPoll,
} from "./bake";
import { defaultPrintParams } from "./contracts";
import type { BakeResult, PrintParams } from "./contracts";
import type { TokenContext } from "./tokens";

const queued: BakeResult = {
  job_id: "job-1",
  status: "queued",
  files: null,
  stats: null,
  warnings: [],
  progress: null,
  error: null,
};

const running: BakeResult = {
  ...queued,
  status: "running",
  progress: 0.42,
  warnings: ["47 buildings widened to meet minimum feature size"],
};

const done: BakeResult = {
  job_id: "job-1",
  status: "done",
  files: { "3mf": "/files/ab12.3mf", stl: "/files/ab12.stl" },
  stats: {
    triangles: 412330,
    volume_mm3: 39122.5,
    bbox_mm: [180, 180, 41.2],
    est_grams: 48.6,
    is_manifold: true,
    min_wall_mm: 0.81,
  },
  warnings: ["47 buildings widened to meet minimum feature size"],
  progress: 1,
  error: null,
};

const failed: BakeResult = {
  job_id: "job-1",
  status: "failed",
  files: null,
  stats: null,
  warnings: [],
  progress: 0.6,
  error: "watertight: mesh has 12 boundary edges",
};

describe("lifecycle", () => {
  it("runs queued -> running -> done", () => {
    let state = bakeStarted("job-1");
    expect(state.phase).toBe("queued");
    expect(shouldPoll(state)).toBe(true);

    state = reduceBake(state, queued);
    expect(state.phase).toBe("queued");
    expect(state.progress).toBeNull();

    state = reduceBake(state, running);
    expect(state.phase).toBe("running");
    expect(state.progress).toBeCloseTo(0.42, 9);
    expect(state.warnings).toHaveLength(1);
    expect(shouldPoll(state)).toBe(true);

    state = reduceBake(state, done);
    expect(state.phase).toBe("done");
    expect(state.progress).toBe(1);
    expect(state.result?.stats?.triangles).toBe(412330);
    expect(shouldPoll(state)).toBe(false);
    expect(isTerminal(state.phase)).toBe(true);
  });

  it("carries the failing validator name into the error", () => {
    const state = reduceBake(bakeStarted("job-1"), failed);
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("watertight: mesh has 12 boundary edges");
    expect(shouldPoll(state)).toBe(false);
  });

  it("always produces a message even if the server names no reason", () => {
    const state = reduceBake(bakeStarted("job-1"), { ...failed, error: null });
    expect(state.error).toBeTruthy();
  });

  it("never polls an idle state", () => {
    expect(shouldPoll(initialBakeState)).toBe(false);
    expect(bakeStatusLabel(initialBakeState)).toBe("Not baked yet");
  });
});

describe("progress handling", () => {
  it("keeps the last known value when the server omits progress", () => {
    let state = reduceBake(bakeStarted("job-1"), running);
    state = reduceBake(state, { ...running, progress: null });
    expect(state.progress).toBeCloseTo(0.42, 9);
  });

  it("never moves backwards and never leaves 0..1", () => {
    let state = reduceBake(bakeStarted("job-1"), { ...running, progress: 0.8 });
    state = reduceBake(state, { ...running, progress: 0.1 });
    expect(state.progress).toBeCloseTo(0.8, 9);
    state = reduceBake(state, { ...running, progress: 5 });
    expect(state.progress).toBe(1);
  });

  it("labels the progress row from the contract fields", () => {
    const state = reduceBake(bakeStarted("job-1"), running);
    expect(bakeStatusLabel(state)).toBe("Baking... 42%");
    expect(bakeStatusLabel(reduceBake(state, done))).toBe("Done");
    expect(bakeStatusLabel(reduceBake(state, failed))).toContain("watertight");
  });
});

describe("stale responses", () => {
  it("ignores a poll answer for a job the user already replaced", () => {
    const state = reduceBake(bakeStarted("job-2"), running);
    expect(state.phase).toBe("queued");
    expect(state.jobId).toBe("job-2");
  });

  it("accepts the first answer when no job id is known yet", () => {
    const state = reduceBake(initialBakeState, running);
    expect(state.jobId).toBe("job-1");
    expect(state.phase).toBe("running");
  });
});

describe("download links", () => {
  it("prefixes the API base URL and puts 3MF first", () => {
    const state = reduceBake(bakeStarted("job-1"), done);
    const links = downloadLinks(state.result);
    expect(links.map((l) => l.label)).toEqual(["3MF", "STL"]);
    expect(links[0].href).toBe(`${BAKE_API_URL}/files/ab12.3mf`);
    expect(links[0].filename).toBe("ab12.3mf");
    expect(links[1].href).toBe(`${BAKE_API_URL}/files/ab12.stl`);
  });

  it("offers nothing while the job is unfinished or failed", () => {
    expect(downloadLinks(null)).toHaveLength(0);
    expect(downloadLinks(running)).toHaveLength(0);
    expect(downloadLinks(failed)).toHaveLength(0);
  });
});

describe("staleness", () => {
  it("keeps the result but withdraws the downloads", () => {
    const fresh = reduceBake(bakeStarted("job-1"), done);
    expect(bakeDownloadLinks(fresh)).toHaveLength(2);

    const stale = markBakeStale(fresh);
    expect(stale.stale).toBe(true);
    expect(stale.result).toBe(fresh.result);
    expect(stale.phase).toBe("done");
    expect(bakeDownloadLinks(stale)).toHaveLength(0);
    expect(bakeStatusLabel(stale)).toBe("Done (outdated)");
  });

  it("marks a failed bake too, so its error stops looking current", () => {
    const state = markBakeStale(reduceBake(bakeStarted("job-1"), failed));
    expect(state.stale).toBe(true);
  });

  it("leaves a non-terminal or already-stale bake untouched, by identity", () => {
    const queuedState = bakeStarted("job-1");
    expect(markBakeStale(queuedState)).toBe(queuedState);
    expect(markBakeStale(initialBakeState)).toBe(initialBakeState);
    const runningState = reduceBake(queuedState, running);
    expect(markBakeStale(runningState)).toBe(runningState);
    const once = markBakeStale(reduceBake(queuedState, done));
    expect(markBakeStale(once)).toBe(once);
  });

  it("is cleared by the next server response", () => {
    const stale = markBakeStale(reduceBake(bakeStarted("job-1"), done));
    expect(reduceBake(stale, done).stale).toBe(false);
  });
});

describe("transport failures", () => {
  it("end the job locally without losing the job id", () => {
    const state = bakeFailedLocally(bakeStarted("job-1"), "Cannot reach the bake API");
    expect(state.phase).toBe("failed");
    expect(state.jobId).toBe("job-1");
    expect(state.error).toContain("Cannot reach");
    expect(shouldPoll(state)).toBe(false);
  });
});

// ==========================================================================
// resolveParamsForBake ([V3-P1]: token expansion happens once, client-side)
// ==========================================================================

describe("resolveParamsForBake", () => {
  const ctx: TokenContext = {
    lat: 41.8827,
    lon: -87.6233,
    scale_mm_per_m: 168 / 1800,
    radius_m: 900,
    date: "2026-08-29",
    buildings: 994,
    city: "Chicago",
  };
  const noCity: TokenContext = { ...ctx, city: "" };

  function withParams(overrides: Partial<PrintParams>): PrintParams {
    return { ...defaultPrintParams(), ...overrides };
  }

  it("passes the contract defaults through unchanged", () => {
    expect(resolveParamsForBake(defaultPrintParams(), ctx)).toEqual(defaultPrintParams());
  });

  it("sends the fully expanded text, not the raw {token} template", () => {
    const params = withParams({
      frame: true,
      engravings: [{ edge: "top", text: "{city} — {radius}" }],
    });
    const resolved = resolveParamsForBake(params, ctx);
    expect(resolved.engravings).toEqual([
      { edge: "top", text: "Chicago — 900 m" },
    ]);
  });

  it("omits an engraving line that resolves empty, never sends it as \"\"", () => {
    const params = withParams({
      frame: true,
      engravings: [
        { edge: "top", text: "{city}" },
        { edge: "bottom", text: "a real line" },
      ],
    });
    const resolved = resolveParamsForBake(params, noCity);
    expect(resolved.engravings).toEqual([{ edge: "bottom", text: "a real line" }]);
  });

  it("omits every engraving line when the frame is off, rather than failing", () => {
    const params = withParams({
      frame: false,
      engravings: [{ edge: "top", text: "{city}" }, { edge: "bottom", text: "real text" }],
    });
    const resolved = resolveParamsForBake(params, ctx);
    expect(resolved.engravings).toEqual([]);
  });

  it("resolves the underside mark template", () => {
    const params = withParams({
      underside_mark: { enabled: true, template: "{city} {scale} {date}" },
    });
    const resolved = resolveParamsForBake(params, ctx);
    expect(resolved.underside_mark).toEqual({
      enabled: true,
      template: "Chicago 1:10,714 2026-08-29",
    });
  });

  it("turns the underside mark off, rather than sending an empty template, when it resolves empty", () => {
    const params = withParams({
      underside_mark: { enabled: true, template: "{city}" },
    });
    const resolved = resolveParamsForBake(params, noCity);
    expect(resolved.underside_mark?.enabled).toBe(false);
  });

  it("leaves an already-disabled underside mark alone", () => {
    const params = withParams({
      underside_mark: { enabled: false, template: "{city}" },
    });
    const resolved = resolveParamsForBake(params, noCity);
    expect(resolved.underside_mark).toEqual({ enabled: false, template: "{city}" });
  });

  it("leaves every other field untouched", () => {
    const params = withParams({ plate_mm: 220, base_thickness_mm: 5, hanger: "keyhole" });
    const resolved = resolveParamsForBake(params, ctx);
    expect(resolved.plate_mm).toBe(220);
    expect(resolved.base_thickness_mm).toBe(5);
    expect(resolved.hanger).toBe("keyhole");
  });

  it("an unknown {token} survives verbatim: it is someone's literal text, not empty", () => {
    const params = withParams({
      frame: true,
      engravings: [{ edge: "top", text: "{unknown}" }],
    });
    const resolved = resolveParamsForBake(params, ctx);
    expect(resolved.engravings).toEqual([{ edge: "top", text: "{unknown}" }]);
  });
});
