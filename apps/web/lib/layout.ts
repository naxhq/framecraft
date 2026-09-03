/**
 * The editor's three regions: how wide each one is, which of them are on
 * screen, and where those answers are kept.
 *
 * The shell is a map, a viewport and a settings column. Until v3.1 all three
 * were fixed: two design tokens (`--spacing-atlas`, `--spacing-rail`) and
 * whatever was left in the middle. That is fine on one screen size and wrong
 * on every other one, and it gave the user no way to say "I am picking a
 * place, give the map the room" or "I am reading the numbers, give the
 * settings the room".
 *
 * What this module owns, and why it is a module rather than component state:
 *
 *  - **Sizes are pixels, not fractions.** A fraction re-reads as a different
 *    column on every screen, so a settings rail sized to fit its widest slider
 *    on a laptop becomes unusable on a 4K display and vice versa. Pixels are
 *    what the user actually dragged, and the fit rules below are what keep
 *    them honest on a narrower row. The two defaults mirror the design tokens
 *    exactly (25rem and 23rem at a 16px root), which `layout.test.ts` reads
 *    out of `app/globals.css` and asserts, so the token file stays the source
 *    of the default and this file stays the source of the behaviour.
 *  - **Every rule is a pure function of (state, available width).** The
 *    component measures; this module decides. That is what makes the fit
 *    rules, the drag clamps and the keyboard steps testable without a DOM.
 *  - **Layout is not a print parameter** (DECISIONS `[V3.1-O6]`). Nothing here
 *    touches `PrintParams`, so it cannot hash into a pipeline stage and cannot
 *    count as a change from default in the settings diff. It rides in a
 *    project file and a permalink as its own block, and it is kept per device
 *    in `localStorage`.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The three regions, left to right. */
export type RegionId = "map" | "viewport" | "settings";

/** The two regions that can be collapsed away: the ones with an edge to hide against. */
export type SideRegion = "map" | "settings";

/** The region filling the whole row, or `null` for the three-column layout. */
export type MaximizedRegion = "map" | "viewport" | null;

/**
 * A draggable boundary, named for the region on its outer side.
 *
 * `"map"` is the divider between the map and the viewport; `"settings"` is the
 * one between the viewport and the settings. The viewport has no size of its
 * own -- it is whatever the two boundaries leave -- which is why there are two
 * boundaries and not three sizes.
 */
export type Boundary = SideRegion;

export interface LayoutSizes {
  readonly map: number;
  readonly settings: number;
}

export interface CollapsedRegions {
  readonly map: boolean;
  readonly settings: boolean;
}

