"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  HANDLE_PX,
  RAIL_PX,
  boundaryPercent,
  boundaryPosition,
  boundaryRange,
  boundaryVisible,
  resolveWidths,
  type Boundary,
  type LayoutState,
} from "@/lib/layout";
import { useLayoutStore } from "@/store/layout";
import { CollapsedRail, collapsedRails } from "./PaneChrome";

/**
 * The three regions and the two dividers between them.
 *
 * ## The model
 *
 * A map, a viewport and a settings column, left to right. The two side
 * regions have widths; the viewport is whatever they leave, which is why there
 * are two boundaries and not three sizes. `lib/layout.ts` owns every rule --
 * the limits, the fit when the row is too narrow, the clamps a drag and an
 * arrow key obey -- so this component measures and renders and decides
 * nothing.
 *
 * ## Nothing is ever unmounted
 *
 * A hidden region is `display:none`, never removed. That is what lets the map
 * keep its WebGL context and the viewport keep its model across a maximize and
 * back: MapLibre and react-three-fiber both watch their container with a
 * ResizeObserver, so a region that comes back resizes itself, and MapLibre's
 * own `_containerDimensions` falls back to 400x300 rather than resizing to
 * zero while it is away. `display:none` also takes the hidden region's
 * controls out of the tab order, which a zero-width column with
 * `overflow:hidden` would not have done.
 *
 * ## Why the children are props
 *
 * The map, the viewport and the settings arrive as elements from
 * `EditorShell`. A drag writes to the layout store on every pointer move, so
 * this component re-renders at pointer rate -- but the three children are the
 * same element objects each time, so React skips their subtrees entirely and a
 * drag never re-renders the map or the 3D scene. That only holds while
 * `EditorShell` itself does not subscribe to the layout store, which is why
 * its keyboard dispatcher reads the layout through `getState()` instead.
 *
 * ## Below `lg`
 *
 * Unchanged from v3: the map and the preview stack, and the settings become a
 * bottom sheet the column reserves height for. Every width here is applied
 * through an `lg:` utility, so none of it reaches that layout, and the handles,
 * the rails and the header's layout controls are all `lg` and up.
 */

interface ResizableRegionsProps {
  map: ReactNode;
  viewport: ReactNode;
  settings: ReactNode;
}

const REGION_IDS = {
  map: "fc-region-map",
  viewport: "fc-region-viewport",
  settings: "fc-region-settings",
} as const;

/** What a handle is called, in the interface's voice and in its accessible name. */
const BOUNDARY_LABEL: Readonly<Record<Boundary, string>> = {
  map: "Resize the map column",
  settings: "Resize the settings column",
};

