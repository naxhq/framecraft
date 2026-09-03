/**
 * Every control the parameter panel renders, in one machine-readable table.
 *
 * The settings truth audit (Task 2 of the v3.1 run) rests on one rule: a
 * control that exists moves the preview and the exported file, or it is not
 * there. Since the pipeline landed, "moves the preview and the file" is not a
 * judgement call -- the preview renders the pipeline's own region solids and
 * the export runs the same stages, so a `PrintParams` leaf claimed by a stage
 * (`lib/engine/pipeline/stages.ts`, read back through `describeGraph()`) moves
 * both, and a leaf no stage claims moves neither.
 *
 * This table is therefore the join between the two: for every control, the
 * leaf paths it writes. `lib/controlCatalog.test.ts` checks
 *
 *  - every path named here is a real `PRINT_PARAM_LEAF_PATHS` entry;
 *  - every path named here is claimed by a pipeline stage (so no control can
 *    write a field with no physical effect), and no control names one of the
 *    four matrix exemptions (DECISIONS `[V3.1-P1-2]`, `[V3.1-P1-13]`);
 *  - every control the group components actually render has a row here.
 *
 * The group components read their labels and help strings from this file, so
 * the copy a user reads, the copy the settings search will index (Task 5) and
 * the copy the tests assert are one string in one place.
 *
 * **Scope.** The catalog covers the settings panel: the eleven parameter
 * groups
 * (`components/editor/groups/**`), the lettering editor, the panel shell's own
 * two controls and the group headers, plus the export-format select, which
 * lives in the action bar but writes a `PrintParams` leaf. It does NOT cover
 * the action bar's other buttons (`ActionBar.tsx`: Preview, Export, Copy
 * link, Save and Load project), the shell chrome (theme, shortcuts, history,
 * recents, presets, the perf HUD, the build-stamp footer and the About dialog
 * it opens) or the drawers (issues, adjustments): those
 * run an action or move the viewport rather than writing a setting, they
 * belong to the action-bar and shell tasks, and `controlCatalog.test.ts` names
 * every one of their files with the reason it is out of scope, so the boundary
 * is a decision rather than an omission.
 *
 * Help strings say what the control does to the printed object, in physical
 * terms, and never restate the control's own name. Where a number is fixed by
 * `lib/transform.ts` or by the contract's defaults it is stated; where it
 * depends on another setting, that setting is named.
 */

import { PRINT_PARAM_LEAF_PATHS, type PrintParamPath } from "./contracts";
import type { GroupId } from "./groups";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * What a control writes when it does not write a `PrintParams` leaf.
 *
 * - `location`: `LocationState` (pin, radius, rotation, preset). Location is
 *   not a parameter (DECISIONS `[V3.1-P1-10]`): it is the `fetch` stage key,
 *   so moving it marks the model stale and costs a network round trip.
 * - `object-override`: a control that is not part of the settings panel at all.
 *   Three of them: the saved-palette library, which lives outside `PrintParams`
 *   in this browser's `localStorage`; the viewport's right-click inspector
 *   (v3.1 Task 11), which writes real `object_overrides` leaves but is opened
 *   on an object in the 3D view rather than found in a group; and the surface
 *   labels' card and gizmo (v3.1 Task 12), which write real `labels` leaves on
 *   a label placed in the 3D view. Which leaves they write is not stated here:
 *   the panel has no control for them at all, so they are named in
 *   `controlCatalog.test.ts:CLAIMED_WITHOUT_A_CONTROL`, the list this catalog
 *   keeps of exactly that.
 * - `viewer`: presentation only. Never reaches a stage and never reaches a
 *   file.
 * - `all-parameters`: rewrites the whole `PrintParams` object at once, so it
 *   names no single leaf.
 * - `section-parameters`: rewrites the leaves of ONE section, or one row of the
 *   changes list. Which leaves those are is not a property of the control: it
 *   is `lib/settingsDiff.ts:sectionPaths(group)`, read off this catalog, so
 *   writing them here would be the same list stated twice and free to drift.
 */
export type NonParamTarget =
  | "location"
  | "object-override"
  | "viewer"
  | "all-parameters"
  | "section-parameters";

/** How the control is drawn, so a search result can say what it will find. */
export type ControlKind =
  | "slider"
  | "toggle"
  | "select"
  | "segmented"
  | "text"
  | "colour"
  | "button"
  | "radiogroup";

export interface ControlSpec {
  /**
   * The control's DOM `id`, or -- for a control rendered once per item -- the
   * id with the varying part written as `*`, e.g. `engraving_*_text`. A
   * control built out of buttons with no `id` is keyed by its `data-testid`.
   */
  readonly id: string;
  readonly group: GroupId;
  readonly kind: ControlKind;
  /** The visible label. */
  readonly label: string;
  /** One line, in physical terms, shown as the control's `aria-describedby`. */
  readonly help: string;
  /** The `PrintParams` leaves this control writes, or what it writes instead. */
  readonly writes: readonly PrintParamPath[] | NonParamTarget;
  /** The `data-testid` an e2e test selects it by. */
  readonly testId: string;
  /** The component that renders it, relative to `apps/web/`. */
  readonly source: string;
}

