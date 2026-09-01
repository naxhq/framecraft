// Printer profile table for PrintParams.printer_profile (FrameCraft v3).
//
// The Bambu rows are verified against the Bambu Studio system presets under
// resources/profiles/BBL/machine/ (see docs/handoff/v3-02-export.md, section 3):
// `printerModel` is the `printer_model` string of the "<model> 0.4 nozzle"
// machine preset (which equals the `name` of the machine_model file),
// `printerSettingsId` is that preset's `name`, `modelId` its machine_model
// `model_id`, and the plate sizes come from `printable_area` /
// `printable_height` (inherited from fdm_bbl_3dp_001_common and
// fdm_machine_common where the preset does not override them).

import { DEFAULT_PRINT_PARAMS, type PrintParams } from "./contracts";

export type PrinterProfileId = NonNullable<PrintParams["printer_profile"]>;

export interface BambuIdentity {
  /** `printer_model` in project_settings.config, e.g. "Bambu Lab P1S". */
  printerModel: string;
  /** `printer_settings_id`, the system machine preset name, e.g. "Bambu Lab P1S 0.4 nozzle". */
  printerSettingsId: string;
  /** `model_id` of the machine_model file, e.g. "C12". */
  modelId: string;
  /** `default_bed_type` of the machine_model file. */
  bedType: string;
  /** `print_settings_id`: the machine preset's `default_print_profile`, a name in BBL.json's process_list. */
  printProfile: string;
  /** `filament_settings_id` entry: the machine preset's `default_filament_profile[0]`, a name in BBL.json's filament_list. */
  filamentProfile: string;
}

export interface PrinterProfile {
  id: PrinterProfileId;
  label: string;
  vendor: "bambu" | "prusa" | "creality" | "custom";
  plateXMm: number;
  plateYMm: number;
  maxHeightMm: number;
  /** Default nozzle diameter in mm. */
  nozzleMm: number;
  /** Filament slots the exporter may address (AMS 4 on the Bambu rows, 1 elsewhere). */
  slots: number;
  /** The colour-change command for the single-nozzle target. */
  changeGcode: string;
  /** Present on the Bambu rows only. */
  bambu?: BambuIdentity;
}

const BAMBU_BED_TYPE = "Textured PEI Plate";

export const PRINTER_PROFILE_IDS: readonly PrinterProfileId[] = [
  "bambu-h2s",
  "bambu-p1s",
  "bambu-x1c",
  "bambu-a1",
  "bambu-a1-mini",
  "prusa-mk4",
  "prusa-mini",
  "ender-3",
  "custom",
] as const;

