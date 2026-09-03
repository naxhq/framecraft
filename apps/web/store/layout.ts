/**
 * The shell's layout, as its own store.
 *
 * Its own store, and not a slice of `store/editor.ts`, for one reason that
 * DECISIONS `[V3.1-O6]` states and three that follow from it: the layout is
 * not a print parameter. It must not hash into a pipeline stage, it must not
 * count as a change from default in the settings diff, and it must not be an
 * undoable step -- `store/history.ts` snapshots the editor store's location
 * and params, so a layout that lived there would put "you made the map wider"
 * on the undo stack between two real edits.
 *
 * Every mutation writes the result straight to `localStorage` (per device,
 * `lib/layout.ts:storeLayout`). There is no debounce: a drag calls
 * `setBoundary` on every pointer move, and a `localStorage` write of a
 * four-key object measured under 0.05 ms, which is two orders of magnitude
 * inside the frame it is already spending on the layout itself.
 *
 * The store starts on `DEFAULT_LAYOUT` and adopts the stored value in
 * `hydrateLayout()`, called from an effect after mount. Reading storage during
 * render would be a hydration mismatch: the server has no `localStorage` and
 * renders the default, so the first client paint has to as well.
 */

import { create } from "zustand";

import {
  DEFAULT_LAYOUT,
  KEYBOARD_STEP_LARGE_PX,
  KEYBOARD_STEP_PX,
  layoutFromPayload,
  layoutPayload,
  loadStoredLayout,
  moveBoundary,
  resetBoundary,
  sameLayout,
  setBoundaryPosition,
  setCollapsed,
  setMaximized,
  storeLayout,
  toggleCollapsed,
  toggleMaximized,
  type Boundary,
  type LayoutPayload,
  type LayoutState,
  type MaximizedRegion,
  type SideRegion,
} from "@/lib/layout";

export interface LayoutStore extends LayoutState {
  /** Put a boundary at an absolute position inside the region area: a pointer drag. */
  setBoundary: (boundary: Boundary, available: number, position: number) => void;
  /** Nudge a boundary: one arrow press, or `large` for Shift+arrow and Page Up/Down. */
  nudgeBoundary: (
    boundary: Boundary,
    available: number,
    direction: -1 | 1,
    large?: boolean,
  ) => void;
  /** One boundary back to its default, leaving the other alone: a double-click, or Enter on the handle. */
  resetBoundary: (boundary: Boundary) => void;
  setCollapsed: (region: SideRegion, collapsed: boolean) => void;
  toggleCollapsed: (region: SideRegion) => void;
  setMaximized: (region: MaximizedRegion) => void;
  toggleMaximized: (region: "map" | "viewport") => void;
  /** The whole layout back to the default. */
  reset: () => void;
  /** Adopt a layout wholesale: the stored one at startup, or a payload a project file or a link carried. */
  adopt: (state: LayoutState) => void;
}

/** One place that writes: every action goes through here, so nothing can move the layout without persisting it. */
function commit(
  set: (partial: Partial<LayoutStore>) => void,
  get: () => LayoutStore,
  next: LayoutState,
): void {
  const current = get();
  if (sameLayout(current, next)) return;
  storeLayout(next);
  set({ sizes: next.sizes, collapsed: next.collapsed, maximized: next.maximized });
}

/** The plain layout inside the store, without the actions. */
function plain(store: LayoutStore): LayoutState {
  return { sizes: store.sizes, collapsed: store.collapsed, maximized: store.maximized };
}

export const useLayoutStore = create<LayoutStore>()((set, get) => ({
  ...DEFAULT_LAYOUT,

  setBoundary: (boundary, available, position) =>
    commit(set, get, setBoundaryPosition(plain(get()), available, boundary, position)),

  nudgeBoundary: (boundary, available, direction, large = false) =>
    commit(
      set,
      get,
      moveBoundary(
        plain(get()),
        available,
        boundary,
        direction * (large ? KEYBOARD_STEP_LARGE_PX : KEYBOARD_STEP_PX),
      ),
    ),

  resetBoundary: (boundary) => commit(set, get, resetBoundary(plain(get()), boundary)),

  setCollapsed: (region, collapsed) =>
    commit(set, get, setCollapsed(plain(get()), region, collapsed)),

  toggleCollapsed: (region) => commit(set, get, toggleCollapsed(plain(get()), region)),

  setMaximized: (region) => commit(set, get, setMaximized(plain(get()), region)),

  toggleMaximized: (region) => commit(set, get, toggleMaximized(plain(get()), region)),

  reset: () => commit(set, get, DEFAULT_LAYOUT),

  adopt: (state) => commit(set, get, state),
}));

/** The layout this browser last had. Called once, from an effect, after mount. */
export function hydrateLayout(): void {
  useLayoutStore.getState().adopt(loadStoredLayout());
}

/**
 * The current layout as a payload, or `null` when it is the default.
 *
 * This is what `lib/share.ts` and `lib/project.ts` write by default, so a link
 * or a project file carries the layout its author was looking at without
 * either of those modules having to be handed it by a component. A default
 * layout writes nothing at all, which is what keeps a default link byte for
 * byte what it was before this feature existed.
 */
export function currentLayoutPayload(): LayoutPayload | null {
  return layoutPayload(plain(useLayoutStore.getState()));
}

/**
 * Restore a layout a document named. Returns whether anything was adopted.
 *
 * Called by the two readers (`decodeShare`, `parseProject`) when, and only
 * when, the payload actually carries a layout block: a link or a file written
 * before this feature, or by an author who never moved a boundary, leaves this
 * browser's own layout exactly where it was.
 */
export function adoptLayoutPayload(payload: unknown): boolean {
  const state = layoutFromPayload(payload);
  if (state === null) return false;
  useLayoutStore.getState().adopt(state);
  return true;
}

/** Reset the store itself, for a test that needs a clean layout between cases. */
export function resetLayoutStore(): void {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT });
}
