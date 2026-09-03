"use client";

import { useEffect, useMemo, useState } from "react";

import { EXPORT_STALE_NOTE, exportDownloadLinks, exportStatusLabel, saveDownloadFile } from "@/lib/exportFlow";
import { isTauri } from "@/lib/platform";
import { textTokenContext } from "@/lib/previewText";
import { recentDesignName, recordRecent } from "@/lib/recent";
import { resolvedOutputLines, type ResolvedLine as PredictedLine } from "@/lib/resolvedOutput";
import { encodeShare } from "@/lib/share";
import type { ResolvedLine as EngineResolvedLine } from "@/lib/engine/types";
import { locationToRequest, useEditorStore } from "@/store/editor";
import { Note } from "./Controls";
import EstimateCard from "./EstimateCard";
import RecentDesigns from "./RecentDesigns";
import StatsCard from "./StatsCard";

/**
 * The RESULTS of a run: what came out, never what starts one.
 *
 * The action row this file used to open with (Preview, Export, the format
 * select, Save, Load, Copy link, the predicted height and the reason Export
 * was refused) is now `ActionBar`, mounted from `EditorShell` at the top of
 * the settings column. The two were interleaved here, which is what let a
 * finished export's status, links and notes push the primary actions around
 * the moment they reported anything.
 *
 * What is left is five slots in a fixed order -- estimate, export, resolved
 * output, stats, recent designs -- each of which lives in the same place every
 * run. A slot with nothing to show renders nothing INSIDE its wrapper rather
 * than being absent from the list, so the order can never depend on which
 * results happen to exist, and a result appearing never moves the one below
 * it into a different position than it had last time.
 */