export const PRINTER_PROFILES: Readonly<Record<PrinterProfileId, PrinterProfile>> = {
  "bambu-h2s": {
    id: "bambu-h2s",
    label: "Bambu Lab H2S",
    vendor: "bambu",
    plateXMm: 340,
    plateYMm: 320,
    maxHeightMm: 340,
    nozzleMm: 0.4,
    slots: 4,
    changeGcode: "M600",
    bambu: {
      printerModel: "Bambu Lab H2S",
      printerSettingsId: "Bambu Lab H2S 0.4 nozzle",
      printProfile: "0.20mm Standard @BBL H2S",
      filamentProfile: "Bambu PLA Basic @BBL H2S",
      modelId: "O1S",
      bedType: BAMBU_BED_TYPE,
    },
  },
  "bambu-p1s": {
    id: "bambu-p1s",
    label: "Bambu Lab P1S",
    vendor: "bambu",
    plateXMm: 256,
    plateYMm: 256,
    maxHeightMm: 250,
    nozzleMm: 0.4,
    slots: 4,
    changeGcode: "M600",
    bambu: {
      printerModel: "Bambu Lab P1S",
      printerSettingsId: "Bambu Lab P1S 0.4 nozzle",
      printProfile: "0.20mm Standard @BBL X1C",
      filamentProfile: "Bambu PLA Basic @BBL P1S 0.4 nozzle",
      modelId: "C12",
      bedType: BAMBU_BED_TYPE,
    },
  },
  "bambu-x1c": {
    id: "bambu-x1c",
    label: "Bambu Lab X1 Carbon",
    vendor: "bambu",
    plateXMm: 256,
    plateYMm: 256,
    maxHeightMm: 250,
    nozzleMm: 0.4,
    slots: 4,
    changeGcode: "M600",
    bambu: {
      printerModel: "Bambu Lab X1 Carbon",
      printerSettingsId: "Bambu Lab X1 Carbon 0.4 nozzle",
      printProfile: "0.20mm Standard @BBL X1C",
      filamentProfile: "Bambu PLA Basic @BBL X1C",
      modelId: "BL-P001",
      bedType: BAMBU_BED_TYPE,
    },
  },
  "bambu-a1": {
    id: "bambu-a1",
    label: "Bambu Lab A1",
    vendor: "bambu",
    plateXMm: 256,
    plateYMm: 256,
    maxHeightMm: 256,
    nozzleMm: 0.4,
    slots: 4,
    changeGcode: "M600",
    bambu: {
      printerModel: "Bambu Lab A1",
      printerSettingsId: "Bambu Lab A1 0.4 nozzle",
      printProfile: "0.20mm Standard @BBL A1",
      filamentProfile: "Bambu PLA Basic @BBL A1",
      modelId: "N2S",
      bedType: BAMBU_BED_TYPE,
    },
  },
  "bambu-a1-mini": {
    id: "bambu-a1-mini",
    label: "Bambu Lab A1 mini",
    vendor: "bambu",
    plateXMm: 180,
    plateYMm: 180,
    maxHeightMm: 180,
    nozzleMm: 0.4,
    slots: 4,
    changeGcode: "M600",
    bambu: {
      printerModel: "Bambu Lab A1 mini",
      printerSettingsId: "Bambu Lab A1 mini 0.4 nozzle",
      printProfile: "0.20mm Standard @BBL A1M",
      filamentProfile: "Bambu PLA Basic @BBL A1M",
      modelId: "N1",
      bedType: BAMBU_BED_TYPE,
    },
  },
  "prusa-mk4": {
    id: "prusa-mk4",
    label: "Prusa MK4",
    vendor: "prusa",
    plateXMm: 250,
    plateYMm: 210,
    maxHeightMm: 220,
    nozzleMm: 0.4,
    // Single nozzle without an MMU; the MMU3 is optional hardware, so the
    // colour-change target is the default for this row.
    slots: 1,
    changeGcode: "M600",
  },
  "prusa-mini": {
    id: "prusa-mini",
    label: "Prusa MINI",
    vendor: "prusa",
    plateXMm: 180,
    plateYMm: 180,
    maxHeightMm: 180,
    nozzleMm: 0.4,
    slots: 1,
    changeGcode: "M600",
  },
  "ender-3": {
    id: "ender-3",
    label: "Creality Ender-3",
    vendor: "creality",
    plateXMm: 220,
    plateYMm: 220,
    maxHeightMm: 250,
    nozzleMm: 0.4,
    slots: 1,
    changeGcode: "M600",
  },
  custom: {
    id: "custom",
    label: "Custom printer",
    vendor: "custom",
    plateXMm: DEFAULT_PRINT_PARAMS.custom_profile?.plate_x_mm ?? 256,
    plateYMm: DEFAULT_PRINT_PARAMS.custom_profile?.plate_y_mm ?? 256,
    maxHeightMm: DEFAULT_PRINT_PARAMS.custom_profile?.max_height_mm ?? 250,
    nozzleMm: DEFAULT_PRINT_PARAMS.custom_profile?.nozzle_mm ?? 0.4,
    slots: DEFAULT_PRINT_PARAMS.custom_profile?.slots ?? 4,
    changeGcode: DEFAULT_PRINT_PARAMS.custom_profile?.change_gcode ?? "M600",
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface ProfileApplyPatch {
  printer_profile: PrinterProfileId;
  plate_mm?: number;
  nozzle_mm?: number;
}

/**
 * What selecting `id` in the PRINTER group writes onto PrintParams: the
 * profile id itself, plus -- for every NAMED printer, never for `custom`
 * ([V3-P4-U]) -- its plate and nozzle, clamped into `plate_mm`/`nozzle_mm`'s
 * own `PARAM_RANGES`, not the profile's own numbers, which can exceed it (the
 * H2S's 340 x 320 mm bed against a 256 mm `plate_mm` ceiling).
 *
 * The plate written is the SMALLER of the profile's two bed dimensions:
 * `plate_mm` prints a square, and a square that fits a non-square bed cannot
 * exceed its short side. Selecting `custom` writes only the id -- `plate_mm`
 * and `nozzle_mm` stay whatever they already were ("switching back to Custom
 * restores nothing silently"). This only ever runs on the selection CHANGE
 * itself; the user can still move `plate_mm`/`nozzle_mm` afterwards and
 * nothing here fights them back.
 */
export function profileApplyPatch(
  id: PrinterProfileId,
  ranges: {
    plate_mm: { min: number; max: number };
    nozzle_mm: { min: number; max: number };
  },
): ProfileApplyPatch {
  if (id === "custom") return { printer_profile: id };
  const profile = PRINTER_PROFILES[id];
  const plate = clamp(Math.min(profile.plateXMm, profile.plateYMm), ranges.plate_mm.min, ranges.plate_mm.max);
  const nozzle = clamp(profile.nozzleMm, ranges.nozzle_mm.min, ranges.nozzle_mm.max);
  return { printer_profile: id, plate_mm: plate, nozzle_mm: nozzle };
}

export function isPrinterProfileId(value: unknown): value is PrinterProfileId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PRINTER_PROFILES, value);
}

/**
 * The profile a PrintParams selects. For `custom` the `custom_profile` fields
 * override the row's defaults (a missing field keeps the default); every other
 * id returns its table row unchanged, so a stray `custom_profile` on a Bambu
 * selection is ignored.
 */
export function resolveProfile(params: Pick<PrintParams, "printer_profile" | "custom_profile">): PrinterProfile {
  const id: PrinterProfileId = isPrinterProfileId(params.printer_profile) ? params.printer_profile : "custom";
  const base = PRINTER_PROFILES[id];
  if (id !== "custom") {
    return base;
  }
  const custom = params.custom_profile ?? {};
  return {
    ...base,
    plateXMm: custom.plate_x_mm ?? base.plateXMm,
    plateYMm: custom.plate_y_mm ?? base.plateYMm,
    maxHeightMm: custom.max_height_mm ?? base.maxHeightMm,
    nozzleMm: custom.nozzle_mm ?? base.nozzleMm,
    slots: custom.slots ?? base.slots,
    changeGcode: custom.change_gcode !== undefined && custom.change_gcode !== "" ? custom.change_gcode : base.changeGcode,
  };
}
