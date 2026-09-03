"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import MapPane from "@/components/map/MapPane";
import PreviewPane from "@/components/scene/PreviewPane";
import { scheduleReverseGeocode } from "@/lib/geocode";
import { shortcutFor, type TargetLike } from "@/lib/keyboard";
import { SHARE_PARAM } from "@/lib/share";
import { exportBlockReason } from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";
import { initHistory, redoHistory, undoHistory, useHistoryStore } from "@/store/history";
import { hydrateLayout, useLayoutStore } from "@/store/layout";
import ActionBar from "./ActionBar";
import HistoryChip from "./HistoryChip";
import { LayoutControls } from "./PaneChrome";
import ParamPanel from "./ParamPanel";
import PresetRow from "./PresetRow";
import ResizableRegions from "./ResizableRegions";
import ShortcutSheet from "./ShortcutSheet";
import ThemeToggle from "./ThemeToggle";
import WarningBanners from "./WarningBanners";

/**
 * The editor: the atlas on the left, the workpiece in the middle, the spec
 * sheet on the right.
 *
 * The three regions, their sizes and everything that hides or maximizes one
 * live in `ResizableRegions` and `lib/layout.ts`; what stays here is the
 * header, the keyboard, the four things that have to happen once after mount,
 * and the small-screen states.
 *
 * Responsive behaviour (01 puts mobile polish out of scope, so this is about
 * not lying to the user rather than about a phone-first layout):
 *
 *  - **≥ 1024 px** three columns, resizable, either side hideable, the map or
 *    the preview able to take the whole window.
 *  - **640–1023 px** map and preview stack, and the parameter panel becomes a
 *    bottom sheet that is closed by default. A 23 rem rail beside a 3D
 *    viewport on a 900 px screen leaves neither of them usable, and neither
 *    does a divider between two things that are not side by side.
 *  - **< 640 px** a plain "this needs a desktop" state. The alternative is a
 *    broken layout that pretends to work; the honest version says what is
 *    needed and what the product does.
 *
 * This component deliberately does NOT subscribe to the layout store. A drag
 * writes a new width on every pointer move, and a re-render here would rebuild
 * the three region elements and take the map and the 3D scene down with them
 * on every frame of the drag. The keyboard dispatcher reads the layout through
 * `getState()` for the same reason it reads the editor store that way.
 */
