/**
 * The `.framecraft` project file: round trip, filename, migration from every
 * legacy form, and refusal of anything that is not a well-formed FrameCraft
 * project ([V3-P6], extension and envelope revised for v3.1 Task 13).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { resetCameraForTest, useCameraStore } from "@/store/camera";

import { PARAM_LIMITS, PARAM_RANGES, defaultPrintParams, type PrintParams } from "./contracts";
import type { LayoutPayload, LayoutState } from "./layout";
import type { LocationState } from "@/store/editor";
import {
  LEGACY_PROJECT_FILE_EXTENSION,
  PROJECT_FILE_ACCEPT,
  PROJECT_FILE_EXTENSION,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  buildProject,
  isLegacyProjectFilename,
  migrationNotice,
  parseProject,
  projectFilename,
  serializeProject,
} from "./project";
import { COPYRIGHT_HOLDER, appVersion } from "./version";

const LOCATION: LocationState = {
  lat: 41.8827,
  lon: -87.6233,
  radius_m: 900,
  rotation_deg: 45,
  preset_id: "chicago-loop",
};

const SAVED_AT = new Date("2026-08-29T12:00:00.000Z");

describe("buildProject / serializeProject", () => {
  it("carries the whole location and the whole PrintParams object", () => {
    const params = { ...defaultPrintParams(), city_label: "Chicago", plate_mm: 200 };
    const project = buildProject(LOCATION, params, SAVED_AT);
    expect(project.format).toBe(PROJECT_FORMAT);
    expect(project.version).toBe(PROJECT_VERSION);
    expect(project.saved_at).toBe("2026-08-29T12:00:00.000Z");
    expect(project.pin).toEqual({ lat: LOCATION.lat, lon: LOCATION.lon });
    expect(project.radius_m).toBe(900);
    expect(project.rotation_deg).toBe(45);
    expect(project.preset_id).toBe("chicago-loop");
    expect(project.place).toBe("Chicago");
    expect(project.params).toEqual(params);
    expect(project.app_version).toBe(appVersion());
  });

  it("serializes to readable, indented JSON", () => {
    const project = buildProject(LOCATION, defaultPrintParams(), SAVED_AT);
    const text = serializeProject(project);
    expect(text).toContain("\n");
    expect(JSON.parse(text)).toEqual(project);
  });
});

describe("projectFilename", () => {
  it("uses the place name, lower-cased and hyphenated, plus the save date", () => {
    const project = buildProject(
      LOCATION,
      { ...defaultPrintParams(), city_label: "Chicago" },
      SAVED_AT,
    );
    expect(projectFilename(project)).toBe("chicago-2026-08-29.framecraft");
  });

  it("falls back to 'framecraft' when there is no place name", () => {
    const project = buildProject(LOCATION, defaultPrintParams(), SAVED_AT);
    expect(projectFilename(project)).toBe("framecraft-2026-08-29.framecraft");
  });

  it("strips characters a filesystem would not accept", () => {
    const project = buildProject(
      LOCATION,
      { ...defaultPrintParams(), city_label: "São Paulo / Brazil?" },
      SAVED_AT,
    );
    expect(projectFilename(project)).toMatch(/^s-o-paulo-brazil-2026-08-29\.framecraft$/);
    expect(projectFilename(project)).not.toMatch(/[/\\?]/);
  });

  it("never writes the legacy double extension again", () => {
    const project = buildProject(LOCATION, defaultPrintParams(), SAVED_AT);
    expect(projectFilename(project).endsWith(PROJECT_FILE_EXTENSION)).toBe(true);
    expect(isLegacyProjectFilename(projectFilename(project))).toBe(false);
  });
});

/**
 * The file picker has to OFFER both extensions or the "load accepts both"
 * promise is one a user cannot reach: a picker filtered to `.framecraft`
 * alone greys out every file FrameCraft 3.0 ever wrote.
 */
