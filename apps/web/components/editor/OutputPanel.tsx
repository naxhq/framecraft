"use client";

import { useEffect, useMemo, useState } from "react";

import {
  BAKE_STALE_NOTE,
  bakeDownloadLinks,
  bakeStatusLabel,
} from "@/lib/bake";
import { textTokenContext } from "@/lib/previewText";
import { resolvedOutputLines, type ResolvedLine as PredictedLine } from "@/lib/resolvedOutput";
import { shareUrl } from "@/lib/share";
import type { ResolvedLine as EngineResolvedLine } from "@/lib/engine/types";
import { bakeBlockReason, heightCeilingMm, predictedTopMm, warningDeps } from "@/lib/warnings";
import { locationToRequest, useEditorStore } from "@/store/editor";
import { Note } from "./Controls";
import EstimateCard from "./EstimateCard";
import ExportMenu from "./ExportMenu";
import StatsCard from "./StatsCard";

/**
 * The action row and everything that comes out of it.
 *
 * Hierarchy (the defect this replaces: two equal-weight buttons, and a
 * Generate that stayed clickable with nothing to do):
 *
 *  - With no scene, **Generate** is the primary action -- it is the only thing
 *    that can move the product forward -- and Bake is disabled with the reason.
 *  - Once a scene exists, **Bake** becomes primary and Generate drops to a
 *    quiet outline, carrying a real `disabled` attribute whenever the scene is
 *    already current. A button that looks alive and does nothing is worse than
 *    one that is honestly out of play.
 *
 * Bake is disabled -- with the reason spelled out -- whenever the engine would
 * refuse the job anyway: too few buildings (01/A2) or a model over 04's 60 mm
 * ceiling. Both verdicts come from the SceneGraph already in memory; neither
 * costs a request, and since v3 E4 neither Bake nor Generate ever leave the
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
  const bake = useEditorStore((state) => state.bake);
  const generate = useEditorStore((state) => state.generate);
  const requestBake = useEditorStore((state) => state.requestBake);
  const location = useEditorStore((state) => state.location);

  const predictedTop = useMemo(
    () => predictedTopMm(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    warningDeps(graph, params),
  );
  const blockReason = bakeBlockReason(graph, params);
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
   * first bake, or while a newer one is computing, the client-side PREDICTION
   * (`lib/resolvedOutput.ts`, the same maths the Issues badge and `lib/bake.ts`
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

  const exporting = bake.phase === "exporting";
  const generating = sceneStatus === "loading";
  const hasScene = graph !== null;
  // Nothing has moved since the last successful Generate, so there is nothing
  // to generate. Not "inert": genuinely disabled.
  const sceneIsCurrent = sceneStatus === "ready" && !stale;
  // Empty while the bake is stale: the file was exported from parameters the
  // user has since moved.
  const links = bakeDownloadLinks(bake);

  /*
    The shareable link.

    `window.location` is read in an effect, not during render: this is a client
    component but Next still renders it on the server, where there is no
    `window`, and a value that differs between the two is a hydration mismatch.
    The href is captured once -- `shareUrl` overwrites the `s` parameter, so a
    replaceState from an earlier copy cannot leak into a later one.
  */
  const [href, setHref] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  useEffect(() => setHref(window.location.href), []);
  const link = useMemo(
    () => (href === null ? null : shareUrl(href, locationToRequest(location), params)),
    [href, location, params],
  );
  // A link that no longer describes what is on screen must not still say
  // "Copied".
  useEffect(() => setCopyState("idle"), [link]);

  const copyLink = async (): Promise<void> => {
    if (link === null) return;
    // The address bar becomes the link, without a navigation: the browser's own
    // copy-URL and bookmark then carry the configuration too.
    window.history.replaceState(null, "", link);
    try {
      await navigator.clipboard.writeText(link);
      setCopyState("copied");
    } catch {
      // Permission denied, or an insecure origin. The field below is the
      // fallback, and it is why the link is in the DOM at all rather than only
      // on a clipboard we cannot verify.
      setCopyState("manual");
    }
  };

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
          data-testid="generate-button"
          onClick={() => void generate()}
          disabled={generating || sceneIsCurrent}
          title={sceneIsCurrent ? "The scene already matches this location." : undefined}
          className={`flex-1 ${hasScene ? secondary : primary}`}
        >
          {generating ? "Generating..." : stale && graph ? "Regenerate" : "Generate"}
        </button>
        <button
          type="button"
          data-testid="bake-button"
          onClick={() => void requestBake()}
          disabled={exporting || blockReason !== null}
          title={blockReason ?? undefined}
          className={`flex-1 ${hasScene ? primary : secondary}`}
        >
          {exporting ? "Baking..." : "Bake"}
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

      {copyState !== "idle" && link !== null ? (
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
        <Note tone="warn" testId="bake-block-reason">
          {blockReason}
        </Note>
      ) : null}

      {/*
        The results, which are what the Output group's toggle folds.

        `max-h` + `overflow-y-auto`, not `space-y-3` alone: `group-output` is
        a `shrink-0` sibling of the scrollable group list in `ParamPanel.tsx`
        (never itself scrollable), so unbounded content here -- the estimate
        card, a finished bake's status and download links, and the stats
        card, all at once -- pushed the whole Output section past the
        sidebar's own height and squeezed that group list to zero visible
        height, making every group above it unreachable by click (found by
        actually running `e2e/print.spec.ts` against a real browser, not
        assumed: `group-output intercepts pointer events` on a click aimed at
        the Printer group's toggle, two groups above it). The action row,
        the predicted height and the block reason above stay OUTSIDE this
        cap -- Bake must never itself be scrolled out of reach.

        `tabIndex={0}`, same discipline as `AdjustmentsChip`'s drawer: this is
        now an `overflow-y-auto` region with no focusable child guaranteed
        (a fresh scene with nothing baked yet has no links, no notes, nothing
        to tab to), so without it a keyboard-only user could not reach
        content past the fold -- and axe's `scrollable-region-focusable` rule
        (serious) agrees, caught by `e2e/a11y.spec.ts`'s Issues-drawer state.
      */}
      <div id={resultsId} tabIndex={0} className="max-h-[45vh] space-y-3 overflow-y-auto">
        {/*
          Ahead of the bake status/download links: what the print will cost,
          before or after the decision to run it. Folded under the same
          toggle as the rest of the results (not always on screen): a card
          with a slot row per filament plus a caveat paragraph is real height,
          and the whole point of "hide results" is to let the panel's
          scrollable group list recover that space on a short viewport.
        */}
        {showResults ? <EstimateCard /> : null}

        {showResults && bake.phase !== "idle" ? (
          <div className="space-y-2" data-testid="bake-status">
            <div className="flex items-center justify-between gap-2 text-2xs">
              <span
                className={bake.phase === "failed" ? "text-danger" : "text-ink-muted"}
              >
                {bakeStatusLabel(bake)}
              </span>
              {bake.target ? (
                <span className="truncate text-2xs text-ink-faint">{bake.target}</span>
              ) : null}
            </div>

            {exporting ? (
              <div
                data-testid="bake-progress"
                role="progressbar"
                aria-label="Exporting"
                className="h-1.5 overflow-hidden rounded-milled bg-plate-sunken"
              >
                <div className="h-full w-1/3 animate-[fc-indeterminate_1.4s_ease-in-out_infinite] rounded-milled bg-accent" />
              </div>
            ) : null}

            {bake.stale ? (
              <Note tone="warn" testId="bake-stale-note">
                {BAKE_STALE_NOTE}
              </Note>
            ) : null}

            {links.length > 0 ? (
              <div className="flex flex-wrap gap-2" data-testid="download-links">
                {links.map((link) => (
                  <a
                    key={link.filename}
                    href={link.href}
                    download={link.filename}
                    className="flex-1 rounded-milled border border-positive px-3 py-1.5 text-center text-2xs font-medium text-positive transition-colors hover:bg-positive-soft"
                  >
                    Download {link.label}
                  </a>
                ))}
              </div>
            ) : null}

            {bake.notes.length > 0 ? (
              <ul className="space-y-1" data-testid="bake-notes">
                {bake.notes.map((note) => (
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
}

function fromPredictedLine(line: PredictedLine): DisplayLine {
  return { id: line.id, surface: line.surface, text: line.text, cut: line.status === "cut", reason: line.reason };
}

function fromEngineLine(line: EngineResolvedLine): DisplayLine {
  return { id: line.id, surface: line.surface, text: line.text, cut: line.status === "cuts", reason: line.reason ?? null };
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
              <span className="text-ink-faint">{line.surface}</span>
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
