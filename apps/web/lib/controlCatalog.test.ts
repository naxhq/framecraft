/**
 * The settings truth audit, as a test (Task 2 of the v3.1 run).
 *
 * Three questions, none of them answerable by reading the panel:
 *
 *  1. Does every control write a field that exists? (`PRINT_PARAM_LEAF_PATHS`)
 *  2. Does every field a control writes actually do something? A leaf is
 *     claimed by a pipeline stage or it is not, and since the preview renders
 *     the pipeline's own solids and the export runs the same stages, "claimed"
 *     is exactly "moves the preview and the file". A control writing an
 *     unclaimed leaf is a decorative control, and the rule for this wave is
 *     that a decorative control is removed.
 *  3. Does every control the panel renders have a row in the catalog? Answered
 *     by parsing the group components themselves, so adding a control without
 *     a catalog row fails here rather than shipping without a help string.
 *
 * The four matrix exemptions (DECISIONS `[V3.1-P1-2]` and `[V3.1-P1-13]`) are
 * pinned from the other side too: no control may write one.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRINT_PARAM_LEAF_PATHS, type PrintParamPath } from "./contracts";
import {
  CONTROLS,
  SECTIONS,
  control,
  controlledPaths,
  controlsInGroup,
  controlsWriting,
  labelled,
  labelledAs,
  section,
  sectionProps,
} from "./controlCatalog";
import { claimedPaths, stagesReading } from "./engine/pipeline";
import { KNOWN_DEFECTS } from "./engine/pipeline/matrix.probes";
import { GROUP_IDS } from "./groups";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

/**
 * The four fields no control may write (DECISIONS `[V3.1-P1-2]`,
 * `[V3.1-P1-13]`), with the reason each one is out of the panel.
 */
const FORBIDDEN_FOR_CONTROLS: ReadonlyMap<string, string> = new Map([
  ["part_colors.base", "v1 colour block; migrated into colour.region_colors at parse time"],
  ["part_colors.frame", "v1 colour block; migrated into colour.region_colors at parse time"],
  ["part_colors.buildings", "v1 colour block; migrated into colour.region_colors at parse time"],
  ["part_colors.roads", "v1 colour block; migrated into colour.region_colors at parse time"],
  ["part_colors.water", "v1 colour block; migrated into colour.region_colors at parse time"],
  ["part_colors.green", "v1 colour block; migrated into colour.region_colors at parse time"],
  ["part_colors.trees", "v1 colour block; migrated into colour.region_colors at parse time"],
  [
    "colour.region_colors.attribution",
    "the attribution marks are cuts, never a body, so no colour can reach a file",
  ],
  ["schema_version", "payload metadata, echoed in the sidecar; never a user setting"],
  [
    "colour.preview_theme",
    "a viewer setting; its toggle lives in the viewport HUD, not in the settings panel",
  ],
]);

/**
 * Leaves a stage claims that the settings panel does not yet offer a control
 * for, each with the reason. Two whole contract groups are in here: `regions`
 * and `bridges` are read heavily by the geometry stages and reachable through
 * a share link or a project file, but no group renders a control for them.
 * They are the settings-panel task's to add; this map is what keeps that fact
 * from going quiet again.
 */
