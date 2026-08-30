"use client";

import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import type { PartColors } from "@/lib/contracts";
import { useEditorStore } from "@/store/editor";
import { ColorField, Field, Note, SelectField, Segmented } from "../Controls";

const COLOR_MODES = [
  { value: "single" as const, label: "one filament" },
  { value: "parts" as const, label: "one per part" },
];

const HERO_MODES = [
  { value: "true_height" as const, label: "True height" },
  { value: "own_color" as const, label: "Own colour" },
  { value: "both" as const, label: "Both" },
];

/**
 * The seven parts, in the order they stack up off the plate. The pairing note
 * on each is DECISIONS [V2-P2]: the defaults are four distinct filaments, not
 * seven, so a four-slot AMS prints the file with no slot re-assignment.
 */
const PARTS: ReadonlyArray<{ key: keyof PartColors; label: string }> = [
  { key: "base", label: "Base" },
  { key: "buildings", label: "Buildings" },
  { key: "roads", label: "Roads" },
  { key: "frame", label: "Frame" },
  { key: "water", label: "Water" },
  { key: "green", label: "Planting" },
  { key: "trees", label: "Trees" },
];

const DEFAULT_PART_COLORS = DEFAULT_PRINT_PARAMS.part_colors as PartColors;

/** One filament, or one per part — plus what makes a hero building a hero. */
export function ColourGroup() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);
  const setNested = useEditorStore((state) => state.setNested);

  const mode = params.color_mode ?? "single";
  const colours = params.part_colors ?? DEFAULT_PART_COLORS;
  const single = mode === "single";
  const heroes = params.hero_building_ids ?? [];

  /**
   * Rewrite the whole palette, never one key in place. The cast is honest:
   * every one of the seven required keys is present in the spread, which is
   * what `PartColors` demands.
   */
  const setPart = (key: keyof PartColors, value: string): void => {
    setNested("part_colors", { ...colours, [key]: value } as PartColors);
  };

  return (
    <>
      <Segmented
        id="color_mode"
        label="Colour"
        value={mode}
        options={COLOR_MODES}
        onChange={(value) => setParam("color_mode", value)}
        hint="One filament exports a single object. One per part exports each part with its own colour, ready for a multi-material printer."
      />

      <Field
        label="Part colours"
        hint="The defaults are four filaments, not seven: the base shares with the buildings, the frame with the roads, and the trees with the planting."
      >
        <div className="space-y-2" data-testid="part-colors">
          {PARTS.map((part) => (
            <ColorField
              key={part.key}
              id={`part_color_${part.key}`}
              label={part.label}
              value={colours[part.key]}
              disabled={single}
              onChange={(value) => setPart(part.key, value)}
            />
          ))}
        </div>
      </Field>

      {single ? (
        <Note testId="part-colors-disabled-note">
          Switch to one filament per part to change these.
        </Note>
      ) : null}

      <SelectField
        id="hero_mode"
        label="Hero buildings print as"
        value={params.hero_mode ?? "true_height"}
        options={HERO_MODES}
        onChange={(value) => setParam("hero_mode", value)}
        hint="True height keeps a hero at its real relative height even when the other buildings are scaled down. Own colour gives it its own filament."
      />

      {heroes.length === 0 ? (
        <Note testId="hero-mode-idle-note">
          No hero buildings picked yet — click one in the preview and this starts
          to matter.
        </Note>
      ) : null}
    </>
  );
}

export default ColourGroup;
