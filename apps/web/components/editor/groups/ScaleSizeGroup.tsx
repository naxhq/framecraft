"use client";

import { useMemo } from "react";

import { PARAM_RANGES } from "@/lib/contracts";
import { scaleRatio } from "@/lib/hud";
import * as T from "@/lib/transform";
import { warningDeps } from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";
import { Note, Slider } from "../Controls";

/**
 * Scale and size: the three numbers that decide how much of the world fits on
 * the plate and how fine the print can be.
 *
 * Every bound comes from `PARAM_RANGES` in the GENERATED contracts, so a schema
 * change moves the sliders without anyone editing this file.
 */
export function ScaleSizeGroup() {
  const params = useEditorStore((state) => state.params);
  const graph = useEditorStore((state) => state.scene.graph);
  const setParam = useEditorStore((state) => state.setParam);

  const ratio = useMemo(
    () => scaleRatio(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    warningDeps(graph, params),
  );

  return (
    <>
      <Slider
        id="plate_mm"
        label="Plate size"
        min={PARAM_RANGES.plate_mm.min}
        max={PARAM_RANGES.plate_mm.max}
        step={1}
        value={params.plate_mm}
        display={`${params.plate_mm} mm`}
        onChange={(value) => setParam("plate_mm", value)}
        hint="The square the model is printed on. With the frame on, 12 mm of it becomes border."
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

      <Slider
        id="nozzle_mm"
        label="Nozzle diameter"
        min={PARAM_RANGES.nozzle_mm.min}
        max={PARAM_RANGES.nozzle_mm.max}
        step={0.05}
        value={params.nozzle_mm}
        display={`${params.nozzle_mm.toFixed(2)} mm`}
        onChange={(value) => setParam("nozzle_mm", value)}
        hint="Your printer's nozzle. It sets the minimum wall, gap and detail, so a wider one merges more of the city into fewer blocks."
      />

      <Note testId="scale-summary">
        {ratio ? `${ratio} · ` : ""}
        {T.min_wall_mm(params).toFixed(2)} mm minimum wall ·{" "}
        {T.usable_span_mm(params).toFixed(0)} mm of usable plate
      </Note>
    </>
  );
}

export default ScaleSizeGroup;