const CLAIMED_WITHOUT_A_CONTROL: ReadonlyMap<string, string> = new Map([
  ["schema_version", "payload metadata; the export stage echoes it into the sidecar"],
  ["place.country", "written by the reverse geocoder from the pin, not typed"],
  ["place.state", "written by the reverse geocoder from the pin, not typed"],
  ["place.neighbourhood", "written by the reverse geocoder from the pin, not typed"],
  ["regions.roads.depth_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.roads.proud_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.water.depth_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.water.proud_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.parks.depth_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.parks.proud_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.rail.depth_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.rail.proud_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.rail.width_m", "no control yet: the settings-panel task adds a Regions section"],
  ["regions.building_skirt_mm", "no control yet: the settings-panel task adds a Regions section"],
  ["colour.preview_theme", "the viewport HUD's own toggle writes it; not a settings-panel control"],
  ["custom_profile.nozzle_mm", "the Scale group's nozzle slider is the one nozzle a build uses"],
  ["bridges.enabled", "no control yet: defaults to true, so every model builds bridge decks"],
  ["bridges.clearance_mm", "no control yet: the settings-panel task adds a Bridges section"],
  ["bridges.abutments", "no control yet: the settings-panel task adds a Bridges section"],
  ["heights.type_defaults.house", "no control yet: one row per building type is a table, not a slider"],
  ["heights.type_defaults.apartments", "no control yet: one row per building type is a table, not a slider"],
  ["heights.type_defaults.commercial", "no control yet: one row per building type is a table, not a slider"],
  ["heights.type_defaults.retail", "no control yet: one row per building type is a table, not a slider"],
  ["heights.type_defaults.industrial", "no control yet: one row per building type is a table, not a slider"],
  ["heights.type_defaults.garage", "no control yet: one row per building type is a table, not a slider"],
  [
    "frame_style.lip_depth_mm",
    "claimed only through the frame_style.* wildcard: the matrix's KNOWN_DEFECTS says nothing reads it, so the slider was removed until [V3.1-P2-2] lands the sight-edge rebate",
  ],
]);

// ---------------------------------------------------------------------------
// A JSX scan of the components that render the panel
// ---------------------------------------------------------------------------

/**
 * Every shipped `.tsx` under `components/editor`, recursively, repo-relative.
 *
 * A `.test.tsx` is excluded for the same reason `.test.ts` always was (it fell
 * out of the extension filter rather than being a decision): a test file
 * renders components to assert on them and ships no control of its own, so
 * requiring it to be catalogued or declared out of scope would be noise.
 */
function everyEditorComponent(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(resolve(webRoot, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(path);
    }
  };
  walk("components/editor");
  return out.sort();
}

/**
 * The files whose controls this catalog does NOT cover, each with the reason.
 *
 * The first audit of this task found the real hole: the scanned list was
 * hand-written, so a whole component (`CollapsibleGroup.tsx`, which renders
 * the nine group headers) could sit outside it and never be missed. The scan
 * now walks every `.tsx` under `components/editor` and partitions it, so
 * adding a file forces a decision rather than an omission, and the partition
 * itself is asserted to be exhaustive.
 */
const OUT_OF_SCOPE_FILES: ReadonlyMap<string, string> = new Map([
  [
    "components/editor/Controls.tsx",
    "the primitive library itself: its button, input and select ARE the primitives, and take their id from the caller",
  ],
  [
    "components/editor/ActionBar.tsx",
    "the action bar: Preview, Cancel, Export, Copy link, Save and Load project run an action rather than writing a setting",
  ],
  [
    "components/editor/OutputPanel.tsx",
    "the results slots: the estimate, the export status and its download links, the resolved text and the stats, none of which is a control",
  ],
  [
    "components/editor/ProgressBar.tsx",
    "the action bar's progress readout: a progressbar and two lines of text, with nothing to click",
  ],
  [
    "components/editor/ExportErrorDetail.tsx",
    "the action bar's failure surface: one Copy details button, which copies text rather than writing a setting",
  ],
  [
    "components/editor/ExportMenu.tsx",
    "the action bar, except the export-format select, which writes a PrintParams leaf and IS catalogued (see EXPORT_MENU_SOURCE)",
  ],
  ["components/editor/EstimateCard.tsx", "a readout in the results slots, no controls"],
  ["components/editor/StatsCard.tsx", "a readout in the results slots, no controls"],
  ["components/editor/PerfHud.tsx", "the ?perf=1 diagnostic overlay, not a shipped setting"],
  [
    "components/editor/IssuesBadge.tsx",
    "the issues drawer: its fix buttons apply an audit finding's patch, which is arbitrary params rather than one control's field",
  ],
  ["components/editor/AdjustmentsChip.tsx", "a drawer opener in the viewport shell"],
  ["components/editor/HistoryChip.tsx", "undo, redo and the history list: whole-state actions, not settings"],
  ["components/editor/RecentDesigns.tsx", "restores a whole saved state; shell, not a setting"],
  ["components/editor/PresetRow.tsx", "the preset chips move the location, which is not a parameter ([V3.1-P1-10])"],
  ["components/editor/EditorShell.tsx", "shell chrome: the shortcut sheet and the small-screen sheet toggle"],
  ["components/editor/ShortcutSheet.tsx", "shell chrome: one close button"],
  ["components/editor/ThemeToggle.tsx", "the app theme, a viewer setting outside PrintParams ([V3.1-O6])"],
  ["components/editor/WarningBanners.tsx", "shell chrome: one dismiss button"],
]);

