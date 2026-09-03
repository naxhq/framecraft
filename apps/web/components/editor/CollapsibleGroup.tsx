"use client";

import type { ReactNode } from "react";

import { labelled } from "@/lib/controlCatalog";
import type { GroupId } from "@/lib/groups";
import { SrHint } from "./Controls";

/**
 * One collapsible group of the parameter panel.
 *
 * **The header is a header.** Before this it was set in the same 11 px as the
 * quietest text in the panel, on the same surface as the controls under it, so
 * a header and a control label read as two lines of the same list and the panel
 * scanned as one long ribbon. It is now on the sunken surface with a rule under
 * it, in ink rather than in the faint tone, with a hairline standing at the
 * left edge of the open one: three signals, none of which depends on colour
 * alone.
 *
 * **The header says what the section holds.** `state` is computed from the
 * current parameters by `lib/groups.ts:summariseGroup` ("bevelled, 6 mm border,
 * 2 lines"), never a fixed string, so a collapsed group can be read without
 * being opened. That is what makes eleven collapsed groups navigable rather
 * than eleven closed doors.
 *
 * The toggle is a real `<button>` carrying `aria-expanded` and `aria-controls`,
 * so a screen reader and the axe run both see a disclosure rather than a div
 * that happens to be clickable. The section reset is a SIBLING of it, never a
 * child: a button inside a button is invalid HTML and the inner one is
 * unreachable by keyboard in several browsers.
 *
 * The body is unmounted when collapsed: these groups hold sliders whose ids the
 * e2e drives, and a hidden-but-present `#plate_mm` would be findable and
 * unclickable, which is the worst of both.
 */
export function CollapsibleGroup({
  id,
  title,
  summary,
  state,
  collapsed,
  onToggle,
  onReset,
  resetDisabled,
  changedCount,
  children,
}: {
  id: GroupId;
  title: string;
  /** What the group decides, standing text, shown in the open body. */
  summary: string;
  /** What the group is set to right now, computed from the parameters. */
  state: string;
  collapsed: boolean;
  onToggle: () => void;
  /** Put this group's own fields back to their contract defaults. */
  onReset: () => void;
  /** True when the group is already at its defaults. */
  resetDisabled: boolean;
  /** How many of this group's fields differ from the default. */
  changedCount: number;
  children: ReactNode;
}) {
  const bodyId = `group-${id}-body`;
  const reset = labelled("group-*-reset");
  const resetHintId = `group-${id}-reset-hint`;
  return (
    <section
      data-testid={`group-${id}`}
      data-collapsed={collapsed ? "true" : "false"}
      className="border-b border-line last:border-b-0"
    >
      <div
        className={`flex items-stretch border-l-2 bg-plate-sunken ${
          collapsed ? "border-l-transparent" : "border-l-ink-faint"
        }`}
      >
        <h3 className="min-w-0 flex-1">
          <button
            type="button"
            data-testid={`group-${id}-toggle`}
            aria-expanded={!collapsed}
            // Only while the body exists. The body is unmounted when collapsed,
            // so an unconditional `aria-controls` dangles on every closed group.
            aria-controls={collapsed ? undefined : bodyId}
            // The title, the state line and the count are adjacent JSX
            // elements, so no whitespace text node is emitted and the computed
            // name ran them together ("Buildings1/12 heroes"). Visually fine,
            // read aloud wrong.
            aria-label={
              changedCount > 0
                ? `${title}, ${state}, ${changedCount} changed from default`
                : `${title}, ${state}`
            }
            onClick={onToggle}
            className="flex w-full items-center gap-2 py-2.5 pl-3 pr-2 text-left transition-colors hover:bg-plate-raised"
          >
            <Chevron collapsed={collapsed} />
            <span className="shrink-0 font-display text-xs font-semibold uppercase tracking-[0.12em] text-ink">
              {title}
            </span>
            <span
              data-testid={`group-${id}-state`}
              className="min-w-0 flex-1 truncate text-right text-2xs text-ink-faint"
            >
              {state}
            </span>
            {changedCount > 0 ? (
              <span
                data-testid={`group-${id}-changed`}
                className="shrink-0 rounded-milled border border-line bg-plate px-1 py-0.5 text-2xs text-ink-muted"
              >
                {changedCount}
              </span>
            ) : null}
          </button>
        </h3>
        <button
          type="button"
          data-testid={`group-${id}-reset`}
          disabled={resetDisabled}
          aria-label={`${reset.label}: ${title}`}
          aria-describedby={resetHintId}
          title={reset.hint}
          onClick={onReset}
          className="shrink-0 self-center rounded-milled px-2 py-1 text-2xs text-ink-faint transition-colors hover:bg-plate-raised hover:text-ink disabled:invisible"
        >
          Reset
        </button>
        <SrHint id={resetHintId}>{reset.hint}</SrHint>
      </div>
      {collapsed ? null : (
        <div id={bodyId} className="space-y-4 bg-plate px-4 pb-5 pt-3">
          <p className="text-2xs leading-snug text-ink-faint">{summary}</p>
          {children}
        </div>
      )}
    </section>
  );
}

/** A hairline chevron: two strokes, rotated. No icon font, no dependency. */
function Chevron({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 10 10"
      className={`h-2.5 w-2.5 shrink-0 text-ink-faint transition-transform ${
        collapsed ? "" : "rotate-90"
      }`}
    >
      <path
        d="M3 1.5 L7 5 L3 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="square"
      />
    </svg>
  );
}

export default CollapsibleGroup;