export function EditorShell() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  /**
   * The shortcut sheet is `aria-modal="true"`, which asserts the rest of the
   * page is inert. It was not: the listener below is on `window`, the dialog
   * panel is not a typing target, so with the sheet open -- the one surface
   * that says "B — Export the model file" -- pressing B started a real
   * export behind it and R silently reset every parameter, including up
   * to eight engraving lines and twelve picked heroes, with no undo.
   *
   * Read through a ref rather than a dependency so the listener is attached
   * once and never re-bound mid-keystroke.
   */
  const overlayRef = useRef({ sheet: false, drawer: false, issues: false, history: false });
  const adjustmentsOpen = useEditorStore((state) => state.adjustmentsOpen);
  const issuesOpen = useEditorStore((state) => state.issuesOpen);
  const historyOpen = useHistoryStore((state) => state.open);
  const setHistoryOpen = useHistoryStore((state) => state.setOpen);
  overlayRef.current = {
    sheet: shortcutsOpen,
    drawer: adjustmentsOpen,
    issues: issuesOpen,
    history: historyOpen,
  };

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
    const { sheet, drawer, issues, history } = overlayRef.current;

    // Escape always gets through, and closes what is open, outermost last.
    //
    // With NOTHING open it is the cancel key: a run in flight stops at its next
    // stage boundary and the model on screen stays exactly where it is. The
    // overlay rule is kept rather than bypassed -- Escape with a drawer up is a
    // request to close the drawer, not to abandon a build the user cannot even
    // see behind it -- so the cancel is the ELSE branch, never both at once.
    if (action === "dismiss") {
      if (drawer || issues || history || sheet) {
        if (drawer) state.setAdjustmentsOpen(false);
        if (issues) state.setIssuesOpen(false);
        if (history) setHistoryOpen(false);
        if (sheet) setShortcutsOpen(false);
        return;
      }
      if (state.pipeline.status === "running") {
        event.preventDefault();
        state.cancelPipeline();
      }
      return;
    }
    // Undo/redo are exempt from the "nothing else acts while an overlay is
    // up" rule below: Ctrl+Z with the shortcut sheet or the Issues drawer open
    // is still a request to undo, not a request that got swallowed by
    // whatever else happens to be on screen.
    if (action === "undo") {
      undoHistory();
      return;
    }
    if (action === "redo") {
      redoHistory();
      return;
    }
    // Nothing else acts while an overlay is up. `help` included: the sheet is
    // already open, and re-opening it would be a no-op that hides the fact
    // that the key did nothing.
    if (sheet || drawer || issues || history) return;

    // The layout keys. Read through `getState()` so this component never
    // subscribes to the layout store: it renders the three regions, and a
    // re-render of it on every frame of a divider drag would take the map's GL
    // context and the 3D scene with it.
    switch (action) {
      case "maximize-map":
        event.preventDefault();
        useLayoutStore.getState().toggleMaximized("map");
        return;
      case "maximize-viewport":
        event.preventDefault();
        useLayoutStore.getState().toggleMaximized("viewport");
        return;
      case "collapse-map":
        event.preventDefault();
        useLayoutStore.getState().toggleCollapsed("map");
        return;
      case "collapse-settings":
        event.preventDefault();
        useLayoutStore.getState().toggleCollapsed("settings");
        return;
    }

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
      case "export": {
        if (state.exportState.phase === "exporting") return;
        if (exportBlockReason(state.scene.graph, state.params) !== null) return;
        event.preventDefault();
        void state.requestExport();
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
  }, [setHistoryOpen]);

  useEffect(() => {
    window.addEventListener("keydown", dispatchShortcut);
    return () => window.removeEventListener("keydown", dispatchShortcut);
  }, [dispatchShortcut]);

  /**
   * This browser's own layout, adopted after mount.
   *
   * Declared BEFORE the share-link effect below, and React runs effects in
   * declaration order, so a link that carries a layout wins over the one this
   * device happened to have: the point of shipping the layout in a payload is
   * that a shared design opens the way its author framed it.
   *
   * After mount rather than during render, for the reason every other
   * `localStorage` read in this app is: the server has no storage, renders the
   * default, and a client that read storage during its first render would be a
   * hydration mismatch.
   */
  useEffect(() => {
    hydrateLayout();
  }, []);

  /**
   * A shared configuration in the URL (`?s=v3.…`, a v2 link from before
   * [V3-P6] still restores too -- `lib/share.ts:decodeShare`).
   *
   * Read once, after mount -- the payload cannot be read during render without
   * a hydration mismatch, and it must not be read on the server at all. It
   * restores the location and every PrintParams field and then stops: the scene
   * is marked stale and Preview is the user's move, because previewing is a
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

  /** Prefill the Author field from localStorage, once, after mount. */
  useEffect(() => {
    useEditorStore.getState().initAuthor();
  }, []);

  /**
   * Start recording undo/redo history, once, after mount -- and, by React's
   * own "effects run in declaration order" rule, after the share-link effect
   * above has already applied (or refused) whatever `?s=` named. A restored
   * link therefore becomes the STARTING point of history, not an undoable
   * step over the plain Chicago default nobody watching the page ever saw
   * rendered: the first thing a keyboard-only Ctrl+Z can reach is the
   * restored configuration itself, which is the state the user actually
   * opened.
   */
  useEffect(() => {
    initHistory();
  }, []);

  /**
   * `{city}` for a location that is not a preset: a debounced Nominatim
   * reverse geocode, kept running here rather than inside a collapsible group
   * so it fires even while the Location group is folded shut (DECISIONS
   * [V3-P1]).
   *
   * A preset already knows its own city name client-side (`lib/presets.ts`)
   * and needs no network round trip at all -- `preset_id !== null` skips this
   * entirely, so clicking a preset chip never touches Nominatim.
   */
  const lat = useEditorStore((state) => state.location.lat);
  const lon = useEditorStore((state) => state.location.lon);
  const presetId = useEditorStore((state) => state.location.preset_id);
  useEffect(() => {
    if (presetId !== null) return undefined;
    return scheduleReverseGeocode(lat, lon, (result, resultLat, resultLon) => {
      useEditorStore.getState().applyGeocodeResult(resultLat, resultLon, result);
    });
  }, [lat, lon, presetId]);

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
            {/*
              The layout controls sit with the other window chrome, not inside
              the panes they act on: the button that brings a hidden column
              back cannot live in the column that is hidden, and a fixed
              cluster is the one place a user can look for it before knowing
              it exists.
            */}
            <LayoutControls />
            {/*
              [V3-P6]: undo/redo lives in the header, not inside
              `CityPreview`'s scene-gated chip stack -- a parameter change is
              recorded into history from the very first slider move, before
              anything has ever been generated, so this has to be reachable
              then too.
            */}
            <HistoryChip />
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
          The three regions. `ResizableRegions` owns the row, its dividers, the
          rails a hidden column leaves behind, and the bottom-sheet behaviour
          below `lg`.

          The SETTINGS column's slots are stated here and nowhere else, because
          the promise is about this order and not about any one component:
          the action bar first, fixed, outside anything that scrolls, and then
          the panel, which holds the scrolling groups and pins the results
          under them. Preview and Export are the two things the whole editor
          exists to do, and inside `ParamPanel` they sat under a results block
          that grew and shrank with every run. Here nothing below them can move
          them, which `e2e/shell.spec.ts` measures across a run, a refusal and
          a finished export rather than asserting.
        */}
        <ResizableRegions
          map={<MapPane />}
          viewport={
            <>
              <WarningBanners />
              {/*
                `min-h-0`, deliberately no floor: a minimum taller than what is
                left after the sheet's reserve would push the canvas back under
                the sheet, which is the bug that reserve exists to fix.
              */}
              <div className="min-h-0 flex-1 lg:h-auto">
                <PreviewPane />
              </div>
            </>
          }
          settings={
            <>
              <ActionBar />
              <div className="min-h-0 flex-1" data-testid="settings-panel-slot">
                <ParamPanel />
              </div>
            </>
          }
        />
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
