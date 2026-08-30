"use client";

import { presetRequests } from "@/lib/engine/osm/presets";
import { presetLabel, sortPresets } from "@/lib/presets";
import { activePresetId, useEditorStore } from "@/store/editor";

/**
 * The six preset cities (01). Since FrameCraft v3 E4 the `SceneRequest`
 * objects come from `lib/engine/osm/presets.ts` -- a plain, static,
 * client-side list, never `GET /presets` -- so there is no loading/error
 * state to render here any more; the labels are keyed by `preset_id` per
 * DECISIONS [P1].
 *
 * Clicking a preset sets the location (including its rotation) and generates
 * immediately, which is the "preset loads and previews in under 5 s" path in
 * 01/A1.
 *
 * The active chip comes from `activePresetId`, not straight from
 * `location.preset_id`: the store's initial location IS the Chicago Loop
 * preset, so reading the id directly lit that chip up on every fresh page
 * load while nothing had been generated.
 */
const PRESETS = sortPresets(presetRequests());

export function PresetRow() {
  const applyPreset = useEditorStore((state) => state.applyPreset);
  const generate = useEditorStore((state) => state.generate);
  const activeId = useEditorStore(activePresetId);
  const sceneStatus = useEditorStore((state) => state.scene.status);

  return (
    <div className="flex flex-wrap gap-2" data-testid="preset-row">
      {PRESETS.map((preset) => {
        const id = preset.preset_id ?? `${preset.lat},${preset.lon}`;
        const active = activeId !== null && activeId === preset.preset_id;
        return (
          <button
            key={id}
            type="button"
            data-preset-id={preset.preset_id ?? ""}
            disabled={sceneStatus === "loading"}
            onClick={() => {
              applyPreset(preset);
              void generate();
            }}
            aria-pressed={active}
            className={`rounded-milled border px-2.5 py-1 text-2xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              active
                ? "border-accent bg-accent text-accent-ink"
                : "border-control bg-plate-raised text-ink-muted hover:border-ink-faint hover:text-ink"
            }`}
          >
            {presetLabel(preset.preset_id)}
          </button>
        );
      })}
    </div>
  );
}

export default PresetRow;