describe("PROJECT_FILE_ACCEPT", () => {
  it("offers the current extension, the legacy one, and the .json the legacy one really is", () => {
    const offered = PROJECT_FILE_ACCEPT.split(",");
    expect(offered).toContain(PROJECT_FILE_EXTENSION);
    expect(offered).toContain(LEGACY_PROJECT_FILE_EXTENSION);
    // Only the LAST extension of `design.framecraft.json` reaches an OS file
    // filter, so without this entry the legacy files are unselectable.
    expect(offered).toContain(".json");
  });
});

describe("parseProject: round trip", () => {
  it("restores exactly the location and params that were saved", () => {
    const params = {
      ...defaultPrintParams(),
      city_label: "Chicago",
      plate_mm: 220,
      frame: true,
      engravings: [{ edge: "bottom" as const, text: "{city}" }],
    };
    const project = buildProject(LOCATION, params, SAVED_AT);
    const decoded = parseProject(serializeProject(project));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.location).toEqual(LOCATION);
    expect(decoded.params).toEqual(params);
  });

  it("restores a null preset id", () => {
    const project = buildProject(
      { ...LOCATION, preset_id: null },
      defaultPrintParams(),
      SAVED_AT,
    );
    const decoded = parseProject(serializeProject(project));
    expect(decoded.ok && decoded.location.preset_id).toBeNull();
  });

  /**
   * A file per supported `PrintParams.schema_version`.
   *
   * `PROJECT_VERSION` is the FILE format's own tag and moves for its own
   * reasons; the payload inside carries the contract revision it was written
   * against, and a file saved before a contract bump has to keep loading and
   * has to keep saying which revision it was. Loading validates through
   * `parsePrintParams` (`lib/share.ts`), the same door a share link comes in
   * by, so a version the validator's literal set does not name is refused
   * outright -- which is exactly how a saved v4 file broke the moment the
   * contract's default moved to 4 and that set still read {2, 3}.
   */
  for (const version of [2, 3, 4] as const) {
    it(`round-trips a project saved against schema_version ${version}`, () => {
      const params = {
        ...defaultPrintParams(),
        schema_version: version,
        city_label: "Chicago",
        plate_mm: 200,
      };
      const decoded = parseProject(serializeProject(buildProject(LOCATION, params, SAVED_AT)));
      expect(decoded.ok, `schema_version ${version} was refused`).toBe(true);
      if (!decoded.ok) return;
      // Not silently migrated: the file still says what it was written against.
      expect(decoded.params.schema_version).toBe(version);
      expect(decoded.params).toEqual(params);
      expect(decoded.location).toEqual(LOCATION);
    });
  }

  it("refuses a project claiming a contract revision this build does not know", () => {
    const project = buildProject(LOCATION, defaultPrintParams(), SAVED_AT);
    const text = JSON.stringify({
      ...project,
      params: { ...project.params, schema_version: 5 },
    });
    const decoded = parseProject(text);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.reason).toContain("schema_version");
  });
});

/**
 * A MAXIMAL project: every optional block set, every list at the contract's
 * `maxItems`, every string at its `maxLength`, and the layout and the
 * unmodelled blocks alongside them.
 *
 * The point is not that a user would build this. It is that the round trip is
 * asserted against a payload where nothing is left at its default, so a field
 * this module drops, truncates, reorders or quietly re-defaults has nowhere to
 * hide: a test built on defaults passes just as happily when the reader
 * ignores a block entirely and refills it from `defaultPrintParams()`.
 */
