"use client";

import { useEffect, useMemo, useState } from "react";

import {
  BAKE_STALE_NOTE,
  bakeDownloadLinks,
  bakeStatusLabel,
  isTerminal,
} from "@/lib/bake";
import { shareUrl } from "@/lib/share";
import { MAX_HEIGHT_MM } from "@/lib/transform";
import { bakeBlockReason, predictedTopMm, warningDeps } from "@/lib/warnings";
import { locationToRequest, useEditorStore } from "@/store/editor";
import { Note } from "./Controls";
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
 * Bake is disabled -- with the reason spelled out -- whenever the server would
 * refuse the job anyway: too few buildings (01/A2) or a model over 04's 60 mm
 * ceiling. Both verdicts come from the SceneGraph already in memory; neither
 * costs a request.
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
  const baking = bake.phase === "queued" || bake.phase === "running";
  const generating = sceneStatus === "loading";
  const hasScene = graph !== null;
  // Nothing has moved since the last successful Generate, so there is nothing
  // to generate. Not "inert": genuinely disabled.
  const sceneIsCurrent = sceneStatus === "ready" && !stale;
  // Empty while the bake is stale: the file on the server was built from
  // parameters the user has since moved.
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
          disabled={baking || blockReason !== null}
          title={blockReason ?? undefined}
          className={`flex-1 ${hasScene ? primary : secondary}`}
        >
          {baking ? "Baking..." : "Bake"}
        </button>
        {/*
          Third in the row and deliberately narrower: it is the only action here
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
          className={`text-2xs ${
            predictedTop >= MAX_HEIGHT_MM ? "font-medium text-danger" : "text-ink-faint"
          }`}
        >
          Predicted height {predictedTop.toFixed(1)} mm of {MAX_HEIGHT_MM.toFixed(0)} mm
        </p>
      ) : null}

      {blockReason && graph ? (
        <Note tone="warn" testId="bake-block-reason">
          {blockReason}
        </Note>
      ) : null}

      {/* The results, which are what the Output group's toggle folds. */}
      <div id={resultsId} className="space-y-3">
        {showResults && bake.phase !== "idle" ? (
          <div className="space-y-2" data-testid="bake-status">
            <div className="flex items-center justify-between gap-2 text-2xs">
              <span
                className={bake.phase === "failed" ? "text-danger" : "text-ink-muted"}
              >
                {bakeStatusLabel(bake)}
              </span>
              {bake.jobId ? (
                <span className="truncate text-2xs text-ink-faint">{bake.jobId}</span>
              ) : null}
            </div>

            {!isTerminal(bake.phase) ? (
              <BakeProgress progress={bake.progress} />
            ) : null}

            {bake.stale ? (
              <Note tone="warn" testId="bake-stale-note">
                {BAKE_STALE_NOTE}
              </Note>
            ) : null}

            {links.length > 0 ? (
              <div className="flex gap-2" data-testid="download-links">
                {links.map((link) => (
                  <a
                    key={link.label}
                    href={link.href}
                    download={link.filename}
                    className="flex-1 rounded-milled border border-positive px-3 py-1.5 text-center text-2xs font-medium text-positive transition-colors hover:bg-positive-soft"
                  >
                    Download {link.label}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {showResults ? <StatsCard /> : null}
      </div>
    </div>
  );
}

/**
 * Determinate whenever the server reports progress, indeterminate only when it
 * does not. `BakeResult.progress` is optional in the contract and `reduceBake`
 * keeps the last known value, so the bar stops moving rather than resetting.
 */
function BakeProgress({ progress }: { progress: number | null }) {
  if (progress === null) {
    return (
      <div
        data-testid="bake-progress"
        data-determinate="false"
        role="progressbar"
        aria-label="Baking"
        className="h-1.5 overflow-hidden rounded-milled bg-plate-sunken"
      >
        <div className="h-full w-1/3 animate-[fc-indeterminate_1.4s_ease-in-out_infinite] rounded-milled bg-accent" />
      </div>
    );
  }
  const percent = Math.round(progress * 100);
  return (
    <div
      data-testid="bake-progress"
      data-determinate="true"
      data-progress={percent}
      role="progressbar"
      aria-label="Baking"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1.5 overflow-hidden rounded-milled bg-plate-sunken"
    >
      <div
        className="h-full rounded-milled bg-accent transition-[width] duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export default OutputPanel;