export function ResizableRegions({ map, viewport, settings }: ResizableRegionsProps) {
  const sizes = useLayoutStore((state) => state.sizes);
  const collapsed = useLayoutStore((state) => state.collapsed);
  const maximized = useLayoutStore((state) => state.maximized);
  const setBoundary = useLayoutStore((state) => state.setBoundary);
  const nudgeBoundary = useLayoutStore((state) => state.nudgeBoundary);
  const resetBoundaryTo = useLayoutStore((state) => state.resetBoundary);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [rowWidth, setRowWidth] = useState(0);
  const [dragging, setDragging] = useState<Boundary | null>(null);
  const rowRef = useRef<HTMLDivElement | null>(null);
  /** The distance between the pointer and the boundary when the drag started, so the divider does not jump under the cursor. */
  const grabRef = useRef<{ boundary: Boundary; offset: number; pointerId: number } | null>(null);

  /*
    The row's own width, measured rather than assumed.

    `window.resize` is not enough: the row also changes width when the browser
    zoom changes, when a scrollbar appears in the settings column, and -- on
    this very component -- when a rail appears or disappears. A ResizeObserver
    is the only thing that sees all of those.
  */
  useEffect(() => {
    const row = rowRef.current;
    if (row === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setRowWidth(entry.contentRect.width);
    });
    observer.observe(row);
    setRowWidth(row.clientWidth);
    return () => observer.disconnect();
  }, []);

  const state: LayoutState = { sizes, collapsed, maximized };
  const rails = collapsedRails(collapsed, maximized);
  const handles: readonly Boundary[] = (["map", "settings"] as const).filter((boundary) =>
    boundaryVisible(state, boundary),
  );
  /*
    What the three regions actually share: the row, minus the dividers and the
    rails standing in for the columns that are away. Subtracting them here is
    what keeps `lib/layout.ts` free of any knowledge of the chrome.
  */
  const available = Math.max(
    0,
    rowWidth - handles.length * HANDLE_PX - rails.length * RAIL_PX,
  );
  const widths = resolveWidths(state, available);

  /** Where the region area starts on screen: the row's left edge, plus a rail standing before it. */
  const areaLeft = (): number => {
    const row = rowRef.current;
    if (row === null) return 0;
    return row.getBoundingClientRect().left + (rails.includes("map") ? RAIL_PX : 0);
  };

  /** The dividers to the left of this one, whose width sits between the row's edge and the boundary. */
  const handlesBefore = (boundary: Boundary): number =>
    boundary === "settings" && handles.includes("map") ? HANDLE_PX : 0;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, boundary: Boundary): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const at = boundaryPosition(widths, boundary);
    grabRef.current = {
      boundary,
      pointerId: event.pointerId,
      offset: event.clientX - areaLeft() - handlesBefore(boundary) - at,
    };
    setDragging(boundary);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const grab = grabRef.current;
    if (grab === null || grab.pointerId !== event.pointerId) return;
    event.preventDefault();
    setBoundary(
      grab.boundary,
      available,
      event.clientX - areaLeft() - handlesBefore(grab.boundary) - grab.offset,
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const grab = grabRef.current;
    if (grab === null || grab.pointerId !== event.pointerId) return;
    grabRef.current = null;
    setDragging(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /**
   * The separator's keys.
   *
   * Arrows nudge, Shift and the page keys nudge further, Home and End go to
   * the two ends of what this boundary may do, and Enter puts it back where it
   * started -- the keyboard's version of double-clicking the divider. Every
   * one of them is `preventDefault`ed, because Home, End and the page keys
   * otherwise scroll the settings column behind the handle.
   */
  const onHandleKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    boundary: Boundary,
  ): void => {
    const range = boundaryRange(state, available, boundary);
    switch (event.key) {
      case "ArrowLeft":
        nudgeBoundary(boundary, available, -1, event.shiftKey);
        break;
      case "ArrowRight":
        nudgeBoundary(boundary, available, 1, event.shiftKey);
        break;
      case "PageUp":
        nudgeBoundary(boundary, available, -1, true);
        break;
      case "PageDown":
        nudgeBoundary(boundary, available, 1, true);
        break;
      case "Home":
        setBoundary(boundary, available, range.min);
        break;
      case "End":
        setBoundary(boundary, available, range.max);
        break;
      case "Enter":
      case " ":
        resetBoundaryTo(boundary);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const handleFor = (boundary: Boundary): ReactNode => {
    if (!handles.includes(boundary)) return null;
    const range = boundaryRange(state, available, boundary);
    const at = boundaryPosition(widths, boundary);
    const percent = boundaryPercent(at, available);
    const name = boundary === "map" ? "Map" : "Settings";
    return (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={BOUNDARY_LABEL[boundary]}
        aria-controls={REGION_IDS[boundary]}
        aria-valuenow={percent}
        aria-valuemin={boundaryPercent(range.min, available)}
        aria-valuemax={boundaryPercent(range.max, available)}
        aria-valuetext={`${name} column ${boundary === "map" ? percent : 100 - percent} percent of the width`}
        tabIndex={0}
        data-testid={`layout-handle-${boundary}`}
        data-dragging={dragging === boundary ? "true" : "false"}
        data-position={Math.round(at)}
        style={{ width: HANDLE_PX }}
        onPointerDown={(event) => onPointerDown(event, boundary)}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        // A capture the browser takes back (the element moving, a context menu,
        // a device disconnecting) would otherwise leave the handle believing a
        // drag is still in flight.
        onLostPointerCapture={endDrag}
        onDoubleClick={() => resetBoundaryTo(boundary)}
        onKeyDown={(event) => onHandleKeyDown(event, boundary)}
        className="hidden shrink-0 grow-0 cursor-col-resize touch-none bg-plate transition-colors hover:bg-accent data-[dragging=true]:bg-accent lg:block"
      />
    );
  };

  const mapFills = maximized === "map";

  return (
    <div
      ref={rowRef}
      data-testid="editor-regions"
      data-maximized={maximized ?? "none"}
      className="flex min-h-0 flex-1 flex-col pb-[var(--fc-sheet-reserve)] transition-[padding] lg:flex-row lg:pb-0"
      // A custom property, not an inline `padding-bottom`: an inline style
      // would beat `lg:pb-0` and reserve space on the desktop layout too,
      // where the panel is a static column and reserves nothing.
      style={{ "--fc-sheet-reserve": sheetOpen ? "42dvh" : "3rem" } as CSSProperties}
    >
      {rails.includes("map") ? <CollapsedRail region="map" /> : null}

      <section
        id={REGION_IDS.map}
        aria-label="Location"
        data-testid="region-map"
        data-visible={widths.visible.map ? "true" : "false"}
        style={{ "--fc-region-w": `${widths.map}px` } as CSSProperties}
        className={`flex min-h-0 shrink-0 flex-col border-b border-line lg:border-b-0 lg:border-r ${
          mapFills ? "lg:min-w-0 lg:flex-1" : "lg:w-[var(--fc-region-w)] lg:shrink-0 lg:grow-0"
        } ${widths.visible.map ? "" : "lg:hidden"}`}
      >
        <div className="h-[20dvh] min-h-28 lg:h-auto lg:min-h-0 lg:flex-1">{map}</div>
      </section>

      {handleFor("map")}

      <section
        id={REGION_IDS.viewport}
        aria-label="Preview"
        data-testid="region-viewport"
        data-visible={widths.visible.viewport ? "true" : "false"}
        className={`flex min-h-0 flex-1 flex-col bg-plate-sunken lg:min-w-0 ${
          widths.visible.viewport ? "" : "lg:hidden"
        }`}
      >
        {viewport}
      </section>

      {handleFor("settings")}

      {/*
        The settings column. Below `lg` it is a fixed bottom sheet the row
        reserves height for; at `lg` it is the third column, and hiding it is
        `lg:hidden` alone so the sheet below `lg` is untouched by a collapse
        that only means something in the three-column layout.
      */}
      <aside
        id={REGION_IDS.settings}
        aria-label="Parameters"
        data-testid="param-sheet"
        data-open={sheetOpen ? "true" : "false"}
        data-visible={widths.visible.settings ? "true" : "false"}
        style={{ "--fc-region-w": `${widths.settings}px` } as CSSProperties}
        className={`fixed inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden border-t border-line bg-plate shadow-lifted transition-[height] lg:static lg:h-auto lg:min-h-0 lg:w-[var(--fc-region-w)] lg:shrink-0 lg:grow-0 lg:border-l lg:border-t-0 lg:shadow-none ${
          sheetOpen ? "h-[42dvh]" : "h-12"
        } ${widths.visible.settings ? "" : "lg:hidden"}`}
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
          <span className="text-2xs text-ink-faint">{sheetOpen ? "Hide" : "Show"}</span>
        </button>
        <div id="param-sheet-body" className="flex min-h-0 flex-1 flex-col">
          {settings}
        </div>
      </aside>

      {rails.includes("settings") ? <CollapsedRail region="settings" /> : null}
    </div>
  );
}

export default ResizableRegions;
