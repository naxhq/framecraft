"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import MapPane from "@/components/map/MapPane";
import PreviewPane from "@/components/scene/PreviewPane";
import { shortcutFor, type TargetLike } from "@/lib/keyboard";
import { SHARE_PARAM } from "@/lib/share";
import { bakeBlockReason } from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";
import ParamPanel from "./ParamPanel";
import PresetRow from "./PresetRow";
import ShortcutSheet from "./ShortcutSheet";
import ThemeToggle from "./ThemeToggle";
import WarningBanners from "./WarningBanners";

/**
 * The editor: the atlas on the left, the workpiece in the middle, the spec
 * sheet on the right.
 *
 * Responsive behaviour (01 puts mobile polish out of scope, so this is about
 * not lying to the user rather than about a phone-first layout):
 *
 *  - **≥ 1024 px** three columns.
 *  - **640–1023 px** map and preview stack, and the parameter panel becomes a
 *    bottom sheet that is closed by default. A 23 rem rail beside a 3D
 *    viewport on a 900 px screen leaves neither of them usable.
 *  - **< 640 px** a plain "this needs a desktop" state. The alternative is a
 *    broken layout that pretends to work; the honest version says what is
 *    needed and what the product does.
 */
export function EditorShell() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /**
   * The shortcut sheet is `aria-modal="true"`, which asserts the rest of the
   * page is inert. It was not: the listener below is on `window`, the dialog
   * panel is not a typing target, so with the sheet open -- the one surface
   * that says "B — Bake the printable model" -- pressing B started a real
   * server bake behind it and R silently reset every parameter, including up
   * to eight engraving lines and twelve picked heroes, with no undo.
   *
   * Read through a ref rather than a dependency so the listener is attached
   * once and never re-bound mid-keystroke.
   */
  const overlayRef = useRef({ sheet: false, drawer: false });
  const adjustmentsOpen = useEditorStore((state) => state.adjustmentsOpen);
  overlayRef.current = { sheet: shortcutsOpen, drawer: adjustmentsOpen };

  const dispatchShortcut = useCallback((event: KeyboardEvent) => {
    const action = shortcutFor({
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      target: event.target as TargetLike | null,
    });
    if (action === null) return;

    const state = useEditorStore.getState();
    const { sheet, drawer } = overlayRef.current;

    // Escape always gets through, and closes what is open, outermost last.
    if (action === "dismiss") {
      if (drawer) state.setAdjustmentsOpen(false);
      if (sheet) setShortcutsOpen(false);
      return;
    }
    // Nothing else acts while an overlay is up. `help` included: the sheet is
    // already open, and re-opening it would be a no-op that hides the fact
    // that the key did nothing.
    if (sheet || drawer) return;

    switch (action) {
      case "generate": {
        // Same rule as the button: nothing to generate when the scene already
        // matches the location.
        if (state.scene.status === "loading") return;
        if (state.scene.status === "ready" && !state.scene.stale) return;
        event.preventDefault();
        void state.generate();
        return;
      }
      case "bake": {
        if (state.bake.phase === "queued" || state.bake.phase === "running") return;
        if (bakeBlockReason(state.scene.graph, state.params) !== null) return;
        event.preventDefault();
        void state.requestBake();
        return;
      }
      case "reset": {
        event.preventDefault();
        state.resetParams();
        return;
      }
      case "help": {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", dispatchShortcut);
    return () => window.removeEventListener("keydown", dispatchShortcut);
  }, [dispatchShortcut]);

  /**
   * A shared configuration in the URL (`?s=v2.…`).
   *
   * Read once, after mount -- the payload cannot be read during render without
   * a hydration mismatch, and it must not be read on the server at all. It
   * restores the location and every PrintParams field and then stops: the scene
   * is marked stale and Generate is the user's move, because generating is a
   * live Overpass query and opening a link in a background tab is not consent
   * to one.
   */
  useEffect(() => {
    const outcome = useEditorStore.getState().loadShared(window.location.search);
    if (outcome !== "refused") return;
    /*
      Take the bad payload back out of the address bar.

      Without this, dismissing the banner and reloading brings the same refusal
      back forever, on what is by then a bookmarked URL -- and the URL still
      claims to carry a configuration the editor is not showing. The banner has
      already said what happened; the address bar should stop repeating it.
      Only on a REFUSAL: an accepted payload is what the page is showing, and
      the user may well want to copy it again.
    */
    const url = new URL(window.location.href);
    url.searchParams.delete(SHARE_PARAM);
    window.history.replaceState(null, "", url.toString());
  }, []);

  return (
    <>
      <DesktopRecommended />

      <div
        data-testid="editor"
        className="hidden h-[calc(100dvh-2.75rem)] flex-col overflow-hidden sm:flex"
      >
        <header className="flex items-center gap-3 border-b border-line bg-plate px-4 py-2">
          <div className="flex items-baseline gap-2">
            <h1 className="font-display text-md font-semibold uppercase tracking-[0.18em] text-ink">
              Framecraft
            </h1>
            <p className="hidden text-2xs text-ink-faint xl:block">
              a place, printed
            </p>
          </div>

          <div className="min-w-0 flex-1 overflow-x-auto">
            <PresetRow />
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              data-testid="shortcuts-button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="Keyboard shortcuts"
              className="rounded-milled border border-control px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
            >
              ?
            </button>
            <ThemeToggle />
          </div>
        </header>

        {/*
          Below `lg` this is a flex column (map above, preview filling what is
          left) and the bottom sheet is `fixed`, so the column has to RESERVE
          the sheet's height. Without that, opening the sheet at 900 px put the
          whole 3D canvas and the spec strip behind it: the user could see the
          model or change it, never both, which is precisely the promise the
          empty state makes ("the preview follows every control instantly").
        */}
        <div
          className="flex min-h-0 flex-1 flex-col pb-[var(--fc-sheet-reserve)] transition-[padding] lg:grid lg:grid-cols-[minmax(0,var(--spacing-atlas))_minmax(0,1fr)_var(--spacing-rail)] lg:pb-0"
          // A custom property, not an inline `padding-bottom`: an inline style
          // would beat `lg:pb-0` and reserve space on the desktop layout too,
          // where the panel is a static column and reserves nothing.
          style={{ "--fc-sheet-reserve": sheetOpen ? "42dvh" : "3rem" } as CSSProperties}
        >
          <section
            aria-label="Location"
            className="flex min-h-0 shrink-0 flex-col border-b border-line lg:shrink lg:border-b-0 lg:border-r"
          >
            <div className="h-[20dvh] min-h-28 lg:h-auto lg:flex-1">
              <MapPane />
            </div>
          </section>

          <section
            aria-label="Preview"
            className="flex min-h-0 flex-1 flex-col bg-plate-sunken"
          >
            <WarningBanners />
            {/*
              `min-h-0`, deliberately no floor: a minimum taller than what is
              left after the sheet's reserve would push the canvas back under
              the sheet, which is the bug this reserve exists to fix.
            */}
            <div className="min-h-0 flex-1 lg:h-auto">
              <PreviewPane />
            </div>
          </section>

          <aside
            aria-label="Parameters"
            data-testid="param-sheet"
            data-open={sheetOpen ? "true" : "false"}
            className={`fixed inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden border-t border-line bg-plate shadow-lifted transition-[height] lg:static lg:h-auto lg:min-h-0 lg:border-l lg:border-t-0 lg:shadow-none ${
              sheetOpen ? "h-[42dvh]" : "h-12"
            }`}
          >
            <button
              type="button"
              data-testid="param-sheet-toggle"
              aria-expanded={sheetOpen}
              aria-controls="param-sheet-body"
              onClick={() => setSheetOpen((value) => !value)}
              className="flex h-12 shrink-0 items-center justify-between px-4 text-left lg:hidden"
            >
              <span className="font-display text-2xs font-semibold uppercase tracking-[0.16em] text-ink">
                Model parameters
              </span>
              <span className="text-2xs text-ink-faint">
                {sheetOpen ? "Hide" : "Show"}
              </span>
            </button>
            <div id="param-sheet-body" className="min-h-0 flex-1">
              <ParamPanel />
            </div>
          </aside>
        </div>
      </div>

      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </>
  );
}

/**
 * Under 640 px. Not an apology and not a dead end: it says what the product
 * does, what it needs, and leaves the OSM attribution in the footer intact.
 */
function DesktopRecommended() {
  return (
    <div
      data-testid="desktop-recommended"
      className="fc-drafting-sheet flex min-h-[calc(100dvh-2.75rem)] flex-col items-center justify-center gap-3 px-6 text-center sm:hidden"
    >
      <h1 className="font-display text-xl font-semibold uppercase tracking-[0.16em] text-ink">
        Framecraft
      </h1>
      <p className="max-w-xs text-sm text-ink-muted">
        FrameCraft turns a map location into a 3D-printable framed miniature
        city. It needs a wider screen: a map, a live 3D preview and around
        thirty controls have to be visible at once.
      </p>
      <p className="max-w-xs text-2xs text-ink-faint">
        Open it on a laptop or desktop, 640 px wide or more.
      </p>
    </div>
  );
}

export default EditorShell;
