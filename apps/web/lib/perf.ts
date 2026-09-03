/**
 * FrameCraft performance mode: a permanent, opt-in instrumentation layer over
 * the browser Performance API.
 *
 * It is OFF unless the page URL carries `?perf=1` or `localStorage` holds
 * `framecraft.perf = "1"` (the desktop shell has no query string, so that is
 * how Tauri turns it on). Off means every entry point here is a single boolean
 * read and a straight call through to the wrapped work: no marks, no measures,
 * no allocation, nothing for the engine to pay for. This matters because the
 * marks sit inside the solid pipeline's hot path, where a build runs thousands
 * of manifold3d calls with no yield points.
 *
 * Three realms record into three different buffers, and only one of them can
 * read the DOM timing sources:
 *
 *  - **The page.** `perfReport()` reads Navigation Timing, Resource Timing and
 *    the paint entries, and merges them with whatever spans this module
 *    recorded (`overpass`, `export`, preview geometry build, ...).
 *  - **The engine workers.** A worker has `performance.now()` and its own
 *    resource entries but no `window`; `worker.ts` switches perf mode on from
 *    the flag `client.ts` puts on the job message, and drains this module's
 *    buffer into the job result's `timings` array
 *    (`lib/engine/protocol.ts`). A worker's `performance.timeOrigin` is the
 *    moment the worker was created, NOT the document's, so every timing also
 *    carries `epochMs` and `perfMergeTimings` rebases it onto the page clock.
 *  - **Node** (`export:cli`, vitest). `perfEnabled()` is false there unless a
 *    caller sets it, and nothing installs an observer.
 *
 * Two shapes the report has that a flat list of numbers does not:
 *
 *  - **Runs.** Everything recorded between two `perfFlush` calls is one run
 *    with its own id. Rows fold within a run and never across one, so a second
 *    build cannot double the first one's `count` and `totalMs`, and the HUD
 *    can show any of the last `MAX_RUNS` on its own.
 *  - **A tree.** `solid.roads` is recorded inside `solid.surfaces`, so its
 *    milliseconds are already part of the parent's. Every row carries `parent`,
 *    `depth` and `selfMs`; only rows at depth 0 may be summed for a total,
 *    which is what `perfTotalMs` does.
 *
 * Turning the mode on: `?perf=1` on the URL, or `localStorage.setItem(
 * "framecraft.perf", "1")`. The stored flag is the durable one and the only
 * one the desktop shell can use. The query parameter does not survive
 * everything the app does to the address bar -- copying a share link replaces
 * the URL with the encoded link (`components/editor/OutputPanel.tsx`), which
 * correctly does not hand perf mode to whoever receives the link, but also
 * means a reload after copying one starts with perf mode off unless the stored
 * flag is set.
 *
 * Nothing in this module throws. A browser without `PerformanceObserver`,
 * without `longtask` support, or with a full mark buffer degrades to fewer
 * rows, never to a broken page.
 */

export const PERF_QUERY_PARAM = "perf";
export const PERF_STORAGE_KEY = "framecraft.perf";

/** Which realm recorded a timing. */
export type PerfScope = "main" | "worker";

/** One recorded mark (`durationMs === null`) or span. */
export interface PerfTiming {
  name: string;
  scope: PerfScope;
  /** Milliseconds since this realm's `performance.timeOrigin`. */
  startMs: number;
  /** Wall duration, or null for an instantaneous mark. */
  durationMs: number | null;
  /** `performance.timeOrigin + startMs`, so another realm can rebase it. */
  epochMs: number;
  /** Bytes this timing accounts for (a WASM fetch, an export payload). */
  bytes?: number;
  /**
   * Which run this timing belongs to. Optional on the wire: a worker numbers
   * its own runs and `perfMergeTimings` re-stamps every incoming timing with
   * the page's current run, which is the only numbering the report uses.
   */
  runId?: number;
  /** The span this one was recorded inside, if any. */
  parent?: string;
  /** How many spans deep this one sits. 0 is top level. */
  depth?: number;
}

/**
 * One line of the report: every timing sharing a name WITHIN ONE RUN, folded
 * together.
 *
 * Rows are a tree, not a list: `solid.roads` is recorded inside
 * `solid.surfaces`, so its milliseconds are already part of the parent's. Sum
 * `totalMs` over rows with `depth === 0` for the run's wall time, or sum
 * `selfMs` over every row; summing `totalMs` over every row double counts the
 * nesting, which is exactly what the flat table used to invite.
 */
