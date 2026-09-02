/**
 * `lib/perf.ts`: the permanent `?perf=1` instrumentation.
 *
 * Three things have to hold, and nothing else in the app checks them:
 *
 * 1. **Off is really off.** Every entry point must be a pass-through when perf
 *    mode is not on, because these calls sit inside the solid pipeline's hot
 *    path. "Off" is asserted as "recorded nothing", which is the observable
 *    form of "cost nothing".
 * 2. **The report has a shape callers can rely on.** The HUD, the console
 *    table and the baseline note all read the same object.
 * 3. **Worker timings merge onto the page clock.** A dedicated worker's
 *    `performance.timeOrigin` is its own creation, so a raw `startMs` would
 *    plot a bake before the navigation that started it. The merge rebases from
 *    `epochMs`, and this is the only place that is proven.
 *
 * The vitest environment is `node`, so `location`/`localStorage` are absent
 * unless a test installs them: exactly the two sources `perfEnabled()` reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PERF_STORAGE_KEY,
  perfBytes,
  perfDrainTimings,
  perfEnabled,
  perfFlush,
  perfMark,
  perfMergeTimings,
  perfRecord,
  perfReport,
  perfReset,
  perfResetDetectionForTest,
  perfResetInstallForTest,
  perfSpan,
  perfSubscribe,
  perfText,
  setPerfEnabled,
  type PerfTiming,
} from "./perf";

type Mutable = Record<string, unknown>;

function installLocation(search: string): void {
  (globalThis as Mutable).location = { search, href: `http://localhost/${search}` };
}

function installStorage(value: string | null): void {
  (globalThis as Mutable).localStorage = {
    getItem: (key: string) => (key === PERF_STORAGE_KEY ? value : null),
  };
}

function clearEnvironment(): void {
  delete (globalThis as Mutable).location;
  delete (globalThis as Mutable).localStorage;
}

beforeEach(() => {
  clearEnvironment();
  perfResetDetectionForTest();
  perfResetInstallForTest();
  perfReset();
});

afterEach(() => {
  clearEnvironment();
  perfResetDetectionForTest();
  perfResetInstallForTest();
  perfReset();
});

describe("perfEnabled", () => {
  it("is off with no query string and no stored preference", () => {
    expect(perfEnabled()).toBe(false);
  });

  it("is on for ?perf=1", () => {
    installLocation("?perf=1");
    expect(perfEnabled()).toBe(true);
  });

  it("ignores any other value of the query parameter", () => {
    installLocation("?perf=0&other=1");
    expect(perfEnabled()).toBe(false);
  });

  it("is on for the stored preference, which is how the desktop app enables it", () => {
    installStorage("1");
    expect(perfEnabled()).toBe(true);
  });

  it("survives a localStorage that throws", () => {
    (globalThis as Mutable).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(perfEnabled()).toBe(false);
  });

  it("caches the detection, so the hot path is one boolean read", () => {
    const getItem = vi.fn(() => "1");
    (globalThis as Mutable).localStorage = { getItem };
    expect(perfEnabled()).toBe(true);
    expect(perfEnabled()).toBe(true);
    expect(perfEnabled()).toBe(true);
    expect(getItem).toHaveBeenCalledTimes(1);
  });

  it("takes an explicit override, which is how a worker is switched on", () => {
    expect(perfEnabled()).toBe(false);
    setPerfEnabled(true);
    expect(perfEnabled()).toBe(true);
    setPerfEnabled(false);
    expect(perfEnabled()).toBe(false);
    setPerfEnabled(null);
    expect(perfEnabled()).toBe(false);
  });
});

describe("recording with perf mode off", () => {
  it("records nothing at all", () => {
    perfMark("mark");
    perfRecord("record", 1, 2);
    perfSpan("span", () => 1);
    expect(perfDrainTimings()).toEqual([]);
  });

  it("still runs the wrapped function and returns its value", () => {
    const fn = vi.fn(() => "value");
    expect(perfSpan("span", fn)).toBe("value");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("still awaits and returns an async function's value", async () => {
    await expect(perfSpan("span", async () => "async")).resolves.toBe("async");
    expect(perfDrainTimings()).toEqual([]);
  });

  it("reports an empty, well-formed report", () => {
    const report = perfReport("off");
    expect(report.enabled).toBe(false);
    expect(report.label).toBe("off");
    expect(report.rows).toEqual([]);
    expect(report.spans).toEqual([]);
    expect(report.navigation).toBeNull();
    expect(report.resources).toEqual([]);
    expect(report.resourceTotals.count).toBe(0);
    expect(report.longTasks).toEqual({ count: 0, longestMs: 0, totalMs: 0, observed: false });
  });

  it("flushes to nothing: no console output, no subscriber call", () => {
    const listener = vi.fn();
    const unsubscribe = perfSubscribe(listener);
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    try {
      expect(perfFlush("nothing")).toBeNull();
      expect(listener).not.toHaveBeenCalled();
      expect(table).not.toHaveBeenCalled();
    } finally {
      table.mockRestore();
      unsubscribe();
    }
  });
});

describe("recording with perf mode on", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  it("records a mark with no duration", () => {
    perfMark("a-mark");
    const [timing] = perfDrainTimings();
    expect(timing.name).toBe("a-mark");
    expect(timing.durationMs).toBeNull();
    // Node is neither a page nor a worker; the scope is whichever this realm
    // looks like, and what matters is that one is always recorded.
    expect(["main", "worker"]).toContain(timing.scope);
    expect(timing.epochMs).toBeGreaterThan(timing.startMs);
  });

  it("records bytes on a mark", () => {
    perfMark("payload", { bytes: 4096 });
    expect(perfDrainTimings()[0].bytes).toBe(4096);
  });

  it("times a synchronous span and returns its value", () => {
    const value = perfSpan("sync", () => {
      let total = 0;
      for (let i = 0; i < 200_000; i += 1) total += i;
      return total;
    });
    expect(value).toBeGreaterThan(0);
    const [timing] = perfDrainTimings();
    expect(timing.name).toBe("sync");
    expect(timing.durationMs).not.toBeNull();
    expect(timing.durationMs ?? -1).toBeGreaterThan(0);
  });

  it("times an asynchronous span to its settlement", async () => {
    const value = await perfSpan("async", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "done";
    });
    expect(value).toBe("done");
    const [timing] = perfDrainTimings();
    expect(timing.name).toBe("async");
    expect(timing.durationMs ?? 0).toBeGreaterThanOrEqual(15);
  });

  it("closes the span and rethrows when the work throws", () => {
    expect(() =>
      perfSpan("throws", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const [timing] = perfDrainTimings();
    expect(timing.name).toBe("throws");
    expect(timing.durationMs).not.toBeNull();
  });

  it("closes the span and rethrows when the promise rejects", async () => {
    await expect(perfSpan("rejects", () => Promise.reject(new Error("nope")))).rejects.toThrow(
      "nope",
    );
    const [timing] = perfDrainTimings();
    expect(timing.name).toBe("rejects");
    expect(timing.durationMs).not.toBeNull();
  });

  it("drains the buffer, so a second drain is empty", () => {
    perfMark("one");
    expect(perfDrainTimings()).toHaveLength(1);
    expect(perfDrainTimings()).toHaveLength(0);
  });
});

describe("perfReport", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  it("folds same-named timings into one row with a count and a summed duration", () => {
    perfRecord("solid.frame", 10, 4);
    perfRecord("solid.frame", 20, 6);
    perfRecord("solid.base", 30, 5);
    const report = perfReport("folded");
    expect(report.enabled).toBe(true);
    expect(report.rows).toHaveLength(2);
    const frame = report.rows.find((row) => row.name === "solid.frame");
    expect(frame?.count).toBe(2);
    expect(frame?.totalMs).toBeCloseTo(10, 6);
    expect(frame?.lastMs).toBeCloseTo(6, 6);
    expect(frame?.startMs).toBeCloseTo(10, 6);
  });

  it("orders rows by when they started, not alphabetically", () => {
    perfRecord("zebra", 5, 1);
    perfRecord("apple", 50, 1);
    expect(perfReport().rows.map((row) => row.name)).toEqual(["zebra", "apple"]);
  });

  it("sums bytes across a row and leaves null when none carried any", () => {
    perfMark("export.bytes", { bytes: 1_000 });
    perfMark("export.bytes", { bytes: 2_500 });
    perfRecord("solid.base", 1, 1);
    const report = perfReport();
    expect(report.rows.find((row) => row.name === "export.bytes")?.bytes).toBe(3_500);
    expect(report.rows.find((row) => row.name === "solid.base")?.bytes).toBeNull();
  });

  it("keeps every raw span beside the folded rows", () => {
    perfRecord("a", 1, 1);
    perfRecord("a", 2, 1);
    const report = perfReport();
    expect(report.spans).toHaveLength(2);
    expect(report.rows).toHaveLength(1);
  });

  it("has no navigation section outside a document", () => {
    expect(perfReport().navigation).toBeNull();
  });
});

describe("perfMergeTimings", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  /**
   * A worker created 5 s into the page's life reports `startMs` relative to
   * ITS origin. Merged naively those rows would sit 5 s earlier than they
   * happened; rebased through `epochMs` they land where they belong.
   */
  it("rebases worker timings from epochMs onto this realm's clock", () => {
    const pageOrigin = performance.timeOrigin;
    const workerOrigin = pageOrigin + 5_000;
    const incoming: PerfTiming[] = [
      {
        name: "solid.buildings",
        scope: "worker",
        startMs: 120,
        durationMs: 42,
        epochMs: workerOrigin + 120,
      },
    ];
    perfMergeTimings(incoming);
    const [merged] = perfDrainTimings();
    expect(merged.name).toBe("solid.buildings");
    expect(merged.scope).toBe("worker");
    expect(merged.durationMs).toBe(42);
    expect(merged.startMs).toBeCloseTo(5_120, 6);
  });

  it("marks every merged timing as worker scope, whatever the sender said", () => {
    perfMergeTimings([
      { name: "engine.bake", scope: "main", startMs: 1, durationMs: 2, epochMs: performance.timeOrigin + 9 },
    ]);
    expect(perfDrainTimings()[0].scope).toBe("worker");
  });

  it("keeps bytes through the merge", () => {
    perfMergeTimings([
      {
        name: "wasm.fetch",
        scope: "worker",
        startMs: 3,
        durationMs: 8,
        epochMs: performance.timeOrigin + 3,
        bytes: 1_234_567,
      },
    ]);
    expect(perfDrainTimings()[0].bytes).toBe(1_234_567);
  });

  it("merges nothing when perf mode is off", () => {
    setPerfEnabled(false);
    perfMergeTimings([
      { name: "solid.base", scope: "worker", startMs: 1, durationMs: 1, epochMs: 1 },
    ]);
    expect(perfDrainTimings()).toEqual([]);
  });

  it("shows worker and page rows side by side in one report", () => {
    perfRecord("export.run", 900, 30);
    perfMergeTimings([
      {
        name: "solid.buildings",
        scope: "worker",
        startMs: 10,
        durationMs: 500,
        epochMs: performance.timeOrigin + 100,
      },
    ]);
    const report = perfReport("merged");
    const scopes = new Set(report.rows.map((row) => row.scope));
    expect(scopes.has("worker")).toBe(true);
    expect(report.rows).toHaveLength(2);
  });
});