export function OutputPanel({
  showResults = true,
  resultsId,
}: {
  showResults?: boolean;
  /** Id for the results block, so the group toggle can name exactly it. */
  resultsId?: string;
}) {
  const graph = useEditorStore((state) => state.scene.graph);
  const params = useEditorStore((state) => state.params);
  const pipeline = useEditorStore((state) => state.pipeline);
  const exportState = useEditorStore((state) => state.exportState);
  const location = useEditorStore((state) => state.location);

  /**
   * `{date}` is pinned once, the same reason `CityPreview` and `FrameTextGroup`
   * both pin it: the shared token table never reads a clock, so this is the one
   * place it is consulted (DECISIONS [V2-P2]).
   */
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  /**
   * "Resolved output": one row per text FrameCraft will try to cut.
   *
   * Two sources, one truth (E4 brief, item 3): while the engine result is
   * FRESH (`status === "ready" && !stale`) its own `resolvedText` is
   * authoritative -- it is what the exported file actually carries, because
   * the engine resolved every token and every refusal itself. Before the first
   * build, or while a newer one is computing, the client-side PREDICTION
   * (`lib/resolvedOutput.ts`) fills the gap so the panel is never empty.
   */
  const fresh = pipeline.status === "ready" && !pipeline.stale && pipeline.result !== null;
  const predictedLines = useMemo(
    () => resolvedOutputLines(params, textTokenContext(graph, params, today)),
    [graph, params, today],
  );
  const lines: DisplayLine[] = useMemo(
    () =>
      fresh && pipeline.result
        ? pipeline.result.resolvedText.map(fromEngineLine)
        : predictedLines.map(fromPredictedLine),
    [fresh, pipeline.result, predictedLines],
  );

  // Empty while the export is stale: the file was written from parameters the
  // user has since moved.
  const links = exportDownloadLinks(exportState);

  /**
   * Every SUCCESSFUL export records a recent design, the same way Copy link
   * does. `[exportState]` (a fresh object on every phase transition) as the
   * effect's only dependency means this fires exactly once per completed
   * export -- never once per render of an unchanged "done" state, and never
   * for `exportStarted`/`exportFailedLocally`'s own phases.
   */
  useEffect(() => {
    if (exportState.phase !== "done") return;
    recordRecent(
      recentDesignName(params.city_label ?? ""),
      encodeShare(locationToRequest(location), params),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportState]);

  /*
    `max-h` + `overflow-y-auto`, not `space-y-3` alone: `group-output` is a
    `shrink-0` sibling of the scrollable group list in `ParamPanel.tsx` (never
    itself scrollable), so unbounded content here -- the estimate card, a
    finished export's status and links, and the stats card, all at once --
    pushed the whole Output section past the sidebar's own height and squeezed
    that group list to zero visible height, making every group above it
    unreachable by click (found by running `e2e/print.spec.ts` against a real
    browser: `group-output intercepts pointer events` on a click aimed at the
    Printer group's toggle, two groups above it).

    `tabIndex={0}`, same discipline as `AdjustmentsChip`'s drawer: this is an
    `overflow-y-auto` region with no focusable child guaranteed, so without it
    a keyboard-only user could not reach content past the fold -- and axe's
    `scrollable-region-focusable` rule (serious) agrees, caught by
    `e2e/a11y.spec.ts`'s Issues-drawer state.
  */
  return (
    <div id={resultsId} tabIndex={0} className="max-h-[45vh] space-y-3 overflow-y-auto">
      <div data-testid="result-slot-estimate">{showResults ? <EstimateCard /> : null}</div>

      <div data-testid="result-slot-export">
        {showResults && exportState.phase !== "idle" ? (
          <div className="space-y-2" data-testid="export-status">
            <div className="flex items-center justify-between gap-2 text-2xs">
              <span className={exportState.phase === "failed" ? "text-danger" : "text-ink-muted"}>
                {exportStatusLabel(exportState)}
              </span>
              {exportState.target ? (
                <span className="truncate text-2xs text-ink-faint">{exportState.target}</span>
              ) : null}
            </div>

            {/*
              A finished export whose parameters have since moved keeps saying
              so, and offers no links: 01's whole promise is that the preview
              and the printed result agree, and a file written from settings
              the user has since changed breaks it silently.
            */}
            {exportState.stale ? (
              <Note tone="warn" testId="export-stale-note">
                {EXPORT_STALE_NOTE}
              </Note>
            ) : null}

            {links.length > 0 ? (
              <div className="flex flex-wrap gap-2" data-testid="download-links">
                {links.map((link) => (
                  <a
                    key={link.filename}
                    href={link.href}
                    download={link.filename}
                    onClick={(event) => {
                      // Inside the Tauri desktop shell an anchor download is
                      // inert; go through the native save dialog instead. In a
                      // browser this is a no-op and the anchor proceeds.
                      if (!isTauri()) return;
                      event.preventDefault();
                      void saveDownloadFile(link);
                    }}
                    className="flex-1 rounded-milled border border-positive px-3 py-1.5 text-center text-2xs font-medium text-positive transition-colors hover:bg-positive-soft"
                  >
                    Download {link.label}
                  </a>
                ))}
              </div>
            ) : null}

            {exportState.notes.length > 0 ? (
              <ul className="space-y-1" data-testid="export-notes">
                {exportState.notes.map((note) => (
                  <li key={note} className="text-2xs text-ink-faint">
                    {note}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div data-testid="result-slot-text">
        {showResults ? <ResolvedOutputCard lines={lines} fresh={fresh} /> : null}
      </div>
      <div data-testid="result-slot-stats">{showResults ? <StatsCard /> : null}</div>
      <div data-testid="result-slot-recent">{showResults ? <RecentDesigns /> : null}</div>
    </div>
  );
}

/** The two `ResolvedLine` shapes (the prediction's and the engine's) normalized to what this panel renders. */
interface DisplayLine {
  id: string;
  surface: string;
  text: string;
  cut: boolean;
  reason: string | null;
  /**
   * A mandatory attribution line the engine cuts itself (`attribution-*` ids,
   * [V3-P7]): the FrameCraft/OpenStreetMap underside mark, the frame's inner
   * wall mark, the base-edge microtext. Distinguished in the row so it does
   * not read like text the USER typed.
   */
  mandatory: boolean;
}

function fromPredictedLine(line: PredictedLine): DisplayLine {
  return {
    id: line.id,
    surface: line.surface,
    text: line.text,
    cut: line.status === "cut",
    reason: line.reason,
    mandatory: false,
  };
}

function fromEngineLine(line: EngineResolvedLine): DisplayLine {
  return {
    id: line.id,
    surface: line.surface,
    text: line.text,
    cut: line.status === "cuts",
    reason: line.reason ?? null,
    mandatory: line.id.startsWith("attribution-"),
  };
}

/**
 * "Resolved output": one row per text FrameCraft will try to cut, in the order
 * the source (engine or prediction) reports them.
 */
function ResolvedOutputCard({ lines, fresh }: { lines: readonly DisplayLine[]; fresh: boolean }) {
  if (lines.length === 0) {
    return (
      <p data-testid="resolved-output-empty" className="text-2xs text-ink-faint">
        Nothing configured to cut yet: add a line of lettering or turn on the
        underside mark.
      </p>
    );
  }
  return (
    <div className="space-y-2" data-testid="resolved-output" data-source={fresh ? "engine" : "prediction"}>
      <h3 className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
        Resolved output
      </h3>
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li
            key={line.id}
            data-testid={`resolved-output-row-${line.id}`}
            data-status={line.cut ? "cut" : "skipped"}
            className="rounded-milled border border-line bg-plate-sunken px-2 py-1.5 text-2xs"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1 text-ink-faint">
                {line.surface}
                {line.mandatory ? (
                  <span
                    data-testid={`resolved-output-row-${line.id}-mandatory`}
                    title="Every FrameCraft model carries this; it is not something you typed."
                    className="rounded-milled border border-line px-1 py-px text-[0.6rem] uppercase tracking-wide text-ink-faint"
                  >
                    mandatory
                  </span>
                ) : null}
              </span>
              <span className={line.cut ? "text-positive" : "text-ink-faint"}>
                {line.cut ? "cuts" : "skipped"}
              </span>
            </div>
            {line.cut ? (
              <p className="mt-0.5 truncate text-ink" title={line.text}>
                {line.text}
              </p>
            ) : (
              <p className="mt-0.5 text-ink-faint">{line.reason}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default OutputPanel;