export interface PerfRow {
  name: string;
  scope: PerfScope;
  /** The run this row belongs to. Rows never fold across runs. */
  runId: number;
  count: number;
  /** Sum of the durations, 0 for a row of pure marks. Children included. */
  totalMs: number;
  /** `totalMs` minus the total of the rows nested inside this one. */
  selfMs: number;
  /** The row this one is nested inside, or null at top level. */
  parent: string | null;
  /** Nesting depth, 0 at top level: what the indentation renders from. */
  depth: number;
  /** The most recent duration, or null when the row holds only marks. */
  lastMs: number | null;
  /** Sum of the bytes, or null when no timing in the row carried any. */
  bytes: number | null;
  /** Start of the earliest timing in the row, on the page clock. */
  startMs: number;
}

/** One run: everything recorded between two `perfFlush` calls. */
export interface PerfRunInfo {
  id: number;
  /** The flush label that closed the run, or "current" while it is open. */
  label: string;
  /** Page clock milliseconds at which the run closed, or was first seen. */
  atMs: number;
  /** False for the one run still accepting timings. */
  closed: boolean;
}

export type PerfResourceKind =
  | "document"
  | "script"
  | "css"
  | "font"
  | "wasm"
  | "worker"
  | "image"
  | "fetch"
  | "other";

export interface PerfResource {
  /** The file name, which is what a chunk is recognised by. */
  name: string;
  url: string;
  kind: PerfResourceKind;
  /** Bytes on the wire, 0 for a cache hit or an opaque cross-origin response. */
  transferBytes: number;
  decodedBytes: number;
  durationMs: number;
  startMs: number;
}

export interface PerfResourceKindTotal {
  count: number;
  transferBytes: number;
  decodedBytes: number;
  durationMs: number;
}

export interface PerfResourceTotals {
  count: number;
  transferBytes: number;
  decodedBytes: number;
  byKind: Record<PerfResourceKind, PerfResourceKindTotal>;
}

export interface PerfNavigation {
  /** `responseEnd - requestStart`: the HTML document itself. */
  htmlMs: number;
  htmlTransferBytes: number;
  htmlDecodedBytes: number;
  /** Null until the `DOMContentLoaded` event has actually fired. */
  domContentLoadedMs: number | null;
  /** Null until the `load` event has actually fired. */
  loadMs: number | null;
  domInteractiveMs: number;
  firstPaintMs: number | null;
  firstContentfulPaintMs: number | null;
  /** Whether this navigation was served from the back/forward or HTTP cache. */
  type: string;
}

export interface PerfLongTasks {
  count: number;
  longestMs: number;
  totalMs: number;
  /** False when this browser has no `longtask` entry type. */
  observed: boolean;
}

export interface PerfReport {
  enabled: boolean;
  /** What produced this report ("engine job", "export", "hud"). */
  label: string;
  /** Page clock milliseconds at which the report was built. */
  atMs: number;
  /** The run this report is about: the one just closed, or the open one. */
  runId: number;
  /** Every run still held, oldest first, the open one last. */
  runs: PerfRunInfo[];
  rows: PerfRow[];
  spans: PerfTiming[];
  navigation: PerfNavigation | null;
  /** The ten largest resources by transfer size, largest first. */
  resources: PerfResource[];
  resourceTotals: PerfResourceTotals;
  longTasks: PerfLongTasks;
}

const EMPTY_KIND_TOTAL: PerfResourceKindTotal = {
  count: 0,
  transferBytes: 0,
  decodedBytes: 0,
  durationMs: 0,
};

const RESOURCE_KINDS: readonly PerfResourceKind[] = [
  "document",
  "script",
  "css",
  "font",
  "wasm",
  "worker",
  "image",
  "fetch",
  "other",
];

/** How many timings the buffer holds before the oldest are dropped. */
const MAX_TIMINGS = 4000;

/** How many closed runs the buffer keeps before the oldest is dropped. */
export const MAX_RUNS = 10;

/** How many resources a report lists individually. */
export const REPORT_RESOURCE_LIMIT = 10;

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

let override: boolean | null = null;
let detected: boolean | null = null;

interface LocationLike {
  search?: string;
  href?: string;
}

interface StorageLike {
  getItem(key: string): string | null;
}

function globalLocation(): LocationLike | null {
  const holder = globalThis as { location?: LocationLike };
  return holder.location ?? null;
}

function globalStorage(): StorageLike | null {
  try {
    const holder = globalThis as { localStorage?: StorageLike };
    return holder.localStorage ?? null;
  } catch {
    // Storage access can throw outright (a sandboxed iframe, a browser set to
    // block site data). Treat it as "no preference stored".
    return null;
  }
}

function detect(): boolean {
  const location = globalLocation();
  const search = typeof location?.search === "string" ? location.search : "";
  if (search !== "") {
    try {
      if (new URLSearchParams(search).get(PERF_QUERY_PARAM) === "1") return true;
    } catch {
      // A malformed query string is not a reason to fail a page load.
    }
  }
  try {
    if (globalStorage()?.getItem(PERF_STORAGE_KEY) === "1") return true;
  } catch {
    // Same as above: a throwing storage means no preference.
  }
  return false;
}

