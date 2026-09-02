"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  EXPORT_STALE_NOTE,
  exportDownloadLinks,
  exportStatusLabel,
  saveDownloadFile,
} from "@/lib/exportFlow";
import { isTauri } from "@/lib/platform";
import { buildProject, downloadProject, parseProject } from "@/lib/project";
import { textTokenContext } from "@/lib/previewText";
import { recentDesignName, recordRecent } from "@/lib/recent";
import { resolvedOutputLines, type ResolvedLine as PredictedLine } from "@/lib/resolvedOutput";
import { SHARE_LINK_LENGTH_LIMIT, encodeShare, shareUrl } from "@/lib/share";
import type { ResolvedLine as EngineResolvedLine } from "@/lib/engine/types";
import { exportBlockReason, heightCeilingMm, predictedTopMm, warningDeps } from "@/lib/warnings";
import { locationToRequest, useEditorStore } from "@/store/editor";
import { Note } from "./Controls";
import EstimateCard from "./EstimateCard";
import ExportMenu from "./ExportMenu";
import RecentDesigns from "./RecentDesigns";
import StatsCard from "./StatsCard";

/**
 * The action row and everything that comes out of it.
 *
 * Hierarchy (the defect this replaces: two equal-weight buttons, and a
 * Preview that stayed clickable with nothing to do):
 *
 *  - With no scene, **Preview** is the primary action -- it is the only thing
 *    that can move the product forward -- and Export is disabled with the reason.
 *  - Once a scene exists, **Export** becomes primary and Preview drops to a
 *    quiet outline, carrying a real `disabled` attribute whenever the scene is
 *    already current. A button that looks alive and does nothing is worse than
 *    one that is honestly out of play.
 *
 * Export is disabled -- with the reason spelled out -- whenever the engine would
 * refuse the job anyway: too few buildings (01/A2) or a model over 04's 60 mm
 * ceiling. Both verdicts come from the SceneGraph already in memory; neither
 * costs a request, and since v3 E4 neither Export nor Preview ever leave the
 * browser tab except for the ingest fetch to Overpass.
 */
