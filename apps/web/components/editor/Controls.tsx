"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * The control primitives the parameter panel is built from. Kept deliberately
 * dumb: they own no state, so a slider move is one store write and nothing
 * else (01 step 4).
 *
 * Every one of them is labelled -- `htmlFor`/`id` on the native controls, an
 * `aria-label` on the two that are built out of buttons -- and every hint is
 * wired through `aria-describedby`, so the axe run in `e2e/a11y.spec.ts` can
 * hold the whole panel to WCAG AA.
 */

/**
 * Keyboard keys a `type="range"` input reacts to. Tab, Shift, Escape and any
 * modified chord are NOT in here: `onCommit` on the radius and rotation
 * sliders is `generate()`, i.e. a POST /scene that is a live Overpass query at
 * a non-preset location (measured 6.6-11.5 s server side), so tabbing through
 * the panel must not fire one.
 */
const VALUE_CHANGING_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export function isValueChangingKey(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) return false;
  return VALUE_CHANGING_KEYS.has(event.key);
}

/** How long a commit waits for the next keystroke before it fires. */
export const COMMIT_DEBOUNCE_MS = 250;

export interface CommitGate {
  /** Called from `onChange`: the value really moved. */
  markDirty: () => void;
  /** Called on release: schedules `run` iff something changed since the last. */
  commit: () => void;
  /** Drops a pending commit (unmount). */
  cancel: () => void;
}

/**
 * Release-to-commit gate for a slider.
 *
 * Two jobs, both about not hitting Overpass for nothing:
 *  1. **Change detection.** A bare `onKeyUp={onCommit}` fires on Tab, on
 *     releasing Shift, on any keyup at all -- three verified POST /scene calls
 *     with zero value change just from keyboard-navigating the panel.
 *  2. **Coalescing.** Five quick arrow taps are five distinct values but one
 *     intent; the debounce turns them into one request instead of four
 *     client-aborted ones (the server does not stop working when we abort).
 *
 * Exported so `Controls.test.ts` can drive the real gate, not a copy of it.
 */
export function createCommitGate(
  run: () => void,
  delayMs: number = COMMIT_DEBOUNCE_MS,
): CommitGate {
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    markDirty: () => {
      dirty = true;
    },
    commit: () => {
      if (!dirty) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        dirty = false;
        run();
      }, delayMs);
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      dirty = false;
    },
  };
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

/** The boxed value readout: an instrument window, not a caption. */
function Readout({
  children,
  testId,
  muted = false,
}: {
  children: ReactNode;
  testId?: string;
  muted?: boolean;
}) {
  return (
    <span
      data-testid={testId}
      className={`rounded-milled border border-line bg-plate-raised px-1.5 py-0.5 text-2xs tracking-tight ${
        muted ? "text-ink-faint" : "text-ink"
      }`}
    >
      {children}
    </span>
  );
}

/**
 * The explanatory line under a control. 12 px rather than the 11 px the rest of
 * the secondary layer uses: the audit found this the least readable text on a
 * 1280 screen, and it is the text that carries the printing consequences.
 *
 * Exported so a repeated control -- the eleven filament-slot rows, the height
 * bands -- can render its help ONCE and have every row point at it through
 * `aria-describedby`, rather than either repeating the same sentence eleven
 * times on screen or leaving the rows undescribed.
 */
export function Hint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs leading-snug text-ink-faint">
      {children}
    </p>
  );
}

/**
 * The same description, for a control with no room for a visible line: a text
 * button in a row, one of the eleven filament-slot cells. The help string is
 * still the catalog's, still attached through `aria-describedby`, and still
 * offered to a mouse user as the button's `title`; it is only the printed line
 * that is dropped, because a sentence under every Remove button would bury the
 * list it belongs to.
 */
