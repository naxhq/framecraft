/**
 * Bake job state machine.
 *
 * `POST /bake` returns a job id immediately and the editor polls
 * `GET /bake/{job_id}` once a second until the job reaches a terminal state.
 * All of the state transitions live here as pure functions so they can be
 * tested against canned `BakeResult` objects without a server, which matters
 * because the /bake endpoints are mesh-bake's phase-3 deliverable and do not
 * exist yet.
 */

import { fileUrl } from "./api";
import type { BakeResult, PrintParams } from "./contracts";
import { resolvedOutputLines } from "./resolvedOutput";
import type { TokenContext } from "./tokens";

/**
 * Token expansion happens ONCE, client-side, right here: every `{token}`
 * FrameCraft knows about is fully resolved against `ctx` before the request
 * ever reaches `POST /bake` (DECISIONS [V3-P1]). Two rules this enforces:
 *
 *  - An engraving line (or the underside mark) that resolves EMPTY is never
 *    sent as `""`: the whole entry is OMITTED, so the bake never has to guess
 *    whether an empty string was deliberate. `lib/resolvedOutput.ts` is the
 *    single source of truth for which lines are cut vs skipped -- the Issues
 *    badge, the "Resolved output" panel and this function all read the same
 *    rows, so what the panel promises is exactly what gets sent.
 *  - With the frame off, every engraving line is omitted outright (the frame
 *    edges do not exist to cut into); the underside mark is unaffected, since
 *    it lives on the base, not the frame.
 *
 * Every other field of `params` passes through unchanged.
 */
export function resolveParamsForBake(
  params: PrintParams,
  ctx: TokenContext,
): PrintParams {
  const lines = resolvedOutputLines(params, ctx);
  const engravings = (params.engravings ?? []).flatMap((engraving, index) => {
    const line = lines.find((l) => l.index === index && l.id === `engraving-${index}`);
    if (!line || line.status !== "cut") return [];
    return [{ ...engraving, text: line.text }];
  });

  const underside = params.underside_mark;
  const undersideLine = lines.find((l) => l.id === "underside-mark");
  const resolvedUnderside =
    underside?.enabled && undersideLine?.status === "cut"
      ? { ...underside, template: undersideLine.text }
      : underside?.enabled
        ? { ...underside, enabled: false }
        : underside;

  return {
    ...params,
    engravings,
    underside_mark: resolvedUnderside,
  };
}

/** `idle` is client-only; the other four are the contract's status values. */
export type BakePhase = "idle" | "queued" | "running" | "done" | "failed";

export interface BakeState {
  phase: BakePhase;
  jobId: string | null;
  /** 0..1 when the server reports it, else null. Never moves backwards. */
  progress: number | null;
  result: BakeResult | null;
  /** Human-readable failure text: a failing validator, or a transport error. */
  error: string | null;
  warnings: string[];
  /**
   * True when a PrintParams value, the location or the SceneGraph changed after
   * this bake reached a terminal state, i.e. the stats and the files on the
   * server no longer describe what the preview is showing. The result is kept
   * (it is still a real bake) but it must not be offered as a download: 01's
   * whole promise is that the preview and the printed result agree.
   */
  stale: boolean;
}

export const POLL_INTERVAL_MS = 1000;

/** Shown by the Bake panel and the stats card while `stale` is true. */
export const BAKE_STALE_NOTE =
  "Parameters changed since this bake — bake again to download a matching file.";

export const initialBakeState: BakeState = {
  phase: "idle",
  jobId: null,
  progress: null,
  result: null,
  error: null,
  warnings: [],
  stale: false,
};

/** State right after `POST /bake` succeeded and before the first poll. */
export function bakeStarted(jobId: string): BakeState {
  return { ...initialBakeState, phase: "queued", jobId };
}

/** Terminal states stop the poller. */
export function isTerminal(phase: BakePhase): boolean {
  return phase === "done" || phase === "failed";
}

