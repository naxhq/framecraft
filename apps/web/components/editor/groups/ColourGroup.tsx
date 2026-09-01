"use client";

import {
  alignConflictsPatch,
  colourRows,
  distinctSlots,
  exceedsProfileSlots,
  planMergeToSlots,
  printedColors,
  slotColourConflicts,
} from "@/lib/colourMap";
import { DEFAULT_PRINT_PARAMS, PARAM_RANGES } from "@/lib/contracts";
import type { PartColors, RegionColors, RegionSlots } from "@/lib/contracts";
import type { RegionName } from "@/lib/engine/types";
import { resolveProfile } from "@/lib/printers";
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
 *
 * This "Part colours" section (and its `color_mode` toggle) is the v1/v2
 * palette: it still decides the instanced preview's fallback colours while an
 * engine job is computing, and `generic-3mf`'s own `single`/`parts` default
 * ([lib/engine/export/generic3mf.ts]). It is NOT what the real engine result,
 * the Bambu export or the colour-change plan use for filament SLOTS -- that
 * is the "Filament slots" section below, `params.colour`, added in v3.
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
const DEFAULT_REGION_SLOTS = DEFAULT_PRINT_PARAMS.colour?.region_slots as RegionSlots;
const DEFAULT_REGION_COLORS = DEFAULT_PRINT_PARAMS.colour?.region_colors as RegionColors;

const REGION_LABELS: Record<RegionName, string> = {
  base: "Base",
  frame: "Frame",
  matting: "Matting",
  buildings: "Buildings",
  hero_building: "Hero buildings",
  roads: "Roads",
  water: "Water",
  parks: "Parks",
  rail: "Rail",
  lettering: "Lettering",
  attribution: "Attribution",
  easel: "Easel",
};

const SLOT_MAX: number = PARAM_RANGES.colour.region_slots.base.max;
const SLOT_OPTIONS = Array.from({ length: SLOT_MAX }, (_, i) => {
  const value = String(i + 1);
  return { value, label: `Slot ${i + 1}` };
});

/**
 * The v1/v2 parts palette (still read by the instanced fallback preview and
 * by `generic-3mf`'s single/parts default), plus the v3 filament-slot table
 * that the real engine result, the preview once it is fresh, the Bambu
 * export and the colour-change plan all read from the same place
 * (`params.colour`, resolved through `lib/engine/solid/context.ts`'s
 * `regionSlot`/`regionColor` -- the one function every one of those reads,
 * so they can never disagree). One row per region the current bake produced,
 * or every colourable region name before the first one has (`lib/colourMap.ts:
 * colourRows`).
 */