export function OutputPanel({
  showResults = true,
  resultsId,
}: {
  showResults?: boolean;
  /** Id for the results block, so the group toggle can name exactly it. */
  resultsId?: string;
}) {
  const sceneStatus = useEditorStore((state) => state.scene.status);
  const graph = useEditorStore((state) => state.scene.graph);
  const stale = useEditorStore((state) => state.scene.stale);
  const params = useEditorStore((state) => state.params);
  const engine = useEditorStore((state) => state.engine);
  const exportState = useEditorStore((state) => state.exportState);
  const generate = useEditorStore((state) => state.generate);
  const requestExport = useEditorStore((state) => state.requestExport);
  const location = useEditorStore((state) => state.location);

  const predictedTop = useMemo(
    () => predictedTopMm(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    warningDeps(graph, params),
  );
  const blockReason = exportBlockReason(graph, params);
  // The selected printer's own ceiling, `lib/warnings.ts:heightCeilingMm`
  // (team lead's ruling, `[V3-P4]`): the ACTIVE profile's `maxHeightMm`,
  // straight, so this line and the block reason above can never name two
  // different numbers for the same model.
  const heightCeiling = heightCeilingMm(params);

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
   * the engine resolved every token and every refusal itself. Before the
   * first build, or while a newer one is computing, the client-side PREDICTION
   * (`lib/resolvedOutput.ts`, the same maths the Issues badge and `lib/exportFlow.ts`
   * used pre-engine) fills the gap so the panel is never empty.
   */
  const fresh = engine.status === "ready" && !engine.stale && engine.result !== null;
  const predictedLines = useMemo(
    () => resolvedOutputLines(params, textTokenContext(graph, params, today)),
    [graph, params, today],
  );
  const lines: DisplayLine[] = useMemo(
    () =>
      fresh && engine.result
        ? engine.result.resolvedText.map(fromEngineLine)
        : predictedLines.map(fromPredictedLine),
    [fresh, engine.result, predictedLines],
  );

  const exporting = exportState.phase === "exporting";
  const generating = sceneStatus === "loading";
  const hasScene = graph !== null;
  // Nothing has moved since the last successful Preview, so there is nothing
  // to generate. Not "inert": genuinely disabled.
  const sceneIsCurrent = sceneStatus === "ready" && !stale;
  // Empty while the export is stale: the file was written from parameters the
  // user has since moved.
  const links = exportDownloadLinks(exportState);

  /*
    The shareable link.

    `window.location` is read in an effect, not during render: this is a client
    component but Next still renders it on the server, where there is no
    `window`, and a value that differs between the two is a hydration mismatch.
    The href is captured once -- `shareUrl` overwrites the `s` parameter, so a
    replaceState from an earlier copy cannot leak into a later one.
  */
  const [href, setHref] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual" | "too-large">("idle");
  useEffect(() => setHref(window.location.href), []);
  const link = useMemo(
    () => (href === null ? null : shareUrl(href, locationToRequest(location), params)),
    [href, location, params],
  );
  // A link that no longer describes what is on screen must not still say
  // "Copied".
  useEffect(() => setCopyState("idle"), [link]);

  /**
   * A recent design is the exact share payload (`lib/recent.ts`), recorded on
   * a successful Copy-link and (below) a successful export -- the two moments
   * the brief names, and, not coincidentally, the two moments a design is
   * demonstrably "finished enough to be worth keeping" rather than mid-edit.
   */
  const recordCurrentAsRecent = (): void => {
    recordRecent(recentDesignName(params.city_label ?? ""), encodeShare(locationToRequest(location), params));
  };

  const copyLink = async (): Promise<void> => {
    if (link === null) return;
    // [V3-P6]: even compressed, a configuration at the contract's real
    // maxima can exceed a sane URL length, and there is no server to hand out
    // a short id for one instead (no share-id backend exists by design). Past
    // the guard the dialog explains that and points at the project file
    // instead, rather than copying a link several chat clients would mangle.
    if (link.length > SHARE_LINK_LENGTH_LIMIT) {
      setCopyState("too-large");
      return;
    }
    // The address bar becomes the link, without a navigation: the browser's own
    // copy-URL and bookmark then carry the configuration too.
    window.history.replaceState(null, "", link);
    try {
      await navigator.clipboard.writeText(link);
      setCopyState("copied");
      recordCurrentAsRecent();
    } catch {
      // Permission denied, or an insecure origin. The field below is the
      // fallback, and it is why the link is in the DOM at all rather than only
      // on a clipboard we cannot verify.
      setCopyState("manual");
      recordCurrentAsRecent();
    }
  };

  // --- project file (lib/project.ts, [V3-P6]) -------------------------------
  const [projectError, setProjectError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const saveProject = (): void => {
    downloadProject(buildProject(location, params));
  };

  const openLoadDialog = (): void => {
    setProjectError(null);
    fileInputRef.current?.click();
  };

  const onProjectFileChosen = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0] ?? null;
    // The input is cleared regardless of outcome: choosing the SAME file
    // twice in a row (fix a typo, load it again) must fire `onChange` again,
    // which a browser will not do if the value never changed.
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    const result = parseProject(text);
    if (!result.ok) {
      setProjectError(result.reason);
      return;
    }
    setProjectError(null);
    useEditorStore.getState().applyProject(result.location, result.params);
  };

  /**
   * Every SUCCESSFUL export records a recent design too, not just Copy-link.
   * `[exportState]` (the whole state object, a fresh reference on every phase
   * transition) as the effect's only dependency means this fires exactly
   * once per completed export -- never once per render of an unchanged "done"
   * state, and never for `exportStarted`/`exportFailedLocally`'s own phases.
   */
  useEffect(() => {
    if (exportState.phase !== "done") return;
    recordCurrentAsRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportState]);

  const primary =
    "rounded-milled bg-primary px-3 py-2 text-sm font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40";
  // The secondary button's border IS its boundary, so it takes the control
  // token (>= 3:1, WCAG 1.4.11) rather than the decorative hairline, which
  // measured 1.87:1 on the raised surface in the dark theme.
  const secondary =
    "rounded-milled border border-control bg-plate-raised px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="preview-button"
          onClick={() => void generate()}
          disabled={generating || sceneIsCurrent}
          title={sceneIsCurrent ? "The scene already matches this location." : undefined}
          className={`flex-1 ${hasScene ? secondary : primary}`}
        >
          {generating ? "Previewing..." : stale && graph ? "Preview again" : "Preview"}
        </button>
        <button
          type="button"
          data-testid="export-button"
          onClick={() => void requestExport()}
          disabled={exporting || blockReason !== null}
          title={blockReason ?? undefined}
          className={`flex-1 ${hasScene ? primary : secondary}`}
        >
          {exporting ? "Exporting..." : "Export"}
        </button>
        <ExportMenu />
        {/*
          Fourth in the row and deliberately narrower: it is the only action here
          that changes nothing about the model. The link is on the button as a
          data attribute whether or not the clipboard write is allowed, so it is
          always readable -- by a person, by a test, and by the field below.
        */}
        <button
          type="button"
          data-testid="copy-link-button"
          data-share-url={link ?? ""}
          onClick={() => void copyLink()}
          disabled={link === null}
          title="Copy a link that restores every setting on this page"
          className={`shrink-0 ${secondary}`}
        >
          {copyState === "copied" ? "Link copied" : "Copy link"}
        </button>
      </div>

      {/*
        Save/Load a `.framecraft.json` project ([V3-P6]). A second, quieter
        row: this is not the primary flow (Preview and Export are), but it
        needs to live in the OUTPUT group beside them, not behind a menu that
        would hide "your work has a Save button" from a first-time user.
      */}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="save-project-button"
          onClick={saveProject}
          title="Download this whole design as a .framecraft.json file"
          className={`flex-1 ${secondary}`}
        >
          Save project
        </button>
        <button
          type="button"
          data-testid="load-project-button"
          onClick={openLoadDialog}
          title="Load a .framecraft.json file, replacing every setting"
          className={`flex-1 ${secondary}`}
        >
          Load project
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          aria-label="Load a FrameCraft project file"
          data-testid="load-project-input"
          className="hidden"
          onChange={(event) => void onProjectFileChosen(event)}
        />
      </div>
      {projectError !== null ? (
        <Note tone="warn" testId="project-error">
          {projectError}
        </Note>
      ) : null}

      {copyState === "too-large" && link !== null ? (
        <Note tone="warn" testId="share-too-large">
          This design is too large for a link ({link.length} characters). Use
          Save project instead --{" "}
          <button
            type="button"
            data-testid="share-too-large-save-project"
            onClick={saveProject}
            className="font-medium underline underline-offset-2"
          >
            save a project file
          </button>{" "}
          and share that.
        </Note>
      ) : null}

      {(copyState === "copied" || copyState === "manual") && link !== null ? (
        <div className="space-y-1">
          <label htmlFor="share-link" className="block text-2xs text-ink-faint">
            {copyState === "copied"
              ? "This link restores every setting on this page."
              : "Copying was blocked, so here is the link to select and copy."}
          </label>
          <input
            id="share-link"
            data-testid="share-link"
            type="text"
            readOnly
            value={link}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full rounded-milled border border-control bg-plate-sunken px-2 py-1 text-2xs text-ink-muted"
          />
        </div>
      ) : null}

      {predictedTop !== null ? (
        <p
          data-testid="predicted-height"
          data-predicted-mm={predictedTop.toFixed(1)}
          data-ceiling-mm={heightCeiling.toFixed(0)}
          className={`text-2xs ${
            predictedTop >= heightCeiling ? "font-medium text-danger" : "text-ink-faint"
          }`}
        >
          Predicted height {predictedTop.toFixed(1)} mm of {heightCeiling.toFixed(0)} mm
        </p>
      ) : null}

      {blockReason && graph ? (
        <Note tone="warn" testId="export-block-reason">
          {blockReason}
        </Note>
      ) : null}

      {/*
        The results, which are what the Output group's toggle folds.

        `max-h` + `overflow-y-auto`, not `space-y-3` alone: `group-output` is
        a `shrink-0` sibling of the scrollable group list in `ParamPanel.tsx`
        (never itself scrollable), so unbounded content here -- the estimate
        card, a finished export's status and download links, and the stats
        card, all at once -- pushed the whole Output section past the
        sidebar's own height and squeezed that group list to zero visible
        height, making every group above it unreachable by click (found by
        actually running `e2e/print.spec.ts` against a real browser, not
        assumed: `group-output intercepts pointer events` on a click aimed at
        the Printer group's toggle, two groups above it). The action row,
        the predicted height and the block reason above stay OUTSIDE this
        cap -- Export must never itself be scrolled out of reach.

        `tabIndex={0}`, same discipline as `AdjustmentsChip`'s drawer: this is
        now an `overflow-y-auto` region with no focusable child guaranteed
        (a fresh scene with nothing exported yet has no links, no notes, nothing
        to tab to), so without it a keyboard-only user could not reach
        content past the fold -- and axe's `scrollable-region-focusable` rule
        (serious) agrees, caught by `e2e/a11y.spec.ts`'s Issues-drawer state.
      */}
      <div id={resultsId} tabIndex={0} className="max-h-[45vh] space-y-3 overflow-y-auto">
        {/*
          Ahead of the export status/download links: what the print will cost,
          before or after the decision to run it. Folded under the same
          toggle as the rest of the results (not always on screen): a card
          with a slot row per filament plus a caveat paragraph is real height,
          and the whole point of "hide results" is to let the panel's
          scrollable group list recover that space on a short viewport.
        */}
        {showResults ? <EstimateCard /> : null}

        {showResults && exportState.phase !== "idle" ? (
          <div className="space-y-2" data-testid="export-status">
            <div className="flex items-center justify-between gap-2 text-2xs">
              <span
                className={exportState.phase === "failed" ? "text-danger" : "text-ink-muted"}
              >
                {exportStatusLabel(exportState)}
              </span>
              {exportState.target ? (
                <span className="truncate text-2xs text-ink-faint">{exportState.target}</span>
              ) : null}
            </div>

            {exporting ? (
              <div
                data-testid="export-progress"
                role="progressbar"
                aria-label="Exporting"
                className="h-1.5 overflow-hidden rounded-milled bg-plate-sunken"
              >
                <div className="h-full w-1/3 animate-[fc-indeterminate_1.4s_ease-in-out_infinite] rounded-milled bg-accent" />
              </div>
            ) : null}

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
                      // inert; go through the native save dialog instead. In
                      // a browser this is a no-op and the anchor proceeds.
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

        {showResults ? <ResolvedOutputCard lines={lines} fresh={fresh} /> : null}
        {showResults ? <StatsCard /> : null}
        {showResults ? <RecentDesigns /> : null}
      </div>
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
   * not read like text the USER typed -- nothing here is editable either
   * way (this panel has no edit affordance for any row), but an unlabelled
   * line of text nobody remembers writing is confusing on its own.
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
 * "Resolved output": one row per text FrameCraft will try to cut, in the
 * order the source (engine or prediction) reports them.
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
