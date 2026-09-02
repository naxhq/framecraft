"use client";

import { useCallback, useEffect, useState } from "react";

import {
  perfBytes,
  perfEnabled,
  perfInstall,
  perfMark,
  perfReport,
  perfReset,
  perfSubscribe,
  perfText,
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
 * Mounting is deliberately deferred to an effect rather than read during
 * render: this is a statically exported page, so the prerendered HTML must not
 * depend on a query string that only exists in the browser.
 */
export function PerfHud() {
  const [report, setReport] = useState<PerfReport | null>(null);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!perfEnabled()) return;
    perfInstall();
    // The editor tree is mounted and interactive: the closest honest marker of
    // "time to interactive" the app can produce for itself. The first RENDERED
    // frame of the 3D viewport is `preview.firstFrame` (`CityPreview.tsx`).
    perfMark("app.mounted");
    setReport(perfReport("hud"));
    return perfSubscribe(setReport);
  }, []);

  const copy = useCallback(() => {
    if (report === null) return;
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
              {nav.domInteractiveMs.toFixed(0)} ms · load {nav.loadMs.toFixed(0)} ms
              {nav.firstContentfulPaintMs === null
                ? ""
                : ` · FCP ${nav.firstContentfulPaintMs.toFixed(0)} ms`}
            </p>
          )}

          <table className="w-full border-collapse tabular-nums">
            <thead>
              <tr className="text-ink-faint">
                <th className="py-0.5 text-left font-normal">step</th>
                <th className="py-0.5 text-right font-normal">n</th>
                <th className="py-0.5 text-right font-normal">ms</th>
                <th className="py-0.5 text-right font-normal">bytes</th>
              </tr>
            </thead>
            <tbody data-testid="perf-rows">
              {report.rows.map((row) => (
                <tr
                  key={`${row.scope}:${row.name}`}
                  data-testid="perf-row"
                  data-perf-name={row.name}
                  data-perf-scope={row.scope}
                  data-perf-ms={row.totalMs.toFixed(3)}
                  className="border-t border-line"
                >
                  <td className="py-0.5 pr-1">
                    <span className="text-ink">{row.name}</span>
                    {row.scope === "worker" ? (
                      <span className="pl-1 text-ink-faint">w</span>
                    ) : null}
                  </td>
                  <td className="py-0.5 pr-1 text-right text-ink-muted">{row.count}</td>
                  <td className="py-0.5 pr-1 text-right">{row.totalMs.toFixed(1)}</td>
                  <td className="py-0.5 text-right text-ink-muted">
                    {row.bytes === null ? "" : perfBytes(row.bytes)}
                  </td>
                </tr>
              ))}
            </tbody>
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