function maximalParams(): PrintParams {
  const text = (n: number, seed: string): string => seed.repeat(n).slice(0, n);
  const R = PARAM_RANGES;
  const L = PARAM_LIMITS;
  return {
    ...defaultPrintParams(),
    schema_version: 4,
    plate_mm: R.plate_mm.max,
    base_thickness_mm: R.base_thickness_mm.max,
    nozzle_mm: R.nozzle_mm.max,
    small_scale: R.small_scale.max,
    large_scale: R.large_scale.max,
    terrain_exaggeration: R.terrain_exaggeration.max,
    road_mode: "emboss",
    road_scale: R.road_scale.max,
    trees: false,
    water: false,
    frame: true,
    city_label: text(L.city_label.max_length, "Chicago Loop "),
    color_mode: "parts",
    part_colors: {
      base: "#111111",
      frame: "#222222",
      buildings: "#333333",
      roads: "#444444",
      water: "#555555",
      green: "#666666",
      trees: "#777777",
    },
    engravings: Array.from({ length: L.engravings.max_items }, (_, i) => ({
      edge: (["top", "bottom", "left", "right", "underside"] as const)[i % 5],
      align: (["start", "center", "end"] as const)[i % 3],
      text: text(L.engravings.text.max_length, `line ${i} `),
      mode: (["engrave", "emboss", "inlay"] as const)[i % 3],
      size_mm: R.engravings.size_mm.max,
      depth_mm: R.engravings.depth_mm.max,
      font: (["sans", "serif", "mono"] as const)[i % 3],
    })),
    north_arrow: { enabled: true, corner: "sw", size_mm: R.north_arrow.size_mm.max },
    scale_bar: {
      enabled: true,
      edge: "left",
      length_mode: "fixed",
      length_m: R.scale_bar.length_m.max,
    },
    hanger: "magnets",
    underside_mark: {
      enabled: true,
      template: text(L.underside_mark.template.max_length, "{city} {scale} {date} "),
    },
    hero_building_ids: Array.from(
      { length: L.hero_building_ids.max_items },
      (_, i) => `way/${1000000000 + i}`,
    ),
    hero_mode: "both",
    place: {
      country: text(L.place.country.max_length, "Kingdom of the Netherlands "),
      state: text(L.place.state.max_length, "North Holland "),
      neighbourhood: text(L.place.neighbourhood.max_length, "Grachtengordel "),
      author: text(L.place.author.max_length, "V. Alizadeh "),
    },
    regions: {
      roads: { depth_mm: R.regions.roads.depth_mm.max, proud_mm: R.regions.roads.proud_mm.max },
      water: { depth_mm: R.regions.water.depth_mm.max, proud_mm: R.regions.water.proud_mm.min },
      parks: { depth_mm: R.regions.parks.depth_mm.max, proud_mm: R.regions.parks.proud_mm.max },
      rail: {
        depth_mm: R.regions.rail.depth_mm.max,
        proud_mm: R.regions.rail.proud_mm.max,
        width_m: R.regions.rail.width_m.max,
      },
      building_skirt_mm: R.regions.building_skirt_mm.max,
    },
    colour: {
      region_slots: {
        base: R.colour.region_slots.base.max,
        frame: R.colour.region_slots.frame.max,
        matting: R.colour.region_slots.matting.max,
        buildings: R.colour.region_slots.buildings.max,
        hero_building: R.colour.region_slots.hero_building.max,
        roads: R.colour.region_slots.roads.max,
        water: R.colour.region_slots.water.max,
        parks: R.colour.region_slots.parks.max,
        rail: R.colour.region_slots.rail.max,
        lettering: R.colour.region_slots.lettering.max,
        attribution: R.colour.region_slots.attribution.max,
      },
      region_colors: {
        base: "#0A0A0A",
        frame: "#1B1B1B",
        matting: "#2C2C2C",
        buildings: "#3D3D3D",
        hero_building: "#4E4E4E",
        roads: "#5F5F5F",
        water: "#607080",
        parks: "#718191",
        rail: "#8292A2",
        lettering: "#93A3B3",
        attribution: "#A4B4C4",
      },
      palette: text(L.colour.palette.max_length, "midnight-atlas "),
      tint: {
        enabled: true,
        hue_range_deg: R.colour.tint.hue_range_deg.max,
        lightness_range: R.colour.tint.lightness_range.max,
        seed: 4242,
      },
      gradient: {
        enabled: true,
        slots: Array.from({ length: L.colour.gradient.slots.max_items }, (_, i) => i + 1),
      },
      preview_theme: "light",
    },
    printer_profile: "custom",
    custom_profile: {
      plate_x_mm: R.custom_profile.plate_x_mm.max,
      plate_y_mm: R.custom_profile.plate_y_mm.max,
      max_height_mm: R.custom_profile.max_height_mm.max,
      nozzle_mm: R.custom_profile.nozzle_mm.max,
      slots: R.custom_profile.slots.max,
      change_gcode: "M600 ; swap filament\nG1 X0 Y0 F3000\n".repeat(12),
    },
    export_target: "color-change-3mf",
    terrain: { enabled: true, smoothing: R.terrain.smoothing.max },
    heights: {
      floor_height_m: R.heights.floor_height_m.max,
      unknown_default_m: R.heights.unknown_default_m.max,
      type_defaults: {
        house: 7,
        apartments: 17,
        commercial: 13,
        retail: 9,
        industrial: 11,
        garage: 4,
      },
    },
    bridges: { enabled: true, clearance_mm: R.bridges.clearance_mm.max, abutments: true },
    height_exaggeration: {
      multiplier: R.height_exaggeration.multiplier.max,
      curve: R.height_exaggeration.curve.max,
    },
    hero_auto: { enabled: true, count: R.hero_auto.count.max },
    tiling: {
      enabled: true,
      cols: R.tiling.cols.max,
      rows: R.tiling.rows.max,
      joint: "dovetail",
      tolerance_mm: R.tiling.tolerance_mm.max,
      index_mark: true,
    },
    frame_style: {
      profile: "ogee",
      corner: "rounded",
      corner_radius_mm: R.frame_style.corner_radius_mm.max,
      lip_depth_mm: R.frame_style.lip_depth_mm.max,
      shadow_gap: {
        enabled: true,
        width_mm: R.frame_style.shadow_gap.width_mm.max,
        depth_mm: R.frame_style.shadow_gap.depth_mm.max,
      },
      matting: {
        enabled: true,
        width_mm: R.frame_style.matting.width_mm.max,
        proud_mm: R.frame_style.matting.proud_mm.max,
      },
      separate: {
        enabled: true,
        mount: "magnet",
        tolerance_mm: R.frame_style.separate.tolerance_mm.max,
      },
      texture: {
        pattern: "knurl",
        scale_mm: R.frame_style.texture.scale_mm.max,
        depth_mm: R.frame_style.texture.depth_mm.max,
      },
    },
    hanger_magnet: {
      diameter_mm: R.hanger_magnet.diameter_mm.max,
      thickness_mm: R.hanger_magnet.thickness_mm.max,
      count: R.hanger_magnet.count.max,
    },
    /*
      Per-object overrides and surface labels (Tasks 11 and 12) are PRINT
      PARAMETERS, not envelope blocks: they landed inside `PrintParams`, so a
      project file carries them the same way it carries a plate size, and this
      module needed no field of its own for either. Both are at their
      `maxItems` here with every optional member set, so the round trip is
      asserted on the two lists that can actually grow with the scene.
    */
    object_overrides: Array.from({ length: L.object_overrides.max_items }, (_, i) => ({
      osm_id: `way/${1000000000 + i}`,
      layer: (["building", "road", "water", "green"] as const)[i % 4],
      hidden: i % 2 === 0,
      height_scale: R.object_overrides.height_scale.max,
      hero: (["inherit", "on", "off"] as const)[i % 3],
      tint: "#8899AA",
      slot: R.object_overrides.slot.max,
      color: "#AABBCC",
      road_mode: (["inherit", "engrave", "emboss", "off"] as const)[i % 4],
      width_scale: R.object_overrides.width_scale.max,
      raise_mm: R.object_overrides.raise_mm.max,
    })),
    labels: Array.from({ length: L.labels.max_items }, (_, i) => ({
      target_osm_id: `way/${2000000000 + i}`,
      layer: (["building", "road", "water", "green"] as const)[i % 4],
      surface: (["building_top", "ground"] as const)[i % 2],
      u: R.labels.u.max,
      v: R.labels.v.max,
      rotation_deg: R.labels.rotation_deg.max,
      size_mm: R.labels.size_mm.max,
      mode: (["engrave", "emboss"] as const)[i % 2],
      depth_mm: R.labels.depth_mm.max,
      font: (["sans", "serif", "mono"] as const)[i % 3],
      text: text(L.labels.text.max_length, `label ${i} `),
      follow: i % 2 === 0,
    })),
  };
}

