/**
 * Export, v3.1: turning the worker's finished files into downloads.
 *
 * There is no server round trip left in this module, and since v3.1 there is
 * no exporter call either: the writer and the sidecar are the pipeline's own
 * `export` stage (`lib/engine/pipeline/stages.ts`), so an export is "run the
 * remaining uncached stages and write the file" rather than a second build on
 * the main thread. What is left here is the part that can only happen on the
 * page: turning the transferred bytes into Blob object URLs, and the staleness
 * labelling that stops an outdated file being offered.
 *
 * `store/editor.ts` is the only caller: it awaits the run that is already
 * under way (or starts one), asks `PipelineClient.exportFiles` for the files,
 * and hands the result here.
 */

import { perfMark } from "./perf";
import { isTauri, saveFileWithDialog } from "./platform";
import { sanitizeStem } from "./engine/export/common";
import type { ExportTarget } from "./engine/export";
import type { ColorChangePlan } from "./engine/export/colorchange";
import type { ExportOut } from "./engine/pipeline";
import type { AuditFinding, EngineResult } from "./engine/types";

export type ExportPhase = "idle" | "exporting" | "done" | "failed";

export interface DownloadFile {
  /** Shown next to the download link; the file's own name. */
  label: string;
  filename: string;
  /** A `blob:` object URL. Revoked by `exportStarted`/`revokeExportUrls` the moment it stops being current. */
  href: string;
  mime: string;
}

export interface ExportState {
  phase: ExportPhase;
  error: string | null;
  files: DownloadFile[];
  target: ExportTarget | null;
  /** Remarks from the exporter (STEP size, the colour-change plan in prose). */
  notes: string[];
  findings: AuditFinding[];
  plan: ColorChangePlan | null;
  /**
   * True once a PrintParams value, the location or the SceneGraph changed
   * after this export was produced, i.e. the files no longer describe what
   * the preview is showing. The result is kept (the stats and the resolved
   * text still describe a real build) but it must not be offered as a
   * download: 01's whole promise is that the preview and the printed result
   * agree.
   */
  stale: boolean;
}

export const initialExportState: ExportState = {
  phase: "idle",
  error: null,
  files: [],
  target: null,
  notes: [],
  findings: [],
  plan: null,
  stale: false,
};

/** Shown by the Output panel and the stats card while `stale` is true. */
export const EXPORT_STALE_NOTE =
  "Parameters changed since this export. Export again to download a matching file.";

/** Revoke every Blob URL a `ExportState` is holding. A `blob:` URL leaks until it is revoked or the page unloads. */
export function revokeExportUrls(state: ExportState): void {
  for (const file of state.files) {
    if (!file.href.startsWith("blob:")) continue;
    try {
      URL.revokeObjectURL(file.href);
    } catch {
      // already revoked, or no URL API (SSR/Node): nothing to clean up.
    }
  }
}

/**
 * Invalidate a finished export because the inputs moved under it.
 *
 * Only a terminal (`done`) export can go stale: one still `exporting` will be
 * replaced by its own completion anyway, and `idle` has nothing to
 * invalidate. A `failed` export goes stale too, so an old failure message
 * stops looking like a verdict on the CURRENT parameters. Returns the SAME
 * object when nothing changes, so a store write that marks an already-stale
 * (or non-terminal) export re-renders nothing.
 */
export function markExportStale(previous: ExportState): ExportState {
  if (previous.stale || !isTerminal(previous.phase)) return previous;
  return { ...previous, stale: true };
}

export function exportStarted(previous: ExportState): ExportState {
  return { ...previous, phase: "exporting", error: null };
}

/**
 * An export that produced no file: refused by the gate, refused by the editor
 * before the worker was asked, or stopped by the user mid-run.
 *
 * The previous export's `files` are carried over UNTOUCHED and its Blob URLs
 * are deliberately not revoked ([V3.1-P1-15]: "the previously downloadable
 * files stay exactly where they were"). Whether they may still be OFFERED is a
 * separate question that `exportDownloadLinks` answers from `stale`, so a
 * refusal never takes a good file away and a parameter change always does.
 */
export function exportFailedLocally(previous: ExportState, message: string): ExportState {
  return { ...previous, phase: "failed", error: message };
}

/**
 * The file stem the store asks the `export` stage for: the city label, or
 * "framecraft".
 *
 * The stage falls back to the same label with the same slug rule when no stem
 * is passed, but it does NOT run `sanitizeStem`, so this is what keeps a label
 * carrying a slash or a colon out of the file name.
 */
export function stemForResult(result: EngineResult): string {
  const label = (result.params.city_label ?? "").trim();
  const base = label !== "" ? label.toLowerCase().replace(/\s+/g, "-") : "framecraft";
  return sanitizeStem(base);
}

