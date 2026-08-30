"use client";

import { useEffect, useRef } from "react";

import { SHORTCUTS } from "@/lib/keyboard";

/**
 * The `?` sheet.
 *
 * A real modal: `role="dialog"` + `aria-modal`, focus moved into it on open and
 * returned to whatever opened it on close, Escape and a backdrop click both
 * dismiss it, and Tab is kept inside. Without the focus return, pressing `?`
 * from a slider and closing again would drop the user back at the top of the
 * document, which is the sort of thing that makes a keyboard user give up.
 */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    panelRef.current?.focus();
    return () => {
      returnFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      data-testid="shortcut-sheet"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bench/80 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-sheet-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = panelRef.current?.querySelectorAll<HTMLElement>("button");
          if (!focusable || focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="w-full max-w-sm rounded-panel border border-line bg-plate p-5 shadow-lifted"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2
              id="shortcut-sheet-title"
              className="font-display text-md font-semibold tracking-tight text-ink"
            >
              Keyboard
            </h2>
            <p className="mt-0.5 text-2xs text-ink-faint">
              Shortcuts are ignored while you are typing in a field.
            </p>
          </div>
          <button
            type="button"
            data-testid="shortcut-sheet-close"
            onClick={onClose}
            aria-label="Close the keyboard shortcuts"
            className="rounded-milled border border-control px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
          >
            Close
          </button>
        </div>

        <dl className="space-y-2">
          {SHORTCUTS.map((shortcut) => (
            <div
              key={`${shortcut.keys}-${shortcut.action}`}
              className="flex items-baseline justify-between gap-4"
            >
              <dt>
                <kbd className="rounded-milled border border-control bg-plate-raised px-1.5 py-0.5 text-2xs text-ink">
                  {shortcut.keys}
                </kbd>
              </dt>
              <dd className="flex-1 text-right text-2xs text-ink-muted">
                {shortcut.description}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export default ShortcutSheet;
