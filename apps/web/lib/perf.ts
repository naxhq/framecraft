/**
 * FrameCraft performance mode: a permanent, opt-in instrumentation layer over
 * the browser Performance API.
 *
 * It is OFF unless the page URL carries `?perf=1` or `localStorage` holds
 * `framecraft.perf = "1"` (the desktop shell has no query string, so that is
 * how Tauri turns it on). Off means every entry point here is a single boolean
 * read and a straight call through to the wrapped work: no marks, no measures,
 * no allocation, nothing for the engine to pay for. This matters because the
 * marks sit inside the solid pipeline's hot path, where a bake runs thousands
 * of manifold3d calls with no yield points.
 *
 * Three realms record into three different buffers, and only one of them can
 * read the DOM timing sources:
 *
 *  - **The page.** `perfReport()` reads Navigation Timing, Resource Timing and
 *    the paint entries, and merges them with whatever spans this module
 *    recorded (`overpass`, `export`, preview geometry upload, ...).
 *  - **The engine workers.** A worker has `performance.now()` and its own
 *    resource entries but no `window`; `worker.ts` switches perf mode on from
 *    the flag `client.ts` puts on the job message, and drains this module's
 *    buffer into the job result's `timings` array
 *    (`lib/engine/protocol.ts`). A worker's `performance.timeOrigin` is the
 *    moment the worker was created, NOT the document's, so every timing also
 *    carries `epochMs` and `perfMergeTimings` rebases it onto the page clock.
 *  - **Node** (`bake:cli`, vitest). `perfEnabled()` is false there unless a
 *    caller sets it, and nothing installs an observer.
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
}

/** One line of the report: every timing sharing a name, folded together. */
export interface PerfRow {
  name: string;
  scope: PerfScope;
  count: number;
  /** Sum of the durations, 0 for a row of pure marks. */
  totalMs: number;
  /** The most recent duration, or null when the row holds only marks. */
  lastMs: number | null;
  /** Sum of the bytes, or null when no timing in the row carried any. */
  bytes: number | null;
  /** Start of the earliest timing in the row, on the page clock. */
  startMs: number;
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
  domContentLoadedMs: number;
  loadMs: number;
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
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const timings: PerfTiming[] = [];

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
  timings.push(timing);
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
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
  });
}

function finish(name: string, startMs: number, bytes?: number): void {
  const endMs = nowMs();
  record({
    name,
    scope: scope(),
    startMs,
    durationMs: endMs - startMs,
    epochMs: timeOriginMs() + startMs,
    ...(bytes === undefined ? {} : { bytes }),
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
  const startMs = nowMs();
  let value: T;
  try {
    value = fn();
  } catch (error) {
    finish(name, startMs);
    throw error;
  }
  if (isThenable(value)) {
    // The cast is the price of one function covering both shapes: `then`
    // returns a Promise of T's awaited type, which for a thenable T is
    // exactly T's own contract to its caller.
    return value.then(
      (resolved) => {
        finish(name, startMs);
        return resolved;
      },
      (error: unknown) => {
        finish(name, startMs);
        throw error;
      },
    ) as unknown as T;
  }
  finish(name, startMs);
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
  return drained;
}

/**
 * Merge timings recorded in another realm into this one's buffer.
 *
 * `startMs` is rebased from the sender's `epochMs` onto this realm's clock,
 * because a dedicated worker's `performance.timeOrigin` is the moment the
 * worker was created and its raw `startMs` would plot the whole bake before
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

/** Drop every recorded timing. The HUD's Clear button, and test setup. */
export function perfReset(): void {
  timings.length = 0;
  longTaskCount = 0;
  longTaskLongestMs = 0;
  longTaskTotalMs = 0;
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

function startLongTaskObserver(): void {
  if (longTaskObserver !== null || typeof PerformanceObserver === "undefined") return;
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
    domContentLoadedMs: entry.domContentLoadedEventEnd,
    loadMs: entry.loadEventEnd,
    firstPaintMs,
    firstContentfulPaintMs,
    type: entry.type,
  };
}

function emptyTotals(): PerfResourceTotals {
  const byKind = {} as Record<PerfResourceKind, PerfResourceKindTotal>;
  for (const kind of RESOURCE_KINDS) byKind[kind] = { ...EMPTY_KIND_TOTAL };
  return { count: 0, transferBytes: 0, decodedBytes: 0, byKind };
}

function foldRows(source: readonly PerfTiming[]): PerfRow[] {
  const byKey = new Map<string, PerfRow>();
  for (const timing of source) {
    const key = `${timing.scope} ${timing.name}`;
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        name: timing.name,
        scope: timing.scope,
        count: 1,
        totalMs: timing.durationMs ?? 0,
        lastMs: timing.durationMs,
        bytes: timing.bytes ?? null,
        startMs: timing.startMs,
      });
      continue;
    }
    existing.count += 1;
    existing.totalMs += timing.durationMs ?? 0;
    if (timing.durationMs !== null) existing.lastMs = timing.durationMs;
    if (timing.bytes !== undefined) existing.bytes = (existing.bytes ?? 0) + timing.bytes;
    if (timing.startMs < existing.startMs) existing.startMs = timing.startMs;
  }
  return [...byKey.values()].sort((a, b) => a.startMs - b.startMs);
}

/**
 * The current breakdown: every span recorded in this page (worker spans
 * included, rebased), plus what Navigation, Resource and Long Task Timing say
 * about the load. Safe to call with perf mode off, where it returns an empty
 * report with `enabled: false`.
 */
export function perfReport(label = "report"): PerfReport {
  const enabled = perfEnabled();
  if (!enabled) {
    return {
      enabled: false,
      label,
      atMs: nowMs(),
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
        `interactive ${ms(nav.domInteractiveMs)} ms, DOMContentLoaded ${ms(nav.domContentLoadedMs)} ms, ` +
        `load ${ms(nav.loadMs)} ms, FCP ${nav.firstContentfulPaintMs === null ? "n/a" : `${ms(nav.firstContentfulPaintMs)} ms`}`,
    );
  }
  lines.push("");
  lines.push("name\tscope\tcount\tms\tbytes");
  for (const row of report.rows) {
    lines.push(
      `${row.name}\t${row.scope}\t${row.count}\t${ms(row.totalMs)}\t${row.bytes === null ? "" : row.bytes}`,
    );
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
  const report = perfReport(label);
  const out = consoleLike();
  if (out !== null) {
    const group = out.groupCollapsed;
    if (typeof group === "function") group.call(out, `FrameCraft perf: ${label}`);
    else out.log(`FrameCraft perf: ${label}`);
    if (typeof out.table === "function") {
      out.table(
        report.rows.map((row) => ({
          name: row.name,
          scope: row.scope,
          count: row.count,
          ms: Number(row.totalMs.toFixed(2)),
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
 * renders, so the observer is running before any preview or bake. Idempotent
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

/** Test-only: forget that `perfInstall` already ran. */
export function perfResetInstallForTest(): void {
  installed = false;
}
