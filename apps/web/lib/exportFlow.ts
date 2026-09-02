/**
 * Export, v3: turning a fresh `EngineResult` into a downloaded file.
 *
 * There is no server round trip left in this module. Export means:
 * export `EngineResult` for `PrintParams.export_target` through
 * `lib/engine/export`, build the same sidecar JSON the CLI/Python validator
 * expects (`lib/engine/export/common.ts:buildSidecarJson`, so the two can
 * never drift), and hand the browser two (or more) Blob object URLs to
 * download. `store/editor.ts` is the only caller: it decides whether to
 * reuse the fresh engine result or run one first, and calls the pure
 * functions here to turn that result into files.
 */

import type { SceneGraph } from "./contracts";
import { perfMark, perfSpan } from "./perf";
import { isTauri, saveFileWithDialog } from "./platform";
import { buildSidecarJson, sanitizeStem } from "./engine/export/common";
import { exportForTarget, type ExportOutput, type ExportTarget, type SourceLocation } from "./engine/export";
import type { ColorChangePlan } from "./engine/export/colorchange";
import type { AuditFinding, EngineResult } from "./engine/types";
import { resolveProfile } from "./printers";

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

export function exportFailedLocally(previous: ExportState, message: string): ExportState {
  return { ...previous, phase: "failed", error: message };
}

/** The stem `runExport` defaults to when the caller does not name one: the city label, or "framecraft". */
export function stemForResult(result: EngineResult): string {
  const label = (result.params.city_label ?? "").trim();
  const base = label !== "" ? label.toLowerCase().replace(/\s+/g, "-") : "framecraft";
  return sanitizeStem(base);
}

export interface RunExportOptions {
  stem?: string;
  title?: string;
  source?: SourceLocation;
  layerHeightMm?: number;
}

export interface RunExportOutcome {
  output: ExportOutput;
  sidecarBytes: Uint8Array;
  sidecarName: string;
}

/**
 * Export `result` for `target` and build its sidecar JSON. Pure (besides the
 * `Date.now()` the sidecar's `created_at` reads): no Blob, no download, no
 * store write. `exportDone` turns the result into `DownloadFile[]`.
 */
export function runExport(result: EngineResult, target: ExportTarget, scene: SceneGraph, options: RunExportOptions = {}): RunExportOutcome {
  // The whole export as the user experiences it: the writer plus the sidecar.
  // `export.<target>` inside it is the writer alone (`export/index.ts`).
  return perfSpan("export.run", () => writeExport(result, target, scene, options));
}

function writeExport(result: EngineResult, target: ExportTarget, scene: SceneGraph, options: RunExportOptions): RunExportOutcome {
  const created = new Date();
  const stem = options.stem ?? stemForResult(result);
  const output = exportForTarget(result, target, {
    stem,
    title: options.title,
    created,
    source: options.source,
    layerHeightMm: options.layerHeightMm,
  });
  const sidecarBytes = perfSpan("export.sidecar", () => {
    const sidecar = buildSidecarJson({
      result,
      target,
      // The sidecar's provenance block names the same place the FILES do
      // (`[V3-P7-A10]`); passing it here is what keeps the two from disagreeing.
      source: options.source ?? null,
      files: output.files,
      notes: output.notes,
      scene,
      elapsedS: result.stats.elapsedMs / 1000,
      created,
      printerProfileId: resolveProfile(result.params).id,
    });
    return new TextEncoder().encode(`${JSON.stringify(sidecar, null, 2)}\n`);
  });
  // A mark, not a span: what matters about an export payload is its SIZE, and
  // the report's bytes column is where a 40 MB STEP file makes itself obvious.
  let bytes = sidecarBytes.byteLength;
  for (const file of output.files) bytes += file.bytes.byteLength;
  perfMark("export.bytes", { bytes });
  return { output, sidecarBytes, sidecarName: `${stem}.json` };
}

/**
 * Turn a `RunExportOutcome` into the new terminal `ExportState`, as Blob object
 * URLs the OUTPUT panel can hand straight to `<a download>`. Revokes whatever
 * URLs the previous state was holding first.
 */
export function exportDone(previous: ExportState, target: ExportTarget, outcome: RunExportOutcome, findings: AuditFinding[]): ExportState {
  revokeExportUrls(previous);
  const files: DownloadFile[] = [
    ...outcome.output.files.map((file) => ({
      label: file.name,
      filename: file.name,
      href: URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mime })),
      mime: file.mime,
    })),
    {
      label: outcome.sidecarName,
      filename: outcome.sidecarName,
      href: URL.createObjectURL(new Blob([outcome.sidecarBytes as BlobPart], { type: "application/json" })),
      mime: "application/json",
    },
  ];
  return {
    phase: "done",
    error: null,
    files,
    target,
    notes: outcome.output.notes,
    findings,
    plan: outcome.output.plan,
    stale: false,
  };
}

/** The links the editor may actually offer: none while the export is stale. */
export function exportDownloadLinks(state: ExportState): DownloadFile[] {
  if (state.stale) return [];
  return state.files;
}

/** Text for the phase row. */
export function exportStatusLabel(state: ExportState): string {
  switch (state.phase) {
    case "idle":
      return "Not exported yet";
    case "exporting":
      return "Exporting...";
    case "done":
      return state.stale ? "Done (outdated)" : "Done";
    case "failed":
      return state.error ?? "Failed";
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
