"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The three control primitives the parameter panel is built from. Kept
 * deliberately dumb: they own no state, so a slider move is one store write
 * and nothing else (01 step 4).
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
  // `onCommit` is an inline arrow in ParamPanel, so it is a new function every
  // render; the gate has to be created once and read the latest one.
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

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <span
          className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400"
          data-testid={`${id}-value`}
        >
          {display}
        </span>
      </div>
      <input
        id={id}
        type="range"
        className="w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          gate.markDirty();
          onChange(Number(event.target.value));
        }}
        onPointerUp={() => gate.commit()}
        onKeyUp={(event) => {
          if (isValueChangingKey(event)) gate.commit();
        }}
      />
      {hint ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
      ) : null}
    </div>
  );
}

interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  id: string;
  hint?: ReactNode;
}

export function Toggle({ label, checked, onChange, id, hint }: ToggleProps) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? "bg-sky-500" : "bg-neutral-300 dark:bg-neutral-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            checked ? "left-5.5" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  id: string;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  id,
}: SegmentedProps<T>) {
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <div
        id={id}
        role="radiogroup"
        aria-label={label}
        className="flex rounded-md border border-neutral-300 p-0.5 dark:border-neutral-700"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-colors ${
              value === option.value
                ? "bg-sky-500 text-white"
                : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-b border-neutral-200 px-4 py-4 last:border-b-0 dark:border-neutral-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {title}
      </h3>
      {children}
    </section>
  );
}
