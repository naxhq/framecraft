"use client";

import { PARAM_LIMITS, PARAM_RANGES } from "@/lib/contracts";
import type { Engraving } from "@/lib/contracts";
import { TOKENS, resolve_text, type TokenContext } from "@/lib/tokens";
import type { TextFit } from "@/lib/transform";
import { Note, SelectField, Slider, TextField } from "./Controls";

/**
 * Up to eight lines of lettering cut into (or raised off) the frame.
 *
 * Every write replaces the whole array immutably, so the store's `setParam`
 * sees a new identity and bake staleness works exactly as it does for a slider.
 *
 * The live line under each text field is the REAL expansion, through
 * `lib/tokens.ts` -- the mirrored table the bake uses (DECISIONS [V2-P2]) --
 * so what the panel shows is what gets cut. `{scale}` deliberately stays
 * unexpanded until a scene has been generated: there is no honest ratio for a
 * model nobody has measured yet.
 */

/** `print_params.json` -> `engravings.maxItems`, from the GENERATED contract. */
export const ENGRAVING_CAP: number = PARAM_LIMITS.engravings.max_items;

/** `engravings[].text.maxLength`, likewise. */
const TEXT_MAX = PARAM_LIMITS.engravings.text.max_length;

const EDGES = [
  { value: "top" as const, label: "Top" },
  { value: "bottom" as const, label: "Bottom" },
  { value: "left" as const, label: "Left" },
  { value: "right" as const, label: "Right" },
];

const ALIGNMENTS = [
  { value: "start" as const, label: "Start" },
  { value: "center" as const, label: "Centre" },
  { value: "end" as const, label: "End" },
];

const MODES = [
  { value: "engrave" as const, label: "Engrave" },
  { value: "emboss" as const, label: "Emboss" },
];

const FONTS = [
  { value: "sans" as const, label: "Sans" },
  { value: "serif" as const, label: "Serif" },
  { value: "mono" as const, label: "Mono" },
];

/** A new line, at the contract's defaults, on the first free edge. */
export function newEngraving(existing: readonly Engraving[]): Engraving {
  const used = new Set(existing.map((item) => item.edge));
  const edge = EDGES.find((option) => !used.has(option.value))?.value ?? "bottom";
  return {
    edge,
    align: "center",
    text: "{city}",
    mode: "engrave",
    size_mm: PARAM_RANGES.engravings.size_mm.default,
    depth_mm: PARAM_RANGES.engravings.depth_mm.default,
    font: "sans",
  };
}

/**
 * The verdict for one line, in the interface's voice.
 *
 * Straight from `transform.fit_text`: the size the bake will cut at, or the
 * refusal and the size that would work. It is stated HERE, next to the cap
 * height that caused it, as well as in the adjustments drawer -- the drawer is
 * a summary of everything, and this is the answer to the control the user has
 * their hand on.
 *
 * `reasonOverride` replaces the shared math's generic refusal ("the top
 * engraving is empty") with the SPECIFIC diagnosis this panel can make that
 * `transform.fit_text` cannot: which exact `{token}` had no value, or that the
 * frame itself is off (DECISIONS [V3-P1]). `fit.refused` still decides
 * whether the line reads "Not cut" at all; only the wording changes.
 */
function fitVerdict(fit: TextFit, reasonOverride?: string | null): { text: string; refused: boolean } {
  if (fit.refused) {
    return { text: `Not cut — ${reasonOverride ?? fit.reason}`, refused: true };
  }
  if (fit.size_mm < fit.requested_mm) {
    return {
      text: `Cuts at ${fit.size_mm.toFixed(2)} mm, reduced to fit the frame.`,
      refused: false,
    };
  }
  return { text: `Cuts at ${fit.size_mm.toFixed(2)} mm.`, refused: false };
}