/** The files the catalog is answerable for: everything else. */
const SCANNED: readonly string[] = everyEditorComponent().filter(
  (file) => !OUT_OF_SCOPE_FILES.has(file),
);

/**
 * `ExportMenu.tsx` is out of scope as a FILE and yet holds one catalogued
 * control, so its select is scanned on its own.
 */
const EXTRA_SCANNED = ["components/editor/ExportMenu.tsx"] as const;

/** Tags that render a control. The five primitives, plus the native elements. */
const CONTROL_TAGS = [
  "Slider",
  "Toggle",
  "SelectField",
  "Segmented",
  "TextField",
  "button",
  "input",
  "select",
  "textarea",
] as const;

/**
 * The index of the `>` that closes the open tag beginning at `start`.
 *
 * A regex cannot do this: a JSX attribute holds arbitrary expressions, and
 * `onClick={() => setPart(key, value)}` alone contains two characters that
 * would end the tag early. So this walks the source with a small stack of
 * modes -- code, the two quote kinds, and template literals with their `${}`
 * holes -- and only accepts a `>` in code at brace depth zero.
 */
function endOfOpenTag(src: string, start: number): number {
  type Frame = { mode: "code" | "dq" | "sq" | "tpl"; depth: number };
  const stack: Frame[] = [{ mode: "code", depth: 0 }];
  let i = start;
  while (i < src.length) {
    const frame = stack[stack.length - 1];
    const c = src[i];
    if (frame.mode === "code") {
      if (c === '"') stack.push({ mode: "dq", depth: 0 });
      else if (c === "'") stack.push({ mode: "sq", depth: 0 });
      else if (c === "`") stack.push({ mode: "tpl", depth: 0 });
      else if (c === "{") frame.depth += 1;
      else if (c === "}") {
        if (frame.depth > 0) frame.depth -= 1;
        else stack.pop();
      } else if (c === ">" && frame.depth === 0 && stack.length === 1) return i;
      i += 1;
      continue;
    }
    if (frame.mode === "tpl") {
      if (c === "\\") i += 2;
      else if (c === "`") {
        stack.pop();
        i += 1;
      } else if (c === "$" && src[i + 1] === "{") {
        stack.push({ mode: "code", depth: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    // A quoted string: only its own closing quote ends it.
    if (c === "\\") i += 2;
    else if ((frame.mode === "dq" && c === '"') || (frame.mode === "sq" && c === "'")) {
      stack.pop();
      i += 1;
    } else i += 1;
  }
  throw new Error(`unterminated JSX tag from index ${start}`);
}

/** `engraving_${index}_text` and friends collapse to their `*` form. */
function normaliseTemplate(body: string): string {
  return body.replace(/\$\{[^}]*\}/g, "*").replace(/\*+/g, "*");
}

/**
 * The catalog id an open tag names, or null when the tag is not a control the
 * catalog is responsible for.
 *
 * Order matters. A `labelled("x")` / `labelledAs("x", ...)` call anywhere in
 * the tag is the strongest signal there is -- it is the component asking the
 * catalog for this control's own label and help -- so it wins over the raw
 * `id` and `data-testid` attributes.
 */
function catalogIdOf(openTag: string): string | null {
  const viaCatalog = /\blabelledAs\(\s*"([^"]+)"|\blabelled\(\s*"([^"]+)"/.exec(openTag);
  if (viaCatalog !== null) return viaCatalog[1] ?? viaCatalog[2];

  const literalId = /\bid="([^"]+)"/.exec(openTag);
  if (literalId !== null) return literalId[1];

  const templateId = /\bid=\{`([^`]*)`\}/.exec(openTag);
  if (templateId !== null) return normaliseTemplate(templateId[1]);

  const literalTestId = /\bdata-testid="([^"]+)"/.exec(openTag);
  if (literalTestId !== null) return literalTestId[1];

  const templateTestId = /\bdata-testid=\{`([^`]*)`\}/.exec(openTag);
  if (templateTestId !== null) return normaliseTemplate(templateTestId[1]);

  return null;
}

/**
 * The source with its block comments blanked out, newlines kept so any index
 * still lines up. A JSDoc line reading "the header is a real `<button>`" is
 * prose, not a control, and `CollapsibleGroup.tsx` has exactly that.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
}

interface Rendered {
  id: string | null;
  file: string;
  tag: string;
  /** The open tag itself, so a test can ask what else it carries. */
  openTag: string;
}

/** Every control tag in one component, with the catalog id it names. */
function renderedControls(file: string): Rendered[] {
  const src = withoutComments(readFileSync(resolve(webRoot, file), "utf-8"));
  const out: Rendered[] = [];
  for (const tag of CONTROL_TAGS) {
    const opener = new RegExp(`<${tag}(?=[\\s/>])`, "g");
    let match = opener.exec(src);
    while (match !== null) {
      const end = endOfOpenTag(src, match.index + tag.length + 1);
      const openTag = src.slice(match.index, end);
      out.push({ id: catalogIdOf(openTag), file, tag, openTag });
      opener.lastIndex = end;
      match = opener.exec(src);
    }
  }
  return out;
}

const RENDERED: readonly Rendered[] = [...SCANNED, ...EXTRA_SCANNED].flatMap((file) =>
  renderedControls(file),
);

// ---------------------------------------------------------------------------

describe("the control catalog: shape", () => {
  it("has a unique id, group, label, help string and test id per row", () => {
    expect(CONTROLS.length).toBeGreaterThan(0);
    const ids = CONTROLS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    const testIds = CONTROLS.map((spec) => spec.testId);
    expect(new Set(testIds).size).toBe(testIds.length);
    for (const spec of CONTROLS) {
      expect(spec.label.trim(), spec.id).not.toBe("");
      expect(spec.help.trim(), spec.id).not.toBe("");
      expect(spec.testId.trim(), spec.id).not.toBe("");
      expect(GROUP_IDS, spec.id).toContain(spec.group);
      expect(spec.source, spec.id).toMatch(/^components\/editor\/.+\.tsx$/);
    }
  });

  it("writes help in whole sentences, on one line, without restating the control's own name", () => {
    for (const spec of CONTROLS) {
      expect(spec.help, spec.id).not.toContain("\n");
      // The house rule for this run: no em dashes anywhere.
      expect(spec.help, spec.id).not.toContain("—");
      expect(spec.help.endsWith("."), `${spec.id}: ${spec.help}`).toBe(true);
      const opening = spec.help.slice(0, spec.label.length).toLowerCase();
      expect(opening, `${spec.id} restates its own label`).not.toBe(spec.label.toLowerCase());
      expect(spec.help.length, `${spec.id} help is too short to say anything`).toBeGreaterThan(24);
    }
  });

  it("has a unique id, label and help string per section", () => {
    const ids = SECTIONS.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of SECTIONS) {
      expect(spec.label.trim(), spec.id).not.toBe("");
      expect(spec.help.trim(), spec.id).not.toBe("");
      expect(spec.help, spec.id).not.toContain("—");
      expect(GROUP_IDS, spec.id).toContain(spec.group);
    }
  });

  it("looks a control up by id and refuses one it does not have", () => {
    expect(control("plate_mm").label).toBe("Plate size");
    expect(labelled("plate_mm")).toEqual({
      id: "plate_mm",
      label: control("plate_mm").label,
      hint: control("plate_mm").help,
    });
    expect(labelledAs("engraving_*_text", "engraving_2_text").id).toBe("engraving_2_text");
    expect(labelledAs("engraving_*_text", "engraving_2_text").label).toBe(
      control("engraving_*_text").label,
    );
    expect(sectionProps("tiling").label).toBe(section("tiling").label);
    expect(() => control("no-such-control")).toThrow(/no control named/);
    expect(() => section("no-such-section")).toThrow(/no section named/);
    expect(controlsInGroup("scale").map((spec) => spec.id)).toEqual([
      "plate_mm",
      "base_thickness_mm",
      "nozzle_mm",
    ]);
  });
});

