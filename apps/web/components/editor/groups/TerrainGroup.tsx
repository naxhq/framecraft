"use client";

import { PARAM_RANGES } from "@/lib/contracts";
import { labelled } from "@/lib/controlCatalog";
import { useEditorStore } from "@/store/editor";
import { Note, Slider, Toggle } from "../Controls";

const PERCENT_STEP = 5;

/**
 * Terrain: drape the real ground elevation under the model, on top of the
 * flat base every other group assumes.
 *
 * Off by default (`params.terrain.enabled`). Turning it on schedules a
 * debounced DEM tile fetch keyed on the pin, radius, rotation, exaggeration
 * and smoothing (`store/editor.ts:scheduleTerrainJob`, `lib/terrainCache.ts`)
 * -- never an Overpass refetch, and never blocking the live preview: while the
 * fetch is in flight or has failed, the model stays flat and this group says
 * so.
 */
export function TerrainGroup() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);
  const setNested = useEditorStore((state) => state.setNested);
  const terrain = useEditorStore((state) => state.terrain);
  const findings = useEditorStore((state) => state.pipeline.result?.findings);

  const enabled = params.terrain?.enabled ?? false;
  const smoothing = params.terrain?.smoothing ?? 1;
  const exaggerationPercent = Math.round((params.terrain_exaggeration ?? 1) * 100);

  const lowRelief = findings?.find((finding) => finding.id === "terrain-low-relief") ?? null;

  return (
    <>
      <Toggle
        {...labelled("terrain_enabled")}
        checked={enabled}
        onChange={(value) => setNested("terrain", { enabled: value })}
      />

      <Slider
        {...labelled("terrain_exaggeration")}
        min={PARAM_RANGES.terrain_exaggeration.min * 100}
        max={PARAM_RANGES.terrain_exaggeration.max * 100}
        step={PERCENT_STEP}
        value={exaggerationPercent}
        display={`${exaggerationPercent} %`}
        onChange={(value) => setParam("terrain_exaggeration", value / 100)}
        disabled={!enabled}
      />

      <Slider
        {...labelled("terrain_smoothing")}
        min={PARAM_RANGES.terrain.smoothing.min}
        max={PARAM_RANGES.terrain.smoothing.max}
        step={1}
        value={smoothing}
        display={String(smoothing)}
        onChange={(value) => setNested("terrain", { smoothing: value })}
        disabled={!enabled}
      />

      {!enabled ? (
        <Note testId="terrain-off-note">
          The exaggeration and the smoothing shape a draped surface, so both
          wait until Terrain is on.
        </Note>
      ) : null}
      {enabled && terrain.status === "loading" ? (
        <Note testId="terrain-loading">Fetching elevation data…</Note>
      ) : null}
      {enabled && terrain.status === "error" ? (
        <Note tone="warn" testId="terrain-error">
          {terrain.error ?? "Could not fetch terrain for this location."} The model stays flat
          until this succeeds.
        </Note>
      ) : null}
      {enabled && lowRelief ? (
        <Note testId="terrain-low-relief-hint">
          {lowRelief.detail || "Terrain will be barely visible here."}
        </Note>
      ) : null}
      {enabled && terrain.status === "ready" && terrain.grid ? (
        <Note testId="terrain-attribution">{terrain.grid.source}</Note>
      ) : null}
    </>
  );
}

export default TerrainGroup;
