"use client";

import { useEffect } from "react";

import { presetLabel, sortPresets } from "@/lib/presets";
import { activePresetId, useEditorStore } from "@/store/editor";

/**
 * The six preset cities (01). The `SceneRequest` objects come from
 * `GET /presets` on mount -- never a hard-coded list in app code -- and the
 * labels are keyed by `preset_id` per DECISIONS [P1].
 *
 * Clicking a preset sets the location (including its rotation) and generates
 * immediately, which is the "preset loads and previews in under 5 s" path in
 * 01/A1.
 *
 * The active chip comes from `activePresetId`, not straight from
 * `location.preset_id`: the store's initial location IS the Chicago Loop
 * preset, so reading the id directly lit that chip up on every fresh page load
 * while nothing had been generated.
 */
export function PresetRow() {
  const presets = useEditorStore((state) => state.presets);
  const loadPresets = useEditorStore((state) => state.loadPresets);
  const applyPreset = useEditorStore((state) => state.applyPreset);
  const generate = useEditorStore((state) => state.generate);
  const activeId = useEditorStore(activePresetId);
  const sceneStatus = useEditorStore((state) => state.scene.status);

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  if (presets.status === "loading" || presets.status === "idle") {
    return (
      <p className="py-1 text-2xs text-ink-faint" data-testid="presets-loading">
        Loading presets...
      </p>
    );
  }

  if (presets.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2 py-1 text-2xs text-warn">
        <span data-testid="presets-error">
          Presets unavailable: {presets.message}
        </span>
        <button
          type="button"
          onClick={() => void loadPresets()}
          className="rounded-milled border border-control px-1.5 py-0.5 text-ink-muted transition-colors hover:text-ink"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2" data-testid="preset-row">
      {sortPresets(presets.items).map((preset) => {
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
