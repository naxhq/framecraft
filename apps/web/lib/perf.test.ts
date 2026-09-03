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
 *    plot a build before the navigation that started it. The merge rebases from
 *    `epochMs`, and this is the only place that is proven.
 *
 * The vitest environment is `node`, so `location`/`localStorage` are absent
 * unless a test installs them: exactly the two sources `perfEnabled()` reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RUNS,
  PERF_STORAGE_KEY,
  perfBytes,
  perfDrainTimings,
  perfEnabled,
  perfFlush,
  perfInstall,
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
  perfTotalMs,
  perfUninstall,
  setPerfEnabled,
  type PerfTiming,
} from "./perf";

type Mutable = Record<string, unknown>;

/** Burn wall time so a span has a duration a test can compare. */
function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // Spin: `setTimeout` would not extend a SYNCHRONOUS span.
  }
}

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
  delete (globalThis as Mutable).document;
  delete (globalThis as Mutable).__framecraftPerf;
  if (originalObserver === undefined) delete (globalThis as Mutable).PerformanceObserver;
  else (globalThis as Mutable).PerformanceObserver = originalObserver;
}

const originalObserver = (globalThis as Mutable).PerformanceObserver;

interface FakeObserverCalls {
  observed: PerformanceObserverInit[];
  disconnects: number;
}

/**
 * A `PerformanceObserver` that reports exactly the entry types it is given.
 *
 * Firefox is the case that matters: it does NOT throw on
 * `observe({ type: "longtask" })`, it warns and delivers nothing, so throwing
 * is not the test for support and this fake does not throw either.
 */
function installObserver(supported: readonly string[]): FakeObserverCalls {
  const calls: FakeObserverCalls = { observed: [], disconnects: 0 };
  class FakeObserver {
    static supportedEntryTypes: readonly string[] = supported;
    observe(options: PerformanceObserverInit): void {
      calls.observed.push(options);
    }
    disconnect(): void {
      calls.disconnects += 1;
    }
  }
  (globalThis as Mutable).PerformanceObserver = FakeObserver;
  return calls;
}

beforeEach(() => {
  perfUninstall();
  clearEnvironment();
  perfResetDetectionForTest();
  perfResetInstallForTest();
  perfReset();
});

afterEach(() => {
  perfUninstall();
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

/**
 * Nesting. `solid.roads` is recorded INSIDE `solid.surfaces`, so its
 * milliseconds are already part of the parent's; a flat table of both invites
 * a sum that exceeds the build it describes (baseline audit, finding 2).
 */
describe("nested spans", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  it("records a parent and its two children as a tree, not as three siblings", () => {
    perfSpan("parent", () => {
      perfSpan("child.a", () => spin(2));
      perfSpan("child.b", () => spin(2));
    });

    const rows = perfReport("tree").rows;
    expect(rows.map((row) => row.name)).toEqual(["parent", "child.a", "child.b"]);

    const [parent, a, b] = rows;
    expect(parent.depth).toBe(0);
    expect(parent.parent).toBeNull();
    expect(a.depth).toBe(1);
    expect(a.parent).toBe("parent");
    expect(b.depth).toBe(1);
    expect(b.parent).toBe("parent");

    // The parent's own time is what is left after the children are taken out.
    expect(parent.selfMs).toBeCloseTo(parent.totalMs - a.totalMs - b.totalMs, 6);
    expect(a.selfMs).toBeCloseTo(a.totalMs, 6);

    // The total counts the top level only, so it is the parent's wall time and
    // not the inflated sum of every row.
    expect(perfTotalMs(rows)).toBeCloseTo(parent.totalMs, 6);
    const flat = rows.reduce((total, row) => total + row.totalMs, 0);
    expect(flat).toBeGreaterThan(perfTotalMs(rows));
  });

  it("keeps the nesting of a grandchild, and of a mark recorded inside a span", () => {
    perfSpan("outer", () => {
      perfSpan("middle", () => {
        perfSpan("inner", () => spin(1));
        perfMark("inner.mark", { bytes: 8 });
      });
    });
    const rows = perfReport().rows;
    const depths = new Map(rows.map((row) => [row.name, row.depth]));
    expect(depths.get("outer")).toBe(0);
    expect(depths.get("middle")).toBe(1);
    expect(depths.get("inner")).toBe(2);
    expect(depths.get("inner.mark")).toBe(2);
    expect(rows.find((row) => row.name === "inner.mark")?.parent).toBe("middle");
  });

  it("closes the frame that settled, not whichever one is on top", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const firstOpen = perfSpan("first.open", () => sleep(1));
    const stillOpen = perfSpan("second.open", () => sleep(40));
    await firstOpen;
    // `second.open` is the one still running, so this mark belongs to it. A
    // stack that just popped would have closed `second.open` here instead.
    perfMark("during");
    await stillOpen;
    perfSpan("after", () => spin(1));

    const rows = perfReport().rows;
    expect(rows.find((row) => row.name === "during")?.parent).toBe("second.open");
    expect(rows.find((row) => row.name === "after")?.depth).toBe(0);
  });

  it("does not tangle when a span recurses into itself", () => {
    // `export/index.ts` calls the target's own writer once per tile from
    // inside the span named for that target. One row, at the top, not a row
    // that is its own child.
    const writeTiles = (remaining: number): void => {
      perfSpan("export.stl", () => {
        if (remaining > 0) writeTiles(remaining - 1);
      });
    };
    writeTiles(2);

    const rows = perfReport().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
    expect(rows[0].parent).toBeNull();
    expect(rows[0].depth).toBe(0);
  });

  it("indents children and prints a self column in the copied text", () => {
    perfSpan("parent", () => {
      perfSpan("child.a", () => spin(2));
    });
    const text = perfText(perfReport("copy"));
    expect(text).toContain("name\tscope\tcount\tms\tbytes\tself");
    expect(text).toMatch(/\n {2}child\.a\t/);
    expect(text).toMatch(/\nparent\t/);
    expect(text).toContain("total (top level)");
  });
});