export interface LayoutState {
  readonly sizes: LayoutSizes;
  readonly collapsed: CollapsedRegions;
  readonly maximized: MaximizedRegion;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Below these a region stops being usable rather than merely small.
 *
 * The map minimum is roughly the width at which MapLibre's own attribution
 * control and the radius square still read; the settings minimum is the
 * narrowest a slider row plus its numeric readout survives without wrapping
 * every label; the viewport minimum is where the 3D model stops being a
 * preview and becomes a thumbnail.
 */
export const REGION_MIN_PX: Readonly<Record<RegionId, number>> = {
  map: 240,
  viewport: 320,
  settings: 288,
};

/**
 * Above these a side column is taking room from the thing the product is for.
 * The viewport has no maximum: it is the middle, and the middle gets the rest.
 */
export const REGION_MAX_PX: Readonly<Record<SideRegion, number>> = {
  map: 720,
  settings: 560,
};

/**
 * The default widths, in pixels, mirroring `--spacing-atlas` (25rem) and
 * `--spacing-rail` (23rem) at a 16px root. `layout.test.ts` parses those two
 * declarations out of `app/globals.css` and fails if this drifts from them.
 */
export const DEFAULT_SIZES: LayoutSizes = { map: 400, settings: 368 };

export const DEFAULT_LAYOUT: LayoutState = {
  sizes: DEFAULT_SIZES,
  collapsed: { map: false, settings: false },
  maximized: null,
};

/** The drag handle's own width, and the collapsed rail's. Applied as an inline width so this file is the only place either number lives. */
export const HANDLE_PX = 6;
export const RAIL_PX = 28;

/** One arrow press on a focused handle, and one Shift+arrow / PageUp / PageDown. */
export const KEYBOARD_STEP_PX = 16;
export const KEYBOARD_STEP_LARGE_PX = 64;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** One region's stated width, held inside its own limits. Rounded, because a fractional column width is a blurry border. */
export function clampSize(region: SideRegion, px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_SIZES[region];
  return Math.round(clamp(px, REGION_MIN_PX[region], REGION_MAX_PX[region]));
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export type RegionVisibility = Readonly<Record<RegionId, boolean>>;

/**
 * Which regions are on screen.
 *
 * A maximized region is the only visible one; otherwise the two side regions
 * answer for themselves and the viewport is always there. Nothing here
 * unmounts anything: `ResizableRegions` hides an invisible region with
 * `display:none`, so the map keeps its WebGL context and the viewport keeps
 * its model across a maximize and back.
 */
export function visibleRegions(state: LayoutState): RegionVisibility {
  if (state.maximized !== null) {
    return {
      map: state.maximized === "map",
      viewport: state.maximized === "viewport",
      settings: false,
    };
  }
  return {
    map: !state.collapsed.map,
    viewport: true,
    settings: !state.collapsed.settings,
  };
}

/** Whether a boundary is draggable right now: both regions it separates have to be on screen. */
export function boundaryVisible(state: LayoutState, boundary: Boundary): boolean {
  const visible = visibleRegions(state);
  return visible.viewport && visible[boundary];
}

// ---------------------------------------------------------------------------
// Fitting the row
// ---------------------------------------------------------------------------

export interface ResolvedWidths {
  readonly map: number;
  readonly viewport: number;
  readonly settings: number;
  readonly visible: RegionVisibility;
  /** The width the three regions share, i.e. the row minus its handles and rails. */
  readonly available: number;
}

/**
 * The width each region actually gets, given the room there is.
 *
 * `available` is the row width MINUS the handles and the collapsed rails, so
 * the three numbers this returns sum to exactly `available` and the caller can
 * hand them straight to the layout.
 *
 * Three rules, in order:
 *
 *  1. A maximized region takes everything.
 *  2. Otherwise each visible side region takes its stated width, held inside
 *     its own limits.
 *  3. If that leaves the viewport under its minimum, the side regions give
 *     the difference back in proportion to how much slack each one has above
 *     ITS minimum -- so a 900 px map and a 300 px settings column shrink by
 *     wildly different amounts, which is what "give the room back to the
 *     middle" has to mean when one side is already at its floor. If both are
 *     at their floors and the row is still too narrow, the viewport goes under
 *     its minimum: there is nothing left to take, and refusing to render is
 *     not an option.
 *
 * `available <= 0` means "not measured yet" (the server render, and the first
 * client paint before the ResizeObserver has reported). The stated widths are
 * returned unfitted, which is exactly what the server rendered, so hydration
 * matches.
 */
export function resolveWidths(state: LayoutState, available: number): ResolvedWidths {
  const visible = visibleRegions(state);
  const measured = Number.isFinite(available) && available > 0;

  if (state.maximized !== null) {
    const whole = measured ? Math.round(available) : 0;
    return {
      map: state.maximized === "map" ? whole : 0,
      viewport: state.maximized === "viewport" ? whole : 0,
      settings: 0,
      visible,
      available: measured ? Math.round(available) : 0,
    };
  }

  let map = visible.map ? clampSize("map", state.sizes.map) : 0;
  let settings = visible.settings ? clampSize("settings", state.sizes.settings) : 0;

  if (!measured) {
    return { map, viewport: 0, settings, visible, available: 0 };
  }

  const room = Math.round(available);
  const overflow = map + settings + REGION_MIN_PX.viewport - room;
  if (overflow > 0) {
    const mapSlack = visible.map ? Math.max(0, map - REGION_MIN_PX.map) : 0;
    const settingsSlack = visible.settings ? Math.max(0, settings - REGION_MIN_PX.settings) : 0;
    const slack = mapSlack + settingsSlack;
    if (slack > 0) {
      const give = Math.min(overflow, slack);
      const fromMap = Math.round((give * mapSlack) / slack);
      map -= fromMap;
      settings -= give - fromMap;
    }
  }

  // A row narrower than the two floors plus nothing: the side regions still
  // cannot exceed the row itself, or the viewport would get a negative width.
  if (map + settings > room) {
    const scale = room / (map + settings);
    map = Math.floor(map * scale);
    settings = Math.floor(settings * scale);
  }

  return {
    map,
    viewport: Math.max(0, room - map - settings),
    settings,
    visible,
    available: room,
  };
}

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

/**
 * Where a boundary sits, in pixels from the left edge of the region area.
 *
 * The map boundary is the map's own right edge; the settings boundary is the
 * settings column's left edge, which is everything else.
 */
export function boundaryPosition(widths: ResolvedWidths, boundary: Boundary): number {
  return boundary === "map" ? widths.map : widths.map + widths.viewport;
}

export interface BoundaryRange {
  readonly min: number;
  readonly max: number;
}

/**
 * How far a boundary may travel, with the OTHER side region where it is.
 *
 * Both ends are real: the near end is the moving region's own minimum, the far
 * end is whichever comes first of its maximum and the viewport's minimum. A
 * handle that could be dragged past either would snap back under the pointer,
 * which reads as a broken control rather than as a limit.
 */
export function boundaryRange(
  state: LayoutState,
  available: number,
  boundary: Boundary,
): BoundaryRange {
  const widths = resolveWidths(state, available);
  const room = widths.available;
  if (boundary === "map") {
    const other = widths.settings;
    const min = REGION_MIN_PX.map;
    const max = Math.max(min, Math.min(REGION_MAX_PX.map, room - other - REGION_MIN_PX.viewport));
    return { min, max };
  }
  const other = widths.map;
  const widest = Math.max(
    REGION_MIN_PX.settings,
    Math.min(REGION_MAX_PX.settings, room - other - REGION_MIN_PX.viewport),
  );
  return { min: room - widest, max: room - REGION_MIN_PX.settings };
}

/** A boundary's position as a whole percentage of the region area: what `aria-valuenow` reports. */
export function boundaryPercent(position: number, available: number): number {
  if (!Number.isFinite(available) || available <= 0) return 0;
  return Math.round(clamp((position / available) * 100, 0, 100));
}

/** Put a boundary at an absolute position (a pointer drag), clamped to its range. */
export function setBoundaryPosition(
  state: LayoutState,
  available: number,
  boundary: Boundary,
  position: number,
): LayoutState {
  if (!Number.isFinite(position)) return state;
  const range = boundaryRange(state, available, boundary);
  const held = Math.round(clamp(position, range.min, range.max));
  const room = resolveWidths(state, available).available;
  const size = boundary === "map" ? held : room - held;
  if (size === state.sizes[boundary]) return state;
  return { ...state, sizes: { ...state.sizes, [boundary]: size } };
}

/** Nudge a boundary (a keyboard press, or a drag expressed as a delta). Positive moves it right. */
export function moveBoundary(
  state: LayoutState,
  available: number,
  boundary: Boundary,
  deltaPx: number,
): LayoutState {
  const widths = resolveWidths(state, available);
  return setBoundaryPosition(
    state,
    available,
    boundary,
    boundaryPosition(widths, boundary) + deltaPx,
  );
}

/** Put one boundary back where it started, leaving the other one alone: the double-click and the Enter key. */
export function resetBoundary(state: LayoutState, boundary: Boundary): LayoutState {
  return { ...state, sizes: { ...state.sizes, [boundary]: DEFAULT_SIZES[boundary] } };
}

// ---------------------------------------------------------------------------
// Collapse and maximize
// ---------------------------------------------------------------------------

/**
 * Hide a side region, or bring it back.
 *
 * Collapsing the region that is currently maximized restores the three-column
 * layout first: "hide the map" and "the map is the only thing on screen"
 * cannot both be true, and the alternative -- a maximized region that is also
 * collapsed -- is a state with nothing at all in the row.
 */
export function setCollapsed(
  state: LayoutState,
  region: SideRegion,
  collapsed: boolean,
): LayoutState {
  const maximized = collapsed && state.maximized === region ? null : state.maximized;
  return { ...state, collapsed: { ...state.collapsed, [region]: collapsed }, maximized };
}

export function toggleCollapsed(state: LayoutState, region: SideRegion): LayoutState {
  return setCollapsed(state, region, !state.collapsed[region]);
}

/**
 * Give one region the whole row, or hand the row back.
 *
 * Maximizing a collapsed map un-collapses it, so the restore control does what
 * it says; the collapsed flag of the region NOT being maximized survives
 * untouched, so restoring returns the layout the user had rather than a
 * layout they never chose.
 */
export function setMaximized(state: LayoutState, region: MaximizedRegion): LayoutState {
  if (region === "map") {
    return { ...state, maximized: "map", collapsed: { ...state.collapsed, map: false } };
  }
  return { ...state, maximized: region };
}

export function toggleMaximized(state: LayoutState, region: "map" | "viewport"): LayoutState {
  return setMaximized(state, state.maximized === region ? null : region);
}

/** Whether two layouts are the same, field by field. */
export function sameLayout(a: LayoutState, b: LayoutState): boolean {
  return (
    a.sizes.map === b.sizes.map &&
    a.sizes.settings === b.sizes.settings &&
    a.collapsed.map === b.collapsed.map &&
    a.collapsed.settings === b.collapsed.settings &&
    a.maximized === b.maximized
  );
}

export function isDefaultLayout(state: LayoutState): boolean {
  return sameLayout(state, DEFAULT_LAYOUT);
}

// ---------------------------------------------------------------------------
// The payload a project file and a permalink carry
// ---------------------------------------------------------------------------

/**
 * The layout as it travels, with every default left out.
 *
 * Deliberately small and deliberately loose. It is presentation, so a payload
 * this build does not fully understand restores what it can and ignores the
 * rest: a layout must never be the reason a shared design refuses to open,
 * which is the opposite of the rule `lib/share.ts` applies to a setting (an
 * unknown setting refuses the whole link, because a half-applied MODEL is the
 * one outcome the user cannot see).
 */
export interface LayoutPayload {
  readonly map?: number;
  readonly settings?: number;
  readonly collapsed?: readonly SideRegion[];
  readonly maximized?: "map" | "viewport";
}

/** The payload for a state, or `null` when it is simply the default and there is nothing to say. */
export function layoutPayload(state: LayoutState): LayoutPayload | null {
  if (isDefaultLayout(state)) return null;
  const collapsed: SideRegion[] = [];
  if (state.collapsed.map) collapsed.push("map");
  if (state.collapsed.settings) collapsed.push("settings");
  return {
    ...(state.sizes.map === DEFAULT_SIZES.map ? {} : { map: state.sizes.map }),
    ...(state.sizes.settings === DEFAULT_SIZES.settings
      ? {}
      : { settings: state.sizes.settings }),
    ...(collapsed.length > 0 ? { collapsed } : {}),
    ...(state.maximized === null ? {} : { maximized: state.maximized }),
  };
}

const SIDE_REGIONS: readonly SideRegion[] = ["map", "settings"];

function isSideRegion(value: unknown): value is SideRegion {
  return typeof value === "string" && (SIDE_REGIONS as readonly string[]).includes(value);
}

/**
 * A payload back into a layout, or `null` when there is nothing usable in it.
 *
 * Never throws, and never returns a half-state: every field it does not
 * understand falls back to the default for that field. Sizes are CLAMPED
 * rather than refused, because the sender's screen is not the recipient's and
 * a 900 px map column arriving on a 1280 px display is a legitimate payload
 * asking for more map, not a corrupt one.
 */
export function layoutFromPayload(value: unknown): LayoutState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const sizes = { ...DEFAULT_SIZES };
  let named = false;
  for (const region of SIDE_REGIONS) {
    const raw = record[region];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      sizes[region] = clampSize(region, raw);
      named = true;
    }
  }

