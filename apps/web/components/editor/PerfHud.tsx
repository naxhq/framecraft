"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import {
  perfBytes,
  perfEnabled,
  perfInstall,
  perfMark,
  perfReport,
  perfReset,
  perfSubscribe,
  perfText,
  perfTotalMs,
  perfUninstall,
  type PerfReport,
} from "@/lib/perf";

/**
 * The perf-mode readout, bottom-left of the viewport.
 *
 * It exists ONLY with `?perf=1` (or `localStorage.framecraft.perf = "1"`, which
 * is how the desktop shell turns it on, since a Tauri window has no query
 * string). With perf mode off this component renders `null` on the very first
 * effect and subscribes to nothing, so the shipped app carries a few hundred
 * bytes of dead branch and no work at all.
 *
 * It shows exactly what `perfFlush` puts in the console: the same rows, the
 * same numbers. Copy puts the plain-text block (`perfText`) on the clipboard,
 * which is the format `docs/handoff/v3-00-baseline.md` is written from.
 *
 * Two things the numbers depend on, and both are visible here rather than left
 * to whoever reads the table. Rows belong to a RUN -- everything between two
 * `perfFlush` calls, so one ingest, one build or one export -- and never fold
 * across runs, so a second build cannot double the first one's row; the run
 * picker narrows the table to one of the last ten. And rows are a TREE:
 * `solid.roads` was recorded inside `solid.surfaces`, so it is indented, its
 * `self` column is its own time with its children taken out, and the total
 * line adds up only the rows at the top level.
 *
 * Mounting is deliberately deferred to an effect rather than read during
 * render: this is a statically exported page, so the prerendered HTML must not
 * depend on a query string that only exists in the browser.
 */
/**
 * Nesting, one spacing step per level, deeper levels clamped to the last.
 * Tailwind classes rather than a computed style, so the indent stays on the
 * project's spacing scale.
 */
const INDENT = ["", "pl-2", "pl-4", "pl-6"] as const;

