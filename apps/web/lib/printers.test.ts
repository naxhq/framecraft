import { describe, expect, it } from "vitest";

import { DEFAULT_PRINT_PARAMS, defaultPrintParams, PARAM_RANGES } from "./contracts";
import { PRINTER_PROFILE_IDS, PRINTER_PROFILES, isPrinterProfileId, resolveProfile, type PrinterProfileId } from "./printers";

const CONTRACT_IDS: PrinterProfileId[] = ["custom", "bambu-h2s", "bambu-p1s", "bambu-x1c", "bambu-a1", "bambu-a1-mini", "prusa-mk4", "prusa-mini", "ender-3"];

describe("PRINTER_PROFILES", () => {
  it("has one complete row per printer_profile id in the contract", () => {
    expect([...PRINTER_PROFILE_IDS].sort()).toEqual([...CONTRACT_IDS].sort());
    for (const id of CONTRACT_IDS) {
      const row = PRINTER_PROFILES[id];
      expect(row.id).toBe(id);
      expect(row.label.length).toBeGreaterThan(0);
      expect(row.plateXMm).toBeGreaterThanOrEqual(100);
      expect(row.plateYMm).toBeGreaterThanOrEqual(100);
      expect(row.maxHeightMm).toBeGreaterThanOrEqual(20);
      expect(row.nozzleMm).toBeGreaterThan(0);
      expect(row.slots).toBeGreaterThanOrEqual(1);
      expect(row.slots).toBeLessThanOrEqual(16);
      expect(row.changeGcode).toBe("M600");
      expect(isPrinterProfileId(id)).toBe(true);
    }
    expect(isPrinterProfileId("bambu-x1")).toBe(false);
  });

  it("gives every Bambu row its verified printer_model, printer_settings_id and model_id", () => {
    const expected: Record<string, [string, string, string, string, string, number, number, number]> = {
      "bambu-h2s": ["Bambu Lab H2S", "Bambu Lab H2S 0.4 nozzle", "O1S", "0.20mm Standard @BBL H2S", "Bambu PLA Basic @BBL H2S", 340, 320, 340],
      "bambu-p1s": ["Bambu Lab P1S", "Bambu Lab P1S 0.4 nozzle", "C12", "0.20mm Standard @BBL X1C", "Bambu PLA Basic @BBL P1S 0.4 nozzle", 256, 256, 250],
      "bambu-x1c": ["Bambu Lab X1 Carbon", "Bambu Lab X1 Carbon 0.4 nozzle", "BL-P001", "0.20mm Standard @BBL X1C", "Bambu PLA Basic @BBL X1C", 256, 256, 250],
      "bambu-a1": ["Bambu Lab A1", "Bambu Lab A1 0.4 nozzle", "N2S", "0.20mm Standard @BBL A1", "Bambu PLA Basic @BBL A1", 256, 256, 256],
      "bambu-a1-mini": ["Bambu Lab A1 mini", "Bambu Lab A1 mini 0.4 nozzle", "N1", "0.20mm Standard @BBL A1M", "Bambu PLA Basic @BBL A1M", 180, 180, 180],
    };
    for (const [id, [model, settings, modelId, printProfile, filamentProfile, x, y, h]] of Object.entries(expected)) {
      const row = PRINTER_PROFILES[id as PrinterProfileId];
      expect(row.vendor).toBe("bambu");
      expect(row.slots).toBe(4);
      expect(row.bambu).toEqual({ printerModel: model, printerSettingsId: settings, modelId, bedType: "Textured PEI Plate", printProfile, filamentProfile });
      expect([row.plateXMm, row.plateYMm, row.maxHeightMm]).toEqual([x, y, h]);
    }
    for (const id of ["prusa-mk4", "prusa-mini", "ender-3", "custom"] as const) {
      expect(PRINTER_PROFILES[id].bambu).toBeUndefined();
    }
    expect(PRINTER_PROFILES["prusa-mk4"].slots).toBe(1);
    expect(PRINTER_PROFILES["prusa-mini"].slots).toBe(1);
    expect(PRINTER_PROFILES["ender-3"].slots).toBe(1);
  });

  it("keeps the custom row aligned with the contract's custom_profile defaults", () => {
    const custom = PRINTER_PROFILES.custom;
    const defaults = DEFAULT_PRINT_PARAMS.custom_profile;
    expect(custom.plateXMm).toBe(defaults?.plate_x_mm);
    expect(custom.plateYMm).toBe(defaults?.plate_y_mm);
    expect(custom.maxHeightMm).toBe(defaults?.max_height_mm);
    expect(custom.nozzleMm).toBe(defaults?.nozzle_mm);
    expect(custom.slots).toBe(defaults?.slots);
    expect(custom.changeGcode).toBe(defaults?.change_gcode);
    // Every fixed row fits inside the custom_profile ranges the contract allows.
    for (const id of CONTRACT_IDS) {
      const row = PRINTER_PROFILES[id];
      expect(row.plateXMm).toBeLessThanOrEqual(PARAM_RANGES.custom_profile.plate_x_mm.max);
      expect(row.maxHeightMm).toBeLessThanOrEqual(PARAM_RANGES.custom_profile.max_height_mm.max);
      expect(row.slots).toBeLessThanOrEqual(PARAM_RANGES.custom_profile.slots.max);
    }
  });
});

describe("resolveProfile", () => {
  it("returns the table row for a named printer and ignores custom_profile there", () => {
    const params = defaultPrintParams();
    params.printer_profile = "bambu-a1-mini";
    params.custom_profile = { plate_x_mm: 400, slots: 16 };
    const row = resolveProfile(params);
    expect(row.id).toBe("bambu-a1-mini");
    expect(row.plateXMm).toBe(180);
    expect(row.slots).toBe(4);
  });

  it("merges custom_profile over the custom defaults", () => {
    const params = defaultPrintParams();
    params.printer_profile = "custom";
    params.custom_profile = { plate_x_mm: 300, plate_y_mm: 200, slots: 2, change_gcode: "M600 ; pause" };
    const row = resolveProfile(params);
    expect(row.id).toBe("custom");
    expect(row.plateXMm).toBe(300);
    expect(row.plateYMm).toBe(200);
    expect(row.maxHeightMm).toBe(250);
    expect(row.nozzleMm).toBe(0.4);
    expect(row.slots).toBe(2);
    expect(row.changeGcode).toBe("M600 ; pause");
    expect(row.bambu).toBeUndefined();
  });

  it("falls back to custom for a missing or unknown id and to M600 for an empty change gcode", () => {
    expect(resolveProfile({}).id).toBe("custom");
    expect(resolveProfile({ printer_profile: "nope" as PrinterProfileId }).id).toBe("custom");
    expect(resolveProfile({ printer_profile: "custom", custom_profile: { change_gcode: "" } }).changeGcode).toBe("M600");
  });
});