/**
 * Runs. Every flush closes one, and rows never fold across a boundary, so a
 * second build cannot double the first one's numbers (audit, finding 9).
 */
describe("runs", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  it("gives each flush its own run id", () => {
    perfRecord("engine.build", 10, 100);
    const first = perfFlush("engine job");
    perfRecord("export.run", 200, 20);
    const second = perfFlush("export");
    expect(first?.runId).toBe(1);
    expect(second?.runId).toBe(2);
    expect(second?.runs.map((run) => run.label)).toEqual(["engine job", "export", "current"]);
    expect(second?.runs.map((run) => run.closed)).toEqual([true, true, false]);
  });

  it("does not fold a second build into the first one's row", () => {
    perfRecord("engine.build", 10, 100);
    perfFlush("engine job");
    perfRecord("engine.build", 500, 300);
    const report = perfFlush("engine job");
    const builds = report?.rows.filter((row) => row.name === "engine.build") ?? [];
    expect(builds).toHaveLength(2);
    expect(builds.map((row) => row.runId)).toEqual([1, 2]);
    expect(builds.map((row) => row.count)).toEqual([1, 1]);
    expect(builds.map((row) => row.totalMs)).toEqual([100, 300]);
  });

  it("prints only the run it just closed to the console", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const groupEnd = vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    try {
      perfRecord("ingest.first", 1, 5);
      perfFlush("ingest");
      table.mockClear();
      perfRecord("export.second", 10, 5);
      perfFlush("export");
      const printed = table.mock.calls[0][0] as { name: string }[];
      expect(printed.map((row) => row.name.trim())).toEqual(["export.second"]);
      expect(group).toHaveBeenLastCalledWith("FrameCraft perf: export (run 2)");
    } finally {
      table.mockRestore();
      group.mockRestore();
      groupEnd.mockRestore();
    }
  });

  it(`keeps the last ${MAX_RUNS} runs and drops what falls off the end`, () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const groupEnd = vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);
    try {
      for (let run = 1; run <= MAX_RUNS + 2; run += 1) {
        perfRecord(`step.${run}`, run, 1);
        perfFlush(`run ${run}`);
      }
      const report = perfReport("after");
      // The last MAX_RUNS closed runs, plus the open one.
      expect(report.runs).toHaveLength(MAX_RUNS + 1);
      expect(report.runs[0].id).toBe(3);
      expect(report.rows.map((row) => row.name)).not.toContain("step.1");
      expect(report.rows.map((row) => row.name)).toContain(`step.${MAX_RUNS + 2}`);
    } finally {
      table.mockRestore();
      group.mockRestore();
      groupEnd.mockRestore();
    }
  });

  it("starts over at run 1 when the HUD's Clear button resets", () => {
    perfRecord("engine.build", 10, 100);
    perfFlush("engine job");
    perfReset();
    expect(perfReport("cleared").runs).toEqual([
      expect.objectContaining({ id: 1, label: "current", closed: false }),
    ]);
    expect(perfReport("cleared").rows).toEqual([]);
  });

  it("stamps merged worker timings with the page's run, not the worker's", () => {
    perfRecord("page.first", 1, 1);
    perfFlush("engine job");
    perfMergeTimings([
      {
        name: "solid.buildings",
        scope: "worker",
        startMs: 10,
        durationMs: 5,
        epochMs: performance.timeOrigin + 10,
        runId: 1,
      },
    ]);
    const merged = perfReport().rows.find((row) => row.name === "solid.buildings");
    expect(merged?.runId).toBe(2);
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
      { name: "engine.build", scope: "main", startMs: 1, durationMs: 2, epochMs: performance.timeOrigin + 9 },
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
      perfRecord("engine.build", 10, 1_234);
      const report = perfFlush("engine job");
      expect(report?.label).toBe("engine job");
      expect(table).toHaveBeenCalled();
      // The heading names the run, because the table under it is that run's
      // rows and nobody else's.
      expect(group).toHaveBeenCalledWith("FrameCraft perf: engine job (run 1)");
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

/** The long-task observer, the window hook, and taking both back off again. */
describe("perfInstall", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  it("observes long tasks where the entry type exists", () => {
    const observer = installObserver(["longtask", "mark"]);
    perfInstall();
    expect(observer.observed).toEqual([{ type: "longtask", buffered: true }]);
    expect(perfReport().longTasks.observed).toBe(true);
  });

  it("reports long tasks as unobserved where the entry type does not exist", () => {
    // Firefox: `observe` does not throw for an unsupported type, it warns and
    // delivers nothing. A confident `observed: true, count: 0` would render as
    // a measured zero.
    const observer = installObserver(["mark", "measure", "resource"]);
    perfInstall();
    expect(observer.observed).toEqual([]);
    expect(perfReport().longTasks).toEqual({
      count: 0,
      longestMs: 0,
      totalMs: 0,
      observed: false,
    });
    expect(perfText(perfReport())).toContain("long tasks: not observed in this browser");
  });

  it("publishes the window hook and takes it back when perf mode is turned off", () => {
    const observer = installObserver(["longtask"]);
    perfInstall();
    expect((globalThis as Mutable).__framecraftPerf).toBeDefined();

    setPerfEnabled(false);
    expect(observer.disconnects).toBe(1);
    expect("__framecraftPerf" in globalThis).toBe(false);
  });

  it("uninstalls without a fuss in a realm that never installed anything", () => {
    installObserver(["longtask"]);
    expect(() => {
      perfUninstall();
    }).not.toThrow();
    expect("__framecraftPerf" in globalThis).toBe(false);
  });
});

/**
 * Navigation Timing. `domContentLoadedEventEnd` and `loadEventEnd` are 0 until
 * their events fire, and the HUD's mount effect is usually earlier than that:
 * 0 would read as an instant load rather than as not-yet (audit, finding 18).
 */
describe("navigation timing", () => {
  interface FakeNavigation {
    loadEventEnd: number;
    domContentLoadedEventEnd: number;
  }

  function installNavigation(fields: FakeNavigation): void {
    (globalThis as Mutable).document = { readyState: "loading" };
    const entry = {
      responseEnd: 120,
      requestStart: 20,
      transferSize: 38_352,
      decodedBodySize: 120_000,
      domInteractive: 300,
      type: "navigate",
      ...fields,
    };
    vi.spyOn(performance, "getEntriesByType").mockImplementation((type: string) =>
      type === "navigation" ? ([entry] as unknown as PerformanceEntryList) : [],
    );
  }

  beforeEach(() => {
    setPerfEnabled(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports an event that has not fired as null, not as zero", () => {
    installNavigation({ loadEventEnd: 0, domContentLoadedEventEnd: 0 });
    const nav = perfReport("early").navigation;
    expect(nav?.loadMs).toBeNull();
    expect(nav?.domContentLoadedMs).toBeNull();
    expect(nav?.domInteractiveMs).toBe(300);
    expect(perfText(perfReport("early"))).toContain("load n/a");
  });

  it("reports the real figures once the events have fired", () => {
    installNavigation({ loadEventEnd: 2_400, domContentLoadedEventEnd: 1_100 });
    const nav = perfReport("loaded").navigation;
    expect(nav?.loadMs).toBe(2_400);
    expect(nav?.domContentLoadedMs).toBe(1_100);
    expect(perfText(perfReport("loaded"))).toContain("load 2400.0 ms");
  });
});

/**
 * The browser's own User Timing buffer. `perfMark` and `finish` also call
 * `performance.mark`/`measure` so a DevTools timeline shows the same spans;
 * nothing reads those back, so a long session would accumulate entries for
 * ever (audit, finding 20).
 */
describe("User Timing buffer", () => {
  beforeEach(() => {
    setPerfEnabled(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the entries of the run it just harvested, by name", () => {
    const clearMarks = vi.spyOn(performance, "clearMarks").mockImplementation(() => undefined);
    const clearMeasures = vi
      .spyOn(performance, "clearMeasures")
      .mockImplementation(() => undefined);
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    const group = vi.spyOn(console, "groupCollapsed").mockImplementation(() => undefined);
    const groupEnd = vi.spyOn(console, "groupEnd").mockImplementation(() => undefined);

    perfMark("export.bytes", { bytes: 2_048 });
    perfSpan("export.run", () => spin(1));
    perfFlush("export");

    expect(clearMarks).toHaveBeenCalledWith("export.bytes");
    expect(clearMarks).toHaveBeenCalledWith("export.run");
    expect(clearMeasures).toHaveBeenCalledWith("export.run");
    // By name, never a bare clearMarks(): Next.js and React put their own
    // entries in the same buffer.
    for (const call of clearMarks.mock.calls) expect(call[0]).toBeTypeOf("string");
    expect(table).toHaveBeenCalled();
    group.mockRestore();
    groupEnd.mockRestore();
  });

  it("clears the entries a worker drains onto its job result", () => {
    const clearMarks = vi.spyOn(performance, "clearMarks").mockImplementation(() => undefined);
    perfMark("solid.buildings");
    expect(perfDrainTimings()).toHaveLength(1);
    expect(clearMarks).toHaveBeenCalledWith("solid.buildings");
  });
});
