// One entry point per PrintParams.export_target. Every exporter is pure:
// `(result, options) => ExportFile | ExportFile[]`, no manifold, no DOM.

import type { PrintParams } from "../../contracts";
import type { PrinterProfile } from "../../printers";
import type { EngineResult, ExportFile } from "../types";
import { exportBambu3mf, type Bambu3mfOptions } from "./bambu3mf";
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
  plan: ColorChangePlan | null;
}

export function exportForTarget(result: EngineResult, target: ExportTarget, options: ExportForTargetOptions = {}): ExportOutput {
  switch (target) {
    case "bambu-3mf": {
      const bambuOptions: Bambu3mfOptions = { ...options, singleNozzle: false };
      const file = exportBambu3mf(result, bambuOptions);
      return { target, files: [file], notes: [], plan: null };
    }
    case "color-change-3mf": {
      const bambuOptions: Bambu3mfOptions = { ...options, singleNozzle: true };
      const file = exportBambu3mf(result, bambuOptions);
      return { target, files: [file], notes: file.plan ? describePlan(file.plan) : [], plan: file.plan };
    }
    case "generic-3mf":
      return { target, files: [exportGeneric3mf(result, options)], notes: [], plan: null };
    case "stl":
      return { target, files: [exportStl(result, options)], notes: [], plan: null };
    case "stl-parts-zip":
      return { target, files: [exportStlPartsZip(result, options)], notes: [], plan: null };
    case "obj":
      return { target, files: exportObj(result, options), notes: [], plan: null };
    case "step": {
      const stepOptions: StepOptions = options;
      const file = exportStep(result, stepOptions);
      return { target, files: [file], notes: file.notes, plan: null };
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
export { unzipAll, unzipText, zipEntries } from "./zip";
