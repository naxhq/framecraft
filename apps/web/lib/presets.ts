/**
 * Preset labels.
 *
 * DECISIONS [P1]: `GET /presets` returns the six preset `SceneRequest` objects
 * (each carrying its `preset_id`); the human labels live client-side, keyed by
 * `preset_id`. The ids and labels below are the ones frozen in that decision.
 */

import type { SceneRequest } from "./contracts";

export const PRESET_LABELS: Record<string, string> = {
  "chicago-loop": "Chicago — Loop",
  "new-york-midtown": "New York — Midtown",
  "paris-eiffel": "Paris — Tour Eiffel",
  "tokyo-shinjuku": "Tokyo — Shinjuku",
  "london-city": "London — City",
  "san-francisco-fidi": "San Francisco — Financial District",
};

/** Display order, so the row does not reshuffle if the API changes order. */
export const PRESET_ORDER: string[] = [
  "chicago-loop",
  "new-york-midtown",
  "paris-eiffel",
  "tokyo-shinjuku",
  "london-city",
  "san-francisco-fidi",
];

/** Label for a preset, falling back to the raw id for anything unexpected. */
export function presetLabel(presetId: string | null | undefined): string {
  if (!presetId) return "Custom location";
  return PRESET_LABELS[presetId] ?? presetId;
}

/** Sort presets into `PRESET_ORDER`, keeping unknown ids at the end. */
export function sortPresets(presets: SceneRequest[]): SceneRequest[] {
  const rank = (p: SceneRequest): number => {
    const index = p.preset_id ? PRESET_ORDER.indexOf(p.preset_id) : -1;
    return index === -1 ? PRESET_ORDER.length : index;
  };
  return [...presets].sort((a, b) => rank(a) - rank(b));
}