export function EngravingsEditor({
  engravings,
  onChange,
  context,
  fits,
  disabled = false,
}: {
  engravings: readonly Engraving[];
  onChange: (next: Engraving[]) => void;
  context: TokenContext;
  /** `transform.lettering_layout(...).engravings[i].fit`, one per line. */
  fits?: readonly TextFit[];
  disabled?: boolean;
}) {
  const patch = (index: number, change: Partial<Engraving>): void => {
    onChange(
      engravings.map((item, i) => (i === index ? { ...item, ...change } : item)),
    );
  };

  const remove = (index: number): void => {
    onChange(engravings.filter((_, i) => i !== index));
  };

  const full = engravings.length >= ENGRAVING_CAP;

  return (
    <div className="space-y-3" data-testid="engravings-editor">
      {engravings.length === 0 ? (
        <p className="text-2xs text-ink-faint">
          No lettering yet. Add a line to cut a name, a date or the coordinates
          into the frame.
        </p>
      ) : null}

      {disabled ? (
        <Note tone="warn" testId="engravings-frame-off">
          Turn on Frame to engrave the edges.
        </Note>
      ) : null}

      {engravings.map((engraving, index) => {
        const id = `engraving_${index}`;
        const resolved = resolve_text(engraving.text, context);
        const emptyToken = resolved.tokens.find((t) => t.empty)?.token ?? null;
        const fit = fits?.[index];
        const reasonOverride = disabled
          ? "Turn on Frame to engrave the edges."
          : resolved.text.trim() === "" && emptyToken !== null
            ? `Line ${index + 1}: the {${emptyToken}} token has no value.`
            : null;
        const verdict = fit ? fitVerdict(fit, reasonOverride) : null;
        return (
          <div
            key={id}
            data-testid="engraving-row"
            aria-disabled={disabled ? "true" : undefined}
            className="space-y-3 rounded-plate border border-line bg-plate-sunken p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Line {index + 1}
              </span>
              <button
                type="button"
                data-testid={`${id}-remove`}
                onClick={() => remove(index)}
                disabled={disabled}
                aria-label={`Remove engraving line ${index + 1}`}
                className="rounded-[2px] px-1.5 py-0.5 text-2xs text-ink-faint transition-colors hover:bg-plate-raised hover:text-danger disabled:opacity-45"
              >
                Remove
              </button>
            </div>

            <TextField
              id={`${id}_text`}
              label="Text"
              value={engraving.text}
              maxLength={TEXT_MAX}
              meta={`${engraving.text.length}/${TEXT_MAX}`}
              disabled={disabled}
              onChange={(value) => patch(index, { text: value })}
            />

            <p
              data-testid={`${id}-preview`}
              className="rounded-milled border border-line bg-plate-raised px-2 py-1 text-2xs text-ink-muted"
            >
              Cuts as:{" "}
              {resolved.text ? (
                <span className="text-ink">{resolved.text}</span>
              ) : (
                <span className="text-ink-faint">
                  {emptyToken !== null
                    ? `nothing yet — the {${emptyToken}} token has no value`
                    : "nothing yet — the tokens in this line have no value"}
                </span>
              )}
            </p>

            <div className="grid grid-cols-2 gap-3">
              <SelectField
                id={`${id}_edge`}
                label="Edge"
                value={engraving.edge}
                options={EDGES}
                disabled={disabled}
                onChange={(value) => patch(index, { edge: value })}
              />
              <SelectField
                id={`${id}_align`}
                label="Align"
                value={engraving.align ?? "center"}
                options={ALIGNMENTS}
                disabled={disabled}
                onChange={(value) => patch(index, { align: value })}
              />
              <SelectField
                id={`${id}_mode`}
                label="Mode"
                value={engraving.mode ?? "engrave"}
                options={MODES}
                disabled={disabled}
                onChange={(value) => patch(index, { mode: value })}
              />
              <SelectField
                id={`${id}_font`}
                label="Font"
                value={engraving.font ?? "sans"}
                options={FONTS}
                disabled={disabled}
                onChange={(value) => patch(index, { font: value })}
              />
            </div>

            <Slider
              id={`${id}_size_mm`}
              label="Cap height"
              min={PARAM_RANGES.engravings.size_mm.min}
              max={PARAM_RANGES.engravings.size_mm.max}
              step={0.1}
              value={engraving.size_mm ?? PARAM_RANGES.engravings.size_mm.default}
              display={`${(engraving.size_mm ?? PARAM_RANGES.engravings.size_mm.default).toFixed(1)} mm`}
              disabled={disabled}
              onChange={(value) => patch(index, { size_mm: value })}
            />
            <Slider
              id={`${id}_depth_mm`}
              label="Depth"
              min={PARAM_RANGES.engravings.depth_mm.min}
              max={PARAM_RANGES.engravings.depth_mm.max}
              step={0.05}
              value={engraving.depth_mm ?? PARAM_RANGES.engravings.depth_mm.default}
              display={`${(engraving.depth_mm ?? PARAM_RANGES.engravings.depth_mm.default).toFixed(2)} mm`}
              disabled={disabled}
              onChange={(value) => patch(index, { depth_mm: value })}
            />

            {fit ? (
              <Note tone={verdict?.refused ? "warn" : "info"} testId={`${id}-fit`}>
                {verdict?.text}
              </Note>
            ) : null}
          </div>
        );
      })}

      <button
        type="button"
        data-testid="engraving-add"
        disabled={disabled || full}
        onClick={() => onChange([...engravings, newEngraving(engravings)])}
        className="w-full rounded-milled border border-dashed border-control px-3 py-2 text-2xs text-ink-muted transition-colors hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
      >
        Add a line of lettering
      </button>

      {full ? (
        <Note tone="warn" testId="engraving-cap-notice">
          {ENGRAVING_CAP} lines is the limit. Remove one to add another.
        </Note>
      ) : null}

      <Note testId="engraving-tokens">
        Tokens: {TOKENS.map((token) => `{${token}}`).join(" ")}. They expand when
        the file is baked, and the line above each field shows what they say now.
      </Note>
    </div>
  );
}

export default EngravingsEditor;