/**
 * Turn the worker's `ExportOut` into the new terminal `ExportState`, as Blob
 * object URLs the OUTPUT panel can hand straight to `<a download>`. Revokes
 * whatever URLs the previous state was holding first.
 *
 * The bytes arrive transferred from the worker; the sidecar arrives as the
 * object the reference validator reads, and is encoded here so the two files
 * are offered the same way.
 */
export function exportDone(previous: ExportState, outcome: ExportOut, findings: AuditFinding[]): ExportState {
  revokeExportUrls(previous);
  const sidecarBytes = new TextEncoder().encode(`${JSON.stringify(outcome.sidecar, null, 2)}\n`);
  // A mark, not a span: what matters about an export payload is its SIZE, and
  // the report's bytes column is where a 40 MB STEP file makes itself obvious.
  let bytes = sidecarBytes.byteLength;
  for (const file of outcome.files) bytes += file.bytes.byteLength;
  perfMark("export.bytes", { bytes });
  const files: DownloadFile[] = [
    ...outcome.files.map((file) => ({
      label: file.name,
      filename: file.name,
      href: URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mime })),
      mime: file.mime,
    })),
    {
      label: outcome.sidecarName,
      filename: outcome.sidecarName,
      href: URL.createObjectURL(new Blob([sidecarBytes as BlobPart], { type: "application/json" })),
      mime: "application/json",
    },
  ];
  return {
    phase: "done",
    error: null,
    files,
    target: outcome.target,
    notes: outcome.notes,
    // The engine's findings for the model, plus the writer's own for the FILE:
    // a format that could not carry every face says so here rather than leaving
    // the user to find it in `make validate` (`export/stl.ts`).
    findings: [...findings, ...(outcome.findings ?? [])],
    plan: outcome.plan,
    stale: false,
  };
}

/** The links the editor may actually offer: none while the export is stale. */
export function exportDownloadLinks(state: ExportState): DownloadFile[] {
  if (state.stale) return [];
  return state.files;
}

/**
 * Text for the phase row in the results panel.
 *
 * The `failed` case names the PHASE and not the message. `state.error` is
 * whatever ended the export, and the store writes the same string for two
 * different events: a refusal by the printability gate, and a run the user
 * stopped while the export was waiting on it ([V3.1-T6] 2). Echoing it here put
 * "The engine could not build a model." in the results panel for a user-pressed
 * Cancel, which is false twice over -- nothing failed and nothing was refused.
 * The one thing that is true of every `failed` export is that no file came out
 * of it ([V3.1-P1-15]), so that is what this says; the sentence explaining WHY,
 * and the copyable detail behind it, belong to the action bar's own failure
 * surface, which can tell a cancel from a refusal.
 */
export const EXPORT_FAILED_LABEL = "No file written";

/**
 * What `requestExport` records when the run it was waiting on ended without a
 * result and without an error: a user-pressed Cancel, or a run superseded by a
 * newer one.
 *
 * It replaces "The engine could not build a model.", which the store used to
 * write for both, and which was false in both halves of the sentence for the
 * cancel case ([V3.1-T6] 2). Every word here is true of both endings: the
 * export stopped, no file was written, and whatever was downloaded before is
 * still on disk.
 */
export const EXPORT_STOPPED_MESSAGE =
  "The export was stopped before a file was written. The previous download is untouched.";

export function exportStatusLabel(state: ExportState): string {
  switch (state.phase) {
    case "idle":
      return "Not exported yet";
    case "exporting":
      return "Exporting...";
    case "done":
      return state.stale ? "Done (outdated)" : "Done";
    case "failed":
      return EXPORT_FAILED_LABEL;
  }
}

export function isTerminal(phase: ExportPhase): boolean {
  return phase === "done" || phase === "failed";
}

export type SaveOutcome = "browser" | "saved" | "cancelled" | "failed";

/**
 * Route one finished download through the right door for the platform.
 *
 * In a browser this returns "browser" without doing anything: the caller's
 * `<a download href="blob:...">` is the download, and the anchor's default
 * behaviour should proceed. Inside the Tauri desktop shell (where WebView
 * anchor downloads do not exist) the caller prevents the anchor's default
 * and this reads the Blob back out of the object URL and hands the bytes to
 * the native save dialog (`lib/platform.ts:saveFileWithDialog`).
 */
export async function saveDownloadFile(file: DownloadFile): Promise<SaveOutcome> {
  if (!isTauri()) return "browser";
  try {
    const response = await fetch(file.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return (await saveFileWithDialog(file.filename, bytes)) ? "saved" : "cancelled";
  } catch {
    return "failed";
  }
}
