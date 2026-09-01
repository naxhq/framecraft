"use client";

import { PARAM_RANGES } from "@/lib/contracts";
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
  const findings = useEditorStore((state) => state.engine.result?.findings);

  const enabled = params.terrain?.enabled ?? false;
  const smoothing = params.terrain?.smoothing ?? 1;
  const exaggerationPercent = Math.round((params.terrain_exaggeration ?? 1) * 100);

  const lowRelief = findings?.find((finding) => finding.id === "terrain-low-relief") ?? null;

  return (
    <>
      <Toggle
        id="terrain_enabled"
        label="Terrain"
        checked={enabled}
        onChange={(value) => setNested("terrain", { enabled: value })}
        hint="Drapes the base over real ground elevation instead of a flat slab. Off by default."
      />

      <Slider
        id="terrain_exaggeration"
        label="Vertical exaggeration"
        min={PARAM_RANGES.terrain_exaggeration.min * 100}
        max={PARAM_RANGES.terrain_exaggeration.max * 100}
        step={PERCENT_STEP}
        value={exaggerationPercent}
        display={`${exaggerationPercent} %`}
        onChange={(value) => setParam("terrain_exaggeration", value / 100)}
        disabled={!enabled}
        hint="Stretches the elevation relief so a gentle slope reads on the plate. Ignored while terrain is off."
      />

      <Slider
        id="terrain_smoothing"
        label="Smoothing"
        min={PARAM_RANGES.terrain.smoothing.min}
        max={PARAM_RANGES.terrain.smoothing.max}
        step={1}
        value={smoothing}
        display={String(smoothing)}
        onChange={(value) => setNested("terrain", { smoothing: value })}
        disabled={!enabled}
        hint="Blurs the elevation sample before draping it, so buildings do not sit on a jagged terrace."
      />

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
