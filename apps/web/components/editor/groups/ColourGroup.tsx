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
  type ColourRow,
  type SlotColourConflict,
} from "@/lib/colourMap";
import { contrastIssueSentence, contrastIssues } from "@/lib/contrastCheck";
import { DEFAULT_PRINT_PARAMS, PARAM_RANGES } from "@/lib/contracts";
import type { Colour, RegionColors, RegionSlots } from "@/lib/contracts";
import { labelled, sectionProps } from "@/lib/controlCatalog";
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
  type Palette,
  type SavedPalette,
} from "@/lib/palettes";
import { EXPORT_TARGET_LABELS } from "@/lib/engine/export";
import { resolveProfile } from "@/lib/printers";
import { boundGradientSlots, tintIsPreviewOnly } from "@/lib/tint";
import { useEditorStore } from "@/store/editor";
import { Field, Hint, Note, SelectField, Segmented, Slider, SrHint, TextField, Toggle } from "../Controls";

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
 * The seven `part_colors` wells that used to open this group are gone
 * (Task 2, DECISIONS [V3.1-P1-2]). `part_colors` is the v1 colour block and
 * no pipeline stage claims a single one of its leaves, so the wells changed
 * nothing in any exported file; a payload that still carries them and no
 * `colour.region_colors` is migrated at parse time instead
 * (`lib/share.ts:parsePrintParams`). The real wells are the per-region ones
 * in the "Filament slots" section below.
 */
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
  override_1: "Per-object colour 1",
  override_2: "Per-object colour 2",
  override_3: "Per-object colour 3",
  override_4: "Per-object colour 4",
};

/** The three targets whose bodies `color_mode: "single"` merges into one. */
const WELDS_ON_SINGLE: ReadonlySet<string> = new Set(["generic-3mf", "obj", "step"]);

const SLOT_MAX: number = PARAM_RANGES.colour.region_slots.base.max;
const SLOT_OPTIONS = Array.from({ length: SLOT_MAX }, (_, i) => {
  const value = String(i + 1);
  return { value, label: `Slot ${i + 1}` };
});

// ---------------------------------------------------------------------------
// The three colour patches, as pure functions
// ---------------------------------------------------------------------------

/**
 * A region-colour patch with `attribution` taken out.
 *
 * DECISIONS `[V3.1-P1-13]`: no control may write
 * `colour.region_colors.attribution`. The mandatory credit marks are engraved
 * cuts into the base and the frame and never a body of their own, so no stage
 * ever asks for their colour and nothing written here could reach a file.
 *
 * Three helpers upstream of this group do write it: every built-in palette
 * declares an `attribution` colour (`lib/palettes.ts`'s
 * `PALETTE_REGION_NAMES`), `planMergeToSlots` writes every region of every
 * cluster, and `alignConflictsPatch` writes any region that loses its slot.
 * Rather than trusting three call sites to remember, every patch this group
 * hands the store goes through here first, and `ColourGroup.test.ts` drives
 * the real builders over every built-in palette, a real merge and a real
 * align to prove the leaf never moves.
 */
export function withoutAttributionColour(
  patch: Partial<Record<RegionName, string>>,
): Partial<Record<RegionName, string>> {
  if (!("attribution" in patch)) return patch;
  const out = { ...patch };
  delete out.attribution;
  return out;
}

/** `colour.palette` for a table: the built-in it still matches, or "custom". */
function paletteIdFor(colors: RegionColors): string {
  const match = BUILTIN_PALETTES.find((palette) => matchesPalette(palette, colors));
  return match === undefined ? CUSTOM_PALETTE_ID : match.id;
}

/**
 * Applying a palette: its ten colours over the current table, its slots, and
 * its name. The name reaches the exported file (`framecraft:palette`), so it
 * is part of what this control writes.
 */
export function palettePatch(
  palette: Palette,
  currentColors: RegionColors,
  currentSlots: RegionSlots,
): Colour {
  const applied = paletteApplyPatch(palette, currentSlots);
  return {
    region_colors: {
      ...currentColors,
      ...withoutAttributionColour(applied.region_colors),
    } as RegionColors,
    region_slots: applied.region_slots,
    palette: applied.palette,
  };
}