export function SrHint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="sr-only">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Slider
// ---------------------------------------------------------------------------

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Rendered next to the label, e.g. "180 mm" or "150 %". */
  display: string;
  onChange: (value: number) => void;
  /**
   * Fired once the pointer/key is released AND the value actually moved --
   * used by radius and rotation to refetch. Debounced by `COMMIT_DEBOUNCE_MS`
   * so a burst of arrow taps costs one request, not one per tap.
   */
  onCommit?: () => void;
  hint?: ReactNode;
  disabled?: boolean;
  id: string;
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
  onCommit,
  hint,
  disabled = false,
  id,
}: SliderProps) {
  // `onCommit` is an inline arrow in the group components, so it is a new
  // function every render; the gate has to be created once and read the latest.
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  });
  const gateRef = useRef<CommitGate | null>(null);
  if (gateRef.current === null) {
    gateRef.current = createCommitGate(() => commitRef.current?.());
  }
  const gate = gateRef.current;
  useEffect(() => () => gate.cancel(), [gate]);

  const hintId = `${id}-hint`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        <Readout testId={`${id}-value`} muted={disabled}>
          {display}
        </Readout>
      </div>
      <input
        id={id}
        data-testid={id}
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => {
          gate.markDirty();
          onChange(Number(event.target.value));
        }}
        onPointerUp={() => gate.commit()}
        onKeyUp={(event) => {
          if (isValueChangingKey(event)) gate.commit();
        }}
      />
      {hint ? <Hint id={hintId}>{hint}</Hint> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  id: string;
  hint?: ReactNode;
  disabled?: boolean;
}

