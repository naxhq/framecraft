"use client";

import { PARAM_RANGES } from "@/lib/contracts";
import { labelled, sectionProps } from "@/lib/controlCatalog";
import { useEditorStore } from "@/store/editor";
import { Field, Note, Slider } from "../Controls";

/**
 * Surface depths: how thick each surface region is built, and where its top
 * face sits against the plate top.
 *
 * These ten fields were in the contract from schema_version 3 and reachable
 * through a share link or a project file, with no control anywhere
 * (`docs/handoff/v3-02-settings.md` section 5). They are not cosmetic: every
 * one of them moves real geometry in `lib/engine/solid/areas.ts`, where a
 * region spans `[base_top + proud - depth, base_top + proud]` and the base is
 * carved by the same footprint, so the two partition the volume with no
 * overlap.
 *
 * The controls for a region the model is not building are disabled rather than
 * hidden: a slider that vanishes when Water is switched off reads as a missing
 * feature, and the reason it cannot move belongs on screen next to it.
 */
const STEP_MM = 0.05;
const STEP_M = 0.5;

/** Range inputs hand back floats; two decimals is the panel's own resolution. */
function round2(value: number): number {
  return Number(value.toFixed(2));
}

/** Trailing zeros are noise on an instrument readout: 0.6 mm, never 0.60 mm. */
function mm(value: number): string {
  return `${Number(value.toFixed(2))} mm`;
}

export function RegionsGroup() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);

  const ranges = PARAM_RANGES.regions;
  const regions = params.regions ?? {};
  const roads = regions.roads ?? {};
  const water = regions.water ?? {};
  const parks = regions.parks ?? {};
  const rail = regions.rail ?? {};

  const roadsDepth = roads.depth_mm ?? ranges.roads.depth_mm.default;
  const roadsProud = roads.proud_mm ?? ranges.roads.proud_mm.default;
  const waterDepth = water.depth_mm ?? ranges.water.depth_mm.default;
  const waterProud = water.proud_mm ?? ranges.water.proud_mm.default;
  const parksDepth = parks.depth_mm ?? ranges.parks.depth_mm.default;
  const parksProud = parks.proud_mm ?? ranges.parks.proud_mm.default;
  const railDepth = rail.depth_mm ?? ranges.rail.depth_mm.default;
  const railProud = rail.proud_mm ?? ranges.rail.proud_mm.default;
  const railWidth = rail.width_m ?? ranges.rail.width_m.default;
  const skirt = regions.building_skirt_mm ?? ranges.building_skirt_mm.default;

  const roadsOff = params.road_mode === "off";
  const waterOff = params.water === false;

  return (
    <>
      <Field {...sectionProps("region-roads")}>
        <Slider
          {...labelled("regions_roads_depth_mm")}
          min={ranges.roads.depth_mm.min}
          max={ranges.roads.depth_mm.max}
          step={STEP_MM}
          value={roadsDepth}
          display={mm(roadsDepth)}
          disabled={roadsOff}
          onChange={(value) =>
            setParam("regions", { ...regions, roads: { ...roads, depth_mm: round2(value) } })
          }
        />
        <Slider
          {...labelled("regions_roads_proud_mm")}
          min={ranges.roads.proud_mm.min}
          max={ranges.roads.proud_mm.max}
          step={STEP_MM}
          value={roadsProud}
          display={mm(roadsProud)}
          disabled={roadsOff}
          onChange={(value) =>
            setParam("regions", { ...regions, roads: { ...roads, proud_mm: round2(value) } })
          }
        />
        {roadsOff ? (
          <Note testId="regions-roads-off-note">
            There is no road layer to place while Road mode is off, in the Surface group.
          </Note>
        ) : null}
      </Field>

      <Field {...sectionProps("region-water")}>
        <Slider
          {...labelled("regions_water_depth_mm")}
          min={ranges.water.depth_mm.min}
          max={ranges.water.depth_mm.max}
          step={STEP_MM}
          value={waterDepth}
          display={mm(waterDepth)}
          disabled={waterOff}
          onChange={(value) =>
            setParam("regions", { ...regions, water: { ...water, depth_mm: round2(value) } })
          }
        />
        <Slider
          {...labelled("regions_water_proud_mm")}
          min={ranges.water.proud_mm.min}
          max={ranges.water.proud_mm.max}
          step={STEP_MM}
          value={waterProud}
          display={mm(waterProud)}
          disabled={waterOff}
          onChange={(value) =>
            setParam("regions", { ...regions, water: { ...water, proud_mm: round2(value) } })
          }
        />
        {waterOff ? (
          <Note testId="regions-water-off-note">
            Water is switched off in the Surface group, so there is nothing here to place.
          </Note>
        ) : null}
      </Field>

      <Field {...sectionProps("region-parks")}>
        <Slider
          {...labelled("regions_parks_depth_mm")}
          min={ranges.parks.depth_mm.min}
          max={ranges.parks.depth_mm.max}
          step={STEP_MM}
          value={parksDepth}
          display={mm(parksDepth)}
          onChange={(value) =>
            setParam("regions", { ...regions, parks: { ...parks, depth_mm: round2(value) } })
          }
        />
        <Slider
          {...labelled("regions_parks_proud_mm")}
          min={ranges.parks.proud_mm.min}
          max={ranges.parks.proud_mm.max}
          step={STEP_MM}
          value={parksProud}
          display={mm(parksProud)}
          onChange={(value) =>
            setParam("regions", { ...regions, parks: { ...parks, proud_mm: round2(value) } })
          }
        />
      </Field>

      <Field {...sectionProps("region-rail")}>
        <Slider
          {...labelled("regions_rail_depth_mm")}
          min={ranges.rail.depth_mm.min}
          max={ranges.rail.depth_mm.max}
          step={STEP_MM}
          value={railDepth}
          display={mm(railDepth)}
          onChange={(value) =>
            setParam("regions", { ...regions, rail: { ...rail, depth_mm: round2(value) } })
          }
        />
        <Slider
          {...labelled("regions_rail_proud_mm")}
          min={ranges.rail.proud_mm.min}
          max={ranges.rail.proud_mm.max}
          step={STEP_MM}
          value={railProud}
          display={mm(railProud)}
          onChange={(value) =>
            setParam("regions", { ...regions, rail: { ...rail, proud_mm: round2(value) } })
          }
        />
        <Slider
          {...labelled("regions_rail_width_m")}
          min={ranges.rail.width_m.min}
          max={ranges.rail.width_m.max}
          step={STEP_M}
          value={railWidth}
          display={`${railWidth} m`}
          onChange={(value) =>
            setParam("regions", { ...regions, rail: { ...rail, width_m: round2(value) } })
          }
        />
      </Field>

      <Slider
        {...labelled("regions_building_skirt_mm")}
        min={ranges.building_skirt_mm.min}
        max={ranges.building_skirt_mm.max}
        step={STEP_MM}
        value={skirt}
        display={mm(skirt)}
        onChange={(value) => setParam("regions", { ...regions, building_skirt_mm: round2(value) })}
      />
    </>
  );
}

export default RegionsGroup;