/**
 * Whether perf mode is on for this realm.
 *
 * Resolved once per realm and cached, so the hot path costs a boolean read.
 * A worker starts out disabled and is switched on explicitly by `worker.ts`
 * from the job message's `perf` flag.
 */
export function perfEnabled(): boolean {
  if (override !== null) return override;
  if (detected === null) detected = detect();
  return detected;
}

/**
 * Force perf mode on or off for this realm; `null` restores auto-detection.
 * `worker.ts` calls this with the flag from the job message, so the engine
 * worker's marks are on exactly when the page's are.
 */
export function setPerfEnabled(value: boolean | null): void {
  override = value;
  // Turning the mode off takes the observer and the window hook with it: a
  // page that is no longer measuring should have nothing of this module
  // installed in it.
  if (!perfEnabled()) perfUninstall();
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const timings: PerfTiming[] = [];

/**
 * Runs.
 *
 * Every timing carries the id of the run it was recorded in, and a run ends
 * when `perfFlush` reports it. Rows fold within a run and never across one, so
 * a second build cannot fold into the first one's row and double its `count`
 * and `totalMs` -- which is what made the published tables depend on an
 * operator remembering to press Clear between runs.
 */
let currentRunId = 1;
const closedRuns: PerfRunInfo[] = [];

/** One open span, while it is open: what nests the spans recorded inside it. */
interface SpanFrame {
  name: string;
  depth: number;
  parent: string | undefined;
}

const spanStack: SpanFrame[] = [];

function openFrame(name: string): SpanFrame {
  const frame: SpanFrame = {
    name,
    depth: spanStack.length,
    parent: spanStack[spanStack.length - 1]?.name,
  };
  spanStack.push(frame);
  return frame;
}

/**
 * Close one frame by identity, not by popping.
 *
 * An asynchronous span stays open until its promise settles, and two of those
 * can settle out of order; removing the exact frame keeps the rest of the
 * stack intact instead of unwinding somebody else's span.
 */
function closeFrame(frame: SpanFrame): void {
  const index = spanStack.lastIndexOf(frame);
  if (index !== -1) spanStack.splice(index, 1);
}

/** Where a mark or a recorded span sits in the current span tree. */
function currentNesting(): { parent?: string; depth: number } {
  const top = spanStack[spanStack.length - 1];
  return top === undefined ? { depth: 0 } : { parent: top.name, depth: top.depth + 1 };
}

function nowMs(): number {
  return performance.now();
}

function timeOriginMs(): number {
  const origin = performance.timeOrigin;
  return typeof origin === "number" && Number.isFinite(origin)
    ? origin
    : Date.now() - performance.now();
}

/** True in an engine worker: `performance` and `self`, but no document. */
function isWorkerRealm(): boolean {
  return typeof document === "undefined" && typeof self !== "undefined";
}

function record(timing: PerfTiming): void {
  timings.push({ ...timing, runId: currentRunId });
  if (timings.length > MAX_TIMINGS) timings.splice(0, timings.length - MAX_TIMINGS);
}

function scope(): PerfScope {
  return isWorkerRealm() ? "worker" : "main";
}

/** Record an instantaneous mark. A no-op when perf mode is off. */
export function perfMark(name: string, options: { bytes?: number } = {}): void {
  if (!perfEnabled()) return;
  const startMs = nowMs();
  record({
    name,
    scope: scope(),
    startMs,
    durationMs: null,
    epochMs: timeOriginMs() + startMs,
    ...currentNesting(),
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
  });
  try {
    performance.mark(name);
  } catch {
    // A full mark buffer, or a runtime without User Timing: the local record
    // above is the one this module reads anyway.
  }
}

/** Record a span that already happened, measured elsewhere (a resource entry). */
export function perfRecord(
  name: string,
  startMs: number,
  durationMs: number,
  options: { bytes?: number } = {},
): void {
  if (!perfEnabled()) return;
  record({
    name,
    scope: scope(),
    startMs,
    durationMs,
    epochMs: timeOriginMs() + startMs,
    ...currentNesting(),
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
  });
}

function finish(name: string, startMs: number, frame: SpanFrame): void {
  const endMs = nowMs();
  closeFrame(frame);
  record({
    name,
    scope: scope(),
    startMs,
    durationMs: endMs - startMs,
    epochMs: timeOriginMs() + startMs,
    depth: frame.depth,
    ...(frame.parent === undefined ? {} : { parent: frame.parent }),
  });
  try {
    performance.measure(name, { start: startMs, end: endMs });
  } catch {
    // Same as `perfMark`: User Timing is the nice-to-have, not the record.
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Time `fn` under `name`.
 *
 * Works for a synchronous function and for one returning a promise: a
 * thenable result extends the span to its settlement, and everything else
 * closes it on return. A throw or a rejection still closes the span (the work
 * really did take that long) and then propagates unchanged.
 *
 * With perf mode off this is `return fn()` after one boolean read.
 */
export function perfSpan<T>(name: string, fn: () => T): T {
  if (!perfEnabled()) return fn();
  const frame = openFrame(name);
  const startMs = nowMs();
  let value: T;
  try {
    value = fn();
  } catch (error) {
    finish(name, startMs, frame);
    throw error;
  }
  if (isThenable(value)) {
    // The cast is the price of one function covering both shapes: `then`
    // returns a Promise of T's awaited type, which for a thenable T is
    // exactly T's own contract to its caller.
    return value.then(
      (resolved) => {
        finish(name, startMs, frame);
        return resolved;
      },
      (error: unknown) => {
        finish(name, startMs, frame);
        throw error;
      },
    ) as unknown as T;
  }
  finish(name, startMs, frame);
  return value;
}

/**
 * Take every timing recorded in this realm and clear the buffer.
 *
 * Called by `worker.ts` when a job finishes, so the timings ride back to the
 * page on the result message instead of dying with the worker's buffer.
 */
export function perfDrainTimings(): PerfTiming[] {
  const drained = timings.slice();
  timings.length = 0;
  clearUserTiming(drained);
  return drained;
}

/**
 * Merge timings recorded in another realm into this one's buffer.
 *
 * `startMs` is rebased from the sender's `epochMs` onto this realm's clock,
 * because a dedicated worker's `performance.timeOrigin` is the moment the
 * worker was created and its raw `startMs` would plot the whole build before
 * the page had even navigated.
 */
export function perfMergeTimings(incoming: readonly PerfTiming[]): void {
  if (!perfEnabled() || incoming.length === 0) return;
  const origin = timeOriginMs();
  for (const timing of incoming) {
    record({
      ...timing,
      scope: "worker",
      startMs: Number.isFinite(timing.epochMs) ? timing.epochMs - origin : timing.startMs,
    });
  }
}

/**
 * Bound the browser's own User Timing buffer.
 *
 * `perfMark`/`finish` also call `performance.mark`/`measure`, so a DevTools
 * timeline shows the same spans. Nothing ever reads those entries back, so
 * once this module has harvested a batch they are dropped by name -- by name,
 * not with a bare `clearMarks()`, because Next.js and React put their own
 * entries in the same buffer.
 */
function clearUserTiming(harvested: readonly PerfTiming[]): void {
  const names = new Set(harvested.map((timing) => timing.name));
  for (const name of names) {
    try {
      performance.clearMarks?.(name);
      performance.clearMeasures?.(name);
    } catch {
      // A runtime without User Timing: there was nothing to clear anyway.
    }
  }
}

/**
 * Drop every recorded timing and every run. The HUD's Clear button, and test
 * setup.
 */
export function perfReset(): void {
  clearUserTiming(timings);
  timings.length = 0;
  spanStack.length = 0;
  closedRuns.length = 0;
  currentRunId = 1;
  longTaskCount = 0;
  longTaskLongestMs = 0;
  longTaskTotalMs = 0;
}

/** Every run still held, oldest first, the open one last. */
export function perfRuns(): PerfRunInfo[] {
  const open: PerfRunInfo = {
    id: currentRunId,
    label: "current",
    atMs: openRunStartMs(),
    closed: false,
  };
  return [...closedRuns, open];
}

/** When the open run's first timing landed, or now if it holds none yet. */
function openRunStartMs(): number {
  for (const timing of timings) {
    if (timing.runId === currentRunId) return timing.startMs;
  }
  return nowMs();
}

/**
 * Close the open run under `label` and open the next one.
 *
 * Only the last `MAX_RUNS` runs are kept; the timings of anything older go
 * with them, which is what stops a long session from growing without bound.
 */
function closeRun(label: string, atMs: number): number {
  const closedId = currentRunId;
  closedRuns.push({ id: closedId, label, atMs, closed: true });
  currentRunId += 1;
  if (closedRuns.length > MAX_RUNS) {
    closedRuns.splice(0, closedRuns.length - MAX_RUNS);
    const oldestKept = closedRuns[0].id;
    const kept = timings.filter((timing) => (timing.runId ?? oldestKept) >= oldestKept);
    timings.length = 0;
    for (const timing of kept) timings.push(timing);
  }
  return closedId;
}

/** Test-only: forget the cached auto-detection so a new environment is read. */
export function perfResetDetectionForTest(): void {
  override = null;
  detected = null;
}

// ---------------------------------------------------------------------------
// Long tasks
// ---------------------------------------------------------------------------

let longTaskObserver: PerformanceObserver | null = null;
let longTaskSupported = false;
let longTaskCount = 0;
let longTaskLongestMs = 0;
let longTaskTotalMs = 0;

/**
 * Whether this browser really delivers `longtask` entries.
 *
 * `observe({ type: "longtask" })` is not the test: Firefox does not throw on
 * an entry type it does not implement, it warns and delivers nothing, and the
 * report would then claim a measured zero. `supportedEntryTypes` is the only
 * honest answer, and a browser too old to have it is one that has no
 * `longtask` either.
 */
function longTaskEntryTypeSupported(): boolean {
  if (typeof PerformanceObserver === "undefined") return false;
  const types = PerformanceObserver.supportedEntryTypes;
  return Array.isArray(types) && types.includes("longtask");
}

function startLongTaskObserver(): void {
  if (longTaskObserver !== null || !longTaskEntryTypeSupported()) return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskCount += 1;
        longTaskTotalMs += entry.duration;
        if (entry.duration > longTaskLongestMs) longTaskLongestMs = entry.duration;
      }
    });
    observer.observe({ type: "longtask", buffered: true });
    longTaskObserver = observer;
    longTaskSupported = true;
  } catch {
    // Safari and every worker realm: no `longtask` entry type. The report says
    // `observed: false` rather than reporting a confident zero.
    longTaskSupported = false;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function classifyResource(entry: PerformanceResourceTiming): PerfResourceKind {
  const url = entry.name;
  const path = url.split("?")[0];
  if (/\.wasm$/i.test(path)) return "wasm";
  if (/worker[^/]*\.js$/i.test(path)) return "worker";
  if (/\.(?:woff2?|ttf|otf)$/i.test(path)) return "font";
  if (/\.css$/i.test(path)) return "css";
  if (/\.(?:m?js)$/i.test(path)) return "script";
  if (/\.(?:png|jpe?g|svg|gif|webp|avif|ico)$/i.test(path)) return "image";
  if (entry.initiatorType === "script") return "script";
  if (entry.initiatorType === "link") return "css";
  if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") return "fetch";
  return "other";
}

function fileName(url: string): string {
  const path = url.split("?")[0];
  const last = path.split("/").filter((part) => part !== "").pop();
  return last ?? url;
}

function resourceEntries(): PerformanceResourceTiming[] {
  if (typeof performance.getEntriesByType !== "function") return [];
  try {
    return performance.getEntriesByType("resource") as PerformanceResourceTiming[];
  } catch {
    return [];
  }
}

function navigationTiming(): PerfNavigation | null {
  if (typeof document === "undefined" || typeof performance.getEntriesByType !== "function") {
    return null;
  }
  let entry: PerformanceNavigationTiming | undefined;
  try {
    entry = (performance.getEntriesByType("navigation") as PerformanceNavigationTiming[])[0];
  } catch {
    return null;
  }
  if (entry === undefined) return null;
  let firstPaintMs: number | null = null;
  let firstContentfulPaintMs: number | null = null;
  try {
    for (const paint of performance.getEntriesByType("paint")) {
      if (paint.name === "first-paint") firstPaintMs = paint.startTime;
      if (paint.name === "first-contentful-paint") firstContentfulPaintMs = paint.startTime;
    }
  } catch {
    // No paint timing: the two stay null rather than reading as instant.
  }
  return {
    htmlMs: entry.responseEnd - entry.requestStart,
    htmlTransferBytes: entry.transferSize,
    htmlDecodedBytes: entry.decodedBodySize,
    domInteractiveMs: entry.domInteractive,
    // Both of these read 0 until their event fires, and a report built from
    // the HUD's mount effect is often earlier than that. 0 would render as an
    // instant load; null renders as "n/a", the treatment paint timing already
    // gets, and the HUD re-reads the report on `load`.
    domContentLoadedMs: eventTime(entry.domContentLoadedEventEnd),
    loadMs: eventTime(entry.loadEventEnd),
    firstPaintMs,
    firstContentfulPaintMs,
    type: entry.type,
  };
}

/** A navigation event field, or null while the event has not fired. */
function eventTime(value: number): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function emptyTotals(): PerfResourceTotals {
  const byKind = {} as Record<PerfResourceKind, PerfResourceKindTotal>;
  for (const kind of RESOURCE_KINDS) byKind[kind] = { ...EMPTY_KIND_TOTAL };
  return { count: 0, transferBytes: 0, decodedBytes: 0, byKind };
}

/** A row's identity: one name, in one realm, in one run. */
function rowKey(runId: number, scope: PerfScope, name: string): string {
  return `${runId}|${scope}|${name}`;
}

/**
 * Fold timings into rows: one row per name, per scope, PER RUN.
 *
 * Two things come out of this that the flat fold could not express. Rows never
 * cross a run boundary, so a second build starts a new `engine.build` row
 * instead of doubling the first one's count and milliseconds. And a row
 * recorded inside another keeps its `parent` and `depth`, so the report reads
 * as the tree it always was: `selfMs` is the row's own time with its children
 * taken out, and only `depth === 0` rows may be summed for a total.
 */
function foldRows(source: readonly PerfTiming[]): PerfRow[] {
  const byKey = new Map<string, PerfRow>();
  for (const timing of source) {
    const runId = timing.runId ?? 1;
    const key = rowKey(runId, timing.scope, timing.name);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        name: timing.name,
        scope: timing.scope,
        runId,
        count: 1,
        totalMs: timing.durationMs ?? 0,
        selfMs: timing.durationMs ?? 0,
        parent: timing.parent ?? null,
        depth: timing.depth ?? 0,
        lastMs: timing.durationMs,
        bytes: timing.bytes ?? null,
        startMs: timing.startMs,
      });
      continue;
    }
    existing.count += 1;
    existing.totalMs += timing.durationMs ?? 0;
    existing.selfMs += timing.durationMs ?? 0;
    if (timing.durationMs !== null) existing.lastMs = timing.durationMs;
    if (timing.bytes !== undefined) existing.bytes = (existing.bytes ?? 0) + timing.bytes;
    if (timing.startMs < existing.startMs) existing.startMs = timing.startMs;
  }

  const rows = [...byKey.values()].sort((a, b) => a.runId - b.runId || a.startMs - b.startMs);
  for (const row of rows) {
    if (row.parent === null) continue;
    if (row.parent === row.name) {
      // A span recorded inside another span of the same name (a tiled export
      // calls its own writer per tile) folds into ONE row, and a row cannot be
      // its own child: it is the top of its own recursion.
      row.parent = null;
      row.depth = 0;
      continue;
    }
    const parent = byKey.get(rowKey(row.runId, row.scope, row.parent));
    if (parent === undefined) {
      // The parent span is not in this buffer (an older run, or the cap), so
      // this row is the top of what is left rather than an orphan child.
      row.parent = null;
      row.depth = 0;
      continue;
    }
    parent.selfMs -= row.totalMs;
  }
  return orderTree(rows);
}

