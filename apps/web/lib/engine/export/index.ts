// One entry point per PrintParams.export_target. Every exporter is pure:
// `(result, options) => ExportFile | ExportFile[]`, no manifold, no DOM.

import type { PrintParams } from "../../contracts";
import { perfSpan } from "../../perf";
import { resolveProfile, type PrinterProfile } from "../../printers";
import type { AuditFinding, EngineResult, ExportFile } from "../types";
import { exportBambu3mf, type Bambu3mfOptions } from "./bambu3mf";
import { exportTiledZip, isTiled } from "./tiles";
import { describePlan, type ColorChangePlan } from "./colorchange";
import type { ExportOptions } from "./common";
import { exportGeneric3mf, type Generic3mfOptions } from "./generic3mf";
import { exportObj } from "./obj";
import { exportStep, type StepOptions } from "./step";
import { exportStl, exportStlPartsZip } from "./stl";

export type ExportTarget = NonNullable<PrintParams["export_target"]>;

export const EXPORT_TARGETS: readonly ExportTarget[] = [
  "bambu-3mf",
  "generic-3mf",
  "stl",
  "stl-parts-zip",
  "obj",
  "step",
  "color-change-3mf",
] as const;

export const EXPORT_TARGET_LABELS: Readonly<Record<ExportTarget, string>> = {
  "bambu-3mf": "Bambu Studio project (.3mf)",
  "generic-3mf": "Generic 3MF (.3mf)",
  stl: "STL, single body (.stl)",
  "stl-parts-zip": "STL per region (.zip)",
  obj: "OBJ + MTL (.obj)",
  step: "STEP AP214 faceted (.step)",
  "color-change-3mf": "Single-nozzle colour-change project (.3mf)",
};

export function isExportTarget(value: unknown): value is ExportTarget {
  return typeof value === "string" && (EXPORT_TARGETS as readonly string[]).includes(value);
}

export interface ExportForTargetOptions extends ExportOptions {
  profile?: PrinterProfile;
  layerHeightMm?: number;
  mode?: Generic3mfOptions["mode"];
  triangleWarnLimit?: number;
}

export interface ExportOutput {
  target: ExportTarget;
  files: ExportFile[];
  /** Human-readable remarks (STEP size, colour-change plan). */
  notes: string[];
  /**
   * Findings the WRITER raised, which the engine's own audit could not: what a
   * format could not carry (`export/stl.ts`'s `float32-degenerate`). They are
   * also repeated into `notes`, because that is the channel the OUTPUT panel
   * and the sidecar's `bake_result.warnings` already read.
   */
  findings: AuditFinding[];
  plan: ColorChangePlan | null;
}

/** `title: detail`, the shape every other warning takes in `notes`. */
function findingNotes(findings: readonly AuditFinding[]): string[] {
  return findings.map((finding) => `${finding.title}: ${finding.detail}`);
}

/**
 * Every file for one build and one target.
 *
 * A TILED build takes one of two routes. A Bambu project can carry many plates
 * in one file, so a tiled build for a Bambu printer is one .3mf with one plate
 * per tile; everything else - a third-party printer, a generic 3MF, an STL, a
 * colour-change project, which is a plan for ONE printed object - becomes a zip
 * of per-tile files named by their grid reference. `notes` says which happened,
 * because "one file" and "a zip of nine" is the kind of thing a user should not
 * have to discover by opening it (`[V3-P4-E5]`).
 */
export function exportForTarget(result: EngineResult, target: ExportTarget, options: ExportForTargetOptions = {}): ExportOutput {
  // One perf row per exporter (`export.bambu-3mf`, `export.stl`, ...), one span
  // per call: a tiled build writes its tiles through `writeForTarget` below,
  // not back through here, so the row's count is the number of times the
  // target was exported and its time is never counted twice (v3-00 audit
  // finding 3). No-op with perf mode off (`lib/perf.ts`).
  return perfSpan(`export.${target}`, () => writeForTarget(result, target, options));
}

function writeForTarget(result: EngineResult, target: ExportTarget, options: ExportForTargetOptions): ExportOutput {
  const tiles = result.tiles ?? [];
  if (isTiled(result)) {
    const profile = options.profile ?? resolveProfile(result.params);
    if (target === "bambu-3mf" && profile.vendor === "bambu") {
      const file = exportBambu3mf(result, { ...options, profile, singleNozzle: false });
      return {
        target,
        files: [file],
        notes: [`${file.plates} tiles, one plate each, in a single Bambu Studio project.`],
        findings: [],
        plan: null,
      };
    }
    const created = options.created ?? new Date();
    const zip = exportTiledZip({
      result,
      tiles,
      stem: options.stem ?? "framecraft",
      created,
      writeTile: (tileResult, tileOptions) =>
        writeForTarget(tileResult, target, { ...options, ...tileOptions, profile }).files,
    });
    return {
      target,
      files: [zip],
      notes: [
        `${tiles.length} tiles, one ${EXPORT_TARGET_LABELS[target]} file each, in a zip named by tile.`,
      ],
      // A tile writes through `writeTile` above, whose findings the zip does not
      // carry back; a tiled build is judged tile by tile (`ci-export-matrix.sh`).
      findings: [],
      plan: null,
    };
  }
  switch (target) {
    case "bambu-3mf": {
      const bambuOptions: Bambu3mfOptions = { ...options, singleNozzle: false };
      const file = exportBambu3mf(result, bambuOptions);
      return { target, files: [file], notes: [], findings: [], plan: null };
    }
    case "color-change-3mf": {
      const bambuOptions: Bambu3mfOptions = { ...options, singleNozzle: true };
      const file = exportBambu3mf(result, bambuOptions);
      return { target, files: [file], notes: file.plan ? describePlan(file.plan) : [], findings: [], plan: file.plan };
    }
    case "generic-3mf":
      return { target, files: [exportGeneric3mf(result, options)], notes: [], findings: [], plan: null };
    case "stl": {
      const file = exportStl(result, options);
      return { target, files: [file], notes: findingNotes(file.findings), findings: file.findings, plan: null };
    }
    case "stl-parts-zip": {
      const zip = exportStlPartsZip(result, options);
      return { target, files: [zip], notes: findingNotes(zip.findings), findings: zip.findings, plan: null };
    }
    case "obj":
      return { target, files: exportObj(result, options), notes: [], findings: [], plan: null };
    case "step": {
      const stepOptions: StepOptions = options;
      const file = exportStep(result, stepOptions);
      return { target, files: [file], notes: file.notes, findings: [], plan: null };
    }
    default: {
      const never: never = target;
      throw new Error(`unknown export target ${String(never)}`);
    }
  }
}

export { exportBambu3mf } from "./bambu3mf";
export type { Bambu3mfExport, Bambu3mfOptions } from "./bambu3mf";
export { customGcodePerLayerXml, describePlan, planColorChanges } from "./colorchange";
export type { ColorBand, ColorChangeEvent, ColorChangePlan, RegionSeparability } from "./colorchange";
export type { ExportOptions, SourceLocation } from "./common";
export { exportGeneric3mf } from "./generic3mf";
export type { Generic3mfOptions } from "./generic3mf";
export { exportObj } from "./obj";
export { exportStep, stepCheck } from "./step";
export type { StepExportFile, StepOptions } from "./step";
export { exportStl, exportStlPartsZip } from "./stl";
export { exportTiledZip, isTiled, resultForTile, tileStem } from "./tiles";
export { unzipAll, unzipText, zipEntries } from "./zip";
