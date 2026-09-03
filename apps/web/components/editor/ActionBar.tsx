"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { APPLICATION } from "@/lib/engine/export/common";
import { blockingFindings } from "@/lib/engine/export/gate";
import { hashString, planFor, stableJson } from "@/lib/engine/pipeline";
import type { AuditFinding, EngineResult } from "@/lib/engine/types";
import { exportStatusLabel } from "@/lib/exportFlow";
import { stageLabel } from "@/lib/hud";
import { isTauri, saveFileWithDialog } from "@/lib/platform";
import {
  LEGACY_PROJECT_FILE_EXTENSION,
  PROJECT_FILE_ACCEPT,
  PROJECT_FILE_EXTENSION,
  buildProject,
  downloadProject,
  parseProject,
  projectFilename,
  serializeProject,
  type ProjectLoadResult,
} from "@/lib/project";
import { recentDesignName, recordRecent } from "@/lib/recent";
import { SHARE_LINK_LENGTH_LIMIT, encodeShare, shareUrl } from "@/lib/share";
import { exportBlockReason, heightCeilingMm, predictedTopMm, warningDeps } from "@/lib/warnings";
import type { PipelineFailure, PipelineProgress } from "@/store/editor";
import { locationToRequest, useEditorStore } from "@/store/editor";
import { Note } from "./Controls";
import ExportErrorDetail, { type ErrorDetailModel, type ErrorDetailTone } from "./ExportErrorDetail";
import ExportMenu, { ExportTargetNotes } from "./ExportMenu";
import ProgressBar, { type RunProgressModel } from "./ProgressBar";

/**
 * The action bar: everything that DOES something, in one place that never
 * moves.
 *
 * It is mounted from `EditorShell` at the top of the settings column, above
 * the parameter panel and outside its scrolling list, which is the whole
 * point. Before this, Preview and Export lived at the bottom of the panel
 * inside a results block that grew and shrank with every run, so the two
 * primary actions moved under the pointer whenever the thing they had just
 * started reported anything. The controls here keep their position through a
 * run, a cancel, an error and an export; only the status line under them
 * changes.
 *
 * What the bar holds, in order: Preview (which becomes Cancel while a run is
 * in flight), Export, the compact format selector, then the quieter row of
 * Save, Load and Copy link; then one status slot, which is the progress
 * control while something is running and one line of text otherwise; then the
 * notes that explain the actions -- the predicted height, the reason Export is
 * refused, a failure's readable message with its copyable detail, and the
 * share link.
 *
 * The RESULTS of a run (the stats, the estimate, the download links and the
 * export's notes) stay in `OutputPanel`, below. Actions here, outcomes there.
 */

// ---------------------------------------------------------------------------
// The export's own plan
// ---------------------------------------------------------------------------

/**
 * The stage ids an export runs, and the ones a build runs.
 *
 * A `full` run is exactly the prefix of an `export` run: `planFor` filters one
 * registry in one order by phase, and `export` is the last phase. So a build's
 * `index` counts against the same list an export finishes, and the stages an
 * export adds on top are exactly the tail -- today the single `export` stage
 * that writes the file. Both facts are pinned in `ActionBar.test.tsx` rather
 * than assumed here, so a stage added to the export phase moves this control
 * instead of quietly making its denominator wrong.
 */
export const EXPORT_PLAN_IDS: readonly string[] = planFor("export").map((stage) => stage.id);
export const BUILD_PLAN_IDS: readonly string[] = planFor("full").map((stage) => stage.id);
/** The stages an export adds to a build: what is left to do once the model exists. */
export const EXPORT_WRITER_IDS: readonly string[] = EXPORT_PLAN_IDS.slice(BUILD_PLAN_IDS.length);

/**
 * The progress model for an export.
 *
 * An export is one job over the same plan: the stages the model already
 * covered are served from the worker's cache, and the writer is the tail. So
 * while the build half is still running the numbers are the run's own, counted
 * against the EXPORT plan's length; once the run is done the writer is the
 * stage that is running, and it is the last one.
 *
 * Nothing here is a clock. When the model is already fresh the export IS just
 * the writer, and the bar says so by standing at its last step rather than
 * pretending to walk through stages that never ran.
 */
