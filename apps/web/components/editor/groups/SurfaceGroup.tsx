"use client";

import { PARAM_RANGES } from "@/lib/contracts";
import type { PrintParams } from "@/lib/contracts";
import { labelled } from "@/lib/controlCatalog";
import { useEditorStore } from "@/store/editor";
import { Note, Segmented, Slider, Toggle } from "../Controls";

const ROAD_MODES = [
  { value: "engrave" as const, label: "engrave" },
  { value: "emboss" as const, label: "emboss" },
  { value: "off" as const, label: "off" },
];

const PERCENT_STEP = 5;

/** Everything that happens on the plate rather than above it. */
export function SurfaceGroup() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);

  const percent = (key: keyof PrintParams): number =>
    Math.round((params[key] as number) * 100);

  return (
    <>
      <Segmented
        {...labelled("road_mode")}
        value={params.road_mode}
        options={ROAD_MODES}
        onChange={(value) => setParam("road_mode", value)}
      />

      <Slider
        {...labelled("road_scale")}
        min={PARAM_RANGES.road_scale.min * 100}
        max={PARAM_RANGES.road_scale.max * 100}
        step={PERCENT_STEP}
        value={percent("road_scale")}
        display={`${percent("road_scale")} %`}
        onChange={(value) => setParam("road_scale", value / 100)}
        disabled={params.road_mode === "off"}
      />

      {params.road_mode === "off" ? (
        <Note testId="road-scale-off-note">
          There is no road layer to widen while Road mode is off.
        </Note>
      ) : null}

      <Toggle
        {...labelled("water")}
        checked={params.water}
        onChange={(value) => setParam("water", value)}
      />

      <Toggle
        {...labelled("trees")}
        checked={params.trees}
        onChange={(value) => setParam("trees", value)}
      />
    </>
  );
}

export default SurfaceGroup;