describe("the control catalog against the frozen contract", () => {
  it("names only real PrintParams leaves", () => {
    const leaves = new Set<string>(PRINT_PARAM_LEAF_PATHS);
    for (const spec of CONTROLS) {
      if (typeof spec.writes === "string") continue;
      expect(spec.writes.length, `${spec.id} writes nothing`).toBeGreaterThan(0);
      for (const path of spec.writes) {
        expect(leaves.has(path), `${spec.id} writes ${path}, which is not a PrintParams leaf`).toBe(
          true,
        );
      }
    }
  });

  it("gives every non-param control one of the four declared targets", () => {
    const targets = new Set(["location", "object-override", "viewer", "all-parameters"]);
    for (const spec of CONTROLS) {
      if (typeof spec.writes !== "string") continue;
      expect(targets, spec.id).toContain(spec.writes);
    }
    expect(control("radius_m").writes).toBe("location");
    expect(control("rotation_deg").writes).toBe("location");
  });
});

describe("the control catalog against the pipeline", () => {
  it("every field a control writes is claimed by a stage, so no control is decorative", () => {
    const claimed = claimedPaths();
    for (const path of controlledPaths()) {
      expect(
        claimed.has(path),
        `${path} has a control (${controlsWriting(path)
          .map((spec) => spec.id)
          .join(", ")}) but no pipeline stage reads it`,
      ).toBe(true);
      expect(stagesReading(path).length, path).toBeGreaterThan(0);
    }
  });

  it("no control writes one of the four matrix exemptions", () => {
    for (const [path, reason] of FORBIDDEN_FOR_CONTROLS) {
      expect(reason).toBeTruthy();
      expect(
        controlsWriting(path as PrintParamPath).map((spec) => spec.id),
        `${path} must have no control: ${reason}`,
      ).toEqual([]);
    }
  });

  it("no control writes a field the matrix's own KNOWN_DEFECTS says moves nothing", () => {
    // A wildcard claim (`frame_style.*`) marks every leaf under it claimed,
    // so `claimedPaths()` alone cannot tell a field that is read from a field
    // that is merely declared. `matrix.probes.ts:KNOWN_DEFECTS` is the list of
    // leaves whose probe fails because the ENGINE is wrong, and a control for
    // one of those is a control that ships ahead of its effect.
    for (const [path, reason] of KNOWN_DEFECTS) {
      expect(reason.length, path).toBeGreaterThan(20);
      expect(
        controlsWriting(path as PrintParamPath).map((spec) => spec.id),
        `${path} has no working effect yet: ${reason}`,
      ).toEqual([]);
    }
    // Not vacuous: the list really does name the field whose slider this wave
    // removed, so re-adding the slider before the geometry fails here.
    expect([...KNOWN_DEFECTS.keys()]).toContain("frame_style.lip_depth_mm");
  });

  it("names every claimed field the panel still has no control for", () => {
    const controlled = new Set<string>(controlledPaths());
    const claimed = claimedPaths();
    const gaps = PRINT_PARAM_LEAF_PATHS.filter(
      (path) => claimed.has(path) && !controlled.has(path),
    );
    expect([...gaps].sort()).toEqual([...CLAIMED_WITHOUT_A_CONTROL.keys()].sort());
    for (const path of CLAIMED_WITHOUT_A_CONTROL.keys()) {
      expect(CLAIMED_WITHOUT_A_CONTROL.get(path), path).toBeTruthy();
    }
  });
});