export function exportProgressModel(
  progress: PipelineProgress,
  buildRunning: boolean,
  elapsedMs: number,
): RunProgressModel {
  const total = EXPORT_PLAN_IDS.length;
  if (buildRunning && progress.total > 0) {
    return {
      kind: "export",
      stage: progress.stage,
      index: progress.index,
      total,
      phase: progress.phase,
      elapsedMs,
      etaMs: progress.etaMs,
    };
  }
  return {
    kind: "export",
    stage: EXPORT_WRITER_IDS[EXPORT_WRITER_IDS.length - 1] ?? "export",
    index: total - 1,
    total,
    phase: "export",
    elapsedMs,
    // The writer is one stage and the store times the RUN's stages, not this
    // one: there is no honest number for "left", so there is no number.
    etaMs: null,
  };
}

/** The progress model for a Preview: the store's own, verbatim, with the page's wall clock. */
export function previewProgressModel(progress: PipelineProgress, elapsedMs: number): RunProgressModel {
  return {
    kind: "preview",
    stage: progress.stage,
    index: progress.index,
    total: progress.total,
    phase: progress.phase,
    elapsedMs,
    etaMs: progress.etaMs,
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** One `key: value` per line, skipping the keys with nothing to say. */
function detailBlock(rows: ReadonlyArray<readonly [string, string | null]>): string {
  return rows
    .filter((row): row is readonly [string, string] => row[1] !== null && row[1].trim() !== "")
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

/** A short, stable fingerprint of the parameters a failure happened under, so two reports of "it broke" can be told apart. */
export function paramsFingerprint(params: unknown): string {
  return hashString(stableJson(params)).slice(0, 12);
}

/**
 * A run that failed.
 *
 * The headline names the stage, because "the model could not be built" on its
 * own tells the user nothing they can act on and nothing a maintainer can
 * search for. The worker's structured detail and stack go in the copyable
 * block, never in the sentence.
 */
export function runFailureModel(error: PipelineFailure, paramsHash: string): ErrorDetailModel {
  const where = stageLabel(error.stage);
  return {
    headline: `The model could not be built. It failed while ${where === "" ? error.stage : where} (stage "${error.stage}"): ${firstLine(error.message)}`,
    stage: error.stage,
    findingIds: [],
    detail: detailBlock([
      ["what", "the model build failed"],
      ["stage", error.stage],
      ["message", error.message],
      ["detail", error.detail],
      ["app", APPLICATION],
      ["params", paramsHash],
    ]),
  };
}

/**
 * An export that was refused or failed.
 *
 * Two shapes reach this. A refusal by the printability gate ([V3.1-P1-15])
 * arrives as the `export` stage's own message, which already names every
 * blocking finding by id and title; the findings themselves are re-derived
 * here from the model on screen with `blockingFindings`, the SAME function the
 * gate refuses with, so the ids in the detail block are the gate's own rather
 * than parsed back out of a sentence. A refusal the editor made before the
 * worker was asked at all (`lib/warnings.ts:exportBlockReason`) arrives as
 * that reason, with no findings and no stage.
 */
export function exportFailureModel(
  message: string,
  result: EngineResult | null,
  paramsHash: string,
): ErrorDetailModel {
  const blocking: AuditFinding[] = result === null ? [] : blockingFindings(result.findings);
  const ids = blocking.map((finding) => finding.id);
  const headline =
    ids.length === 0
      ? `The export was refused: ${firstLine(message)}`
      : `The export was refused by the printability gate (${ids.join(", ")}): ${firstLine(message)}`;
  return {
    headline,
    stage: ids.length === 0 ? null : "export",
    findingIds: ids,
    detail: detailBlock([
      ["what", "the export was refused"],
      ["stage", ids.length === 0 ? null : "export"],
      ["message", message],
      ["blocking", ids.length === 0 ? null : blocking.map((f) => `${f.id}: ${f.title} (${f.detail})`).join(" | ")],
      ["app", APPLICATION],
      ["params", paramsHash],
    ]),
  };
}

/**
 * An export the user stopped.
 *
 * This is not a failure and must not read as one ([V3.1-T6] 2). The store
 * cannot tell the two apart on its own: `cancelPipeline` leaves
 * `pipeline.error` at null because a cancel is not an error
 * (`store/editor.ts`), so `requestExport` sees its run resolve `null` with no
 * error to quote and falls through to "The engine could not build a model.",
 * which is false in both halves -- nothing was refused and nothing failed. The
 * bar has what the store does not, which is the transition: it watched a run
 * leave flight without a new result and without an error while an export was
 * waiting on it (`useRunOutcome`), and that is exactly what a cancel is.
 *
 * The stage is the one the run had reached, because "cancelled" on its own does
 * not tell a user how far the work got, and the copyable block is kept so a
 * cancel that was actually a hang still produces a report worth reading.
 */
export function exportCancelledModel(stage: string, paramsHash: string): ErrorDetailModel {
  const where = stageLabel(stage);
  const named = where === "" ? null : where;
  return {
    headline:
      named === null
        ? "The export was cancelled. No file was written, and the previous download is untouched."
        : `The export was cancelled while ${named} (stage "${stage}"). No file was written, and the previous download is untouched.`,
    stage: stage === "" ? null : stage,
    findingIds: [],
    detail: detailBlock([
      ["what", "the export was cancelled"],
      ["stage", stage === "" ? null : stage],
      ["message", "Cancel was pressed while the export was still building the model."],
      ["app", APPLICATION],
      ["params", paramsHash],
    ]),
  };
}

/** The first line of a message: a stack that crossed the wire belongs in the detail block, never in the sentence. */
function firstLine(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? "";
  return line === "" ? message.trim() : line;
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

const PRIMARY =
  "rounded-milled bg-primary px-3 py-2 text-sm font-medium text-primary-ink transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40";
// The secondary button's border IS its boundary, so it takes the control token
// (>= 3:1, WCAG 1.4.11) rather than the decorative hairline, which measured
// 1.87:1 on the raised surface in the dark theme.
const SECONDARY =
  "rounded-milled border border-control bg-plate-raised px-3 py-2 text-sm font-medium text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-40";
const QUIET =
  "rounded-milled border border-control bg-plate-raised px-2 py-1.5 text-2xs font-medium text-ink-muted transition-colors hover:border-ink-faint hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

export function ActionBar() {
  const sceneStatus = useEditorStore((state) => state.scene.status);
  const graph = useEditorStore((state) => state.scene.graph);
  const sceneStale = useEditorStore((state) => state.scene.stale);
  const params = useEditorStore((state) => state.params);
  const location = useEditorStore((state) => state.location);
  // Booleans and identities only: `state.pipeline.progress` is read by
  // `RunStatus` and `RunOutcomeNotice` alone, so the buttons and the notes here
  // do not re-render on each of a run's ~142 stage events.
  const pipelineRunning = useEditorStore((state) => state.pipeline.status === "running");
  const pipelineStale = useEditorStore((state) => state.pipeline.stale);
  const result = useEditorStore((state) => state.pipeline.result);
  const exportPhase = useEditorStore((state) => state.exportState.phase);
  const generate = useEditorStore((state) => state.generate);
  const requestExport = useEditorStore((state) => state.requestExport);
  const cancelPipeline = useEditorStore((state) => state.cancelPipeline);

  const predictedTop = useMemo(
    () => predictedTopMm(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    warningDeps(graph, params),
  );
  // The ACTIVE profile's own ceiling (`[V3-P4]`), straight, so this line and
  // the block reason below can never name two different numbers for one model.
  const heightCeiling = heightCeilingMm(params);
  const blockReason = exportBlockReason(graph, params);

  const exporting = exportPhase === "exporting";
  const hasScene = graph !== null;
  const hasModel = result !== null;
  /**
   * Nothing has moved since the last Preview AND a current model was built
   * from it, so Preview has nothing to do. The second half matters: after a
   * cancel the scene is still current but `pipeline.stale` is true and there
   * is no fresh model, and a Preview button that stayed disabled there would
   * leave the user nudging a slider back and forth to get a build started.
   */
  const nothingToPreview = sceneStatus === "ready" && !sceneStale && hasModel && !pipelineStale;
  const exportBlocked = blockReason !== null;

  const paramsHash = useMemo(() => paramsFingerprint(params), [params]);

  // --- the shareable link ---------------------------------------------------
  /*
    `window.location` is read in an effect, not during render: this is a client
    component but Next still renders it on the server, where there is no
    `window`, and a value that differs between the two is a hydration mismatch.
  */
  const [href, setHref] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual" | "too-large">("idle");
  useEffect(() => setHref(window.location.href), []);
  const link = useMemo(
    () => (href === null ? null : shareUrl(href, locationToRequest(location), params)),
    [href, location, params],
  );
  // A link that no longer describes what is on screen must not still say "Copied".
  useEffect(() => setCopyState("idle"), [link]);

  const recordCurrentAsRecent = (): void => {
    recordRecent(
      recentDesignName(params.city_label ?? ""),
      encodeShare(locationToRequest(location), params),
    );
  };

  const copyLink = async (): Promise<void> => {
    if (link === null) return;
    // [V3-P6]: even compressed, a configuration at the contract's real maxima
    // can exceed a sane URL length, and there is no server to hand out a short
    // id for one instead.
    if (link.length > SHARE_LINK_LENGTH_LIMIT) {
      setCopyState("too-large");
      return;
    }
    // The address bar becomes the link, without a navigation.
    window.history.replaceState(null, "", link);
    try {
      await navigator.clipboard.writeText(link);
      setCopyState("copied");
      recordCurrentAsRecent();
    } catch {
      setCopyState("manual");
      recordCurrentAsRecent();
    }
  };

  // --- the project file ([V3-P6]) ------------------------------------------
  const [projectError, setProjectError] = useState<string | null>(null);
  /**
   * Said once, after a project file that was in an older form loaded anyway
   * (Task 13): a version-3 envelope, the legacy `.framecraft.json` name, or
   * both. Its own slot next to `projectError` because it is not an error --
   * nothing failed, the design is on screen -- but without it the next Save
   * writing a differently named file has no explanation.
   */
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Save, through the same door the export links use.
   *
   * Inside the Tauri desktop shell an anchor download is inert, which is why
   * every export link already calls `saveDownloadFile`. Save had no such gate
   * (v3-02 inventory), so in the desktop build the one button that saves the
   * user's WORK did nothing at all. It now takes the native dialog there and
   * the Blob download in a browser, exactly like an export.
   */
  const saveProject = async (): Promise<void> => {
    const project = buildProject(location, params);
    if (!isTauri()) {
      downloadProject(project);
      return;
    }
    const bytes = new TextEncoder().encode(serializeProject(project));
    await saveFileWithDialog(projectFilename(project), bytes);
  };

  const openLoadDialog = (): void => {
    setProjectError(null);
    setProjectNotice(null);
    fileInputRef.current?.click();
  };

  const onProjectFileChosen = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0] ?? null;
    // Cleared regardless of outcome: choosing the SAME file twice in a row must
    // fire `onChange` again, which a browser will not do if the value is unchanged.
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    // The name is passed so a file saved under the legacy `.framecraft.json`
    // extension can say so once; the BYTES still decide whether it loads.
    const outcome = parseProject(text, file.name);
    const { error, notice } = projectLoadNotices(outcome);
    setProjectError(error);
    setProjectNotice(notice);
    if (!outcome.ok) return;
    useEditorStore.getState().applyProject(outcome.location, outcome.params);
  };

  return (
    <section
      aria-label="Actions"
      data-testid="action-bar"
      className="shrink-0 space-y-2 border-b border-line bg-plate px-4 py-3"
    >
      {/*
        The controls, in a row nothing below may move: the status slot, the
        notes and the whole results panel are all rendered AFTER this div, so a
        run, a cancel, an error or a finished export can only ever change what
        is underneath it.

        Pinned in two places, because the claim has two halves.
        `ActionBar.test.tsx` pins the COMPOSITION: every state renders the same
        controls in the same order, and the results panel keeps its five slots
        when they are empty. `e2e/actionbar.spec.ts` pins the BOX, which needs a
        laid-out page: it reads `action-bar-actions`'s own bounding rectangle
        idle, mid-run, after a refused export and after a finished one, and
        fails if any of the four differ.
      */}
      <div data-testid="action-bar-actions" className="space-y-2">
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="preview-button"
            data-mode={pipelineRunning ? "cancel" : "preview"}
            onClick={() => (pipelineRunning ? cancelPipeline() : void generate())}
            /*
              `scene.status === "loading"` is deliberately NOT part of this.
              `generate()` writes it and calls `startPipelineRun` in the same
              synchronous block, so `pipeline.status` is `running` whenever the
              scene is loading and `pipelineRunning` already covers it. The
              `fetching` term and the "Previewing..." label it fed were both
              unreachable ([V3.1-T6] 5); a disabled expression with a branch
              nothing can enter is a claim about behaviour that no test can
              fail.
            */
            disabled={!pipelineRunning && nothingToPreview}
            title={
              pipelineRunning
                ? "Stop the run. The model on screen stays."
                : nothingToPreview
                  ? "The model already matches this location and these settings."
                  : undefined
            }
            className={`flex-1 ${pipelineRunning || hasScene ? SECONDARY : PRIMARY}`}
          >
            {pipelineRunning ? "Cancel" : sceneStale && graph ? "Preview again" : "Preview"}
          </button>
          <button
            type="button"
            data-testid="export-button"
            onClick={() => void requestExport()}
            disabled={exporting || exportBlocked}
            title={blockReason ?? undefined}
            className={`flex-1 ${hasScene ? PRIMARY : SECONDARY}`}
          >
            {exporting ? "Exporting..." : "Export"}
          </button>
          <ExportMenu />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            data-testid="save-project-button"
            onClick={() => void saveProject()}
            title={`Save this whole design as a ${PROJECT_FILE_EXTENSION} file`}
            className={`flex-1 ${QUIET}`}
          >
            Save project
          </button>
          <button
            type="button"
            data-testid="load-project-button"
            onClick={openLoadDialog}
            title={`Load a ${PROJECT_FILE_EXTENSION} file (or an older ${LEGACY_PROJECT_FILE_EXTENSION}), replacing every setting`}
            className={`flex-1 ${QUIET}`}
          >
            Load project
          </button>
          {/*
            The link is on the button as a data attribute whether or not the
            clipboard write is allowed, so it is always readable: by a person,
            by a test, and by the field below.
          */}
          <button
            type="button"
            data-testid="copy-link-button"
            data-share-url={link ?? ""}
            onClick={() => void copyLink()}
            disabled={link === null}
            title="Copy a link that restores every setting on this page"
            className={`flex-1 ${QUIET}`}
          >
            {copyState === "copied" ? "Link copied" : "Copy link"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={PROJECT_FILE_ACCEPT}
            aria-label="Load a FrameCraft project file"
            data-testid="load-project-input"
            className="hidden"
            onChange={(event) => void onProjectFileChosen(event)}
          />
        </div>
      </div>

      <RunStatus />

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

      {blockReason !== null && graph !== null ? (
        <Note tone="warn" testId="export-block-reason">
          {blockReason}
        </Note>
      ) : null}

      <RunOutcomeNotice paramsHash={paramsHash} />

      <ExportTargetNotes />

      {projectError !== null ? (
        <Note tone="warn" testId="project-error">
          {projectError}
        </Note>
      ) : null}

      {projectNotice !== null ? (
        <Note tone="info" testId="project-migrated">
          {projectNotice}
        </Note>
      ) : null}

      {copyState === "too-large" && link !== null ? (
        <Note tone="warn" testId="share-too-large">
          This design is too large for a link ({link.length} characters). Use Save
          project instead:{" "}
          <button
            type="button"
            data-testid="share-too-large-save-project"
            onClick={() => void saveProject()}
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
    </section>
  );
}

// ---------------------------------------------------------------------------
// What the last run did, which only the transition can say
// ---------------------------------------------------------------------------

/** How the run that just left flight ended, for the two surfaces that report it. */
export interface RunOutcome {
  /**
   * The stage a CANCELLED run stopped at, or null when the last run finished or
   * failed. `""` when the cancel arrived before the first stage was named.
   */
  cancelledAt: string | null;
  /** True when the run that was cancelled was the one an export was waiting on. */
  exportCancelled: boolean;
}

export const NO_OUTCOME: RunOutcome = { cancelledAt: null, exportCancelled: false };

/** What the watcher remembers between renders. */
export interface RunWatchState {
  running: boolean;
  /** The last stage the running run named. Reset when a run starts. */
  stage: string;
  /** The result object that was on screen when this run started, compared by identity. */
  resultAtStart: EngineResult | null;
  exportPhase: string;
  /** An export asked for a model and has not been told the answer yet. */
  exportInFlight: boolean;
}

export const INITIAL_RUN_WATCH: RunWatchState = {
  running: false,
  stage: "",
  resultAtStart: null,
  exportPhase: "idle",
  exportInFlight: false,
};

/**
 * One render's worth of the watch: the whole classification, as a pure step so
 * it can be driven event by event without a React renderer.
 *
 * `outcome: null` means "this render said nothing new"; whatever is on screen
 * stands. Every other value REPLACES it, `NO_OUTCOME` included -- a new export
 * or a finished one clears a stale "Cancelled at roads." that would otherwise
 * sit under a fresh download link.
 */
export function stepRunOutcome(
  seen: RunWatchState,
  input: {
    running: boolean;
    stage: string;
    result: EngineResult | null;
    pipelineStatus: string;
    sceneStatus: string;
    exportPhase: string;
  },
): { seen: RunWatchState; outcome: RunOutcome | null } {
  const next: RunWatchState = { ...seen };
  let outcome: RunOutcome | null = null;

  if (input.exportPhase !== seen.exportPhase) {
    next.exportPhase = input.exportPhase;
    if (input.exportPhase === "exporting") {
      next.exportInFlight = true;
      outcome = NO_OUTCOME;
    } else if (input.exportPhase === "done") {
      next.exportInFlight = false;
      outcome = NO_OUTCOME;
    } else if (input.exportPhase === "idle") {
      next.exportInFlight = false;
    }
  }

  if (input.running && !seen.running) {
    next.resultAtStart = input.result;
    next.stage = "";
    outcome = NO_OUTCOME;
  }
  if (input.running && input.stage !== "") next.stage = input.stage;
  if (!input.running && seen.running) {
    // A run that stopped running without landing a NEW result and without an
    // error was stopped by somebody. That is the only definition available:
    // the store puts `pipeline.status` back to `ready` and clears `progress`
    // on a cancel, precisely because a cancel is not a failure.
    const finished = input.result !== next.resultAtStart;
    const failed = input.pipelineStatus === "error" || input.sceneStatus === "error";
    outcome =
      finished || failed
        ? NO_OUTCOME
        : { cancelledAt: next.stage, exportCancelled: next.exportInFlight };
  }
  next.running = input.running;
  return { seen: next, outcome };
}

/**
 * Watch runs leave flight and classify how they ended.
 *
 * A cancel resets `progress` to the idle value and puts `pipeline.status` back
 * to `ready`, deliberately: a cancelled run is not an error and the last good
 * model stays on screen. So neither the stage it stopped at nor the fact that
 * it was cancelled at all survives in the store, and both have to be read off
 * the TRANSITION -- a run that stopped running without landing a new result and
 * without an error was stopped by somebody. That works for the viewport's own
 * Stop button and the `g` shortcut too, neither of which this module hears
 * about.
 *
 * `exportCancelled` is the same observation with one more bit: was an export
 * waiting on that run. It is tracked as a ref rather than read from
 * `exportState.phase` at the moment of the cancel, because the store writes the
 * cancel and the export's own failure in two `set` calls that React batches
 * into one render, so by the time this effect runs the phase has already moved
 * on to `failed`.
 *
 * Call it from a leaf. It subscribes to `pipeline.progress.stage`, which a full
 * Chicago plan writes 142 times per run.
 */
export function useRunOutcome(): RunOutcome {
  const running = useEditorStore((state) => state.pipeline.status === "running");
  const progressStage = useEditorStore((state) => state.pipeline.progress.stage);
  const result = useEditorStore((state) => state.pipeline.result);
  const pipelineStatus = useEditorStore((state) => state.pipeline.status);
  const sceneStatus = useEditorStore((state) => state.scene.status);
  const exportPhase = useEditorStore((state) => state.exportState.phase);

  const [outcome, setOutcome] = useState<RunOutcome>(NO_OUTCOME);
  const seen = useRef<RunWatchState>(INITIAL_RUN_WATCH);

  useEffect(() => {
    const step = stepRunOutcome(seen.current, {
      running,
      stage: progressStage,
      result,
      pipelineStatus,
      sceneStatus,
      exportPhase,
    });
    seen.current = step.seen;
    if (step.outcome === null) return;
    const settled = step.outcome;
    // Identity-stable when nothing changed, so a run's 142 stage events cannot
    // re-render this component's parent through a fresh object.
    setOutcome((previous) =>
      previous.cancelledAt === settled.cancelledAt &&
      previous.exportCancelled === settled.exportCancelled
        ? previous
        : settled,
    );
  }, [running, progressStage, result, pipelineStatus, sceneStatus, exportPhase]);

  return outcome;
}

// ---------------------------------------------------------------------------
// The failure surface
// ---------------------------------------------------------------------------

/**
 * Which of the three things that can go wrong is on screen, if any.
 *
 * A run failure outranks an export one: when the build broke, the export's
 * "there was no model" is a consequence and not news. Below it, a cancel is
 * checked BEFORE a refusal, because the store gives both the same
 * `exportState.phase` of `failed` and the same fallback message, and only the
 * observed transition can separate them ([V3.1-T6] 2).
 */
export function failureNotice(input: {
  pipelineError: PipelineFailure | null;
  pipelineRunning: boolean;
  exportPhase: string;
  exportError: string | null;
  result: EngineResult | null;
  outcome: RunOutcome;
  paramsHash: string;
}): { model: ErrorDetailModel; testId: string; tone: ErrorDetailTone } | null {
  if (input.pipelineError !== null && !input.pipelineRunning) {
    return {
      model: runFailureModel(input.pipelineError, input.paramsHash),
      testId: "run-error-detail",
      tone: "danger",
    };
  }
  if (input.exportPhase !== "failed") return null;
  if (input.outcome.exportCancelled) {
    return {
      model: exportCancelledModel(input.outcome.cancelledAt ?? "", input.paramsHash),
      testId: "export-cancelled-detail",
      tone: "note",
    };
  }
  if (input.exportError === null) return null;
  return {
    model: exportFailureModel(input.exportError, input.result, input.paramsHash),
    testId: "export-error-detail",
    tone: "danger",
  };
}

/**
 * The failure surface, as its OWN store subscriber.
 *
 * It has to be, because telling a cancel from a refusal needs
 * `useRunOutcome`, which watches `pipeline.progress.stage` -- 142 writes on a
 * full Chicago run. Reading that from `ActionBar` would re-render the buttons,
 * the share-link memo and every note on all 142, which is the exact cost
 * `RunStatus` was split out to avoid.
 */
export function RunOutcomeNotice({ paramsHash }: { paramsHash: string }) {
  const pipelineError = useEditorStore((state) => state.pipeline.error);
  const pipelineRunning = useEditorStore((state) => state.pipeline.status === "running");
  const result = useEditorStore((state) => state.pipeline.result);
  const exportPhase = useEditorStore((state) => state.exportState.phase);
  const exportError = useEditorStore((state) => state.exportState.error);
  const outcome = useRunOutcome();

  const notice = failureNotice({
    pipelineError,
    pipelineRunning,
    exportPhase,
    exportError,
    result,
    outcome,
    paramsHash,
  });
  if (notice === null) return null;
  return <ExportErrorDetail model={notice.model} testId={notice.testId} tone={notice.tone} />;
}

// ---------------------------------------------------------------------------
// The status slot
// ---------------------------------------------------------------------------

/**
 * The one line under the buttons: the progress control while something runs,
 * a sentence otherwise.
 *
 * Its own subscriber, for the reason `PipelineStageOverlay` is one: a run
 * reports every stage twice, 142 events on a full Chicago plan, and each one
 * writes `state.pipeline.progress`. Reading that from `ActionBar` would
 * re-render the buttons, the share link memo and every note on all 142.
 */
export function RunStatus() {
  const running = useEditorStore((state) => state.pipeline.status === "running");
  const progress = useEditorStore((state) => state.pipeline.progress);
  const result = useEditorStore((state) => state.pipeline.result);
  const pipelineStatus = useEditorStore((state) => state.pipeline.status);
  const exportState = useEditorStore((state) => state.exportState);
  const exporting = exportState.phase === "exporting";
  const { cancelledAt, exportCancelled } = useRunOutcome();

  // The wall clock. `progress.elapsedMs` is the sum of the stage times the
  // worker reported, which is the right number to compare with `etaMs` and the
  // wrong one to show a person waiting: it does not move between events.
  const active = running || exporting;
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setElapsedMs(0);
      return undefined;
    }
    startedAt.current = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - (startedAt.current ?? Date.now()));
    }, 250);
    return () => clearInterval(timer);
  }, [active]);

  const model: RunProgressModel | null = exporting
    ? exportProgressModel(progress, running, elapsedMs)
    : running && progress.total > 0
      ? previewProgressModel(progress, elapsedMs)
      : null;

  return (
    <div className="min-h-[1.75rem]" data-testid="action-bar-status-slot">
      {model !== null ? (
        <ProgressBar model={model} />
      ) : (
        <p data-testid="action-bar-status" className="truncate text-2xs text-ink-muted">
          {statusLine({
            cancelledAt,
            exportCancelled,
            pipelineStatus,
            hasResult: result !== null,
            exportLabel: exportStatusLabel(exportState),
            exportPhase: exportState.phase,
            running,
          })}
        </p>
      )}
    </div>
  );
}

