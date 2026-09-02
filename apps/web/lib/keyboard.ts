/**
 * The editor's keyboard map.
 *
 * G generate · B bake · R reset · ? shortcuts · Escape closes what is open.
 *
 * Two rules make this safe to hang off `window`:
 *
 *  1. **Never while typing.** `city_label`, the engraving texts and the hex
 *     fields are free text; "b" in "Berlin" must not start a bake. Anything
 *     that accepts text -- input, textarea, select, contenteditable -- swallows
 *     the shortcut.
 *  2. **Never a chord.** Ctrl/Alt/Meta combinations belong to the browser and
 *     the OS. A bare letter is the only thing this reacts to, so Ctrl+R still
 *     reloads the page instead of resetting the parameters.
 *
 * A range input is deliberately NOT a typing target: arrow keys move the slider
 * natively (and commit through `Controls.createCommitGate` on key release),
 * while G/B/R still work with a slider focused.
 */

export type Shortcut = "generate" | "bake" | "reset" | "help" | "dismiss" | "undo" | "redo";

/**
 * Rendered by the shortcut sheet, and the single source of the key map.
 *
 * `action: null` is a DISPLAY-ONLY row: keys the browser or a native control
 * handles, which the sheet has to mention but this module never dispatches.
 * They were previously smuggled in under a real action's name, which quietly
 * made the "single source of the key map" claim false.
 */
export interface ShortcutSpec {
  action: Shortcut | null;
  /** How the key is printed in the sheet. */
  keys: string;
  description: string;
}

export const SHORTCUTS: readonly ShortcutSpec[] = [
  { action: "generate", keys: "G", description: "Generate the scene for this location" },
  { action: "bake", keys: "B", description: "Bake the printable model" },
  { action: "reset", keys: "R", description: "Reset every parameter to its default" },
  { action: "undo", keys: "Ctrl+Z", description: "Undo the last change (Cmd+Z on Mac)" },
  { action: "redo", keys: "Ctrl+Shift+Z", description: "Redo (Cmd+Shift+Z on Mac)" },
  { action: "help", keys: "?", description: "Show this list" },
  { action: "dismiss", keys: "Esc", description: "Close the drawer, sheet or dialog" },
  { action: null, keys: "Tab", description: "Move between controls, including the preview" },
  { action: null, keys: "← →", description: "Nudge the focused slider" },
  {
    action: null,
    keys: "← → in the preview",
    description: "Move the building cursor; Enter picks it as a hero",
  },
] as const;

/** Element shapes this module needs, so it can be tested without a DOM. */
export interface TargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

export interface KeyEventLike {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: TargetLike | null;
}

/** Input types that hold text, i.e. the ones a letter belongs to. */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
  "date",
  "month",
  "week",
  "time",
  "datetime-local",
  // A colour well opens a picker that takes a typed hex on some platforms.
  "color",
]);

/** True when the event landed somewhere a bare letter means "type a letter". */
export function isTypingTarget(target: TargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = (target.type ?? "text").toLowerCase();
  return TEXT_INPUT_TYPES.has(type);
}

/**
 * The action this keystroke means, or null.
 *
 * `?` is reported for both "?" and "/" so the sheet opens on a keyboard where
 * the question mark needs a shifted slash and the browser reports the unshifted
 * key -- but only when Shift is actually held, so "/" alone stays free.
 *
 * Ctrl+Z / Ctrl+Shift+Z (and Cmd on Mac, [V3-P6]) is the one deliberate
 * exception to "never a chord": undo/redo. It is still refused inside a
 * typing target (checked first, same as every other shortcut) so this never
 * hijacks a text field's own native undo, and refused with Alt held, which is
 * not the accelerator on any platform.
 */
export function shortcutFor(event: KeyEventLike): Shortcut | null {
  if (isTypingTarget(event.target)) return null;

  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
    return event.shiftKey ? "redo" : "undo";
  }

  if (event.altKey || event.ctrlKey || event.metaKey) return null;

  if (event.key === "Escape") return "dismiss";
  if (event.key === "?") return "help";
  if (event.key === "/" && event.shiftKey) return "help";
  if (event.shiftKey) return null;

  switch (event.key.toLowerCase()) {
    case "g":
      return "generate";
    case "b":
      return "bake";
    case "r":
      return "reset";
    default:
      return null;
  }
}
