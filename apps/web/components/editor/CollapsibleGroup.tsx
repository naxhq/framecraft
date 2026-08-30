"use client";

import type { ReactNode } from "react";

import type { GroupId } from "@/lib/groups";

/**
 * One collapsible group of the parameter panel.
 *
 * The header is a real `<button>` carrying `aria-expanded` and `aria-controls`,
 * so a screen reader and the axe run both see a disclosure rather than a div
 * that happens to be clickable. The body is unmounted when collapsed: these
 * groups hold sliders whose ids the e2e drives, and a hidden-but-present
 * `#plate_mm` would be findable and unclickable, which is the worst of both.
 */
export function CollapsibleGroup({
  id,
  title,
  summary,
  collapsed,
  onToggle,
  badge,
  children,
}: {
  id: GroupId;
  title: string;
  summary: string;
  collapsed: boolean;
  onToggle: () => void;
  /** A short count shown on the header, e.g. "3 heroes". */
  badge?: string | null;
  children: ReactNode;
}) {
  const bodyId = `group-${id}-body`;
  return (
    <section
      data-testid={`group-${id}`}
      data-collapsed={collapsed ? "true" : "false"}
      className="border-b border-line last:border-b-0"
    >
      <h3>
        <button
          type="button"
          data-testid={`group-${id}-toggle`}
          aria-expanded={!collapsed}
          // Only while the body exists. The body is unmounted when collapsed,
          // so an unconditional `aria-controls` dangles on every closed group.
          aria-controls={collapsed ? undefined : bodyId}
          // The title and the badge are adjacent JSX elements, so no whitespace
          // text node is emitted and the computed name ran them together
          // ("Buildings1/12 heroes"). Visually fine, read aloud wrong.
          aria-label={badge ? `${title}, ${badge}` : title}
          onClick={onToggle}
          className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-plate-raised"
        >
          <Chevron collapsed={collapsed} />
          <span className="flex-1 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink">
            {title}
          </span>
          {badge ? (
            <span className="rounded-milled border border-line bg-plate-sunken px-1.5 py-0.5 text-2xs text-ink-muted">
              {badge}
            </span>
          ) : null}
        </button>
      </h3>
      {collapsed ? null : (
        <div id={bodyId} className="space-y-4 px-4 pb-5">
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
