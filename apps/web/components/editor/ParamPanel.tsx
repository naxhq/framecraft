"use client";

import { useShallow } from "zustand/react/shallow";

import { PARAM_RANGES } from "@/lib/contracts";
import type { PrintParams } from "@/lib/contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M, RADIUS_STEP_M } from "@/lib/geo";
import { useEditorStore } from "@/store/editor";
import { PanelSection, Segmented, Slider, Toggle } from "./Controls";

/**
 * The right-hand parameter panel: every control in 01's editor table, bound to
 * the zustand store.
 *
 * Ranges come from `PARAM_RANGES` in the GENERATED contracts wherever the
 * contract has them, so a schema change moves the sliders automatically.
 * 01 states the height/road/terrain sliders as percentages while the frozen
 * `PrintParams` stores 0.5..2.0 floats, so those controls render `value * 100`
 * and write `percent / 100`.
 *
 * Nothing in this file calls the API except the rotation slider, which is a
 * location-level change (the crop happens server-side) and therefore
 * re-generates when the pointer is released.
 */

const ROAD_MODES = [
  { value: "engrave" as const, label: "engrave" },
  { value: "emboss" as const, label: "emboss" },
  { value: "off" as const, label: "off" },
];

/** Percent sliders move in 5-point steps; 0.05 of the underlying float. */
const PERCENT_STEP = 5;

export function ParamPanel() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);
  const resetParams = useEditorStore((state) => state.resetParams);
  const { rotation_deg, radius_m } = useEditorStore(
    useShallow((state) => ({
      rotation_deg: state.location.rotation_deg,
      radius_m: state.location.radius_m,
    })),
  );
  const setRotation = useEditorStore((state) => state.setRotation);
  const setRadius = useEditorStore((state) => state.setRadius);
  const generate = useEditorStore((state) => state.generate);

  const percent = (key: keyof PrintParams): number =>
    Math.round((params[key] as number) * 100);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold">Parameters</h2>
        <button
          type="button"
          onClick={resetParams}
          className="text-xs text-sky-600 hover:underline dark:text-sky-400"
        >
          Reset
        </button>
      </div>

      <PanelSection title="Plate">
        <Slider
          id="plate_mm"
          label="Plate size"
          min={PARAM_RANGES.plate_mm.min}
          max={PARAM_RANGES.plate_mm.max}
          step={1}
          value={params.plate_mm}
          display={`${params.plate_mm} mm`}
          onChange={(value) => setParam("plate_mm", value)}
          hint="Sets the scale from ground span to print."
        />
        <Slider
          id="base_thickness_mm"
          label="Base thickness"
          min={PARAM_RANGES.base_thickness_mm.min}
          max={PARAM_RANGES.base_thickness_mm.max}
          step={0.1}
          value={params.base_thickness_mm}
          display={`${params.base_thickness_mm.toFixed(1)} mm`}
          onChange={(value) => setParam("base_thickness_mm", value)}
          hint="Solid slab under everything."
        />
        <Toggle
          id="frame"
          label="Frame"
          checked={params.frame}
          onChange={(value) => setParam("frame", value)}
          hint="6 mm border lip, 2 mm proud of the base. Costs 12 mm of scale."
        />
      </PanelSection>

      <PanelSection title="Buildings">
        <Slider
          id="small_scale"
          label="Small building scale"
          min={PARAM_RANGES.small_scale.min * 100}
          max={PARAM_RANGES.small_scale.max * 100}
          step={PERCENT_STEP}
          value={percent("small_scale")}
          display={`${percent("small_scale")} %`}
          onChange={(value) => setParam("small_scale", value / 100)}
          hint="Height multiplier for buildings under 40 m."
        />
        <Slider
          id="large_scale"
          label="Large building scale"
          min={PARAM_RANGES.large_scale.min * 100}
          max={PARAM_RANGES.large_scale.max * 100}
          step={PERCENT_STEP}
          value={percent("large_scale")}
          display={`${percent("large_scale")} %`}
          onChange={(value) => setParam("large_scale", value / 100)}
          hint="Height multiplier for buildings 40 m and over."
        />
      </PanelSection>

      <PanelSection title="Surface">
        <Segmented
          id="road_mode"
          label="Road mode"
          value={params.road_mode}
          options={ROAD_MODES}
          onChange={(value) => setParam("road_mode", value)}
        />
        <Slider
          id="road_scale"
          label="Road scale"
          min={PARAM_RANGES.road_scale.min * 100}
          max={PARAM_RANGES.road_scale.max * 100}
          step={PERCENT_STEP}
          value={percent("road_scale")}
          display={`${percent("road_scale")} %`}
          onChange={(value) => setParam("road_scale", value / 100)}
          disabled={params.road_mode === "off"}
          hint="Width multiplier, applied before the minimum-feature clamp."
        />
        <Toggle
          id="water"
          label="Water"
          checked={params.water}
          onChange={(value) => setParam("water", value)}
          hint="Recessed 0.5 mm below the base top."
        />
        <Toggle
          id="trees"
          label="Trees"
          checked={params.trees}
          onChange={(value) => setParam("trees", value)}
          hint="Instanced cones, height 3x the site radius, capped at 2000."
        />
        <Slider
          id="terrain_exaggeration"
          label="Terrain exaggeration"
          min={PARAM_RANGES.terrain_exaggeration.min * 100}
          max={PARAM_RANGES.terrain_exaggeration.max * 100}
          step={PERCENT_STEP}
          value={percent("terrain_exaggeration")}
          display={`${percent("terrain_exaggeration")} %`}
          onChange={(value) => setParam("terrain_exaggeration", value / 100)}
          hint="Flat terrain in the MVP: the DEM fetcher is behind a feature flag, so this is carried through the pipeline but has no visible effect yet."
        />
      </PanelSection>

      <PanelSection title="Printer">
        <Slider
          id="nozzle_mm"
          label="Nozzle diameter"
          min={PARAM_RANGES.nozzle_mm.min}
          max={PARAM_RANGES.nozzle_mm.max}
          step={0.05}
          value={params.nozzle_mm}
          display={`${params.nozzle_mm.toFixed(2)} mm`}
          onChange={(value) => setParam("nozzle_mm", value)}
          hint="Drives the minimum wall, gap and detail thresholds."
        />
      </PanelSection>

      <PanelSection title="Location">
        <Slider
          id="radius_m"
          label="Radius"
          min={RADIUS_MIN_M}
          max={RADIUS_MAX_M}
          step={RADIUS_STEP_M}
          value={radius_m}
          display={`${radius_m} m`}
          onChange={setRadius}
          onCommit={() => void generate()}
          hint="Half the ground span. Changing it refetches the scene."
        />
        <Slider
          id="rotation_deg"
          label="Rotation"
          min={0}
          max={360}
          step={1}
          value={rotation_deg}
          display={`${rotation_deg}°`}
          onChange={setRotation}
          onCommit={() => void generate()}
          hint="Rotates the crop before it is squared. Server-side, so it refetches the scene on release."
        />
      </PanelSection>
    </div>
  );
}

export default ParamPanel;