describe("perfFlush", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  it("prints a table and notifies every subscriber", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const groupEnd = vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    const listener = vi.fn();
    const unsubscribe = perfSubscribe(listener);
    try {
      perfRecord("engine.bake", 10, 1_234);
      const report = perfFlush("engine job");
      expect(report?.label).toBe("engine job");
      expect(table).toHaveBeenCalled();
      expect(group).toHaveBeenCalledWith("FrameCraft perf: engine job");
      expect(groupEnd).toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(report);
    } finally {
      unsubscribe();
      table.mockRestore();
      group.mockRestore();
      groupEnd.mockRestore();
    }
  });

  it("stops calling a listener that unsubscribed", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const groupEnd = vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    const listener = vi.fn();
    perfSubscribe(listener)();
    try {
      perfFlush("dropped");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      table.mockRestore();
      group.mockRestore();
      groupEnd.mockRestore();
    }
  });
});

describe("perfText", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  it("writes one tab-separated line per row, which is what Copy puts on the clipboard", () => {
    perfRecord("overpass.fetch", 100, 812.4);
    perfMark("export.bytes", { bytes: 2_000_000 });
    const text = perfText(perfReport("copy"));
    expect(text).toContain("FrameCraft perf: copy");
    expect(text).toContain("name\tscope\tcount\tms\tbytes");
    expect(text).toMatch(/overpass\.fetch\t\w+\t1\t812\.4\t/);
    expect(text).toContain("export.bytes");
    expect(text).toContain("2000000");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("perfBytes", () => {
  it("uses the decimal units DevTools shows", () => {
    expect(perfBytes(512)).toBe("512 B");
    expect(perfBytes(2_048)).toBe("2.0 kB");
    expect(perfBytes(1_500_000)).toBe("1.50 MB");
  });
});

describe("perfReset", () => {
  it("drops every recorded timing", () => {
    setPerfEnabled(true);
    perfMark("one");
    perfMark("two");
    perfReset();
    expect(perfReport().rows).toEqual([]);
  });
});
