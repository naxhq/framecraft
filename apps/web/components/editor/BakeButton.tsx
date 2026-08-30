"use client";

import { useMemo } from "react";

import {
  BAKE_STALE_NOTE,
  bakeDownloadLinks,
  bakeStatusLabel,
  isTerminal,
} from "@/lib/bake";
import { MAX_HEIGHT_MM } from "@/lib/transform";
import { bakeBlockReason, predictedTopMm, warningDeps } from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";

/**
 * Generate + Bake.
 *
 * Generate is the only button that fetches a SceneGraph. Bake POSTs
 * `{scene_request, print_params}` and the store polls `GET /bake/{job_id}`
 * once a second until the job is terminal; this component only renders the
 * resulting state.
 *
 * Bake is disabled -- with the reason spelled out -- whenever the server would
 * refuse the job anyway: too few buildings (01/A2) or a model over 04's 60 mm
 * ceiling. Both verdicts are computed from the SceneGraph already in memory;
 * neither costs a request.
 */
export function BakeButton() {
  const sceneStatus = useEditorStore((state) => state.scene.status);
  const graph = useEditorStore((state) => state.scene.graph);
  const stale = useEditorStore((state) => state.scene.stale);
  const params = useEditorStore((state) => state.params);
  const bake = useEditorStore((state) => state.bake);
  const generate = useEditorStore((state) => state.generate);
  const requestBake = useEditorStore((state) => state.requestBake);

  const predictedTop = useMemo(
    () => predictedTopMm(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    warningDeps(graph, params),
  );
  const blockReason = bakeBlockReason(graph, params);
  const baking = bake.phase === "queued" || bake.phase === "running";
  const generating = sceneStatus === "loading";
  // Empty while the bake is stale: the file on the server was built from
  // parameters the user has since moved.
  const links = bakeDownloadLinks(bake);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="generate-button"
          onClick={() => void generate()}
          disabled={generating}
          className="flex-1 rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {generating ? "Generating..." : stale && graph ? "Regenerate" : "Generate"}
        </button>
        <button
          type="button"
          data-testid="bake-button"
          onClick={() => void requestBake()}
          disabled={baking || blockReason !== null}
          title={blockReason ?? undefined}
          className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {baking ? "Baking..." : "Bake"}
        </button>
      </div>

      {predictedTop !== null ? (
        <p
          data-testid="predicted-height"
          data-predicted-mm={predictedTop.toFixed(1)}
          className={`text-xs ${
            predictedTop >= MAX_HEIGHT_MM
              ? "font-medium text-red-600 dark:text-red-400"
              : "text-neutral-500 dark:text-neutral-400"
          }`}
        >
          Predicted height {predictedTop.toFixed(1)} mm of {MAX_HEIGHT_MM.toFixed(0)} mm
        </p>
      ) : null}

      {blockReason && graph ? (
        <p
          data-testid="bake-block-reason"
          className="text-xs text-neutral-500 dark:text-neutral-400"
        >
          {blockReason}
        </p>
      ) : null}

      {bake.phase !== "idle" ? (
        <div className="space-y-2" data-testid="bake-status">
          <div className="flex items-center justify-between text-xs">
            <span
              className={
                bake.phase === "failed"
                  ? "text-red-600 dark:text-red-400"
                  : "text-neutral-600 dark:text-neutral-300"
              }
            >
              {bakeStatusLabel(bake)}
            </span>
            {bake.jobId ? (
              <span className="font-mono text-[10px] text-neutral-400">{bake.jobId}</span>
            ) : null}
          </div>

          {!isTerminal(bake.phase) ? (
            <div className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
                style={{ width: `${Math.round((bake.progress ?? 0.05) * 100)}%` }}
              />
            </div>
          ) : null}

          {bake.stale ? (
            <p
              data-testid="bake-stale-note"
              className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
            >
              {BAKE_STALE_NOTE}
            </p>
          ) : null}

          {links.length > 0 ? (
            <div className="flex gap-2" data-testid="download-links">
              {links.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  download={link.filename}
                  className="flex-1 rounded-md border border-emerald-500 px-3 py-1.5 text-center text-xs font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950"
                >
                  Download {link.label}
                </a>
              ))}
            </div>
          ) : null}

          {bake.warnings.length > 0 ? (
            <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
              {bake.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default BakeButton;
