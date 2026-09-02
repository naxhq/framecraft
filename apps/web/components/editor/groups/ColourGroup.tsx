"use client";

import { useEffect, useMemo, useState } from "react";

import {
  alignConflictsPatch,
  colourRows,
  distinctSlots,
  exceedsProfileSlots,
  planMergeToSlots,
  printedColors,
  slotColourConflicts,
} from "@/lib/colourMap";
import { contrastIssueSentence, contrastIssues } from "@/lib/contrastCheck";
import { DEFAULT_PRINT_PARAMS, PARAM_RANGES } from "@/lib/contracts";
import type { PartColors, RegionColors, RegionSlots } from "@/lib/contracts";
import { GRADIENT_MAX_BANDS, bandRegionName, type RegionName } from "@/lib/engine/types";
import {
  BUILTIN_PALETTES,
  CUSTOM_PALETTE_ID,
  customPaletteId,
  loadCustomPalettes,
  matchesPalette,
  paletteApplyPatch,
  savedAsPalette,
  saveCustomPalettes,
  type SavedPalette,
} from "@/lib/palettes";
import { resolveProfile } from "@/lib/printers";
import { boundGradientSlots, tintIsPreviewOnly } from "@/lib/tint";
import { useEditorStore } from "@/store/editor";
import { ColorField, Field, Note, SelectField, Segmented, Slider, TextField, Toggle } from "../Controls";

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
const DEFAULT_TINT = DEFAULT_PRINT_PARAMS.colour!.tint!;
const DEFAULT_GRADIENT = DEFAULT_PRINT_PARAMS.colour!.gradient!;