describe("the control catalog against what the panel renders", () => {
  it("finds a control tag in every scanned component", () => {
    for (const file of SCANNED) {
      expect(RENDERED.filter((entry) => entry.file === file).length, file).toBeGreaterThan(0);
    }
  });

  it("can name every control tag it finds", () => {
    const anonymous = RENDERED.filter((entry) => entry.id === null);
    expect(
      anonymous.map((entry) => `${entry.file}: <${entry.tag}>`),
      "a control with no id, no data-testid and no catalog call cannot be tested or described",
    ).toEqual([]);
  });

  it("has a row for every control the panel renders", () => {
    const known = new Set(CONTROLS.map((spec) => spec.id));
    const missing = [
      ...new Set(
        RENDERED.filter((entry) => entry.id !== null && !known.has(entry.id)).map(
          (entry) => `${entry.id} (${entry.file})`,
        ),
      ),
    ].sort();
    expect(missing, "add a row to lib/controlCatalog.ts for each of these").toEqual([]);
  });

  it("classifies every component under components/editor, scanned or out of scope with a reason", () => {
    const all = everyEditorComponent();
    expect(all.length).toBeGreaterThan(20);
    for (const file of all) {
      const covered = SCANNED.includes(file) || OUT_OF_SCOPE_FILES.has(file);
      expect(covered, `${file} is neither scanned nor declared out of scope`).toBe(true);
    }
    for (const [file, reason] of OUT_OF_SCOPE_FILES) {
      expect(all, `${file} is declared out of scope but does not exist`).toContain(file);
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });

  it("has no row for a control the panel no longer renders", () => {
    const scanned = new Set<string>([...SCANNED, ...EXTRA_SCANNED]);
    const found = new Set(RENDERED.map((entry) => entry.id));
    const stale = CONTROLS.filter(
      (spec) => scanned.has(spec.source) && !found.has(spec.id),
    ).map((spec) => `${spec.id} (${spec.source})`);
    expect(stale.sort(), "these catalog rows name a control nothing renders").toEqual([]);
  });

  it("never lets a control carry its help as a title alone", () => {
    const tooltipOnly = RENDERED.filter(
      (entry) =>
        /\btitle=\{labelled/.test(entry.openTag) && !/\baria-describedby=/.test(entry.openTag),
    ).map((entry) => `${entry.id} (${entry.file})`);
    expect(
      tooltipOnly,
      "title is not announced by most screen readers and is unreachable by keyboard: add aria-describedby and a Hint or SrHint",
    ).toEqual([]);
  });

  it("keeps the removed controls removed", () => {
    // Comment-stripped: the point is what the panel RENDERS, and a comment
    // saying why a control is gone must not read as the control still being
    // there.
    const sources = SCANNED.map((file) =>
      withoutComments(readFileSync(resolve(webRoot, file), "utf-8")),
    ).join("\n");
    // The seven v1 part-colour wells and their block.
    expect(sources).not.toContain("part_color_");
    expect(sources).not.toContain('data-testid="part-colors"');
    expect(sources).not.toContain("params.part_colors");
    // The attribution colour well ([V3.1-P1-13]); its slot select stays.
    expect(sources).toContain('row.region === "attribution"');
    expect(sources).toContain("colour_slot_");
    // The preview theme is a viewport control, never a settings-panel one.
    expect(sources).not.toContain("preview_theme");
    // The Lip depth slider, removed with its own finding: `[V3.1-P2-2]` lands
    // the sight-edge rebate in the next wave and re-adds the control with it.
    expect(sources).not.toContain("lip_depth_mm");
  });
});