/**
 * A top-level block this build does not model, standing in for whatever a
 * FUTURE FrameCraft adds beside `params` and `layout`.
 *
 * The two blocks this task was told to expect -- object overrides and surface
 * labels -- turned out to be print parameters and ride inside `params`, so
 * this channel is what is left: it is what stops an older build from silently
 * deleting a newer build's work the next time the user presses Save.
 */
/*
  Two blocks a LATER FrameCraft might write beside `params`, neither of which
  this build models.

  The second used to be `camera`, which stopped being hypothetical when
  `[V3.1-U6]` gave the envelope a real camera block: it is a known key now, so
  it is consumed rather than kept, and the test was asserting the opposite. A
  fixture standing in for "a field from the future" has to name a field that is
  actually still in the future, so it was renamed rather than the assertion
  loosened.
*/
const FUTURE_BLOCKS = {
  annotations: [{ id: "note-1", text: "a block from a later FrameCraft" }],
  print_queue: { printer: "a name this build has never heard of", copies: 3 },
} as const;

/** A non-default framing: both boundaries moved and the settings column collapsed. */
const MAXIMAL_LAYOUT: LayoutPayload = { map: 512, settings: 420, collapsed: ["settings"] };

/** What `MAXIMAL_LAYOUT` restores to. */
const MAXIMAL_LAYOUT_STATE: LayoutState = {
  sizes: { map: 512, settings: 420 },
  collapsed: { map: false, settings: true },
  maximized: null,
};