export function PerfHud() {
  const [report, setReport] = useState<PerfReport | null>(null);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);
  const [runFilter, setRunFilter] = useState<number | "all">("all");

  useEffect(() => {
    if (!perfEnabled()) return;
    perfInstall();
    // The editor tree is mounted and interactive: the closest honest marker of
    // "time to interactive" the app can produce for itself. The first RENDERED
    // frame of the 3D viewport is `preview.firstFrame` (`CityPreview.tsx`).
    perfMark("app.mounted");
    setReport(perfReport("hud"));
    const unsubscribe = perfSubscribe(setReport);

    // `domContentLoadedEventEnd` and `loadEventEnd` are 0 until their events
    // fire, and this effect usually runs first. Re-read once on `load` so the
    // panel shows the real numbers instead of an "n/a" it could have filled
    // in; a report from a flush that already happened is left alone.
    const pending = typeof document !== "undefined" && document.readyState !== "complete";
    const onLoad = (): void => {
      setReport((current) =>
        current === null || current.label === "hud" ? perfReport("hud") : current,
      );
    };
    if (pending) window.addEventListener("load", onLoad);

    return () => {
      unsubscribe();
      if (pending) window.removeEventListener("load", onLoad);
      // Nothing this mode installs outlives it: the long-task observer is
      // disconnected and `window.__framecraftPerf` goes away with the panel.
      perfUninstall();
    };
  }, []);

  // Only the runs that actually recorded something: a flush with an empty
  // buffer still closes a run, and an empty option would be noise.
  const runs = useMemo(() => {
    if (report === null) return [];
    return report.runs.filter((run) => report.rows.some((row) => row.runId === run.id));
  }, [report]);
  const shown = useMemo(() => {
    if (report === null) return [];
    if (runFilter === "all") return report.rows;
    return report.rows.filter((row) => row.runId === runFilter);
  }, [report, runFilter]);

  const copy = useCallback(() => {
    if (report === null) return;
    // Always the whole session, not just the run on screen: a handoff note
    // wants the ingest, the build and the export in one block.
    const text = perfText(report);
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) return;
    void clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      },
      () => {
        // Clipboard permission denied (a non-secure origin, a headless run
        // without the permission granted): the text is still in the console.
        setCopied(false);
      },
    );
  }, [report]);

  const clear = useCallback(() => {
    perfReset();
    setRunFilter("all");
    setReport(perfReport("hud"));
  }, []);

  if (report === null) return null;

  const nav = report.navigation;
  return (
    <div
      data-testid="perf-hud"
      /* bottom-24, clear of the viewport's own bottom strip and of the
         `preview-too-tall` badge that sits at bottom-16 left-3. */
      className="pointer-events-auto absolute bottom-24 left-3 z-10 max-h-[60%] w-80 overflow-auto rounded-panel border border-line-strong bg-plate/95 text-2xs text-ink shadow-lifted"
    >
      <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-plate px-2 py-1">
        <span className="font-display uppercase tracking-[0.16em] text-ink-faint">perf</span>
        <span className="flex-1 truncate text-ink-muted">{report.label}</span>
        <button
          type="button"
          data-testid="perf-copy"
          onClick={copy}
          className="rounded-milled border border-control px-1.5 py-0.5 text-ink transition-colors hover:border-ink-faint hover:bg-plate-raised"
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          data-testid="perf-clear"
          onClick={clear}
          className="rounded-milled border border-control px-1.5 py-0.5 text-ink transition-colors hover:border-ink-faint hover:bg-plate-raised"
        >
          Clear
        </button>
        <button
          type="button"
          data-testid="perf-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="rounded-milled border border-control px-1.5 py-0.5 text-ink transition-colors hover:border-ink-faint hover:bg-plate-raised"
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        <div className="px-2 py-1">
          {nav === null ? null : (
            <p data-testid="perf-navigation" className="pb-1 text-ink-muted">
              html {nav.htmlMs.toFixed(0)} ms · {perfBytes(nav.htmlTransferBytes)} · interactive{" "}
              {nav.domInteractiveMs.toFixed(0)} ms · load{" "}
              {nav.loadMs === null ? "n/a" : `${nav.loadMs.toFixed(0)} ms`}
              {nav.firstContentfulPaintMs === null
                ? ""
                : ` · FCP ${nav.firstContentfulPaintMs.toFixed(0)} ms`}
            </p>
          )}

          <div className="flex items-center gap-1 pb-1">
            <label htmlFor="perf-run-select" className="text-ink-faint">
              run
            </label>
            <select
              id="perf-run-select"
              data-testid="perf-run-select"
              value={runFilter === "all" ? "all" : String(runFilter)}
              onChange={(event) =>
                setRunFilter(event.target.value === "all" ? "all" : Number(event.target.value))
              }
              className="min-w-0 flex-1 truncate rounded-milled border border-control bg-plate px-1 py-0.5 text-ink"
            >
              <option value="all">all ({runs.length})</option>
              {[...runs].reverse().map((run) => (
                <option key={run.id} value={String(run.id)}>
                  {run.id} · {run.label}
                </option>
              ))}
            </select>
          </div>

          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr className="text-ink-faint">
                <th className="py-0.5 text-left font-normal">step</th>
                <th className="py-0.5 text-right font-normal">n</th>
                <th className="py-0.5 text-right font-normal">ms</th>
                <th className="py-0.5 text-right font-normal">self</th>
                <th className="py-0.5 text-right font-normal">bytes</th>
              </tr>
            </thead>
            <tbody data-testid="perf-rows">
              {shown.map((row, index) => (
                <Fragment key={`${row.runId}:${row.scope}:${row.name}`}>
                  {runFilter === "all" && (index === 0 || shown[index - 1].runId !== row.runId) ? (
                    <tr data-testid="perf-run-head" data-perf-run={row.runId}>
                      <td
                        colSpan={5}
                        className="border-t border-line pt-1 font-display uppercase tracking-[0.16em] text-ink-faint"
                      >
                        run {row.runId} ·{" "}
                        {runs.find((run) => run.id === row.runId)?.label ?? "current"}
                      </td>
                    </tr>
                  ) : null}
                  <tr
                    data-testid="perf-row"
                    data-perf-name={row.name}
                    data-perf-scope={row.scope}
                    data-perf-ms={row.totalMs.toFixed(3)}
                    data-perf-self={row.selfMs.toFixed(3)}
                    data-perf-run={row.runId}
                    data-perf-depth={row.depth}
                    className="border-t border-line"
                  >
                    {/* Indentation IS the nesting: this row's ms is already
                        inside its parent's, so only the top-level rows may be
                        added up. `self` is what adds up in any order. */}
                    <td className={`py-0.5 pr-1 ${INDENT[Math.min(row.depth, INDENT.length - 1)]}`}>
                      <span className="text-ink">{row.name}</span>
                      {row.scope === "worker" ? (
                        <span className="pl-1 text-ink-faint">w</span>
                      ) : null}
                    </td>
                    <td className="py-0.5 pr-1 text-right text-ink-muted">{row.count}</td>
                    <td className="py-0.5 pr-1 text-right">{row.totalMs.toFixed(1)}</td>
                    <td className="py-0.5 pr-1 text-right text-ink-muted">
                      {row.selfMs.toFixed(1)}
                    </td>
                    <td className="py-0.5 text-right text-ink-muted">
                      {row.bytes === null ? "" : perfBytes(row.bytes)}
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              {shown.length === 0 ? null : (
                <tr
                  data-testid="perf-total"
                  data-perf-ms={perfTotalMs(shown).toFixed(3)}
                  className="border-t border-line-strong"
                >
                  {/* Top level only. A child's ms is already inside its
                      parent's, so adding up the whole column would report more
                      than the work it describes. */}
                  <td className="py-0.5 pr-1 text-ink-muted">total (top level)</td>
                  <td className="py-0.5 pr-1" />
                  <td className="py-0.5 pr-1 text-right text-ink">
                    {perfTotalMs(shown).toFixed(1)}
                  </td>
                  <td className="py-0.5 pr-1" />
                  <td className="py-0.5" />
                </tr>
              )}
            </tfoot>
          </table>

          {report.resources.length === 0 ? null : (
            <>
              <p className="pt-2 font-display uppercase tracking-[0.16em] text-ink-faint">
                largest {report.resources.length} of {report.resourceTotals.count} files ·{" "}
                {perfBytes(report.resourceTotals.transferBytes)}
              </p>
              <table className="w-full border-collapse tabular-nums">
                <tbody data-testid="perf-resources">
                  {report.resources.map((resource) => (
                    <tr
                      key={resource.url}
                      data-testid="perf-resource"
                      data-perf-kind={resource.kind}
                      className="border-t border-line"
                    >
                      <td className="max-w-40 truncate py-0.5 pr-1" title={resource.url}>
                        {resource.name}
                      </td>
                      <td className="py-0.5 pr-1 text-right text-ink-muted">{resource.kind}</td>
                      <td className="py-0.5 pr-1 text-right">
                        {perfBytes(resource.transferBytes)}
                      </td>
                      <td className="py-0.5 text-right text-ink-muted">
                        {resource.durationMs.toFixed(0)} ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <p data-testid="perf-longtasks" className="pt-2 text-ink-muted">
            {report.longTasks.observed
              ? `long tasks ${report.longTasks.count} · longest ${report.longTasks.longestMs.toFixed(0)} ms · total ${report.longTasks.totalMs.toFixed(0)} ms`
              : "long tasks not observed in this browser"}
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default PerfHud;