/**
 * Merging to a profile's slot count. Null when the plan changes nothing.
 *
 * The palette id is re-derived rather than left alone: a merge rewrites
 * region colours, so a file still claiming a palette whose table no longer
 * matches would be a lie in the 3MF metadata.
 */
export function mergePatch(
  rows: readonly ColourRow[],
  targetSlots: number,
  currentColors: RegionColors,
  currentSlots: RegionSlots,
): Colour | null {
  const plan = planMergeToSlots(rows, targetSlots);
  if (!plan.changed) return null;
  const region_colors = {
    ...currentColors,
    ...withoutAttributionColour(plan.regionColors),
  } as RegionColors;
  return {
    region_slots: { ...currentSlots, ...plan.regionSlots } as RegionSlots,
    region_colors,
    palette: paletteIdFor(region_colors),
  };
}

/** Aligning a slot's losers to the colour that really prints. Null when there is nothing to align. */
export function alignPatch(
  conflicts: readonly SlotColourConflict[],
  currentColors: RegionColors,
): Colour | null {
  const patch = withoutAttributionColour(alignConflictsPatch(conflicts));
  if (Object.keys(patch).length === 0) return null;
  const region_colors = { ...currentColors, ...patch } as RegionColors;
  return { region_colors, palette: paletteIdFor(region_colors) };
}

/**
 * The filament-slot table the preview, the Bambu export, the generic 3MF and
 * the colour-change plan all read from one place (`params.colour`, resolved
 * through `lib/engine/solid/context.ts`'s `regionSlot`/`regionColor` -- the
 * one function every one of those calls, so they can never disagree), plus
 * the palette picker, the per-building tint and the height-gradient controls
 * (v3 phase 5, `[V3-P5-C]`).
 *
 * One row per region the current model produced, or every colourable region
 * name before one has been (`lib/colourMap.ts: colourRows`). `color_mode` is
 * still here and still real: the export stage reads it to decide one merged
 * object or one per region in the generic 3MF, the OBJ and the STEP.
 */
