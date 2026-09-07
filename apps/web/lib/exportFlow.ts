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
  /**
   * What the file IS, which is not something a `.json` extension can say.
   *
   * `model` is the thing the user asked for and the thing Export delivers
   * without being asked twice (`deliverExportFiles`). `report` is the
   * validator sidecar: the same facts about the model as a JSON object, for
   * `make validate` and for a bug report, and NOT a project file -- a project
   * is `.framecraft` and is written by Save project. Offering the two as
   * equally weighted green buttons called "Download chicago.3mf" and
   * "Download chicago.json" is what made that ambiguous.
   */
  kind: "model" | "report";
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
  /**
   * One line about where the finished file went, or null before an export has
   * delivered one. Written by the store after `deliverExportFiles`; see
   * `deliveryNote`.
   */
  delivery: string | null;
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
  delivery: null,
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
    ...outcome.files.map((file): DownloadFile => ({
      label: file.name,
      filename: file.name,
      href: URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mime })),
      mime: file.mime,
      kind: "model",
    })),
    {
      label: outcome.sidecarName,
      filename: outcome.sidecarName,
      href: URL.createObjectURL(new Blob([sidecarBytes as BlobPart], { type: "application/json" })),
      mime: "application/json",
      kind: "report",
    },
  ];
  return {
    phase: "done",
    error: null,
    // The delivery has not happened yet: the store runs it on this state and
    // writes the note back. Saying anything here would be saying it early.
    delivery: null,
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

export type SaveOutcome =
  | "browser"
  | "saved"
  | "cancelled"
  | "failed"
  /** No DOM to deliver to: server rendering, or a unit test in the node environment. Not a failure; there was nothing to do. */
  | "unavailable";

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

/** The model files an export produced: what Export is for, without the sidecar. */
export function modelFiles(state: ExportState): DownloadFile[] {
  return state.files.filter((file) => file.kind === "model");
}

/**
 * Hand the finished model to the user, the way Save project already does.
 *
 * The defect this exists for, reported by the author against the deployed
 * 3.1.0 site: "export doesn't work, it shows progress bar then says export
 * done but nothing downloaded automatically, had to click show results tiny
 * text to bring up result and output panel". That was exact.
 * `store/editor.ts:requestExport` ended at `exportDone` and nothing anywhere
 * triggered a download, so the only way to the file was a link inside a
 * COLLAPSIBLE section, and a button labelled Export reporting "Done" had
 * written nothing the user could find. The asymmetry made it plain that it was
 * an omission rather than a policy: Save project has always delivered its file
 * on the click (`lib/project.ts:downloadProject`).
 *
 * The links in the Output panel stay exactly where they are. They are now what
 * they should always have been -- a way to fetch the file AGAIN without
 * rebuilding it -- rather than the only way to fetch it at all.
 *
 * Every model file goes, not just the first: an OBJ export is a `.obj` AND its
 * `.mtl`, and delivering one of the two is delivering a model with no colours.
 * The sidecar never goes: it is a report about the file, the user did not ask
 * for it, and a second automatic download of something they did not ask for is
 * how a browser learns to distrust this page.
 *
 * Returns what happened per file, so the action bar can say which file it
 * saved rather than claiming one it did not.
 */
export async function deliverExportFiles(files: readonly DownloadFile[]): Promise<SaveOutcome[]> {
  const out: SaveOutcome[] = [];
  for (const file of files) {
    if (isTauri()) {
      // Sequential, not concurrent: each file gets its own native dialog and
      // two dialogs racing for the same window is not a save flow.
      out.push(await saveDownloadFile(file));
      continue;
    }
    out.push(clickDownload(file));
  }
  return out;
}

/**
 * The browser half: an `<a download>` built, clicked and removed.
 *
 * The same shape as `lib/project.ts:downloadProject`, deliberately, minus the
 * `URL.revokeObjectURL` -- the object URL belongs to `ExportState` and the
 * Output panel's own link still points at it, so revoking here would take the
 * re-download away the moment the first one succeeded. `exportStarted` and
 * `revokeExportUrls` free them when the export stops being current.
 */
function clickDownload(file: DownloadFile): SaveOutcome {
  if (typeof document === "undefined") return "unavailable";
  try {
    const link = document.createElement("a");
    link.href = file.href;
    link.download = file.filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return "browser";
  } catch {
    return "failed";
  }
}

/**
 * What the action bar says after a delivery, or null when there is nothing to
 * add to "Done".
 *
 * A browser download is not observable from script -- the anchor click returns
 * nothing and the file may still land in a download shelf the user has to
 * open -- so this NAMES the file rather than claiming it arrived somewhere
 * specific. Inside the desktop shell the dialog's own outcome is known, so a
 * cancel and a failure can be told apart and said out loud.
 */
export function deliveryNote(files: readonly DownloadFile[], outcomes: readonly SaveOutcome[]): string | null {
  if (files.length === 0) return null;
  // No DOM at all is not an outcome worth reporting: nothing was asked of the
  // page and nothing failed. Server rendering and the node test environment.
  if (outcomes.every((outcome) => outcome === "unavailable")) return null;
  const names = files.map((file) => file.filename).join(" and ");
  if (outcomes.every((outcome) => outcome === "browser")) return `${names} downloaded.`;
  if (outcomes.some((outcome) => outcome === "failed")) {
    return `${names} could not be saved. The download links below still hold the file.`;
  }
  if (outcomes.every((outcome) => outcome === "cancelled")) {
    return "Nothing was saved. The download links below still hold the file.";
  }
  const saved = files.filter((_, index) => outcomes[index] === "saved").map((file) => file.filename);
  if (saved.length === 0) return null;
  return `${saved.join(" and ")} saved.`;
}