/**
 * The two slots a project load can fill, from one parse outcome (Task 13).
 *
 * A pure function so the rule is testable without a DOM, in the same style as
 * `statusLine` and `failureNotice` above it. The rule itself is one sentence:
 * a refusal fills the error slot and nothing else, and an accepted file fills
 * the notice slot only when it was in an older form. Both are cleared on the
 * other branch, so a second load can never show the first load's message.
 */
export function projectLoadNotices(outcome: ProjectLoadResult): {
  error: string | null;
  notice: string | null;
} {
  if (!outcome.ok) return { error: outcome.reason, notice: null };
  return { error: null, notice: outcome.migrated };
}

/** The sentence in the status slot when nothing is running. */
export function statusLine(input: {
  cancelledAt: string | null;
  /** The cancel stopped an export, not just a Preview ([V3.1-T6] 2). */
  exportCancelled?: boolean;
  pipelineStatus: string;
  hasResult: boolean;
  exportLabel: string;
  exportPhase: string;
  running: boolean;
}): string {
  if (input.running) return "Starting...";
  if (input.cancelledAt !== null) {
    // Ahead of the `failed` branch on purpose: a cancelled export IS a failed
    // export as far as the store is concerned, and "Export refused." is the
    // wrong word for something the user asked to stop.
    const what = input.exportCancelled === true ? "Export cancelled" : "Cancelled";
    const where = stageLabel(input.cancelledAt);
    return where === "" ? `${what}.` : `${what} at ${where}.`;
  }
  if (input.pipelineStatus === "error") return "The model could not be built.";
  if (input.exportPhase === "failed") return "Export refused.";
  if (input.exportPhase === "done") return `Export: ${input.exportLabel}`;
  if (input.hasResult) return "Model ready. Export writes the file.";
  return "Nothing built yet. Preview builds the model.";
}

export default ActionBar;