export function ColourGroup() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);
  const setNested = useEditorStore((state) => state.setNested);
  const engineResult = useEditorStore((state) => state.pipeline.result);

  const mode = params.color_mode ?? "single";
  const heroes = params.hero_building_ids ?? [];

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
    // from would relabel their own choice with someone else's name. The id
    // reaches the exported file, so the catalog row declares it too.
    const stillMatches = BUILTIN_PALETTES.some((p) => p.id === params.colour?.palette && matchesPalette(p, nextColors));
    setNested("colour", {
      region_colors: nextColors,
      palette: stillMatches ? params.colour?.palette : CUSTOM_PALETTE_ID,
    });
  };

  const profile = resolveProfile(params);
  /*
    `export/common.ts:isSingleObject` welds every region into one body for the
    generic 3MF, the OBJ and the STEP when `color_mode` is single, so the
    per-region colours below cannot reach those three files. The Bambu project
    always writes one object per region, and STL carries no colour at all.
  */
  const exportTarget = params.export_target ?? "bambu-3mf";
  const weldedIntoOneObject =
    mode === "single" && WELDS_ON_SINGLE.has(exportTarget);
  const usedSlots = distinctSlots(rows);
  const overProfile = exceedsProfileSlots(rows, profile.slots);

  const mergeToProfile = (): void => {
    const patch = mergePatch(rows, profile.slots, regionColors, slots);
    if (patch !== null) setNested("colour", patch);
  };

  const printed = printedColors(rows);
  const conflicts = slotColourConflicts(rows);

  const alignColours = (): void => {
    const patch = alignPatch(conflicts, regionColors);
    if (patch !== null) setNested("colour", patch);
  };

  const contrastProblems = useMemo(() => contrastIssues(rows), [rows]);

  // --- palettes ------------------------------------------------------------
  const activePaletteId = params.colour?.palette ?? "default";
  const [customPalettes, setCustomPalettes] = useState<SavedPalette[]>([]);
  const [saveName, setSaveName] = useState("");
  useEffect(() => {
    setCustomPalettes(loadCustomPalettes());
  }, []);

  const applyPalette = (palette: Palette): void => {
    setNested("colour", palettePatch(palette, regionColors, slots));
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
        {...labelled("color_mode")}
        value={mode}
        options={COLOR_MODES}
        onChange={(value) => setParam("color_mode", value)}
      />

      <SelectField
        {...labelled("hero_mode")}
        value={params.hero_mode ?? "true_height"}
        options={HERO_MODES}
        onChange={(value) => setParam("hero_mode", value)}
      />

      {heroes.length === 0 ? (
        <Note testId="hero-mode-idle-note">
          No hero buildings picked yet. Click one in the preview and this starts
          to matter.
        </Note>
      ) : null}

      <Field {...sectionProps("palette")}>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-1.5" data-testid="palette-builtin-list">
            {BUILTIN_PALETTES.map((palette) => (
              <button
                key={palette.id}
                type="button"
                data-testid={`palette-apply-${palette.id}`}
                onClick={() => applyPalette(palette)}
                aria-pressed={activePaletteId === palette.id}
                aria-describedby="palette-apply-hint"
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
          <Hint id="palette-apply-hint">{labelled("palette-apply-*").hint}</Hint>

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
                    aria-describedby="palette-apply-hint"
                    className="min-w-0 flex-1 truncate text-left text-2xs text-ink"
                  >
                    {saved.name}
                  </button>
                  <button
                    type="button"
                    data-testid={`palette-delete-${saved.id}`}
                    aria-label={`Delete palette ${saved.name}`}
                    aria-describedby="palette-delete-hint"
                    title={labelled("palette-delete-*").hint}
                    onClick={() => deleteCustomPalette(saved.id)}
                    className="text-2xs text-ink-faint hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              ))}
              <Hint id="palette-delete-hint">{labelled("palette-delete-*").hint}</Hint>
            </div>
          ) : null}

          <div className="flex items-center gap-1.5">
            <TextField
              {...labelled("palette-save-name")}
              value={saveName}
              placeholder="My palette"
              onChange={setSaveName}
            />
            <button
              type="button"
              data-testid="palette-save"
              disabled={saveName.trim() === ""}
              onClick={saveCurrentAsPalette}
              aria-describedby="palette-save-hint"
              title={labelled("palette-save").hint}
              className="mt-6 shrink-0 rounded-milled border border-control bg-plate-raised px-2 py-1.5 text-2xs font-medium text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-45"
            >
              {labelled("palette-save").label}
            </button>
          </div>
          <Hint id="palette-save-hint">{labelled("palette-save").hint}</Hint>
        </div>
      </Field>

      <Field {...sectionProps("filament-slots")}>
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
                {/*
                  The hex, not just the swatch. A filament is chosen by its code
                  as often as by its look, and a swatch alone cannot be read out
                  to a slicer; the removed `ColorField` primitive was the only
                  place that said so, so the reason moved here with the value.
                */}
                {row.region === "attribution" ? null : (
                  <span
                    data-testid={`colour-hex-${row.region}`}
                    className="shrink-0 text-2xs uppercase tracking-tight text-ink-faint"
                  >
                    {row.colorHex.toUpperCase()}
                  </span>
                )}
                <select
                  id={`colour_slot_${row.region}`}
                  aria-label={`${REGION_LABELS[row.region]} ${labelled("colour_slot_*").label.toLowerCase()}`}
                  aria-describedby="colour-slot-hint"
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
                {/*
                  No colour well for `attribution` (DECISIONS [V3.1-P1-13]).
                  The mandatory credit marks are engraved CUTS into the base and
                  the frame, never a body of their own, so no stage ever asks
                  for their colour and no value here could reach a file. The
                  slot select above stays: the audit's slot rule does read
                  `colour.region_slots.attribution`.
                */}
                {row.region === "attribution" ? (
                  <span
                    data-testid="colour-color-attribution-absent"
                    className="w-9 shrink-0 text-right text-2xs text-ink-faint"
                  >
                    cut
                  </span>
                ) : (
                  <input
                    id={`colour_color_${row.region}`}
                    type="color"
                    aria-label={`${REGION_LABELS[row.region]} ${labelled("colour_color_*").label.toLowerCase()}`}
                    aria-describedby="colour-color-hint"
                    data-testid={`colour-color-${row.region}`}
                    value={row.colorHex.slice(0, 7)}
                    onChange={(event) => setColor(row.region, event.target.value)}
                    className="h-6 w-9 shrink-0"
                  />
                )}
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
        <Hint id="colour-slot-hint">{labelled("colour_slot_*").hint}</Hint>
        <Hint id="colour-color-hint">{labelled("colour_color_*").hint}</Hint>
        <Note testId="colour-attribution-note">
          The attribution marks are cut into the base and the frame rather than
          printed as a body, so they take a filament slot but no colour of their
          own.
        </Note>
        {weldedIntoOneObject ? (
          <Note tone="warn" testId="colour-welded-note">
            One filament welds every region into a single object in the{" "}
            {EXPORT_TARGET_LABELS[exportTarget]}, so these colours reach the
            preview and not that file. Switch to one filament per part, or
            export a Bambu project, which always writes one object per region.
          </Note>
        ) : null}
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
            aria-describedby="align-slot-colours-hint"
            title={labelled("align-slot-colours").hint}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            {labelled("align-slot-colours").label}
          </button>
          <SrHint id="align-slot-colours-hint">
            {labelled("align-slot-colours").hint}
          </SrHint>
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
            aria-describedby="merge-to-profile-slots-hint"
            title={labelled("merge-to-profile-slots").hint}
            className="font-medium text-accent underline-offset-2 hover:underline"
          >
            Merge to {profile.slots} slot{profile.slots === 1 ? "" : "s"}
          </button>
          <SrHint id="merge-to-profile-slots-hint">
            {labelled("merge-to-profile-slots").hint}
          </SrHint>
        </Note>
      ) : null}

      <Field {...sectionProps("building-tint")}>
        <Toggle
          {...labelled("colour_tint_enabled")}
          checked={tint.enabled ?? false}
          onChange={(value) => setNested("colour", { tint: { ...tint, enabled: value } })}
        />
        {tint.enabled ? (
          <div className="mt-3 space-y-3">
            <Slider
              {...labelled("colour_tint_hue")}
              min={PARAM_RANGES.colour.tint.hue_range_deg.min}
              max={PARAM_RANGES.colour.tint.hue_range_deg.max}
              step={1}
              value={tint.hue_range_deg ?? PARAM_RANGES.colour.tint.hue_range_deg.default}
              display={`± ${(tint.hue_range_deg ?? PARAM_RANGES.colour.tint.hue_range_deg.default).toFixed(0)}°`}
              onChange={(value) => setNested("colour", { tint: { ...tint, hue_range_deg: value } })}
            />
            <Slider
              {...labelled("colour_tint_lightness")}
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
                aria-describedby="colour-tint-reroll-hint"
                title={labelled("colour-tint-reroll").hint}
                onClick={() => setNested("colour", { tint: { ...tint, seed: Math.floor(Math.random() * 1_000_000) } })}
                className="rounded-milled border border-control bg-plate-raised px-2 py-1 text-2xs font-medium text-ink transition-colors hover:border-ink-faint"
              >
                {labelled("colour-tint-reroll").label}
              </button>
            </div>
            <Hint id="colour-tint-reroll-hint">{labelled("colour-tint-reroll").hint}</Hint>
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

      <Field {...sectionProps("height-gradient")}>
        <Toggle
          {...labelled("colour_gradient_enabled")}
          checked={gradient.enabled ?? false}
          onChange={(value) => setNested("colour", { gradient: { ...gradient, enabled: value } })}
        />
        {gradient.enabled ? (
          <div className="mt-3 space-y-2">
            <Slider
              {...labelled("colour_gradient_bands")}
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
                    aria-describedby="colour-gradient-band-hint"
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
            <Hint id="colour-gradient-band-hint">
              {labelled("colour-gradient-band-slot-*").hint}
            </Hint>
          </div>
        ) : null}
      </Field>
    </>
  );
}

export default ColourGroup;