/**
 * Depth-first order: every row directly under its parent, siblings by start.
 *
 * Sorting by start alone gets this right for a strictly sequential pipeline
 * but not for two spans that overlap, and the indentation has to hold either
 * way.
 */
function orderTree(rows: readonly PerfRow[]): PerfRow[] {
  const children = new Map<string, PerfRow[]>();
  const roots: PerfRow[] = [];
  for (const row of rows) {
    if (row.parent === null) {
      roots.push(row);
      continue;
    }
    const key = rowKey(row.runId, row.scope, row.parent);
    const siblings = children.get(key);
    if (siblings === undefined) children.set(key, [row]);
    else siblings.push(row);
  }
  const ordered: PerfRow[] = [];
  const seen = new Set<PerfRow>();
  const walk = (row: PerfRow): void => {
    // A cycle in the parent links would otherwise recurse for ever, and a
    // diagnostic overlay must not be the thing that hangs the page.
    if (seen.has(row)) return;
    seen.add(row);
    ordered.push(row);
    for (const child of children.get(rowKey(row.runId, row.scope, row.name)) ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  // Anything a cycle kept out of the walk is still a measurement, so it goes
  // at the end rather than disappearing from the table.
  for (const row of rows) if (!seen.has(row)) ordered.push(row);
  return ordered;
}

/** The wall time of one run: its top-level rows, with no double counting. */
export function perfTotalMs(rows: readonly PerfRow[]): number {
  let total = 0;
  for (const row of rows) if (row.depth === 0) total += row.totalMs;
  return total;
}

/**
 * The current breakdown: every span recorded in this page (worker spans
 * included, rebased), plus what Navigation, Resource and Long Task Timing say
 * about the load. Safe to call with perf mode off, where it returns an empty
 * report with `enabled: false`.
 */
export function perfReport(label = "report", runId?: number): PerfReport {
  const enabled = perfEnabled();
  // `perfFlush` closes its run before it builds the report, so it names the
  // run it is reporting on; every other caller is looking at the open one.
  const reportRunId = runId ?? currentRunId;
  if (!enabled) {
    return {
      enabled: false,
      label,
      atMs: nowMs(),
      runId: reportRunId,
      runs: [],
      rows: [],
      spans: [],
      navigation: null,
      resources: [],
      resourceTotals: emptyTotals(),
      longTasks: { count: 0, longestMs: 0, totalMs: 0, observed: false },
    };
  }

  const totals = emptyTotals();
  const resources: PerfResource[] = [];
  for (const entry of resourceEntries()) {
    const kind = classifyResource(entry);
    const resource: PerfResource = {
      name: fileName(entry.name),
      url: entry.name,
      kind,
      transferBytes: entry.transferSize,
      decodedBytes: entry.decodedBodySize,
      durationMs: entry.duration,
      startMs: entry.startTime,
    };
    resources.push(resource);
    totals.count += 1;
    totals.transferBytes += resource.transferBytes;
    totals.decodedBytes += resource.decodedBytes;
    const kindTotal = totals.byKind[kind];
    kindTotal.count += 1;
    kindTotal.transferBytes += resource.transferBytes;
    kindTotal.decodedBytes += resource.decodedBytes;
    kindTotal.durationMs += resource.durationMs;
  }
  resources.sort((a, b) => b.transferBytes - a.transferBytes || b.decodedBytes - a.decodedBytes);

  return {
    enabled: true,
    label,
    atMs: nowMs(),
    runId: reportRunId,
    runs: perfRuns(),
    rows: foldRows(timings),
    spans: timings.slice(),
    navigation: navigationTiming(),
    resources: resources.slice(0, REPORT_RESOURCE_LIMIT),
    resourceTotals: totals,
    longTasks: {
      count: longTaskCount,
      longestMs: longTaskLongestMs,
      totalMs: longTaskTotalMs,
      observed: longTaskSupported,
    },
  };
}

// ---------------------------------------------------------------------------
// Subscribers, console, clipboard text
// ---------------------------------------------------------------------------

type PerfListener = (report: PerfReport) => void;

const listeners = new Set<PerfListener>();

/** Listen for every `perfFlush`. Returns the unsubscribe function. */
export function perfSubscribe(listener: PerfListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One decimal, always: the copied block is what a handoff note is written from. */
function ms(value: number): string {
  return value.toFixed(1);
}

/** A milliseconds field that may not have happened yet. */
function msOrNa(value: number | null): string {
  return value === null ? "n/a" : `${ms(value)} ms`;
}

/** `1.2 MB` / `812 kB` / `96 B`, decimal units, matching what DevTools shows. */
export function perfBytes(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} kB`;
  return `${value.toFixed(0)} B`;
}

/**
 * The report as one plain-text block: what the HUD's Copy button puts on the
 * clipboard and what the baseline note is written from.
 */
export function perfText(report: PerfReport): string {
  const lines: string[] = [];
  lines.push(`FrameCraft perf: ${report.label} at ${ms(report.atMs)} ms`);
  const nav = report.navigation;
  if (nav !== null) {
    lines.push(
      `navigation (${nav.type}): html ${ms(nav.htmlMs)} ms ${perfBytes(nav.htmlTransferBytes)}, ` +
        `interactive ${ms(nav.domInteractiveMs)} ms, DOMContentLoaded ${msOrNa(nav.domContentLoadedMs)}, ` +
        `load ${msOrNa(nav.loadMs)}, FCP ${msOrNa(nav.firstContentfulPaintMs)}`,
    );
  }
  // One block per run, because rows from two runs must never be added
  // together, and inside a block the `ms` of a child is already inside the
  // `ms` of its parent: `self` is the column that may be summed freely, and
  // the total line sums only the rows at depth 0.
  for (const run of report.runs) {
    const rows = report.rows.filter((row) => row.runId === run.id);
    if (rows.length === 0) continue;
    lines.push("");
    lines.push(`run ${run.id}: ${run.label} at ${ms(run.atMs)} ms`);
    lines.push("name\tscope\tcount\tms\tbytes\tself");
    for (const row of rows) {
      lines.push(
        `${"  ".repeat(row.depth)}${row.name}\t${row.scope}\t${row.count}\t${ms(row.totalMs)}\t` +
          `${row.bytes === null ? "" : row.bytes}\t${ms(row.selfMs)}`,
      );
    }
    lines.push(`total (top level)\t\t\t${ms(perfTotalMs(rows))}`);
  }
  if (report.resources.length > 0) {
    lines.push("");
    lines.push(`largest ${report.resources.length} resources (transfer bytes)`);
    lines.push("name\tkind\ttransfer\tdecoded\tms");
    for (const resource of report.resources) {
      lines.push(
        `${resource.name}\t${resource.kind}\t${resource.transferBytes}\t${resource.decodedBytes}\t${ms(resource.durationMs)}`,
      );
    }
    lines.push("");
    lines.push(
      `resources: ${report.resourceTotals.count} files, ` +
        `${perfBytes(report.resourceTotals.transferBytes)} transferred, ` +
        `${perfBytes(report.resourceTotals.decodedBytes)} decoded`,
    );
  }
  lines.push(
    `long tasks: ${report.longTasks.observed ? `${report.longTasks.count}, longest ${ms(report.longTasks.longestMs)} ms, total ${ms(report.longTasks.totalMs)} ms` : "not observed in this browser"}`,
  );
  return `${lines.join("\n")}\n`;
}

interface ConsoleLike {
  log(...args: unknown[]): void;
  table?: (data: unknown) => void;
  groupCollapsed?: (label: string) => void;
  groupEnd?: () => void;
}

function consoleLike(): ConsoleLike | null {
  const holder = globalThis as { console?: ConsoleLike };
  return holder.console ?? null;
}

/**
 * Build a report, print it to the console as a table, and hand it to every
 * subscriber (the HUD). Returns null with perf mode off, having done nothing.
 */
export function perfFlush(label: string): PerfReport | null {
  if (!perfEnabled()) return null;
  const runId = closeRun(label, nowMs());
  const report = perfReport(label, runId);
  const runRows = report.rows.filter((row) => row.runId === runId);
  const out = consoleLike();
  if (out !== null) {
    const group = out.groupCollapsed;
    const heading = `FrameCraft perf: ${label} (run ${runId})`;
    if (typeof group === "function") group.call(out, heading);
    else out.log(heading);
    if (typeof out.table === "function") {
      // This run only, indented by depth: a child's ms is part of its
      // parent's, so `self` is the column that adds up to the total.
      out.table(
        runRows.map((row) => ({
          name: `${"  ".repeat(row.depth)}${row.name}`,
          scope: row.scope,
          count: row.count,
          ms: Number(row.totalMs.toFixed(2)),
          self: Number(row.selfMs.toFixed(2)),
          parent: row.parent,
          bytes: row.bytes,
        })),
      );
      if (report.resources.length > 0) {
        out.table(
          report.resources.map((resource) => ({
            name: resource.name,
            kind: resource.kind,
            transfer: resource.transferBytes,
            decoded: resource.decodedBytes,
            ms: Number(resource.durationMs.toFixed(2)),
          })),
        );
      }
    } else {
      out.log(perfText(report));
    }
    const end = out.groupEnd;
    if (typeof end === "function") end.call(out);
  }
  // The run is harvested into `report` now, so the browser's own mark and
  // measure buffer can let it go. This module's copy is what the HUD reads.
  clearUserTiming(report.spans.filter((span) => span.runId === runId));
  for (const listener of listeners) listener(report);
  return report;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** What perf mode publishes on `window` so a measurement harness can read it. */
export interface PerfGlobal {
  enabled: true;
  report: (label?: string) => PerfReport;
  text: (report: PerfReport) => string;
  flush: (label: string) => PerfReport | null;
  reset: () => void;
}

let installed = false;

/**
 * Start the long-task observer and publish `window.__framecraftPerf`.
 *
 * Called from the HUD's mount effect, which is the first thing the editor
 * renders, so the observer is running before any preview or build. Idempotent
 * and a no-op with perf mode off.
 */
export function perfInstall(): void {
  if (installed || !perfEnabled()) return;
  installed = true;
  startLongTaskObserver();
  const holder = globalThis as { __framecraftPerf?: PerfGlobal };
  holder.__framecraftPerf = {
    enabled: true,
    report: perfReport,
    text: perfText,
    flush: perfFlush,
    reset: perfReset,
  };
}

/**
 * Undo `perfInstall`: disconnect the long-task observer and take
 * `window.__framecraftPerf` back off the global.
 *
 * Perf mode is a diagnostic mode, not a permanent tenant of the page. This is
 * called when the HUD unmounts and whenever `setPerfEnabled` turns the mode
 * off, so nothing installed for a measurement outlives the measurement.
 * Idempotent, and safe in a realm that never installed anything.
 */
export function perfUninstall(): void {
  // A realm that never installed anything -- every engine worker, and every
  // page with perf mode off -- leaves on two reads.
  if (!installed && longTaskObserver === null) return;
  installed = false;
  if (longTaskObserver !== null) {
    try {
      longTaskObserver.disconnect();
    } catch {
      // A disconnect that throws still leaves nothing to disconnect.
    }
    longTaskObserver = null;
  }
  longTaskSupported = false;
  const holder = globalThis as { __framecraftPerf?: PerfGlobal };
  delete holder.__framecraftPerf;
}

/** Test-only: forget that `perfInstall` already ran. */
export function perfResetInstallForTest(): void {
  installed = false;
}