/**
 * Every region name a `RegionMesh` can carry, including the derived,
 * feature-gated ones (`cleat`, `buildings_band_2..8`, `[V3-P5-F7]`). A `Record`
 * so TypeScript holds this list to being exhaustive whenever `RegionName`
 * grows -- the compiler is the reminder to add a label here, not a runtime
 * fallback that would silently print the raw region id.
 */
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
  cleat: "Cleat mount",
  buildings_band_2: "Buildings, band 2",
  buildings_band_3: "Buildings, band 3",
  buildings_band_4: "Buildings, band 4",
  buildings_band_5: "Buildings, band 5",
  buildings_band_6: "Buildings, band 6",
  buildings_band_7: "Buildings, band 7",
  buildings_band_8: "Buildings, band 8",
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
 * so they can never disagree). One row per region the current build produced,
 * or every colourable region name before the first one has (`lib/colourMap.ts:
 * colourRows`), plus the palette picker, per-building tint and the
 * height-gradient controls (v3 phase 5, `[V3-P5-C]`).
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
    const nextColors = { ...regionColors, [region]: value } as RegionColors;
    // Editing any single swatch by hand is what flips the picker to "custom"
    // -- a palette id left pointing at a table the user has since diverged
    // from would relabel their own choice with someone else's name.
    const stillMatches = BUILTIN_PALETTES.some((p) => p.id === params.colour?.palette && matchesPalette(p, nextColors));
    setNested("colour", {
      region_colors: nextColors,
      palette: stillMatches ? params.colour?.palette : CUSTOM_PALETTE_ID,
    });
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

  const printed = printedColors(rows);
  const conflicts = slotColourConflicts(rows);

  const alignColours = (): void => {
    const patch = alignConflictsPatch(conflicts);
    if (Object.keys(patch).length === 0) return;
    setNested("colour", { region_colors: { ...regionColors, ...patch } as RegionColors });
  };

  const contrastProblems = useMemo(() => contrastIssues(rows), [rows]);

  // --- palettes ------------------------------------------------------------
  const activePaletteId = params.colour?.palette ?? "default";
  const [customPalettes, setCustomPalettes] = useState<SavedPalette[]>([]);
  const [saveName, setSaveName] = useState("");
  useEffect(() => {
    setCustomPalettes(loadCustomPalettes());
  }, []);

  const applyPalette = (palette: (typeof BUILTIN_PALETTES)[number]): void => {
    setNested("colour", paletteApplyPatch(palette, slots));
  };

  const saveCurrentAsPalette = (): void => {
    const name = saveName.trim();
    if (name === "") return;
    const id = customPaletteId(name, customPalettes);
    const saved: SavedPalette = {
      id,
      name,
      region_colors: regionColors,
      savedAt: new Date().toISOString(),
    };
    const next = [...customPalettes, saved];
    setCustomPalettes(next);
    saveCustomPalettes(next);
    setNested("colour", { palette: id });
    setSaveName("");
  };

  const deleteCustomPalette = (id: string): void => {
    const next = customPalettes.filter((p) => p.id !== id);
    setCustomPalettes(next);
    saveCustomPalettes(next);
    if (activePaletteId === id) setNested("colour", { palette: CUSTOM_PALETTE_ID });
  };

  // --- tint ------------------------------------------------------------------
  const tint = params.colour?.tint ?? DEFAULT_TINT;
  const tintPreviewOnly = tintIsPreviewOnly(params.colour, params.export_target);

  // --- gradient ----------------------------------------------------------
  const gradient = params.colour?.gradient ?? DEFAULT_GRADIENT;
  const boundedBands = boundGradientSlots(gradient.slots ?? [], profile.slots);
  const maxBands = Math.min(GRADIENT_MAX_BANDS, profile.slots);

  const setGradientBandCount = (count: number): void => {
    const current = gradient.slots ?? [];
    const next = Array.from({ length: count }, (_, i) => current[i] ?? Math.min(profile.slots, i + 1));
    setNested("colour", { gradient: { ...gradient, slots: next } });
  };
  const setGradientBandSlot = (index: number, value: number): void => {
    const next = [...(gradient.slots ?? [])];
    next[index] = value;
    setNested("colour", { gradient: { ...gradient, slots: next } });
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
        label="Palette"
        hint="Applying a palette sets every region's colour and slot in one step. The active colours travel in a shared link (region_colors), not the palette name -- share it and the recipient sees the same colours even if they never load this palette."
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5" data-testid="palette-builtin-list">
            {BUILTIN_PALETTES.map((palette) => (
              <button
                key={palette.id}
                type="button"
                data-testid={`palette-apply-${palette.id}`}
                onClick={() => applyPalette(palette)}
                aria-pressed={activePaletteId === palette.id}
                title={palette.description}
                className={`flex items-center gap-1.5 rounded-milled border px-2 py-1.5 text-left text-2xs transition-colors ${
                  activePaletteId === palette.id
                    ? "border-primary bg-primary/10 text-ink"
                    : "border-control bg-plate-raised text-ink-muted hover:border-ink-faint"
                }`}
              >
                <span className="flex shrink-0 overflow-hidden rounded-[2px] border border-control-strong">
                  {[palette.region_colors.base, palette.region_colors.buildings, palette.region_colors.roads, palette.region_colors.water].map(
                    (hex, i) => (
                      <span key={i} className="h-3.5 w-2" style={{ backgroundColor: hex }} />
                    ),
                  )}
                </span>
                {palette.label}
              </button>
            ))}
          </div>

          {activePaletteId === CUSTOM_PALETTE_ID ? (
            <Note testId="palette-custom-note">Custom: a region colour was edited by hand.</Note>
          ) : null}

          {customPalettes.length > 0 ? (
            <div className="space-y-1" data-testid="palette-custom-list">
              {customPalettes.map((saved) => (
                <div
                  key={saved.id}
                  className="flex items-center justify-between gap-2 rounded-milled border border-line bg-plate-sunken px-2 py-1"
                >
                  <button
                    type="button"
                    data-testid={`palette-apply-${saved.id}`}
                    onClick={() => applyPalette(savedAsPalette(saved))}
                    aria-pressed={activePaletteId === saved.id}
                    className="min-w-0 flex-1 truncate text-left text-2xs text-ink"
                  >
                    {saved.name}
                  </button>
                  <button
                    type="button"
                    data-testid={`palette-delete-${saved.id}`}
                    aria-label={`Delete palette ${saved.name}`}
                    onClick={() => deleteCustomPalette(saved.id)}
                    className="text-2xs text-ink-faint hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-1.5">
            <TextField
              id="palette-save-name"
              label="Save current colours as"
              value={saveName}
              placeholder="My palette"
              onChange={setSaveName}
            />
            <button
              type="button"
              data-testid="palette-save"
              disabled={saveName.trim() === ""}
              onClick={saveCurrentAsPalette}
              className="mt-6 shrink-0 rounded-milled border border-control bg-plate-raised px-2 py-1.5 text-2xs font-medium text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-45"
            >
              Save
            </button>
          </div>
        </div>
      </Field>

      <Field
        label="Filament slots"
        hint="What the exported file, the Bambu project and the colour-change plan actually use: a slot and a colour per region. This is what the preview shows once the model has been built."
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

      {contrastProblems.length > 0 ? (
        <Note tone="warn" testId="colour-contrast-warning">
          <span className="block space-y-0.5">
            {contrastProblems.map((issue) => (
              <span key={`${issue.regionA}-${issue.regionB}`} className="block">
                {contrastIssueSentence(issue, (region) => REGION_LABELS[region])}
              </span>
            ))}
          </span>
        </Note>
      ) : null}

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

      <Field
        label="Building tint"
        hint="A small random colour shift per building, so a block of identical footprints does not read as one slab."
      >
        <Toggle
          id="colour_tint_enabled"
          label="Vary building colour"
          checked={tint.enabled ?? false}
          onChange={(value) => setNested("colour", { tint: { ...tint, enabled: value } })}
        />
        {tint.enabled ? (
          <div className="mt-3 space-y-3">
            <Slider
              id="colour_tint_hue"
              label="Hue range"
              min={PARAM_RANGES.colour.tint.hue_range_deg.min}
              max={PARAM_RANGES.colour.tint.hue_range_deg.max}
              step={1}
              value={tint.hue_range_deg ?? PARAM_RANGES.colour.tint.hue_range_deg.default}
              display={`± ${(tint.hue_range_deg ?? PARAM_RANGES.colour.tint.hue_range_deg.default).toFixed(0)}°`}
              onChange={(value) => setNested("colour", { tint: { ...tint, hue_range_deg: value } })}
            />
            <Slider
              id="colour_tint_lightness"
              label="Lightness range"
              min={PARAM_RANGES.colour.tint.lightness_range.min}
              max={PARAM_RANGES.colour.tint.lightness_range.max}
              step={0.01}
              value={tint.lightness_range ?? PARAM_RANGES.colour.tint.lightness_range.default}
              display={`± ${Math.round((tint.lightness_range ?? PARAM_RANGES.colour.tint.lightness_range.default) * 100)}%`}
              onChange={(value) => setNested("colour", { tint: { ...tint, lightness_range: value } })}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-2xs text-ink-faint" data-testid="colour-tint-seed">
                Seed {tint.seed ?? DEFAULT_TINT.seed}
              </span>
              <button
                type="button"
                data-testid="colour-tint-reroll"
                onClick={() => setNested("colour", { tint: { ...tint, seed: Math.floor(Math.random() * 1_000_000) } })}
                className="rounded-milled border border-control bg-plate-raised px-2 py-1 text-2xs font-medium text-ink transition-colors hover:border-ink-faint"
              >
                Reroll
              </button>
            </div>
            {tintPreviewOnly ? (
              <Note tone="info" testId="colour-tint-preview-only-note">
                Building tint affects the preview and the OBJ export only. No printer
                profile can change filament colour per building, so the active export
                target ({params.export_target ?? "bambu-3mf"}) gives every building its
                region&apos;s own slot colour instead.
              </Note>
            ) : null}
          </div>
        ) : null}
      </Field>

      <Field
        label="Height gradient"
        hint="Bands the buildings by height, tallest in one filament, shortest in another. Bounded by the active printer profile's own filament count."
      >
        <Toggle
          id="colour_gradient_enabled"
          label="Band buildings by height"
          checked={gradient.enabled ?? false}
          onChange={(value) => setNested("colour", { gradient: { ...gradient, enabled: value } })}
        />
        {gradient.enabled ? (
          <div className="mt-3 space-y-2">
            <Slider
              id="colour_gradient_bands"
              label="Bands"
              min={1}
              max={maxBands}
              step={1}
              value={boundedBands.length}
              display={String(boundedBands.length)}
              onChange={(value) => setGradientBandCount(value)}
            />
            <div className="space-y-1" data-testid="colour-gradient-bands">
              {boundedBands.map((slot, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between gap-2 rounded-milled border border-line bg-plate-sunken px-2 py-1"
                >
                  <span className="text-2xs text-ink">
                    {REGION_LABELS[bandRegionName(index + 1)]}
                  </span>
                  <select
                    aria-label={`Band ${index + 1} filament slot`}
                    data-testid={`colour-gradient-band-slot-${index}`}
                    value={String(slot)}
                    onChange={(event) => setGradientBandSlot(index, Number(event.target.value))}
                    className="rounded-milled border border-control bg-plate-raised px-1.5 py-1 text-2xs text-ink"
                  >
                    {SLOT_OPTIONS.slice(0, profile.slots).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Field>
    </>
  );
}

export default ColourGroup;