describe("parseProject: a maximal project", () => {
  it("round-trips every setting, the layout and the unmodelled blocks unchanged", () => {
    const params = maximalParams();
    const project = buildProject(LOCATION, params, SAVED_AT, MAXIMAL_LAYOUT, FUTURE_BLOCKS);
    const text = serializeProject(project);
    const decoded = parseProject(text, `chicago-2026-08-29${PROJECT_FILE_EXTENSION}`);

    expect(decoded.ok ? "ok" : decoded.reason).toBe("ok");
    if (!decoded.ok) return;
    expect(decoded.location).toEqual(LOCATION);
    expect(decoded.params).toEqual(params);
    expect(decoded.layout).toEqual(MAXIMAL_LAYOUT_STATE);
    expect(decoded.extras).toEqual(FUTURE_BLOCKS);
    expect(decoded.savedBy).toBe(appVersion());
    expect(decoded.migrated).toBeNull();
  });

  it("survives a second trip, so saving a loaded project changes nothing", () => {
    const params = maximalParams();
    const first = serializeProject(
      buildProject(LOCATION, params, SAVED_AT, MAXIMAL_LAYOUT, FUTURE_BLOCKS),
    );
    const decoded = parseProject(first);
    expect(decoded.ok ? "ok" : decoded.reason).toBe("ok");
    if (!decoded.ok) return;
    const second = serializeProject(
      buildProject(decoded.location, decoded.params, SAVED_AT, MAXIMAL_LAYOUT, decoded.extras),
    );
    expect(second).toBe(first);
  });

  it("carries the camera, and hands it to the viewport when the file is opened", () => {
    resetCameraForTest();
    const camera = { p: [207, 247.25, 273.13] as [number, number, number], t: [0, 0, 0] as [number, number, number] };
    const text = serializeProject(
      buildProject(LOCATION, defaultPrintParams(), SAVED_AT, MAXIMAL_LAYOUT, {}, camera),
    );
    expect(JSON.parse(text).camera).toEqual(camera);
    const decoded = parseProject(text);
    expect(decoded.ok ? "ok" : decoded.reason).toBe("ok");
    // Adopted as a side effect, like the layout: the document carries it, so
    // opening the document restores it, through either door into the editor.
    expect(useCameraStore.getState().pendingPose()).toEqual({
      position: [207, 247.25, 273.13],
      target: [0, 0, 0],
    });
  });

  it("keeps `camera` out of the extras now that the envelope models it", () => {
    resetCameraForTest();
    const camera = { p: [1, 2, 3] as [number, number, number], t: [0, 0, 0] as [number, number, number] };
    const text = serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT, null, {}, camera));
    const decoded = parseProject(text);
    expect(decoded.ok ? "ok" : decoded.reason).toBe("ok");
    if (!decoded.ok) return;
    // A known key is consumed, never carried through as an unmodelled block --
    // otherwise saving again would write it twice and the two could disagree.
    expect(decoded.extras).toEqual({});
  });

  it("opens a file with no camera at all without touching this device's view", () => {
    resetCameraForTest();
    useCameraStore.getState().reportPose({ position: [9, 9, 9], target: [0, 0, 0] });
    const text = serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT, null, {}, null));
    expect("camera" in JSON.parse(text)).toBe(false);
    expect(parseProject(text).ok).toBe(true);
    expect(useCameraStore.getState().pendingPose()).toBeNull();
  });

  it("is small enough that a plain-JSON container needs no compression", () => {
    const text = serializeProject(
      buildProject(LOCATION, maximalParams(), SAVED_AT, MAXIMAL_LAYOUT, FUTURE_BLOCKS),
    );
    // Measured at 19 907 bytes (gzip -9 would make it 2 076). The bound is a
    // change detector for the container decision, not a tuning knob: if a
    // maximal project ever approaches a megabyte, gzip stops being a bad
    // trade and this test is where that conversation starts.
    expect(new TextEncoder().encode(text).length).toBeLessThan(64 * 1024);
  });

  it("keeps the writer from letting an unmodelled block overwrite a modelled one", () => {
    const project = buildProject(LOCATION, defaultPrintParams(), SAVED_AT, null, {
      version: 99,
      params: { plate_mm: 1 },
      radius_m: -5,
      annotations: ["kept"],
    });
    expect(project.version).toBe(PROJECT_VERSION);
    expect(project.radius_m).toBe(LOCATION.radius_m);
    expect(project.params).toEqual(defaultPrintParams());
    expect((project as Record<string, unknown>).annotations).toEqual(["kept"]);
  });
});

