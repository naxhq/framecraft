"use client";

import { useEffect, useState } from "react";

import { decodeShare } from "@/lib/share";
import { RECENT_CHANGED_EVENT, clearRecent, listRecent, type RecentDesign } from "@/lib/recent";
import { useEditorStore } from "@/store/editor";

/**
 * Recent designs: every successful bake or Copy-link recorded a `{name,
 * savedAt, payload}` (`lib/recent.ts`), and this is where they come back
 * ([V3-P6]). Restoring one runs the exact same `decodeShare` a shared link
 * uses -- a recent entry IS a share payload, so the two can never disagree
 * about what it means or how untrusted input is validated.
 *
 * Read from `localStorage` after mount, not during render: SSR has no
 * storage, and reading it during render would be a hydration mismatch (the
 * same discipline `lib/groups.ts`'s collapse state already follows).
 */
export function RecentDesigns() {
  const [list, setList] = useState<RecentDesign[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setList(listRecent());
    // A bake or a Copy-link elsewhere on the page (`OutputPanel.tsx`) writes
    // through `lib/recent.ts`, which fires this event -- the cheapest way to
    // notice without a shared store slice for a list that is, by design,
    // just a mirror of localStorage.
    const onChanged = (): void => setList(listRecent());
    window.addEventListener(RECENT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(RECENT_CHANGED_EVENT, onChanged);
  }, []);

  if (list.length === 0) return null;

  const restore = (entry: RecentDesign): void => {
    const decoded = decodeShare(entry.payload);
    if (!decoded.ok) {
      // A corrupted localStorage entry (or one from a since-changed schema):
      // named through the same share-notice banner a bad link already uses,
      // rather than a second error surface for the same kind of failure.
      useEditorStore.getState().setShareNotice(decoded.reason);
      return;
    }
    useEditorStore.getState().applyShared(decoded.request, decoded.params);
  };

  const clear = (): void => {
    clearRecent();
    setList([]);
    setOpen(false);
  };

  return (
    <div className="space-y-1.5" data-testid="recent-designs">
      <button
        type="button"
        data-testid="recent-designs-toggle"
        aria-expanded={open}
        aria-controls={open ? "recent-designs-list" : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 rounded-milled px-1 py-1 text-left transition-colors hover:bg-plate-raised"
      >
        <span className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Recent ({list.length})
        </span>
        <span aria-hidden="true" className="text-2xs text-ink-faint">
          {open ? "hide" : "show"}
        </span>
      </button>

      {open ? (
        <div id="recent-designs-list" className="space-y-1.5">
          <ul className="space-y-1">
            {list.map((entry) => (
              <li key={entry.payload} className="flex items-center gap-1.5">
                <button
                  type="button"
                  data-testid="recent-design-item"
                  onClick={() => restore(entry)}
                  className="min-w-0 flex-1 truncate rounded-milled border border-line bg-plate-sunken px-2 py-1 text-left text-2xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
                  title={entry.name}
                >
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-testid="recent-designs-clear"
            onClick={clear}
            className="rounded-milled px-1.5 py-0.5 text-2xs text-ink-faint transition-colors hover:bg-plate-raised hover:text-ink"
          >
            Clear recent designs
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default RecentDesigns;