export function ColourGroup() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);
  const setNested = useEditorStore((state) => state.setNested);
  const engineResult = useEditorStore((state) => state.engine.result);

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

  const rows = colourRows(params, engineResult);
  const slots = params.colour?.region_slots ?? DEFAULT_REGION_SLOTS;
  const regionColors = params.colour?.region_colors ?? DEFAULT_REGION_COLORS;

  const setSlot = (region: RegionName, value: number): void => {
    setNested("colour", { region_slots: { ...slots, [region]: value } as RegionSlots });
  };
  const setColor = (region: RegionName, value: string): void => {
    setNested("colour", { region_colors: { ...regionColors, [region]: value } as RegionColors });
  };

  const profile = resolveProfile(params);
  const usedSlots = distinctSlots(rows);
  const overProfile = exceedsProfileSlots(rows, profile.slots);

  const mergeToProfile = (): void => {
    const plan = planMergeToSlots(rows, profile.slots);
    if (!plan.changed) return;
    setNested("colour", {
      region_slots: { ...slots, ...plan.regionSlots } as RegionSlots,
      region_colors: { ...regionColors, ...plan.regionColors } as RegionColors,
    });
  };

  // Audit v3-02 finding 4: two regions sharing a slot but carrying different
  // `region_colors` disagree with the exporter, which resolves one colour per
  // SLOT (`export/common.ts:slotColors`, "first region in REGION_NAMES order
  // wins"), silently. `printed` is what each row's swatch actually prints as;
  // `conflicts` is what the warning below names.
  const printed = printedColors(rows);
  const conflicts = slotColourConflicts(rows);

  const alignColours = (): void => {
    const patch = alignConflictsPatch(conflicts);
    if (Object.keys(patch).length === 0) return;
    setNested("colour", { region_colors: { ...regionColors, ...patch } as RegionColors });
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

      <Field
        label="Filament slots"
        hint="What the printed model, the Bambu project and the colour-change plan actually use: a slot and a colour per region. This is what the preview shows once a bake has run."
      >
        <div className="space-y-1.5" data-testid="colour-region-rows">
          {rows.map((row) => {
            const printedHex = printed.get(row.region) ?? row.colorHex;
            const disagrees = printedHex.slice(0, 7).toLowerCase() !== row.colorHex.slice(0, 7).toLowerCase();
            return (
              <div
                key={row.region}
                data-testid={`colour-region-row-${row.region}`}
                className="flex items-center justify-between gap-2 rounded-milled border border-line bg-plate-sunken px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {REGION_LABELS[row.region]}
                </span>
                <select
                  id={`colour_slot_${row.region}`}
                  aria-label={`${REGION_LABELS[row.region]} filament slot`}
                  data-testid={`colour-slot-${row.region}`}
                  value={String(row.slot)}
                  onChange={(event) => setSlot(row.region, Number(event.target.value))}
                  className="rounded-milled border border-control bg-plate-raised px-1.5 py-1 text-2xs text-ink"
                >
                  {SLOT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <input
                  id={`colour_color_${row.region}`}
                  type="color"
                  aria-label={`${REGION_LABELS[row.region]} colour`}
                  data-testid={`colour-color-${row.region}`}
                  value={row.colorHex.slice(0, 7)}
                  onChange={(event) => setColor(row.region, event.target.value)}
                  className="h-6 w-9 shrink-0"
                />
                {disagrees ? (
                  <span
                    role="img"
                    data-testid={`colour-prints-as-${row.region}`}
                    title={`Prints as ${printedHex.toUpperCase()}: another region sharing this slot wins`}
                    aria-label={`${REGION_LABELS[row.region]} actually prints as ${printedHex.toUpperCase()}`}
                    className="h-6 w-4 shrink-0 rounded-[2px] border border-control-strong"
                    style={{ backgroundColor: printedHex }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </Field>

      {conflicts.length > 0 ? (
        <Note tone="warn" testId="colour-slot-conflicts">
          <span className="block space-y-0.5">
            {conflicts.map((conflict) => (
              <span key={conflict.slot} className="block">
                On slot {conflict.slot},{" "}
                {conflict.losingRegions.map((region) => REGION_LABELS[region]).join(", ")}{" "}
                {conflict.losingRegions.length === 1 ? "prints" : "print"} in{" "}
                {REGION_LABELS[conflict.printedRegion]}&apos;s colour (
                {conflict.printedColorHex.toUpperCase()}), not their own.
              </span>
            ))}
          </span>{" "}
          <button
            type="button"
            data-testid="align-slot-colours"
            onClick={alignColours}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Align colours to what will print
          </button>
        </Note>
      ) : null}

      {overProfile ? (
        <Note tone="warn" testId="colour-slots-exceed-profile">
          This model uses {usedSlots.length} filament slots, more than the{" "}
          {profile.label} profile&apos;s {profile.slots} (Printer group above).{" "}
          <button
            type="button"
            data-testid="merge-to-profile-slots"
            onClick={mergeToProfile}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Merge to {profile.slots} slot{profile.slots === 1 ? "" : "s"}
          </button>
        </Note>
      ) : null}
    </>
  );
}

export default ColourGroup;
