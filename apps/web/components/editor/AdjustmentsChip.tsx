"use client";

import { useEffect, useRef } from "react";

import {
  adjustmentsLabel,
  groupAdjustments,
  type Adjustment,
} from "@/lib/adjustments";
import { useEditorStore } from "@/store/editor";

/**
 * One chip, one drawer.
 *
 * The editor used to stack every non-blocking remark as its own line of orange
 * text: six of them on a normal Chicago scene, all shouting equally, none
 * actionable. They are now counted into a single chip -- "7 adjustments made"
 * -- that opens a grouped, scrollable drawer. Nothing is hidden, but nothing
 * competes with the model either.
 *
 * The blocking warnings are NOT in here (`components/editor/WarningBanners`
 * keeps those on screen): a reason a button is disabled is not a footnote.
 *
 * Two things the audit caught, both about Escape and focus:
 *
 *  - the open flag lives in the STORE, so `EditorShell`'s global dismiss can
 *    close the drawer whatever has focus. It used to be a React `onKeyDown` on
 *    this component's wrapper, which meant Escape worked only while focus was
 *    still on the chip -- while the shortcut sheet advertised "Esc — close the
 *    drawer, sheet or dialog";
 *  - closing returns focus to the chip, but only when focus is somewhere
 *    uninteresting (the body, or inside this widget). Stealing focus back from
 *    a slider the user has since tabbed to would be its own bug.
 */
export function AdjustmentsChip({ adjustments }: { adjustments: Adjustment[] }) {
  const open = useEditorStore((state) => state.adjustmentsOpen);
  const setOpen = useEditorStore((state) => state.setAdjustmentsOpen);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(open);

  const count = adjustments.length;

  // A scene with nothing to report closes the drawer behind itself.
  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count, setOpen]);

  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closing) return;
    const active = document.activeElement;
    const uninteresting =
      active === null ||
      active === document.body ||
      wrapperRef.current?.contains(active) === true;
    if (uninteresting) buttonRef.current?.focus();
  }, [open]);

  if (count === 0) return null;
  const sections = groupAdjustments(adjustments);

  return (
    <div ref={wrapperRef} className="pointer-events-auto">
      <button
        ref={buttonRef}
        type="button"
        data-testid="adjustments-chip"
        aria-expanded={open}
        aria-controls={open ? "adjustments-drawer" : undefined}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-milled border border-control bg-plate/95 px-2 py-1 text-2xs text-ink shadow-raised transition-colors hover:border-ink-faint"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warn" />
        {adjustmentsLabel(count)}
        <span aria-hidden="true" className="text-ink-faint">
          {open ? "×" : "›"}
        </span>
      </button>

      {open ? (
        /*
          `tabIndex={0}` is not decoration: this is an `overflow-y: auto` region
          with a 256 px cap and no focusable children, so the moment there is
          enough to say to make it scroll, a keyboard-only user could not reach
          the bottom -- and axe's `scrollable-region-focusable` rule (serious)
          would fail the a11y gate. Chicago produces two items and never
          scrolls, which is why nothing caught it.
        */
        <div
          id="adjustments-drawer"
          data-testid="adjustments-drawer"
          role="group"
          aria-label={adjustmentsLabel(count)}
          tabIndex={0}
          className="mt-1.5 max-h-64 w-80 max-w-[80vw] overflow-y-auto rounded-plate border border-line bg-plate p-3 shadow-lifted"
        >
          <div className="space-y-3">
            {sections.map((section) => (
              <section key={section.group} data-testid={`adjustments-${section.group}`}>
                {/*
                  h2, not h4: the drawer opens over the viewport, whose nearest
                  ancestor heading is the h1 wordmark, and axe's heading-order
                  rule is right that skipping two levels is a defect.
                */}
                <h2 className="mb-1 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {section.title}
                </h2>
                <ul className="space-y-1">
                  {section.items.map((item) => (
                    <li
                      key={item.id}
                      data-testid="adjustment-item"
                      className="flex gap-1.5 text-2xs leading-snug text-ink-muted"
                    >
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                          item.tone === "warn" ? "bg-warn" : "bg-line-strong"
                        }`}
                      />
                      <span>{item.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default AdjustmentsChip;
