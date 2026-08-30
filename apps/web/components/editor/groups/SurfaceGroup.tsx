"use client";

import { PARAM_RANGES } from "@/lib/contracts";
import type { PrintParams } from "@/lib/contracts";
import { useEditorStore } from "@/store/editor";
import { Segmented, Slider, Toggle } from "../Controls";

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
        id="road_mode"
        label="Road mode"
        value={params.road_mode}
        options={ROAD_MODES}
        onChange={(value) => setParam("road_mode", value)}
        hint="Engraved roads are cut 0.6 mm into the slab; embossed ones stand 0.4 mm proud."
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
        hint="Cones on the green areas, three times as tall as they are wide, capped at 2000. Trees too small to print are dropped."
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
        hint="Terrain is flat in this build: the elevation fetcher is behind a feature flag, so this travels through the pipeline but changes nothing yet."
      />
    </>
  );
}

export default SurfaceGroup;