/** A labelled block inside a group: several controls under one heading. */
export interface SectionSpec {
  readonly id: string;
  readonly group: GroupId;
  readonly label: string;
  readonly help: string;
  readonly source: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every leaf under a dotted prefix, read off the generated list rather than
 * typed out, so a schema addition under `colour.region_slots` reaches the
 * control that writes it without anyone editing this file.
 */
function leavesUnder(prefix: string): readonly PrintParamPath[] {
  const out = PRINT_PARAM_LEAF_PATHS.filter((path) => path.startsWith(`${prefix}.`));
  if (out.length === 0) throw new Error(`controlCatalog: no PrintParams leaf under ${prefix}`);
  return out;
}

/** Every leaf one engraving line owns, in schema order. */
const ENGRAVING_LEAVES = leavesUnder("engravings[]");

const REGION_SLOT_LEAVES = leavesUnder("colour.region_slots");

/**
 * The region colours a control may write. `colour.region_colors.attribution`
 * is NOT among them: the mandatory attribution marks are engraved cuts and
 * never a body, so no colour can reach a file, and DECISIONS `[V3.1-P1-13]`
 * takes its well out of the panel while leaving the field in the contract for
 * v3 payload compatibility. `controlCatalog.test.ts` pins that no control
 * writes it.
 */
const REGION_COLOUR_LEAVES = leavesUnder("colour.region_colors").filter(
  (path) => path !== "colour.region_colors.attribution",
);

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export const SECTIONS: readonly SectionSpec[] = [
  {
    id: "hero-buildings",
    group: "buildings",
    label: "Hero buildings",
    help: "Click a building in the preview to pick it out. A hero keeps its true height and can take a filament slot of its own.",
    source: "components/editor/groups/BuildingsGroup.tsx",
  },
  {
    id: "hero-auto-list",
    group: "buildings",
    label: "Auto-detected",
    help: "What the automatic pass promoted on top of the hand-picked list. Lower the count or turn the pass off to drop one.",
    source: "components/editor/groups/BuildingsGroup.tsx",
  },
  {
    id: "region-roads",
    group: "regions",
    label: "Roads",
    help: "The road ribbon is a solid of its own thickness, and the base is carved to receive it.",
    source: "components/editor/groups/RegionsGroup.tsx",
  },
  {
    id: "region-water",
    group: "regions",
    label: "Water",
    help: "Rivers and lakes, sunk into the plate so they read as channels rather than as flat shapes.",
    source: "components/editor/groups/RegionsGroup.tsx",
  },
  {
    id: "region-parks",
    group: "regions",
    label: "Parks",
    help: "The green areas the trees stand on, flush with the plate top unless moved.",
    source: "components/editor/groups/RegionsGroup.tsx",
  },
  {
    id: "region-rail",
    group: "regions",
    label: "Rail",
    help: "Railway ribbons, standing proud of the surface by default like a ballasted track bed.",
    source: "components/editor/groups/RegionsGroup.tsx",
  },
  {
    id: "frame-profile",
    group: "frame",
    label: "Frame profile",
    help: "The cross-section of the lip. Every profile takes the same 6 mm of plate; only the shape of the moulding changes.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "shadow-gap",
    group: "frame",
    label: "Shadow gap",
    help: "A groove sunk between the frame and the base, so the frame reads as floating above the plate.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "matting",
    group: "frame",
    label: "Matting",
    help: "A recessed board between the frame and the city, like the mat around a photograph.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "separate-frame",
    group: "frame",
    label: "Separate frame part",
    help: "Splits the frame off as its own printable piece, so the two can be different filaments with no colour change.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "face-texture",
    group: "frame",
    label: "Face texture",
    help: "A relief pattern cut into the frame's visible front face.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "lettering",
    group: "frame",
    label: "Lettering",
    help: "Up to eight lines cut into the frame edges or the underside, one engraving each, with tokens expanded as the file is written.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "north-arrow",
    group: "frame",
    label: "North arrow",
    help: "An arrow cut into the frame lip, turned so it points to true north through the crop rotation.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "scale-bar",
    group: "frame",
    label: "Scale bar",
    help: "A measured bar cut into the frame lip, so the model states its own scale.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "underside-mark",
    group: "frame",
    label: "Underside mark",
    help: "Text cut 0.3 mm into the bottom of the base, after the credit every model already carries there.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "hanger",
    group: "frame",
    label: "Hanger",
    help: "A fitting cut into or added to the back, so the finished plate can go on a wall or stand on a desk.",
    source: "components/editor/groups/FrameTextGroup.tsx",
  },
  {
    id: "palette",
    group: "colour",
    label: "Palette",
    help: "Sets every region's colour and slot in one step. The colours travel in a shared link, so a recipient sees them without loading the palette.",
    source: "components/editor/groups/ColourGroup.tsx",
  },
  {
    id: "filament-slots",
    group: "colour",
    label: "Filament slots",
    help: "A slot and a colour per region: what the exported file, the Bambu project and the colour-change plan all read.",
    source: "components/editor/groups/ColourGroup.tsx",
  },
  {
    id: "building-tint",
    group: "colour",
    label: "Building tint",
    help: "A small per-building colour shift, so a block of identical footprints does not read as one slab.",
    source: "components/editor/groups/ColourGroup.tsx",
  },
  {
    id: "height-gradient",
    group: "colour",
    label: "Height gradient",
    help: "Buildings split into height bands, each band printed from its own filament slot.",
    source: "components/editor/groups/ColourGroup.tsx",
  },
  {
    id: "tiling",
    group: "printer",
    label: "Tiling",
    help: "The model cut into a grid of interlocking tiles when it will not fit the plate in one piece.",
    source: "components/editor/groups/PrinterGroup.tsx",
  },
] as const;

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const LOCATION_SOURCE = "components/editor/groups/LocationGroup.tsx";
const SCALE_SOURCE = "components/editor/groups/ScaleSizeGroup.tsx";
const BUILDINGS_SOURCE = "components/editor/groups/BuildingsGroup.tsx";
const HEIGHTS_SOURCE = "components/editor/groups/HeightsGroup.tsx";
const SURFACE_SOURCE = "components/editor/groups/SurfaceGroup.tsx";
const REGIONS_SOURCE = "components/editor/groups/RegionsGroup.tsx";
const BRIDGES_SOURCE = "components/editor/groups/BridgesGroup.tsx";
const TERRAIN_SOURCE = "components/editor/groups/TerrainGroup.tsx";
const FRAME_SOURCE = "components/editor/groups/FrameTextGroup.tsx";
const ENGRAVINGS_SOURCE = "components/editor/EngravingsEditor.tsx";
const COLOUR_SOURCE = "components/editor/groups/ColourGroup.tsx";
const PRINTER_SOURCE = "components/editor/groups/PrinterGroup.tsx";
const PANEL_SOURCE = "components/editor/ParamPanel.tsx";
const COLLAPSIBLE_SOURCE = "components/editor/CollapsibleGroup.tsx";
const EXPORT_MENU_SOURCE = "components/editor/ExportMenu.tsx";
const SEARCH_SOURCE = "components/editor/SettingsSearch.tsx";
const CHANGES_SOURCE = "components/editor/ChangesFromDefault.tsx";
const INSPECTOR_SOURCE = "components/editor/ObjectInspector.tsx";
const LABELS_SOURCE = "components/editor/LabelsPanel.tsx";

export const CONTROLS: readonly ControlSpec[] = [
  // -- Location ------------------------------------------------------------
  {
    id: "city_label",
    group: "location",
    kind: "text",
    label: "Place name",
    help: "The {city} token: it is cut into any line of lettering that names it, and it titles the exported file and its credits sidecar.",
    writes: ["city_label"],
    testId: "city_label",
    source: LOCATION_SOURCE,
  },
  {
    id: "reset-place-name",
    group: "location",
    kind: "button",
    label: "Reset to detected",
    help: "Puts the looked-up name back and lets a preset or a dragged pin overwrite it again.",
    writes: ["city_label"],
    testId: "reset-place-name",
    source: LOCATION_SOURCE,
  },
  {
    id: "author",
    group: "location",
    kind: "text",
    label: "Author",
    help: "The {author} token, for a credit line in an engraving or in the mark under the base.",
    writes: ["place.author"],
    testId: "author",
    source: LOCATION_SOURCE,
  },
  {
    id: "radius_m",
    group: "location",
    kind: "slider",
    label: "Radius",
    help: "Half the ground span of the square that prints, so it decides how much city fits and at what scale. Releasing the slider refetches from OpenStreetMap.",
    writes: "location",
    testId: "radius_m",
    source: LOCATION_SOURCE,
  },
  {
    id: "rotation_deg",
    group: "location",
    kind: "slider",
    label: "Rotation",
    help: "Turns the crop before it is squared, so the dashed square on the map is what prints. Releasing the slider refetches from OpenStreetMap.",
    writes: "location",
    testId: "rotation_deg",
    source: LOCATION_SOURCE,
  },

  // -- Scale and size ------------------------------------------------------
  {
    id: "plate_mm",
    group: "scale",
    kind: "slider",
    label: "Plate size",
    help: "The square the model is printed on. With the frame on, 12 mm of it becomes border and the city keeps the rest.",
    writes: ["plate_mm"],
    testId: "plate_mm",
    source: SCALE_SOURCE,
  },
  {
    id: "base_thickness_mm",
    group: "scale",
    kind: "slider",
    label: "Base thickness",
    help: "The solid slab under everything. Every recess is cut into it, so a thin base clamps how deep water and roads can go.",
    writes: ["base_thickness_mm"],
    testId: "base_thickness_mm",
    source: SCALE_SOURCE,
  },
  {
    id: "nozzle_mm",
    group: "scale",
    kind: "slider",
    label: "Nozzle diameter",
    help: "Your printer's nozzle. The minimum wall is twice it and the minimum gap one and a half times, so a wider one merges more of the city into fewer blocks.",
    writes: ["nozzle_mm"],
    testId: "nozzle_mm",
    source: SCALE_SOURCE,
  },

  // -- Buildings -----------------------------------------------------------
  {
    id: "small_scale",
    group: "buildings",
    kind: "slider",
    label: "Small building scale",
    help: "Multiplies the printed height of every building under 40 m.",
    writes: ["small_scale"],
    testId: "small_scale",
    source: BUILDINGS_SOURCE,
  },
  {
    id: "large_scale",
    group: "buildings",
    kind: "slider",
    label: "Large building scale",
    help: "Multiplies the printed height of every building 40 m and over. Past the printer profile's height ceiling the model is reported as too tall.",
    writes: ["large_scale"],
    testId: "large_scale",
    source: BUILDINGS_SOURCE,
  },
  {
    id: "hero-remove",
    group: "buildings",
    kind: "button",
    label: "Remove",
    help: "Drops this building back to the ordinary height and colour rules.",
    writes: ["hero_building_ids"],
    testId: "hero-remove",
    source: BUILDINGS_SOURCE,
  },
  {
    id: "hero-clear-all",
    group: "buildings",
    kind: "button",
    label: "Clear all",
    help: "Drops every hand-picked building back to the ordinary height and colour rules.",
    writes: ["hero_building_ids"],
    testId: "hero-clear-all",
    source: BUILDINGS_SOURCE,
  },
  {
    id: "hero_auto_enabled",
    group: "buildings",
    kind: "toggle",
    label: "Auto-detect heroes",
    help: "Promotes the tallest, biggest-footprint and most landmark-tagged buildings on top of anything picked by hand.",
    writes: ["hero_auto.enabled"],
    testId: "hero_auto_enabled",
    source: BUILDINGS_SOURCE,
  },
  {
    id: "hero_auto_count",
    group: "buildings",
    kind: "slider",
    label: "Auto-detected count",
    help: "How many buildings the automatic pass promotes. A hand-picked building is never evicted for one of these.",
    writes: ["hero_auto.count"],
    testId: "hero_auto_count",
    source: BUILDINGS_SOURCE,
  },

  // -- Heights -------------------------------------------------------------
  {
    id: "heights_floor_height_m",
    group: "heights",
    kind: "slider",
    label: "Floor height",
    help: "How tall one storey counts as for a building that carries only a level count. Changing it re-reads every building height from the cached OpenStreetMap response, with no refetch.",
    writes: ["heights.floor_height_m"],
    testId: "heights_floor_height_m",
    source: HEIGHTS_SOURCE,
  },
  {
    id: "heights_unknown_default_m",
    group: "heights",
    kind: "slider",
    label: "Unknown building default",
    help: "The height given to a building with neither a height nor a level count and no better default for its type. Changing it re-reads every building height from the cached response, with no refetch.",
    writes: ["heights.unknown_default_m"],
    testId: "heights_unknown_default_m",
    source: HEIGHTS_SOURCE,
  },
  {
    id: "height_exaggeration_multiplier",
    group: "heights",
    kind: "slider",
    label: "Height exaggeration",
    help: "Multiplies every printed building height once more, after the small and large building scales have been applied.",
    writes: ["height_exaggeration.multiplier"],
    testId: "height_exaggeration_multiplier",
    source: HEIGHTS_SOURCE,
  },
  {
    id: "height_exaggeration_curve",
    group: "heights",
    kind: "slider",
    label: "Exaggeration curve",
    help: "Bends that multiplier around a 50 m reference: at 0 every building scales alike, and higher settings lift a shed while holding a tower back.",
    writes: ["height_exaggeration.curve"],
    testId: "height_exaggeration_curve",
    source: HEIGHTS_SOURCE,
  },

  // -- Surface -------------------------------------------------------------
  {
    id: "road_mode",
    group: "surface",
    kind: "segmented",
    label: "Road mode",
    help: "Off leaves the road layer out of the model. Engrave sinks the roads into the base and emboss raises them; the roads region places them 0.6 mm deep, 0.2 mm below the base top.",
    writes: ["road_mode"],
    testId: "road_mode",
    source: SURFACE_SOURCE,
  },
  {
    id: "road_scale",
    group: "surface",
    kind: "slider",
    label: "Road scale",
    help: "Widens or narrows every road before the minimum-feature clamp, so a lane too thin for the nozzle can be scaled up until it survives.",
    writes: ["road_scale"],
    testId: "road_scale",
    source: SURFACE_SOURCE,
  },
  {
    id: "water",
    group: "surface",
    kind: "toggle",
    label: "Water",
    help: "Sinks lakes and rivers into the base: their surface sits 0.5 mm below the base top and the pocket is cut 1.0 mm deep.",
    writes: ["water"],
    testId: "water",
    source: SURFACE_SOURCE,
  },
  {
    id: "trees",
    group: "surface",
    kind: "toggle",
    label: "Trees",
    help: "Stands cones on the green areas, one and a half times as tall as they are wide, up to 2000 of them. A cone under 1 mm across is dropped.",
    writes: ["trees"],
    testId: "trees",
    source: SURFACE_SOURCE,
  },

  // -- Surface depths ------------------------------------------------------
  {
    id: "regions_roads_depth_mm",
    group: "regions",
    kind: "slider",
    label: "Road thickness",
    help: "How thick the road ribbon is built. The base is carved to exactly the same shape, so the two meet with no overlap for the slicer to arbitrate.",
    writes: ["regions.roads.depth_mm"],
    testId: "regions_roads_depth_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_roads_proud_mm",
    group: "regions",
    kind: "slider",
    label: "Road height",
    help: "Where the road's top face sits against the plate top: below it leaves a groove that deep, above stands the ribbon on the surface, and zero makes the two flush.",
    writes: ["regions.roads.proud_mm"],
    testId: "regions_roads_proud_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_water_depth_mm",
    group: "regions",
    kind: "slider",
    label: "Water thickness",
    help: "How thick the water body is built under its own surface. Together with the setting below it decides how far a river is cut into the base.",
    writes: ["regions.water.depth_mm"],
    testId: "regions_water_depth_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_water_proud_mm",
    group: "regions",
    kind: "slider",
    label: "Water height",
    help: "Where the water's top face sits against the plate top. It is sunk by default, so a river reads as a channel rather than as a painted shape.",
    writes: ["regions.water.proud_mm"],
    testId: "regions_water_proud_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_parks_depth_mm",
    group: "regions",
    kind: "slider",
    label: "Park thickness",
    help: "How thick the green areas are built. The trees stand on this surface, so raising it lifts them with it.",
    writes: ["regions.parks.depth_mm"],
    testId: "regions_parks_depth_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_parks_proud_mm",
    group: "regions",
    kind: "slider",
    label: "Park height",
    help: "Where the green areas sit against the plate top. They are flush by default, which is the one case where a region shares a plane with the base.",
    writes: ["regions.parks.proud_mm"],
    testId: "regions_parks_proud_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_rail_depth_mm",
    group: "regions",
    kind: "slider",
    label: "Rail thickness",
    help: "How thick the railway ribbon is built, under whatever height the setting below gives it.",
    writes: ["regions.rail.depth_mm"],
    testId: "regions_rail_depth_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_rail_proud_mm",
    group: "regions",
    kind: "slider",
    label: "Rail height",
    help: "Where the railway's top face sits against the plate top. It stands above the surface by default, so track reads as an embankment rather than as a trench.",
    writes: ["regions.rail.proud_mm"],
    testId: "regions_rail_proud_mm",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_rail_width_m",
    group: "regions",
    kind: "slider",
    label: "Rail width",
    help: "The ground width of the railway ribbon, in real metres, before the nozzle's minimum-feature clamp widens anything too thin to print.",
    writes: ["regions.rail.width_m"],
    testId: "regions_rail_width_m",
    source: REGIONS_SOURCE,
  },
  {
    id: "regions_building_skirt_mm",
    group: "regions",
    kind: "slider",
    label: "Building skirt",
    help: "How far each footprint is grown before it is extruded, so a wall lands on solid plate instead of on the edge of a road pocket.",
    writes: ["regions.building_skirt_mm"],
    testId: "regions_building_skirt_mm",
    source: REGIONS_SOURCE,
  },

  // -- Bridges -------------------------------------------------------------
  {
    id: "bridges_enabled",
    group: "bridges",
    kind: "toggle",
    label: "Build bridges",
    help: "Lifts every segment tagged as a bridge off the ground as a slab, so the river keeps its own surface underneath. Off, all of it is laid at ground level.",
    writes: ["bridges.enabled"],
    testId: "bridges_enabled",
    source: BRIDGES_SOURCE,
  },
  {
    id: "bridges_clearance_mm",
    group: "bridges",
    kind: "slider",
    label: "Clearance",
    help: "The air left between the deck and whatever it crosses. Too little and the two fuse into one body on the plate.",
    writes: ["bridges.clearance_mm"],
    testId: "bridges_clearance_mm",
    source: BRIDGES_SOURCE,
  },
  {
    id: "bridges_abutments",
    group: "bridges",
    kind: "toggle",
    label: "Support the ends",
    help: "Builds an abutment, a short column, under each end of every deck, down through the plate top. Without them the decks print as loose pieces.",
    writes: ["bridges.abutments"],
    testId: "bridges_abutments",
    source: BRIDGES_SOURCE,
  },

  // -- Terrain -------------------------------------------------------------
  {
    id: "terrain_enabled",
    group: "terrain",
    kind: "toggle",
    label: "Terrain",
    help: "Drapes the base over real ground elevation instead of a flat slab, from elevation tiles rather than from OpenStreetMap.",
    writes: ["terrain.enabled"],
    testId: "terrain_enabled",
    source: TERRAIN_SOURCE,
  },
  {
    id: "terrain_exaggeration",
    group: "terrain",
    kind: "slider",
    label: "Vertical exaggeration",
    help: "Stretches the draped relief so a gentle slope still reads on the plate. It raises the model's total height, which the printer profile's ceiling then checks.",
    writes: ["terrain_exaggeration"],
    testId: "terrain_exaggeration",
    source: TERRAIN_SOURCE,
  },
  {
    id: "terrain_smoothing",
    group: "terrain",
    kind: "slider",
    label: "Smoothing",
    help: "Blurs the elevation grid before it is draped, so buildings do not sit on a jagged terrace.",
    writes: ["terrain.smoothing"],
    testId: "terrain_smoothing",
    source: TERRAIN_SOURCE,
  },

  // -- Frame and text ------------------------------------------------------
  {
    id: "frame",
    group: "frame",
    kind: "toggle",
    label: "Frame",
    help: "A 6 mm border standing 2 mm proud of the base. It takes 12 mm off the plate, and it is what the lettering, the north arrow and the scale bar are cut into.",
    writes: ["frame"],
    testId: "frame",
    source: FRAME_SOURCE,
  },
  {
    id: "frame-profile-*",
    group: "frame",
    kind: "radiogroup",
    label: "Frame profile",
    help: "The cross-section cut along the lip, from a flat top to a rounded, stepped or S-curved moulding.",
    writes: ["frame_style.profile"],
    testId: "frame-profile-*",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_corner",
    group: "frame",
    kind: "select",
    label: "Corners",
    help: "How the four corners of the lip meet: left square, mitred on the diagonal, or rounded to the radius below.",
    writes: ["frame_style.corner"],
    testId: "frame_style_corner",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_corner_radius_mm",
    group: "frame",
    kind: "slider",
    label: "Corner radius",
    help: "How far each corner of the lip is cut back, measured on the outside edge.",
    writes: ["frame_style.corner_radius_mm"],
    testId: "frame_style_corner_radius_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_lip_depth_mm",
    group: "frame",
    kind: "slider",
    label: "Lip depth",
    help: "The sight edge: a step cut this deep into the inner top edge of the lip, 1.0 mm wide all round the opening, so the frame looks rebated where it meets the city. Zero leaves the lip flat.",
    writes: ["frame_style.lip_depth_mm"],
    testId: "frame_style_lip_depth_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_shadow_gap_enabled",
    group: "frame",
    kind: "toggle",
    label: "Add a shadow gap",
    help: "Cuts a groove all the way round, between the frame and the base.",
    writes: ["frame_style.shadow_gap.enabled"],
    testId: "frame_style_shadow_gap_enabled",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_shadow_gap_width_mm",
    group: "frame",
    kind: "slider",
    label: "Width",
    help: "How wide that groove is across the plate. It comes out of the city's own space, on top of the frame's 12 mm.",
    writes: ["frame_style.shadow_gap.width_mm"],
    testId: "frame_style_shadow_gap_width_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_shadow_gap_depth_mm",
    group: "frame",
    kind: "slider",
    label: "Depth",
    help: "How far that groove cuts down into the base, bounded by the base thickness.",
    writes: ["frame_style.shadow_gap.depth_mm"],
    testId: "frame_style_shadow_gap_depth_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_matting_enabled",
    group: "frame",
    kind: "toggle",
    label: "Add matting",
    help: "Adds a raised board between the frame and the city, printed as its own region with its own filament slot.",
    writes: ["frame_style.matting.enabled"],
    testId: "frame_style_matting_enabled",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_matting_width_mm",
    group: "frame",
    kind: "slider",
    label: "Width",
    help: "Plate the city loses to the matting board, on top of the 12 mm the frame already takes.",
    writes: ["frame_style.matting.width_mm"],
    testId: "frame_style_matting_width_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_matting_proud_mm",
    group: "frame",
    kind: "slider",
    label: "Standing proud",
    help: "How far the matting board stands above the base top, under the 2 mm frame lip.",
    writes: ["frame_style.matting.proud_mm"],
    testId: "frame_style_matting_proud_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_separate_enabled",
    group: "frame",
    kind: "toggle",
    label: "Print the frame separately",
    help: "Cuts the frame free of the base as a second printable part, so each can be its own filament with no colour change.",
    writes: ["frame_style.separate.enabled"],
    testId: "frame_style_separate_enabled",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_separate_mount",
    group: "frame",
    kind: "select",
    label: "Mount",
    help: "How the separate frame holds onto the base: a snap-fit lip, or the magnet pockets whose size the Hanger section sets.",
    writes: ["frame_style.separate.mount"],
    testId: "frame_style_separate_mount",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_separate_tolerance_mm",
    group: "frame",
    kind: "slider",
    label: "Fit tolerance",
    help: "Clearance left between the two printed parts. Widen it if the frame seats too tight to push home.",
    writes: ["frame_style.separate.tolerance_mm"],
    testId: "frame_style_separate_tolerance_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_texture_pattern",
    group: "frame",
    kind: "select",
    label: "Pattern",
    help: "Which relief is cut into the frame's front face: brushed lines, a knurl, a hatch or dots.",
    writes: ["frame_style.texture.pattern"],
    testId: "frame_style_texture_pattern",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_texture_scale_mm",
    group: "frame",
    kind: "slider",
    label: "Pattern scale",
    help: "How far apart the pattern repeats across the frame face.",
    writes: ["frame_style.texture.scale_mm"],
    testId: "frame_style_texture_scale_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "frame_style_texture_depth_mm",
    group: "frame",
    kind: "slider",
    label: "Pattern depth",
    help: "How deep the pattern is cut into the frame face.",
    writes: ["frame_style.texture.depth_mm"],
    testId: "frame_style_texture_depth_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "north_arrow_enabled",
    group: "frame",
    kind: "toggle",
    label: "Show a north arrow",
    help: "Cuts an arrow into the frame lip, turned by the crop rotation so it still points to true north.",
    writes: ["north_arrow.enabled"],
    testId: "north_arrow_enabled",
    source: FRAME_SOURCE,
  },
  {
    id: "north_arrow_corner",
    group: "frame",
    kind: "select",
    label: "Corner",
    help: "Which corner of the lip the arrow is cut into. Lettering gives that corner a wide berth.",
    writes: ["north_arrow.corner"],
    testId: "north_arrow_corner",
    source: FRAME_SOURCE,
  },
  {
    id: "north_arrow_size_mm",
    group: "frame",
    kind: "slider",
    label: "Size",
    help: "How tall the arrow is cut, between 2 and 6 mm on a 6 mm lip.",
    writes: ["north_arrow.size_mm"],
    testId: "north_arrow_size_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "scale_bar_enabled",
    group: "frame",
    kind: "toggle",
    label: "Show a scale bar",
    help: "Cuts a ticked bar and its distance label into the frame lip.",
    writes: ["scale_bar.enabled"],
    testId: "scale_bar_enabled",
    source: FRAME_SOURCE,
  },
  {
    id: "scale_bar_edge",
    group: "frame",
    kind: "select",
    label: "Edge",
    help: "Which of the four frame edges carries the bar.",
    writes: ["scale_bar.edge"],
    testId: "scale_bar_edge",
    source: FRAME_SOURCE,
  },
  {
    id: "scale_bar_length_mode",
    group: "frame",
    kind: "select",
    label: "Length",
    help: "Auto picks a round ground distance that fits between 15 and 40 mm of lip; Fixed uses the distance set below.",
    writes: ["scale_bar.length_mode"],
    testId: "scale_bar_length_mode",
    source: FRAME_SOURCE,
  },
  {
    id: "scale_bar_length_m",
    group: "frame",
    kind: "slider",
    label: "Ground length",
    help: "The real distance the bar stands for. It is drawn at the model's own scale, so a longer distance is a longer bar.",
    writes: ["scale_bar.length_m"],
    testId: "scale_bar_length_m",
    source: FRAME_SOURCE,
  },
  {
    id: "underside_mark_enabled",
    group: "frame",
    kind: "toggle",
    label: "Mark the underside",
    help: "Cuts text 0.3 mm into the bottom of the base, where it never shows on a shelf.",
    writes: ["underside_mark.enabled"],
    testId: "underside_mark_enabled",
    source: FRAME_SOURCE,
  },
  {
    id: "underside_mark_template",
    group: "frame",
    kind: "text",
    label: "Template",
    help: "What gets cut underneath, once the tokens expand. It is added after the FrameCraft and OpenStreetMap credit, never instead of it.",
    writes: ["underside_mark.template"],
    testId: "underside_mark_template",
    source: FRAME_SOURCE,
  },
  {
    id: "hanger",
    group: "frame",
    kind: "select",
    label: "Fitting",
    help: "What is cut into or added to the back: a keyhole slot, magnet pockets, a French cleat as a second part, or a fold-out easel foot.",
    writes: ["hanger"],
    testId: "hanger",
    source: FRAME_SOURCE,
  },
  {
    id: "hanger_magnet_diameter_mm",
    group: "frame",
    kind: "slider",
    label: "Magnet diameter",
    help: "How wide each pocket in the separate frame's magnet mount is bored. The wall hanger's own pockets are a fixed 6.1 mm.",
    writes: ["hanger_magnet.diameter_mm"],
    testId: "hanger_magnet_diameter_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "hanger_magnet_thickness_mm",
    group: "frame",
    kind: "slider",
    label: "Magnet thickness",
    help: "How deep each pocket in the separate frame's magnet mount is cut. The wall hanger's own pockets are a fixed 3.1 mm.",
    writes: ["hanger_magnet.thickness_mm"],
    testId: "hanger_magnet_thickness_mm",
    source: FRAME_SOURCE,
  },
  {
    id: "hanger_magnet_count",
    group: "frame",
    kind: "slider",
    label: "Magnet count",
    help: "How many magnets hold the separate frame onto the base, spaced evenly along its mating face.",
    writes: ["hanger_magnet.count"],
    testId: "hanger_magnet_count",
    source: FRAME_SOURCE,
  },

  // -- Lettering (inside Frame and text) -----------------------------------
  {
    id: "engraving-add",
    group: "frame",
    kind: "button",
    label: "Add a line of lettering",
    help: "Adds a line on the first free frame edge, at the contract's own default size and depth. Eight lines is the limit.",
    writes: ENGRAVING_LEAVES,
    testId: "engraving-add",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*-remove",
    group: "frame",
    kind: "button",
    label: "Remove",
    help: "Takes this line off the edge it was cut into and renumbers the rest.",
    writes: ENGRAVING_LEAVES,
    testId: "engraving_*-remove",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*_text",
    group: "frame",
    kind: "text",
    label: "Text",
    help: "What gets cut, after the tokens expand. The line under the field shows the expansion as it stands right now.",
    writes: ["engravings[].text"],
    testId: "engraving_*_text",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*_edge",
    group: "frame",
    kind: "select",
    label: "Edge",
    help: "Which frame edge, or the underside, this line is cut along.",
    writes: ["engravings[].edge"],
    testId: "engraving_*_edge",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*_align",
    group: "frame",
    kind: "select",
    label: "Align",
    help: "Where the line sits along its edge, between the 7 mm the corners keep clear.",
    writes: ["engravings[].align"],
    testId: "engraving_*_align",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*_mode",
    group: "frame",
    kind: "select",
    label: "Mode",
    help: "Engrave cuts the line down into the lip; emboss stands it proud of the lip instead.",
    writes: ["engravings[].mode"],
    testId: "engraving_*_mode",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*_font",
    group: "frame",
    kind: "select",
    label: "Font",
    help: "Which of the three built-in outline faces the glyphs are cut from.",
    writes: ["engravings[].font"],
    testId: "engraving_*_font",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*_size_mm",
    group: "frame",
    kind: "slider",
    label: "Cap height",
    help: "How tall a capital letter is cut, 1.5 to 8 mm. A line too long for its edge is reduced or refused, and the verdict is shown below.",
    writes: ["engravings[].size_mm"],
    testId: "engraving_*_size_mm",
    source: ENGRAVINGS_SOURCE,
  },
  {
    id: "engraving_*_depth_mm",
    group: "frame",
    kind: "slider",
    label: "Depth",
    help: "How far the line is cut into the frame lip, or how far it stands off it in emboss mode.",
    writes: ["engravings[].depth_mm"],
    testId: "engraving_*_depth_mm",
    source: ENGRAVINGS_SOURCE,
  },

  // -- Colour --------------------------------------------------------------
  {
    id: "color_mode",
    group: "colour",
    kind: "segmented",
    label: "Colour",
    help: "One filament writes the model as a single merged object; one per part keeps every region separate. It changes the generic 3MF, the OBJ and the STEP; a Bambu project always writes one object per region.",
    writes: ["color_mode"],
    testId: "color_mode",
    source: COLOUR_SOURCE,
  },
  {
    id: "hero_mode",
    group: "colour",
    kind: "select",
    label: "Hero buildings print as",
    help: "True height holds a hero at its real relative height while the others are scaled down; own colour moves it onto the hero filament slot.",
    writes: ["hero_mode"],
    testId: "hero_mode",
    source: COLOUR_SOURCE,
  },
  {
    id: "palette-apply-*",
    group: "colour",
    kind: "button",
    label: "Apply palette",
    help: "Rewrites every region's colour and slot in one step, and writes the palette's name into the exported file's metadata and its credits sidecar.",
    writes: [...REGION_COLOUR_LEAVES, ...REGION_SLOT_LEAVES, "colour.palette"],
    testId: "palette-apply-*",
    source: COLOUR_SOURCE,
  },
  {
    id: "palette-delete-*",
    group: "colour",
    kind: "button",
    label: "Delete",
    help: "Forgets this saved palette in this browser. Colours already applied to the model stay exactly as they are.",
    writes: "object-override",
    testId: "palette-delete-*",
    source: COLOUR_SOURCE,
  },
  {
    id: "palette-save-name",
    group: "colour",
    kind: "text",
    label: "Save current colours as",
    help: "The name this browser will remember the current region colours under. Save is what writes it into the model.",
    writes: "object-override",
    testId: "palette-save-name",
    source: COLOUR_SOURCE,
  },
  {
    id: "palette-save",
    group: "colour",
    kind: "button",
    label: "Save",
    help: "Stores the current region colours in this browser under that name, and writes the name into every exported 3MF's metadata.",
    writes: ["colour.palette"],
    testId: "palette-save",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour_slot_*",
    group: "colour",
    kind: "select",
    label: "Filament slot",
    help: "Which filament slot this region prints from. Two regions on one slot print in a single colour, and the first in region order wins.",
    writes: REGION_SLOT_LEAVES,
    testId: "colour-slot-*",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour_color_*",
    group: "colour",
    kind: "colour",
    label: "Colour",
    help: "The colour written for this region into the exported file and into its filament slot. Editing one by hand renames the palette to custom.",
    writes: [...REGION_COLOUR_LEAVES, "colour.palette"],
    testId: "colour-color-*",
    source: COLOUR_SOURCE,
  },
  {
    id: "align-slot-colours",
    group: "colour",
    kind: "button",
    label: "Align colours to what will print",
    help: "Rewrites each losing region's colour to the one its shared slot actually prints, so the panel and the file agree, and renames the palette to match.",
    writes: [...REGION_COLOUR_LEAVES, "colour.palette"],
    testId: "align-slot-colours",
    source: COLOUR_SOURCE,
  },
  {
    id: "merge-to-profile-slots",
    group: "colour",
    kind: "button",
    label: "Merge to profile slots",
    help: "Groups the regions by how close their colours are until they fit the printer profile's filament count, and renames the palette to match.",
    writes: [...REGION_SLOT_LEAVES, ...REGION_COLOUR_LEAVES, "colour.palette"],
    testId: "merge-to-profile-slots",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour_tint_enabled",
    group: "colour",
    kind: "toggle",
    label: "Vary building colour",
    help: "Shifts each building's colour a little from the buildings colour. Only the preview and the OBJ export carry per-building colour; every other target prints the region's slot colour.",
    writes: ["colour.tint.enabled"],
    testId: "colour_tint_enabled",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour_tint_hue",
    group: "colour",
    kind: "slider",
    label: "Hue range",
    help: "How far a building's hue may drift either way, up to 60 degrees.",
    writes: ["colour.tint.hue_range_deg"],
    testId: "colour_tint_hue",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour_tint_lightness",
    group: "colour",
    kind: "slider",
    label: "Lightness range",
    help: "How far a building's lightness may drift either way, up to half.",
    writes: ["colour.tint.lightness_range"],
    testId: "colour_tint_lightness",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour-tint-reroll",
    group: "colour",
    kind: "button",
    label: "Reroll",
    help: "Draws a new seed, so every building takes a different shift within the same two ranges.",
    writes: ["colour.tint.seed"],
    testId: "colour-tint-reroll",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour_gradient_enabled",
    group: "colour",
    kind: "toggle",
    label: "Band buildings by height",
    help: "Splits the buildings into height bands, each band a region of its own on its own filament slot.",
    writes: ["colour.gradient.enabled"],
    testId: "colour_gradient_enabled",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour_gradient_bands",
    group: "colour",
    kind: "slider",
    label: "Bands",
    help: "How many height bands the buildings are cut into, capped at eight and at the printer profile's filament count.",
    writes: ["colour.gradient.slots"],
    testId: "colour_gradient_bands",
    source: COLOUR_SOURCE,
  },
  {
    id: "colour-gradient-band-slot-*",
    group: "colour",
    kind: "select",
    label: "Band filament slot",
    help: "Which filament slot this height band prints from.",
    writes: ["colour.gradient.slots"],
    testId: "colour-gradient-band-slot-*",
    source: COLOUR_SOURCE,
  },

  // -- Printer -------------------------------------------------------------
  {
    id: "printer_profile",
    group: "printer",
    kind: "select",
    label: "Printer profile",
    help: "Applies its plate size and nozzle once, on selection. It also fixes the height ceiling and the filament count the colour warnings check against, and it is named in the exported file.",
    // `store.setPrinterProfile` spreads `printers.ts:profileApplyPatch`, which
    // returns the plate and the nozzle alongside the id, so the machine-
    // readable column has to say so too.
    writes: ["plate_mm", "nozzle_mm", "printer_profile"],
    testId: "printer_profile",
    source: PRINTER_SOURCE,
  },
  {
    id: "custom_profile_plate_x_mm",
    group: "printer",
    kind: "slider",
    label: "Plate width",
    help: "Your build plate across. A model wider than this is reported as not fitting the plate.",
    writes: ["custom_profile.plate_x_mm"],
    testId: "custom_profile_plate_x_mm",
    source: PRINTER_SOURCE,
  },
  {
    id: "custom_profile_plate_y_mm",
    group: "printer",
    kind: "slider",
    label: "Plate depth",
    help: "Your build plate front to back. A model deeper than this is reported as not fitting the plate.",
    writes: ["custom_profile.plate_y_mm"],
    testId: "custom_profile_plate_y_mm",
    source: PRINTER_SOURCE,
  },
  {
    id: "custom_profile_max_height_mm",
    group: "printer",
    kind: "slider",
    label: "Height ceiling",
    help: "The tallest object this printer can build. A taller model is reported as too tall, and the preview's height readout follows it.",
    writes: ["custom_profile.max_height_mm"],
    testId: "custom_profile_max_height_mm",
    source: PRINTER_SOURCE,
  },
  {
    id: "custom_profile_slots",
    group: "printer",
    kind: "slider",
    label: "Filament slots",
    help: "How many filaments this printer can load. It bounds the height bands and drives the Colour group's slot warning and merge.",
    writes: ["custom_profile.slots"],
    testId: "custom_profile_slots",
    source: PRINTER_SOURCE,
  },
  {
    id: "custom_profile_change_gcode",
    group: "printer",
    kind: "text",
    label: "Colour-change command",
    help: "The command written at each filament swap in the colour-change export.",
    writes: ["custom_profile.change_gcode"],
    testId: "custom_profile_change_gcode",
    source: PRINTER_SOURCE,
  },
  {
    id: "tiling_enabled",
    group: "printer",
    kind: "toggle",
    label: "Split into tiles",
    help: "Cuts the finished model into a grid of interlocking tiles, each exported as its own object so it fits the plate.",
    writes: ["tiling.enabled"],
    testId: "tiling_enabled",
    source: PRINTER_SOURCE,
  },
  {
    id: "tiling_cols",
    group: "printer",
    kind: "slider",
    label: "Columns",
    help: "How many tiles across the plate is cut into.",
    writes: ["tiling.cols"],
    testId: "tiling_cols",
    source: PRINTER_SOURCE,
  },
  {
    id: "tiling_rows",
    group: "printer",
    kind: "slider",
    label: "Rows",
    help: "How many tiles front to back the plate is cut into.",
    writes: ["tiling.rows"],
    testId: "tiling_rows",
    source: PRINTER_SOURCE,
  },
  {
    id: "tiling_joint",
    group: "printer",
    kind: "select",
    label: "Joint",
    help: "How neighbouring tiles key together: a dovetail cut through the seam, or a pin standing in a socket.",
    writes: ["tiling.joint"],
    testId: "tiling_joint",
    source: PRINTER_SOURCE,
  },
  {
    id: "tiling_tolerance_mm",
    group: "printer",
    kind: "slider",
    label: "Joint tolerance",
    help: "Clearance cut into every joint so two printed tiles actually push together.",
    writes: ["tiling.tolerance_mm"],
    testId: "tiling_tolerance_mm",
    source: PRINTER_SOURCE,
  },
  {
    id: "tiling_index_mark",
    group: "printer",
    kind: "toggle",
    label: "Mark tile index",
    help: "Cuts a small column and row number into each tile, so they go back together in the right order.",
    writes: ["tiling.index_mark"],
    testId: "tiling_index_mark",
    source: PRINTER_SOURCE,
  },

  // -- The viewport's right-click inspector (v3.1 Task 11) -----------------
  //
  // Not part of the panel: it opens on the object under the pointer and closes
  // again, so it is in the `output` group the way the group headers are - "not
  // a field in a settings group" - and writes `object-override` rather than
  // naming leaves, which keeps `object_overrides` out of every section's own
  // reset. A section reset that wiped every per-object decision would be a
  // surprise no label on it could undo.
  {
    id: "inspector-*",
    group: "output",
    kind: "button",
    label: "Object action",
    help: "One decision about the object you right-clicked: mark it a hero, leave it out of the model, print this road engraved, and so on. Only the actions its kind can act on are offered.",
    writes: "object-override",
    testId: "inspector-*",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "inspector-back",
    group: "output",
    kind: "button",
    label: "Back to the object menu",
    help: "Leaves a value view and returns to the list of actions. Escape does the same, and a second Escape closes the menu.",
    writes: "viewer",
    testId: "inspector-back",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-height-scale",
    group: "output",
    kind: "slider",
    label: "This building's height",
    help: "Multiplies one building's OpenStreetMap height before every other height rule, so the block repair, the tall-building split and the exaggeration curve all see the number you asked for.",
    writes: "object-override",
    testId: "override-height-scale",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-width-scale",
    group: "output",
    kind: "slider",
    label: "This road's width",
    help: "Multiplies one road's ground width alongside the road-width slider. A road scaled below the minimum wall still prints at one, because a ribbon thinner than the nozzle is a scratch.",
    writes: "object-override",
    testId: "override-width-scale",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-raise-mm",
    group: "output",
    kind: "slider",
    label: "This polygon's raise",
    help: "Moves one water or green polygon's top face relative to the rest of its layer: negative sinks it further, positive raises it.",
    writes: "object-override",
    testId: "override-raise-mm",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-slot",
    group: "output",
    kind: "select",
    label: "This object's filament slot",
    help: "Prints one object from a slot of its own. At most four objects may have a filament to themselves; objects given the same colour share one.",
    writes: "object-override",
    testId: "override-slot",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-color",
    group: "output",
    kind: "colour",
    label: "This object's filament colour",
    help: "The colour the file gives one object's own part, independent of the colour its layer prints in.",
    writes: "object-override",
    testId: "override-color",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-color-clear",
    group: "output",
    kind: "button",
    label: "Use the layer's colour",
    help: "Gives one object its layer's filament colour back, leaving any slot it was given alone.",
    writes: "object-override",
    testId: "override-color-clear",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-tint",
    group: "output",
    kind: "colour",
    label: "This building's shade",
    help: "A shade of one building's own filament. Preview and OBJ only, like the tint switch: a printer lays down whatever is in the slot.",
    writes: "object-override",
    testId: "override-tint",
    source: INSPECTOR_SOURCE,
  },
  {
    id: "override-tint-clear",
    group: "output",
    kind: "button",
    label: "No shade",
    help: "Takes one building's own shade off, leaving the tint switch's own jitter to apply as it would.",
    writes: "object-override",
    testId: "override-tint-clear",
    source: INSPECTOR_SOURCE,
  },

  // -- The surface labels' card (v3.1 Task 12) -----------------------------
  //
  // Docked in the viewport like the inspector, and for the same reason: a
  // label is placed on an object in the 3D view (the inspector's "Label ..."
  // row, catalogued above under `inspector-*`) and dragged there; this card
  // names and sets the one that is selected. Same `object-override` target,
  // so no section reset can wipe a placed label.
  {
    id: "label-row-*",
    group: "output",
    kind: "button",
    label: "Select a label",
    help: "Selects one placed label so its handle, its fields and the keyboard act on it; the same button again deselects it. Arrow keys nudge it, [ and ] turn it, + and - resize it, Delete removes it.",
    writes: "viewer",
    testId: "label-row-*",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_text",
    group: "output",
    kind: "text",
    label: "Text",
    help: "What the label says. Empty means the object's own OpenStreetMap name, which is what the placeholder shows.",
    writes: "object-override",
    testId: "label_*_text",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_size",
    group: "output",
    kind: "slider",
    label: "Cap height",
    help: "The letter height in millimetres. A label that does not fit its roof or street at this size is shrunk to the largest that does and says so; below the size the nozzle can cut it is refused with the size that would work.",
    writes: "object-override",
    testId: "label_*_size",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_mode",
    group: "output",
    kind: "segmented",
    label: "Cut",
    help: "Engrave cuts the letters into the face; emboss stands them proud of it.",
    writes: "object-override",
    testId: "label_*_mode",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_depth",
    group: "output",
    kind: "slider",
    label: "Depth",
    help: "How deep an engraved label goes, or how high an embossed one stands, in millimetres.",
    writes: "object-override",
    testId: "label_*_depth",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_font",
    group: "output",
    kind: "select",
    label: "Face",
    help: "The typeface the letters are cut from: the same three the frame lettering offers.",
    writes: "object-override",
    testId: "label_*_font",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_rotation",
    group: "output",
    kind: "slider",
    label: "Turn",
    help: "The reading direction, in degrees from the object's own long axis (or a street's direction). Zero reads along it.",
    writes: "object-override",
    testId: "label_*_rotation",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_follow",
    group: "output",
    kind: "toggle",
    label: "Follow the street",
    help: "Sets each letter along the street's centreline so the name bends with it. A bend too tight for the letters is refused and the name set straight, with the reason shown.",
    writes: "object-override",
    testId: "label_*_follow",
    source: LABELS_SOURCE,
  },
  {
    id: "label_*_remove",
    group: "output",
    kind: "button",
    label: "Remove label",
    help: "Takes this label off the model. Undo brings it back.",
    writes: "object-override",
    testId: "label_*_remove",
    source: LABELS_SOURCE,
  },

  // -- Panel and output ----------------------------------------------------
  {
    id: "group-*-toggle",
    group: "output",
    kind: "button",
    label: "Group header",
    help: "Folds a group of settings away. A collapsed group is unmounted, not hidden, and the choice is remembered in this browser.",
    writes: "viewer",
    testId: "group-*-toggle",
    source: COLLAPSIBLE_SOURCE,
  },
  {
    id: "group-*-reset",
    group: "output",
    kind: "button",
    label: "Reset section",
    help: "Puts this group's own fields back to the contract's default, in one step that Undo takes back as one. No other group is touched.",
    writes: "section-parameters",
    testId: "group-*-reset",
    source: COLLAPSIBLE_SOURCE,
  },
  {
    id: "settings-search",
    group: "output",
    kind: "text",
    label: "Search settings",
    help: "Finds a control by its name or by what it does, across every group, and opens the groups the matches are in. Press the slash key to jump here.",
    writes: "viewer",
    testId: "settings-search",
    source: SEARCH_SOURCE,
  },
  {
    id: "settings-search-clear",
    group: "output",
    kind: "button",
    label: "Clear",
    help: "Empties the search box and puts every group back the way it was before the search opened any of them.",
    writes: "viewer",
    testId: "settings-search-clear",
    source: SEARCH_SOURCE,
  },
  {
    id: "settings-search-empty-clear",
    group: "output",
    kind: "button",
    label: "Clear the search",
    help: "Offered where nothing matched, so a dead end is one keystroke away from the whole panel again.",
    writes: "viewer",
    testId: "settings-search-empty-clear",
    source: SEARCH_SOURCE,
  },
  {
    id: "search-hit-*",
    group: "output",
    kind: "button",
    label: "Matching control",
    help: "Scrolls to the control this row found and puts the keyboard on it, inside whichever group holds it.",
    writes: "viewer",
    testId: "search-hit-*",
    source: SEARCH_SOURCE,
  },
  {
    id: "changes-chip",
    group: "output",
    kind: "button",
    label: "Changed from default",
    help: "How many settings differ from the contract's defaults, and a list of them with what each one was and what it is now.",
    writes: "viewer",
    testId: "changes-chip",
    source: CHANGES_SOURCE,
  },
  {
    id: "changes-revert-*",
    group: "output",
    kind: "button",
    label: "Revert",
    help: "Puts this one setting back to its default and leaves every other change in place.",
    writes: "section-parameters",
    testId: "changes-revert-*",
    source: CHANGES_SOURCE,
  },
  {
    id: "reset-button",
    group: "output",
    kind: "button",
    label: "Reset all",
    help: "Puts every setting back to the contract's default. The location, the pin and the fetched data are left alone.",
    writes: "all-parameters",
    testId: "reset-button",
    source: PANEL_SOURCE,
  },
  {
    id: "group-output-toggle",
    group: "output",
    kind: "button",
    label: "Output",
    help: "Folds the results away. The Preview and Export actions stay on screen either way.",
    writes: "viewer",
    testId: "group-output-toggle",
    source: PANEL_SOURCE,
  },
  {
    id: "export_target",
    group: "output",
    kind: "select",
    label: "Export format",
    help: "Which file Export writes: a Bambu project, a generic 3MF, an STL, a zip of one STL per part, an OBJ, a STEP, or a colour-change 3MF.",
    writes: ["export_target"],
    testId: "export-target-select",
    source: EXPORT_MENU_SOURCE,
  },
] as const;

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

const BY_ID: ReadonlyMap<string, ControlSpec> = new Map(
  CONTROLS.map((control) => [control.id, control]),
);

const SECTION_BY_ID: ReadonlyMap<string, SectionSpec> = new Map(
  SECTIONS.map((section) => [section.id, section]),
);

/** The catalog row for a control id. Throws for an id that has no row. */
export function control(id: string): ControlSpec {
  const spec = BY_ID.get(id);
  if (spec === undefined) throw new Error(`controlCatalog: no control named ${id}`);
  return spec;
}

/** The catalog row for a section id. Throws for an id that has no row. */
export function section(id: string): SectionSpec {
  const spec = SECTION_BY_ID.get(id);
  if (spec === undefined) throw new Error(`controlCatalog: no section named ${id}`);
  return spec;
}

/**
 * The three props every `Controls` primitive takes, for a control whose DOM id
 * is its catalog id. One call site per control, so a label or a help string
 * can only ever come from this file.
 */
export function labelled(id: string): { id: string; label: string; hint: string } {
  const spec = control(id);
  return { id: spec.id, label: spec.label, hint: spec.help };
}

/**
 * The same, for a control rendered once per item: the catalog row is keyed by
 * the `*` form and the rendered element takes the concrete id.
 */
export function labelledAs(
  catalogId: string,
  domId: string,
): { id: string; label: string; hint: string } {
  const spec = control(catalogId);
  return { id: domId, label: spec.label, hint: spec.help };
}

/** The section's props for `Controls.Field`. */
export function sectionProps(id: string): { label: string; hint: string } {
  const spec = section(id);
  return { label: spec.label, hint: spec.help };
}

/** Every control in one group, in catalog order. */
export function controlsInGroup(group: GroupId): readonly ControlSpec[] {
  return CONTROLS.filter((spec) => spec.group === group);
}

/** Every `PrintParams` leaf some control writes, de-duplicated, in schema order. */
export function controlledPaths(): readonly PrintParamPath[] {
  const named = new Set<string>();
  for (const spec of CONTROLS) {
    if (typeof spec.writes === "string") continue;
    for (const path of spec.writes) named.add(path);
  }
  return PRINT_PARAM_LEAF_PATHS.filter((path) => named.has(path));
}

/** Every control that writes `path`, in catalog order. */
export function controlsWriting(path: PrintParamPath): readonly ControlSpec[] {
  return CONTROLS.filter(
    (spec) => typeof spec.writes !== "string" && spec.writes.includes(path),
  );
}
