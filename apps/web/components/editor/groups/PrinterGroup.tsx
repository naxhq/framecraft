"use client";

import { DEFAULT_PRINT_PARAMS, PARAM_RANGES } from "@/lib/contracts";
import type { Tiling } from "@/lib/contracts";
import { labelled, sectionProps } from "@/lib/controlCatalog";
import { PRINTER_PROFILE_IDS, PRINTER_PROFILES, resolveProfile } from "@/lib/printers";
import type { PrinterProfileId } from "@/lib/printers";
import { useEditorStore } from "@/store/editor";
import { Field, Note, SelectField, Slider, TextField, Toggle } from "../Controls";

const PRINTER_PROFILE_OPTIONS = PRINTER_PROFILE_IDS.map((id) => ({
  value: id,
  label: PRINTER_PROFILES[id].label,
}));

const JOINT_OPTIONS = [
  { value: "dovetail" as const, label: "Dovetail" },
  { value: "pin" as const, label: "Pin and socket" },
];

const DEFAULT_TILING = DEFAULT_PRINT_PARAMS.tiling as Tiling;

/**
 * The printer this model is aimed at: which of the eight named plates and
 * nozzles (or a custom one) it is cut to fit, and -- when it does not fit as
 * one piece -- how it splits.
 *
 * Selecting a named profile applies its plate and nozzle once, on the
 * selection change (`store.setPrinterProfile`,
 * `lib/printers.ts:profileApplyPatch`): `plate_mm`/`nozzle_mm` afterwards are
 * ordinary sliders again, nothing here fights the user back. The profile's
 * height ceiling is not a slider -- it is what `resolveProfile(params).
 * maxHeightMm` now feeds into the OUTPUT panel's "Predicted height" line, the
 * preview's HUD and its own too-tall pill, and the tone on all three follows
 * it (`lib/warnings.ts` [V3-P4-U]).
 */
