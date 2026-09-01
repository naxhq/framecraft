"use client";

import { useMemo } from "react";

import { PARAM_RANGES } from "@/lib/contracts";
import * as T from "@/lib/transform";
import { useEditorStore } from "@/store/editor";
import { Note, Slider } from "../Controls";

/** Used for the live readout when the scene has no scanned tall building yet. */
const SAMPLE_HEIGHT_M = 100;

/**
 * Heights: how a building with no usable OSM height gets one (`heights.*`),
 * and the height exaggeration curve (`height_exaggeration.*`, 3e) that
 * stretches every printed building relative to its neighbours.
 *
 * The exaggeration readout uses `transform.realWorldEquivalentM`, the shared
 * (Python-mirrored) helper: given a height AS THE MODEL SHOWS IT, it returns
 * the real-world height that would produce that appearance --
 * `realWorldEquivalentM(exaggeratedHeight(h, m, c), m, c) === h`. So a sample
 * "shown" height run back through it says what a real building would have to
 * measure to read that tall at the current settings: at the default 100 %
 * multiplier and 0 % curve the two numbers are identical, and raising the
 * multiplier shrinks the real height needed to look the same size.
 */
export function HeightsGroup() {
  const params = useEditorStore((state) => state.params);
  const setNested = useEditorStore((state) => state.setNested);
  const graph = useEditorStore((state) => state.scene.graph);

  const floorHeight = params.heights?.floor_height_m ?? 3.0;
  const unknownDefault = params.heights?.unknown_default_m ?? 8.0;
  const multiplier = params.height_exaggeration?.multiplier ?? 1.0;
  const curve = params.height_exaggeration?.curve ?? 0.0;

  const sampleHeightM = useMemo(() => {
    if (!graph || graph.buildings.length === 0) return SAMPLE_HEIGHT_M;
    let tallest = 0;
    for (const building of graph.buildings) {
      if (building.height_m > tallest) tallest = building.height_m;
    }
    return tallest > 0 ? tallest : SAMPLE_HEIGHT_M;
  }, [graph]);

  const equivalentM = T.realWorldEquivalentM(sampleHeightM, multiplier, curve);

  return (
    <>
      <Slider
        id="heights_floor_height_m"
        label="Floor height"
        min={PARAM_RANGES.heights.floor_height_m.min}
        max={PARAM_RANGES.heights.floor_height_m.max}
        step={0.1}
        value={floorHeight}
        display={`${floorHeight.toFixed(1)} m`}
        onChange={(value) => setNested("heights", { floor_height_m: value })}
        hint="How tall one storey counts as, when a building only carries building:levels."
      />

      <Slider
        id="heights_unknown_default_m"
        label="Unknown building default"
        min={PARAM_RANGES.heights.unknown_default_m.min}
        max={PARAM_RANGES.heights.unknown_default_m.max}
        step={0.5}
        value={unknownDefault}
        display={`${unknownDefault.toFixed(1)} m`}
        onChange={(value) => setNested("heights", { unknown_default_m: value })}
        hint="The guess used when OSM carries no height or level count at all, and the building type has no better default of its own."
      />

      <Slider
        id="height_exaggeration_multiplier"
        label="Height exaggeration"
        min={PARAM_RANGES.height_exaggeration.multiplier.min * 100}
        max={PARAM_RANGES.height_exaggeration.multiplier.max * 100}
        step={5}
        value={Math.round(multiplier * 100)}
        display={`${Math.round(multiplier * 100)} %`}
        onChange={(value) => setNested("height_exaggeration", { multiplier: value / 100 })}
        hint="A flat multiplier on every printed building height, on top of the small/large building scales."
      />

      <Slider
        id="height_exaggeration_curve"
        label="Exaggeration curve"
        min={PARAM_RANGES.height_exaggeration.curve.min * 100}
        max={PARAM_RANGES.height_exaggeration.curve.max * 100}
        step={5}
        value={Math.round(curve * 100)}
        display={`${Math.round(curve * 100)} %`}
        onChange={(value) => setNested("height_exaggeration", { curve: value / 100 })}
        hint="0 keeps the multiplier flat; higher settings pull a tower down and a shed up relative to a straight multiply, so one skyscraper does not dwarf the block."
      />

      <Note testId="height-exaggeration-readout">
        A building that shows as {Math.round(sampleHeightM)} m on the model is really
        about {Math.round(equivalentM)} m in real life at these settings.
      </Note>
    </>
  );
}

export default HeightsGroup;