/**
 * One test per legacy form a load has to accept.
 *
 * "Migrating silently" means the file loads without a question and without a
 * refusal; it does NOT mean the user is left guessing why the next save writes
 * a differently named file, which is what `migrated` says once.
 */
describe("parseProject: migration from the legacy forms", () => {
  /** A FrameCraft 3.0 envelope: version 3, and no `app_version` field at all. */
  function legacyEnvelope(): Record<string, unknown> {
    const current = JSON.parse(
      serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT)),
    ) as Record<string, unknown>;
    delete current.app_version;
    current.version = 3;
    return current;
  }

  it("loads a version-3 envelope and says it was migrated", () => {
    const result = parseProject(JSON.stringify(legacyEnvelope()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.location).toEqual(LOCATION);
    expect(result.params).toEqual(defaultPrintParams());
    expect(result.savedBy).toBe("");
    expect(result.migrated).toContain("project format 3");
    expect(result.migrated).toContain(PROJECT_FILE_EXTENSION);
  });

  it("names the legacy extension when the file was one, even with a current envelope", () => {
    const current = serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT));
    const result = parseProject(current, `chicago-2026-08-29${LEGACY_PROJECT_FILE_EXTENSION}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toContain(LEGACY_PROJECT_FILE_EXTENSION);
  });

  it("names both forms when a version-3 file arrives under its legacy name", () => {
    const result = parseProject(
      JSON.stringify(legacyEnvelope()),
      `chicago-2026-08-29${LEGACY_PROJECT_FILE_EXTENSION}`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toContain("project format 3");
    expect(result.migrated).toContain(LEGACY_PROJECT_FILE_EXTENSION);
  });

  it("says nothing when a current file arrives under its current name", () => {
    const current = serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT));
    const result = parseProject(current, `chicago-2026-08-29${PROJECT_FILE_EXTENSION}`);
    expect(result.ok && result.migrated).toBeNull();
  });

  it("recognises the legacy extension whatever its case", () => {
    expect(isLegacyProjectFilename("Design.FrameCraft.JSON")).toBe(true);
    expect(isLegacyProjectFilename("design.framecraft")).toBe(false);
    expect(isLegacyProjectFilename("design.json")).toBe(false);
  });

  it("builds one sentence for one form and a joined one for several", () => {
    expect(migrationNotice([])).toBeNull();
    expect(migrationNotice(["project format 3"])).toContain("project format 3");
    const both = migrationNotice(["project format 3", "the .framecraft.json extension"]);
    expect(both).toContain(" and ");
  });
});

/**
 * The desktop shell's registration of `.framecraft` with the operating system.
 *
 * Read out of `tauri.conf.json` because that file IS the registration: the
 * bundler turns it into a Windows shell association, a macOS
 * `CFBundleDocumentTypes` + `UTExportedTypeDeclarations` pair, and a Linux
 * `.desktop` MimeType line. Each platform needs a different subset of the
 * block, and a missing field does not fail a build -- it produces an installer
 * whose double-click does nothing, which is exactly the failure a test has to
 * catch before a release.
 */
describe("the desktop file association", () => {
  interface FileAssociation {
    ext?: string[];
    name?: string;
    description?: string;
    mimeType?: string;
    role?: string;
    rank?: string;
    exportedType?: { identifier?: string; conformsTo?: string[] };
  }

  function tauriConfig(): {
    identifier?: string;
    bundle?: { publisher?: string; copyright?: string; fileAssociations?: FileAssociation[] };
  } {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(
      readFileSync(join(here, "..", "..", "desktop", "src-tauri", "tauri.conf.json"), "utf-8"),
    ) as ReturnType<typeof tauriConfig>;
  }

  function association(): FileAssociation {
    const found = tauriConfig().bundle?.fileAssociations ?? [];
    expect(found).toHaveLength(1);
    return found[0];
  }

  it("registers exactly the extension this build writes, without its leading dot", () => {
    expect(association().ext).toEqual([PROJECT_FILE_EXTENSION.replace(/^\./, "")]);
  });

  it("gives Windows Explorer a type name for its Type column", () => {
    expect(association().description).toBeTruthy();
  });

  it("gives macOS a bundle type name, an editor role and an exported UTI it owns", () => {
    const one = association();
    expect(one.name).toBeTruthy();
    expect(one.role).toBe("Editor");
    expect(one.rank).toBe("Owner");
    // A custom extension needs a type DECLARATION on macOS; without it the
    // Finder has nothing to bind the app to.
    expect(one.exportedType?.identifier).toBe(`${tauriConfig().identifier}.project`);
    expect(one.exportedType?.conformsTo).toContain("public.json");
  });

  it("gives Linux a MIME type, which is what reaches the .desktop entry", () => {
    expect(association().mimeType).toMatch(/^application\/[\w.+-]+$/);
  });

  it("does not try to register the legacy double extension, which no OS can bind", () => {
    const exts = association().ext ?? [];
    expect(exts.some((ext) => ext.includes("."))).toBe(false);
    expect(exts).not.toContain("json");
  });

  it("ships the installer under the same publisher and copyright the app shows", () => {
    const bundle = tauriConfig().bundle;
    expect(bundle?.publisher).toBe(COPYRIGHT_HOLDER);
    expect(bundle?.copyright).toContain(COPYRIGHT_HOLDER);
  });
});

describe("parseProject: refusals", () => {
  const valid = serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT));

  it("refuses text that is not JSON", () => {
    const result = parseProject("not json at all {");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not valid JSON");
  });

  it("refuses JSON that is not an object", () => {
    for (const text of ["null", "42", '"hi"', "[1,2,3]"]) {
      const result = parseProject(text);
      expect(result.ok, text).toBe(false);
    }
  });

  it("refuses a file with the wrong or missing format tag", () => {
    for (const format of [undefined, null, "framecraft-scene", 3]) {
      const project = JSON.parse(valid) as Record<string, unknown>;
      project.format = format;
      const result = parseProject(JSON.stringify(project));
      expect(result.ok, String(format)).toBe(false);
      if (!result.ok) expect(result.reason).toContain("not a FrameCraft project");
    }
  });

  it("refuses a version this build does not read, and names it", () => {
    const project = JSON.parse(valid) as Record<string, unknown>;
    project.version = 99;
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("different version");
      expect(result.reason).toContain("99");
    }
  });

  it("refuses an out-of-range or missing pin, radius or rotation", () => {
    const cases: Array<[string, (p: Record<string, unknown>) => void, string]> = [
      ["missing lat", (p) => delete (p.pin as Record<string, unknown>).lat, "latitude"],
      ["lat out of range", (p) => ((p.pin as Record<string, unknown>).lat = 200), "latitude"],
      ["lon out of range", (p) => ((p.pin as Record<string, unknown>).lon = -200), "longitude"],
      ["radius too small", (p) => (p.radius_m = 1), "radius"],
      ["radius too big", (p) => (p.radius_m = 999999), "radius"],
      ["rotation negative", (p) => (p.rotation_deg = -5), "rotation"],
      ["rotation too big", (p) => (p.rotation_deg = 400), "rotation"],
    ];
    for (const [name, mutate, expectedWord] of cases) {
      const project = JSON.parse(valid) as Record<string, unknown>;
      mutate(project);
      const result = parseProject(JSON.stringify(project));
      expect(result.ok, name).toBe(false);
      if (!result.ok) expect(result.reason, name).toContain(expectedWord);
    }
  });

  it("refuses a settings block with an unknown key, via the same validator a share link uses", () => {
    const project = JSON.parse(valid) as Record<string, unknown>;
    (project.params as Record<string, unknown>).moon_phase = 3;
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("moon_phase");
  });

  it("refuses a settings value outside the contract's own range", () => {
    const project = JSON.parse(valid) as Record<string, unknown>;
    (project.params as Record<string, unknown>).nozzle_mm = 0;
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("minimum");
  });

  it("never throws on garbage input", () => {
    for (const text of ["", "{", "{}", "null", "[]", '{"format":"framecraft-project"}']) {
      expect(() => parseProject(text)).not.toThrow();
    }
  });
});


/**
 * A project file written before the settings truth audit carries its colours
 * in `part_colors` (DECISIONS [V3.1-P1-2]). It is migrated by the same code a
 * share link is, because both go through `parsePrintParams`: a file and a link
 * must never migrate a payload two different ways.
 */
describe("parseProject: the part_colors migration", () => {
  const saved = serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT));

  it("carries an older file's part colours onto the regions the engine paints", () => {
    const project = JSON.parse(saved) as Record<string, unknown>;
    const params = project.params as Record<string, unknown>;
    params.part_colors = { water: "#123456", green: "#654321" };
    delete (params.colour as Record<string, unknown>).region_colors;
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.colour!.region_colors!.water).toBe("#123456");
    expect(result.params.colour!.region_colors!.parks).toBe("#654321");
  });

  it("leaves a file that already names region colours alone", () => {
    const project = JSON.parse(saved) as Record<string, unknown>;
    const params = project.params as Record<string, unknown>;
    params.part_colors = { water: "#123456" };
    (params.colour as Record<string, unknown>).region_colors = { water: "#abcdef" };
    const result = parseProject(JSON.stringify(project));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.colour!.region_colors!.water).toBe("#abcdef");
  });
});