export function PrinterGroup() {
  const params = useEditorStore((state) => state.params);
  const setNested = useEditorStore((state) => state.setNested);
  const setPrinterProfile = useEditorStore((state) => state.setPrinterProfile);

  const printerProfileId: PrinterProfileId = params.printer_profile ?? "custom";
  const profile = resolveProfile(params);
  const custom = params.custom_profile ?? DEFAULT_PRINT_PARAMS.custom_profile ?? {};
  const tiling = params.tiling ?? DEFAULT_TILING;

  const setTiling = <K extends keyof Tiling>(key: K, value: Tiling[K]): void => {
    setNested("tiling", { [key]: value } as Partial<Tiling>);
  };

  return (
    <>
      <SelectField
        {...labelled("printer_profile")}
        value={printerProfileId}
        options={PRINTER_PROFILE_OPTIONS}
        onChange={(value) => setPrinterProfile(value)}
      />

      {printerProfileId === "custom" ? (
        <div
          className="space-y-3 rounded-milled border border-line bg-plate-sunken p-2.5"
          data-testid="custom-profile-fields"
        >
          <Slider
            {...labelled("custom_profile_plate_x_mm")}
            min={PARAM_RANGES.custom_profile.plate_x_mm.min}
            max={PARAM_RANGES.custom_profile.plate_x_mm.max}
            step={1}
            value={custom.plate_x_mm ?? PARAM_RANGES.custom_profile.plate_x_mm.default}
            display={`${custom.plate_x_mm ?? PARAM_RANGES.custom_profile.plate_x_mm.default} mm`}
            onChange={(value) => setNested("custom_profile", { plate_x_mm: value })}
          />
          <Slider
            {...labelled("custom_profile_plate_y_mm")}
            min={PARAM_RANGES.custom_profile.plate_y_mm.min}
            max={PARAM_RANGES.custom_profile.plate_y_mm.max}
            step={1}
            value={custom.plate_y_mm ?? PARAM_RANGES.custom_profile.plate_y_mm.default}
            display={`${custom.plate_y_mm ?? PARAM_RANGES.custom_profile.plate_y_mm.default} mm`}
            onChange={(value) => setNested("custom_profile", { plate_y_mm: value })}
          />
          <Slider
            {...labelled("custom_profile_max_height_mm")}
            min={PARAM_RANGES.custom_profile.max_height_mm.min}
            max={PARAM_RANGES.custom_profile.max_height_mm.max}
            step={5}
            value={custom.max_height_mm ?? PARAM_RANGES.custom_profile.max_height_mm.default}
            display={`${custom.max_height_mm ?? PARAM_RANGES.custom_profile.max_height_mm.default} mm`}
            onChange={(value) => setNested("custom_profile", { max_height_mm: value })}
          />
          <Slider
            {...labelled("custom_profile_slots")}
            min={PARAM_RANGES.custom_profile.slots.min}
            max={PARAM_RANGES.custom_profile.slots.max}
            step={1}
            value={custom.slots ?? PARAM_RANGES.custom_profile.slots.default}
            display={String(custom.slots ?? PARAM_RANGES.custom_profile.slots.default)}
            onChange={(value) => setNested("custom_profile", { slots: value })}
          />
          <TextField
            {...labelled("custom_profile_change_gcode")}
            value={custom.change_gcode ?? "M600"}
            onChange={(value) => setNested("custom_profile", { change_gcode: value })}
          />
        </div>
      ) : null}

      <Note testId="printer-profile-summary">
        {profile.label}: {profile.plateXMm} × {profile.plateYMm} mm plate,{" "}
        {profile.maxHeightMm} mm height ceiling, {profile.nozzleMm.toFixed(2)} mm nozzle,{" "}
        {profile.slots} filament {profile.slots === 1 ? "slot" : "slots"}.
      </Note>

      <Field {...sectionProps("tiling")}>
        <div className="space-y-3">
          <Toggle
            {...labelled("tiling_enabled")}
            checked={tiling.enabled ?? false}
            onChange={(checked) => setTiling("enabled", checked)}
          />

          {tiling.enabled ? (
            <div className="space-y-3" data-testid="tiling-fields">
              <Slider
                {...labelled("tiling_cols")}
                min={PARAM_RANGES.tiling.cols.min}
                max={PARAM_RANGES.tiling.cols.max}
                step={1}
                value={tiling.cols ?? PARAM_RANGES.tiling.cols.default}
                display={String(tiling.cols ?? PARAM_RANGES.tiling.cols.default)}
                onChange={(value) => setTiling("cols", value)}
              />
              <Slider
                {...labelled("tiling_rows")}
                min={PARAM_RANGES.tiling.rows.min}
                max={PARAM_RANGES.tiling.rows.max}
                step={1}
                value={tiling.rows ?? PARAM_RANGES.tiling.rows.default}
                display={String(tiling.rows ?? PARAM_RANGES.tiling.rows.default)}
                onChange={(value) => setTiling("rows", value)}
              />
              <SelectField
                {...labelled("tiling_joint")}
                value={tiling.joint ?? "dovetail"}
                options={JOINT_OPTIONS}
                onChange={(value) => setTiling("joint", value)}
              />
              <Slider
                {...labelled("tiling_tolerance_mm")}
                min={PARAM_RANGES.tiling.tolerance_mm.min}
                max={PARAM_RANGES.tiling.tolerance_mm.max}
                step={0.01}
                value={tiling.tolerance_mm ?? PARAM_RANGES.tiling.tolerance_mm.default}
                display={`${(tiling.tolerance_mm ?? PARAM_RANGES.tiling.tolerance_mm.default).toFixed(2)} mm`}
                onChange={(value) => setTiling("tolerance_mm", value)}
              />
              <Toggle
                {...labelled("tiling_index_mark")}
                checked={tiling.index_mark ?? true}
                onChange={(checked) => setTiling("index_mark", checked)}
              />
            </div>
          ) : null}
        </div>
      </Field>

      <Note testId="printer-help-note">
        Filament slots and colours are set in the Colour group above; a model
        using more slots than this profile has warns there, with a one-click
        merge.
      </Note>
    </>
  );
}

export default PrinterGroup;