  const collapsed = { map: false, settings: false };
  const rawCollapsed = record.collapsed;
  if (Array.isArray(rawCollapsed)) {
    for (const entry of rawCollapsed) {
      if (isSideRegion(entry)) {
        collapsed[entry] = true;
        named = true;
      }
    }
  }

  let maximized: MaximizedRegion = null;
  if (record.maximized === "map" || record.maximized === "viewport") {
    maximized = record.maximized;
    named = true;
  }

  if (!named) return null;
  // Through the same door a user's own click takes, so a payload can never
  // describe a state the interface itself cannot reach (a maximized region
  // that is also collapsed, with nothing left in the row).
  let state: LayoutState = { sizes, collapsed: { map: false, settings: false }, maximized: null };
  if (collapsed.map) state = setCollapsed(state, "map", true);
  if (collapsed.settings) state = setCollapsed(state, "settings", true);
  if (maximized !== null) state = setMaximized(state, maximized);
  return state;
}

// ---------------------------------------------------------------------------
// Per device: localStorage
// ---------------------------------------------------------------------------

/**
 * Where this browser's own layout lives.
 *
 * Per device on purpose: the right width for a settings column is a fact about
 * the screen it is being read on, not about the design. A project file and a
 * permalink carry the sender's layout so a shared design opens the way its
 * author framed it, and that is a different question from what this laptop
 * should default to next Tuesday.
 */
export const LAYOUT_STORAGE_KEY = "framecraft.layout.v1";

/** The stored layout, or the default. Every failure mode -- no storage, private mode, a corrupt or foreign value -- lands on the default. */
export function loadStoredLayout(): LayoutState {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw === null) return DEFAULT_LAYOUT;
    return layoutFromPayload(JSON.parse(raw) as unknown) ?? DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Keep this browser's layout. A default layout REMOVES the key rather than writing one, so a reset really does leave no trace. */
export function storeLayout(state: LayoutState): void {
  if (typeof window === "undefined") return;
  try {
    const payload = layoutPayload(state);
    if (payload === null) window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
    else window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private mode, or storage disabled: the in-memory layout still works.
  }
}