/**
 * Invalidate a finished bake because the inputs moved under it.
 *
 * Only a terminal bake can go stale: one that is still queued or running will
 * be replaced by its own poll result anyway, and `idle` has nothing to
 * invalidate. Returns the SAME object when nothing changes, so a store write
 * that marks an already-stale (or non-terminal) bake re-renders nothing.
 */
export function markBakeStale(previous: BakeState): BakeState {
  if (previous.stale || !isTerminal(previous.phase)) return previous;
  return { ...previous, stale: true };
}

/** Should the editor schedule another `GET /bake/{id}`? */
export function shouldPoll(state: BakeState): boolean {
  return state.jobId !== null && !isTerminal(state.phase) && state.phase !== "idle";
}

/**
 * Fold one `GET /bake/{job_id}` response into the state.
 *
 * - A response for a different job id is ignored (a stale in-flight poll from
 *   a bake the user replaced must not clobber the current one).
 * - `progress` is monotonic: the contract makes it optional, so a response
 *   without it keeps the last known value instead of blanking the bar.
 * - `done` implies 100%, `failed` always carries a message even if the server
 *   forgot to name the failing check.
 */
export function reduceBake(previous: BakeState, result: BakeResult): BakeState {
  if (previous.jobId !== null && result.job_id !== previous.jobId) {
    return previous;
  }
  const reported = typeof result.progress === "number" ? result.progress : null;
  let progress = reported ?? previous.progress;
  if (progress !== null) {
    progress = Math.min(1, Math.max(0, progress));
    if (previous.progress !== null) progress = Math.max(previous.progress, progress);
  }
  if (result.status === "done") progress = 1;

  const error =
    result.status === "failed"
      ? (result.error ?? "The bake failed and the server did not name a reason.")
      : null;

  return {
    phase: result.status,
    jobId: result.job_id,
    progress,
    result,
    error,
    warnings: result.warnings ?? [],
    // A response just off the wire describes the parameters this job was
    // started with, so it is current by definition.
    stale: false,
  };
}

/** A transport-level failure (API down, 500, aborted) ends the job locally. */
export function bakeFailedLocally(previous: BakeState, message: string): BakeState {
  return { ...previous, phase: "failed", error: message };
}

export interface DownloadLink {
  label: string;
  href: string;
  filename: string;
}

/**
 * Absolute download links for a finished bake. 3MF first: 04 makes it the
 * primary format and STL the fallback.
 *
 * Prefer `bakeDownloadLinks` in UI code: this one judges the RESULT only and
 * knows nothing about whether the parameters have moved since.
 */
export function downloadLinks(result: BakeResult | null): DownloadLink[] {
  if (!result || result.status !== "done" || !result.files) return [];
  const entries: Array<[string, string]> = [
    ["3MF", result.files["3mf"]],
    ["STL", result.files.stl],
  ];
  return entries
    .filter(([, path]) => typeof path === "string" && path.length > 0)
    .map(([label, path]) => ({
      label,
      href: fileUrl(path),
      filename: path.split("/").pop() ?? `framecraft.${label.toLowerCase()}`,
    }));
}

/**
 * The links the editor may actually offer: none while the bake is stale, so a
 * user can never download a file that does not match the preview in front of
 * them.
 */
export function bakeDownloadLinks(state: BakeState): DownloadLink[] {
  if (state.stale) return [];
  return downloadLinks(state.result);
}

/** Text for the progress row; `progress` is optional in the contract. */
export function bakeStatusLabel(state: BakeState): string {
  switch (state.phase) {
    case "idle":
      return "Not baked yet";
    case "queued":
      return "Queued...";
    case "running":
      return state.progress === null
        ? "Baking..."
        : `Baking... ${Math.round(state.progress * 100)}%`;
    case "done":
      return state.stale ? "Done (outdated)" : "Done";
    case "failed":
      return state.error ?? "Failed";
  }
}
