"use client";

import { useEffect, useRef } from "react";

import { jumpToHistory, redoHistory, undoHistory, useHistoryStore } from "@/store/history";

/**
 * The undo/redo chip and history drawer ([V3-P6]).
 *
 * DECISIONS [V3-P6]: the brief that named this widget called it "the existing
 * 'N adjustments made' chip" -- but `AdjustmentsChip` is a settled, tested
 * surface for a completely different kind of remark (widened footprints,
 * dropped patches, the build's own notes; `lib/adjustments.ts`'s
 * site/repair/build grouping), and folding undo history into it would mean
 * either two unrelated concepts sharing one count-and-drawer, or rewriting
 * that module's grouping and every e2e spec that names it. `IssuesBadge`
 * already set the precedent for this exact situation (`[V3-P4-U]`): a THIRD,
 * additive floating chip, same visual language, own store slice
 * (`useHistoryStore`), own drawer. The three sit side by side over the
 * viewport.
 *
 * Undo/redo work with the drawer closed too (the keyboard shortcuts in
 * `EditorShell`, and any future toolbar button) -- this component is only the
 * chip's own affordance for them plus the step list the brief asks for.
 *
 * Rendered in `EditorShell`'s header, NOT inside `CityPreview`'s own
 * top-left chip stack alongside `AdjustmentsChip`/`IssuesBadge`: those two
 * are genuinely about the MODEL and only exist once a scene has been
 * generated (`CityPreview` returns `PreviewEmpty` before that, which never
 * reaches their render branch at all). A parameter change is recorded into
 * history from the very first slider move, before anything has been
 * generated -- so undo has to be reachable then too, which means this chip
 * cannot live behind the same gate.
 */
export function HistoryChip() {
  const entries = useHistoryStore((state) => state.entries);
  const cursor = useHistoryStore((state) => state.cursor);
  const canUndo = useHistoryStore((state) => state.canUndo);
  const canRedo = useHistoryStore((state) => state.canRedo);
  const open = useHistoryStore((state) => state.open);
  const setOpen = useHistoryStore((state) => state.setOpen);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(open);

  // `cursor` IS "how many steps forward from Start we currently are" --
  // entries[0] is the seed "Start" entry, so `cursor` doubles as the count of
  // changes CURRENTLY APPLIED. `entries.length - 1` (the high-water mark of
  // every step ever recorded) looks identical to `cursor` at the tip of
  // history, which is why using it here originally passed every test that
  // never undid anything: the moment a real undo ran, `entries.length` stayed
  // put (undo moves `cursor`, it never shrinks the array) and the chip kept
  // reporting the step count from BEFORE the undo.
  const stepCount = cursor;
  // Whether there is any real history to show the chip for at all -- distinct
  // from `stepCount`, which can legitimately be 0 (undone all the way back to
  // Start) while `entries` still holds real steps a Redo could reach.
  const hasHistory = entries.length > 1;

  // Closes the drawer behind itself only when the chip is about to hide
  // entirely (no history at all) -- NOT every time `stepCount` merely passes
  // through 0 via an undo, which would slam the drawer shut on a user who is
  // mid-undo with it open.
  useEffect(() => {
    if (!hasHistory) setOpen(false);
  }, [hasHistory, setOpen]);

  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closing) return;
    const active = document.activeElement;
    const uninteresting =
      active === null || active === document.body || wrapperRef.current?.contains(active) === true;
    if (uninteresting) buttonRef.current?.focus();
  }, [open]);

  if (!hasHistory) return null;

  return (
    <div ref={wrapperRef} className="pointer-events-auto">
      <button
        ref={buttonRef}
        type="button"
        data-testid="history-chip"
        aria-expanded={open}
        aria-controls={open ? "history-drawer" : undefined}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-milled border border-control bg-plate/95 px-2 py-1 text-2xs text-ink shadow-raised transition-colors hover:border-ink-faint"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
        {stepCount} {stepCount === 1 ? "change" : "changes"}
        <span aria-hidden="true" className="text-ink-faint">
          {open ? "×" : "›"}
        </span>
      </button>

      {open ? (
        <div
          id="history-drawer"
          data-testid="history-drawer"
          role="group"
          aria-label={`${stepCount} ${stepCount === 1 ? "change" : "changes"}`}
          tabIndex={0}
          className="mt-1.5 max-h-72 w-80 max-w-[80vw] overflow-y-auto rounded-plate border border-line bg-plate p-3 shadow-lifted"
        >
          <div className="mb-2 flex gap-2">
            <button
              type="button"
              data-testid="history-undo"
              disabled={!canUndo}
              onClick={() => undoHistory()}
              className="flex-1 rounded-milled border border-control bg-plate-raised px-2 py-1 text-2xs font-medium text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-45"
            >
              Undo
            </button>
            <button
              type="button"
              data-testid="history-redo"
              disabled={!canRedo}
              onClick={() => redoHistory()}
              className="flex-1 rounded-milled border border-control bg-plate-raised px-2 py-1 text-2xs font-medium text-ink transition-colors hover:border-ink-faint disabled:cursor-not-allowed disabled:opacity-45"
            >
              Redo
            </button>
          </div>

          <ul className="space-y-1">
            {entries.map((entry, index) => {
              const current = index === cursor;
              return (
                <li key={`${entry.at}-${index}`}>
                  <button
                    type="button"
                    data-testid="history-item"
                    data-current={current ? "true" : "false"}
                    aria-current={current ? "step" : undefined}
                    disabled={current}
                    onClick={() => jumpToHistory(index)}
                    className={`w-full rounded-milled border px-2 py-1.5 text-left text-2xs leading-snug transition-colors disabled:cursor-default ${
                      current
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-line bg-plate-sunken text-ink-muted hover:border-ink-faint hover:text-ink"
                    }`}
                  >
                    {entry.label}
                    {current ? <span className="ml-1.5 text-ink-faint">(current)</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export default HistoryChip;