export function Toggle({
  label,
  checked,
  onChange,
  id,
  hint,
  disabled = false,
}: ToggleProps) {
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {hint ? <Hint id={hintId}>{hint}</Hint> : null}
      </div>
      {/*
        The OFF state's border and knob are the only thing distinguishing
        "unchecked" from "no control here", so both use the boundary token
        (>= 3:1 against the sunken track, WCAG 1.4.11) and never the
        decorative hairline, which measured 2.21:1 there.
      */}
      <button
        id={id}
        data-testid={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-milled border transition-colors disabled:opacity-45 ${
          checked
            ? "border-primary bg-primary"
            : "border-control-strong bg-plate-sunken"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-[2px] transition-all ${
            checked ? "left-[1.1rem] bg-primary-ink" : "left-0.5 bg-control-strong"
          }`}
        />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented
// ---------------------------------------------------------------------------

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  id: string;
  hint?: ReactNode;
  disabled?: boolean;
}

/**
 * A radiogroup, implemented the way the ARIA pattern promises: ONE tab stop,
 * arrow keys move the selection, Home/End jump to the ends.
 *
 * Before this it was three plain buttons carrying `role="radio"`, so a screen
 * reader announced "radio 1 of 3", which tells the user arrows will work, and
 * then arrows did nothing while Tab walked through all three.
 */
/**
 * The ARIA radiogroup keyboard contract, as one function.
 *
 * Exported because `Segmented` is not the only radiogroup in the panel: the
 * frame-profile picker draws a cross-section glyph per option and cannot be a
 * `Segmented`, but it must behave like one. Shipping the pattern twice is how
 * the panel ended up with a group that announced "radio 1 of 7" and then did
 * nothing on an arrow press. Pair it with a roving `tabIndex` (0 on the
 * selected option, -1 on the rest) so the group is one Tab stop.
 */
export function radioGroupKeyDown<T extends string>(
  values: readonly T[],
  value: T,
  onChange: (next: T) => void,
  container: { current: HTMLElement | null },
  disabled = false,
): (event: { key: string; preventDefault: () => void }) => void {
  const move = (delta: number | "first" | "last"): void => {
    if (disabled || values.length === 0) return;
    const current = values.indexOf(value);
    const from = current === -1 ? 0 : current;
    const index =
      delta === "first"
        ? 0
        : delta === "last"
          ? values.length - 1
          : (from + delta + values.length) % values.length;
    onChange(values[index]);
    // Selection follows focus, so focus has to follow it back.
    const buttons = container.current?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[index]?.focus();
  };
  return (event) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Home":
        event.preventDefault();
        move("first");
        return;
      case "End":
        event.preventDefault();
        move("last");
        return;
      default:
        return;
    }
  };
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  id,
  hint,
  disabled = false,
}: SegmentedProps<T>) {
  const hintId = `${id}-hint`;
  const groupRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>
      <div
        id={id}
        data-testid={id}
        ref={groupRef}
        role="radiogroup"
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        onKeyDown={radioGroupKeyDown(
          options.map((option) => option.value),
          value,
          onChange,
          groupRef,
          disabled,
        )}
        className="flex rounded-milled border border-control bg-plate-sunken p-0.5"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            // Roving tabindex: the group is one stop, and Tab leaves it.
            tabIndex={value === option.value ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded-[2px] px-2 py-1 text-2xs transition-colors disabled:opacity-45 ${
              value === option.value
                ? "bg-primary text-primary-ink"
                : "text-ink-muted hover:bg-plate-raised hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint ? <Hint id={hintId}>{hint}</Hint> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TextField
// ---------------------------------------------------------------------------

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  id: string;
  placeholder?: string;
  maxLength?: number;
  hint?: ReactNode;
  disabled?: boolean;
  /** Shown right-aligned against the label, e.g. a character count. */
  meta?: string;
}

export function TextField({
  label,
  value,
  onChange,
  id,
  placeholder,
  maxLength,
  hint,
  disabled = false,
  meta,
}: TextFieldProps) {
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        {meta ? <Readout muted>{meta}</Readout> : null}
      </div>
      <input
        id={id}
        data-testid={id}
        type="text"
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-milled border border-control bg-plate-raised px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint disabled:opacity-45"
      />
      {hint ? <Hint id={hintId}>{hint}</Hint> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

interface SelectFieldProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  id: string;
  hint?: ReactNode;
  disabled?: boolean;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  id,
  hint,
  disabled = false,
}: SelectFieldProps<T>) {
  const hintId = `${id}-hint`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        data-testid={id}
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value as T)}
        className="w-full rounded-milled border border-control bg-plate-raised px-2 py-1.5 text-sm text-ink disabled:opacity-45"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <Hint id={hintId}>{hint}</Hint> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

/**
 * A labelled block inside a group, for things that are not a single control:
 * the hero list, the seven colour wells, the lettering editor.
 *
 * It is a `role="group"` with `aria-labelledby` and `aria-describedby` rather
 * than a bare `<span>` plus a floating hint. There is no single control to
 * attach a `<label>` to, and without the group the hint was rendered with an id
 * that nothing referenced -- visible on screen, invisible to anyone moving by
 * control, which is exactly the copy that says what a hero building is.
 */
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const base = useId();
  const labelId = `${base}-label`;
  const hintId = `${base}-hint`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hint ? hintId : undefined}
      className="space-y-1.5"
    >
      <span id={labelId} className="text-sm font-medium text-ink">
        {label}
      </span>
      {children}
      {hint ? <Hint id={hintId}>{hint}</Hint> : null}
    </div>
  );
}

/** A quiet note inside a group: a limit reached, a caveat, a consequence. */
export function Note({
  children,
  tone = "info",
  testId,
}: {
  children: ReactNode;
  tone?: "info" | "warn";
  testId?: string;
}) {
  const tones = {
    info: "border-line bg-plate-sunken text-ink-muted",
    warn: "border-warn/40 bg-warn-soft text-warn",
  } as const;
  return (
    <p
      data-testid={testId}
      className={`rounded-milled border px-2 py-1.5 text-2xs leading-snug ${tones[tone]}`}
    >
      {children}
    </p>
  );
}

/**
 * The old section wrapper, kept because it is the plain (non-collapsible)
 * container the shortcut sheet and the small-screen notice still want.
 */
export function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-line px-4 py-4 last:border-b-0">
      <h3 className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {title}
      </h3>
      {children}
    </section>
  );
}
