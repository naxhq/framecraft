/**
 * Gate V3-1: the settings matrix.
 *
 * Every `PrintParams` leaf except the four ruled exemptions has a probe, and
 * every probe shows a field-specific change in BOTH the `EngineResult` the
 * preview draws and the bytes the export stage wrote. `graph.test.ts` proves
 * each leaf is CLAIMED by a stage; this file proves each leaf DOES something.
 *
 * Probes that share a scene and a `base` share one `before` build and one warm
 * `StageCache`, which is what keeps the file inside its budget: an `after` run
 * re-runs only what the changed leaf invalidates, and `parity.test.ts` is the
 * proof that a warm run and a cold one agree byte for byte.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PRINT_PARAM_LEAF_PATHS, defaultPrintParams, type PrintParams } from "../../contracts";
import { EXPORT_TARGETS } from "../export/index";
import {
  bambuBuildItems,
  fileNames,
  mustPart,
  objGroups,
  sidecarString,
  sidecarValue,
  stepShells,
  stlBbox,
  stlTriangles,
  zipNames,
  type Snapshot,
} from "./matrix.assert";
import { LABEL_PROBES } from "./matrix.labels";
import { EXEMPT, KNOWN_DEFECTS, PROBES as CORE_PROBES, type Probe } from "./matrix.probes";

/** The core table plus the surface-label probes (Task 12), which live in their own file. */
const PROBES: readonly Probe[] = [...CORE_PROBES, ...LABEL_PROBES];
import { MatrixGroup, groupKeyOf, paramsFor, type MatrixScene } from "./matrix.run";

const started = Date.now();

afterAll(() => {
  // The wave's budget is three minutes for this file; the note records what it
  // measured on this host.
  console.info(`matrix: ${PROBES.length} probes in ${((Date.now() - started) / 1000).toFixed(1)} s`);
});

/**
 * The `block` scene at the defaults, opened once.
 *
 * Three sections need it: the biggest probe group, the `export_target` sweep and
 * the exemption checks. Opening a `MatrixGroup` for each would pay three cold
 * builds for one set of parameters, which is the opposite of what the warm cache
 * per group is for. Disposed by the file's own `afterAll`.
 */
let sharedBlock: MatrixGroup | null = null;

async function openSharedBlock(): Promise<MatrixGroup> {
  if (sharedBlock === null) sharedBlock = await MatrixGroup.open("block", undefined);
  return sharedBlock;
}

afterAll(() => {
  sharedBlock?.dispose();
  sharedBlock = null;
});

/** Probes in table order, grouped by the build they share. */
function groups(): Array<{ key: string; scene: MatrixScene; base: Partial<PrintParams> | undefined; probes: Probe[] }> {
  const out: Array<{ key: string; scene: MatrixScene; base: Partial<PrintParams> | undefined; probes: Probe[] }> = [];
  const index = new Map<string, number>();
  for (const probe of PROBES) {
    const key = groupKeyOf(probe.scene, probe.base);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push({ key, scene: probe.scene, base: probe.base, probes: [probe] });
    } else {
      out[at].probes.push(probe);
    }
  }
  return out;
}

/**
 * Run the two assertions, re-throwing with the probe's own sentence in front.
 *
 * A matrix failure has to say what the field was supposed to do, not just which
 * number moved: that is the difference between a red test and a defect report.
 */
function check(probe: Probe, before: Snapshot, after: Snapshot): void {
  const run = (side: "preview" | "export", assertion: (a: Snapshot, b: Snapshot) => void): void => {
    try {
      assertion(before, after);
    } catch (error) {
      const defect = KNOWN_DEFECTS.get(probe.path);
      const head = defect === undefined ? "" : `KNOWN DEFECT (docs/handoff/v3-01-matrix.md): ${defect}\n`;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${head}${probe.path} = ${JSON.stringify(probe.value)} (${side}): ${probe.why}\n${message}`);
    }
  };
  run("preview", probe.assertPreview.bind(probe));
  run("export", probe.assertExport.bind(probe));
}

// ---------------------------------------------------------------------------
// Coverage: the table against the generated leaf list
// ---------------------------------------------------------------------------

describe("the matrix covers every PrintParams leaf", () => {
  it("has one probe per leaf except the four ruled exemptions, and no probe for a path the schema does not have", () => {
    const probed = new Set<string>(PROBES.map((probe) => probe.path));
    expect(probed.size, "two probes claim the same leaf").toBe(PROBES.length);
    const leaves = new Set<string>(PRINT_PARAM_LEAF_PATHS);
    for (const probe of PROBES) expect(leaves.has(probe.path), `${probe.path} is not a PrintParams leaf`).toBe(true);
    for (const path of EXEMPT.keys()) expect(leaves.has(path), `${path} is not a PrintParams leaf`).toBe(true);
    const missing = PRINT_PARAM_LEAF_PATHS.filter((path) => !probed.has(path) && !EXEMPT.has(path));
    expect(missing, "these leaves have neither a probe nor an exemption").toEqual([]);
    // The exemption list is exactly the four rulings, expanded: `schema_version`,
    // `colour.preview_theme`, the seven `part_colors.*` and
    // `colour.region_colors.attribution`.
    expect(EXEMPT.size).toBe(10);
    for (const [path, reason] of EXEMPT) {
      expect(reason, path).toMatch(/^\[V3\.1-P1-(2|13)\]/);
      expect(probed.has(path), `${path} is exempt and probed`).toBe(false);
    }
  });

  it("names a scene and a sentence for every probe", () => {
    for (const probe of PROBES) {
      expect(["block", "rail", "bridge", "terrain", "osm", "labelled"], probe.path).toContain(probe.scene);
      expect(probe.why.length, probe.path).toBeGreaterThan(20);
      expect(probe.why, probe.path).not.toMatch(/hash|bytes moved|differs/i);
    }
  });

  it("writes a value the leaf does not already hold", () => {
    for (const probe of PROBES) {
      const base = paramsFor(probe.base);
      const current = probe.path.split(".").reduce<unknown>((node, step) => {
        if (node === null || node === undefined || typeof node !== "object") return undefined;
        if (step.endsWith("[]")) {
          const list = (node as Record<string, unknown>)[step.slice(0, -2)];
          return Array.isArray(list) ? list[0] : undefined;
        }
        return (node as Record<string, unknown>)[step];
      }, base);
      expect(JSON.stringify(current), `${probe.path} already holds its probe value`).not.toBe(JSON.stringify(probe.value));
    }
  });
});

// ---------------------------------------------------------------------------
// The probes
// ---------------------------------------------------------------------------

const BLOCK_DEFAULTS_KEY = groupKeyOf("block", undefined);

for (const group of groups()) {
  describe(`matrix: ${group.key}`, () => {
    const isShared = group.key === BLOCK_DEFAULTS_KEY;
    let opened: MatrixGroup | null = null;

    beforeAll(async () => {
      opened = isShared ? await openSharedBlock() : await MatrixGroup.open(group.scene, group.base);
    }, 180_000);

    afterAll(() => {
      if (!isShared) opened?.dispose();
      opened = null;
    });

    for (const probe of group.probes) {
      it(`${probe.path} = ${JSON.stringify(probe.value)}`, async () => {
        if (opened === null) throw new Error("the group's before build did not run");
        const after = await opened.run(probe.path, probe.value, probe.forceExport === true);
        check(probe, opened.before, after);
      }, 120_000);
    }
  });
}

// ---------------------------------------------------------------------------
// export_target across all seven values
// ---------------------------------------------------------------------------

describe("matrix: export_target writes a different file set for every one of its seven values", () => {
  let opened: MatrixGroup | null = null;

  beforeAll(async () => {
    opened = await openSharedBlock();
  }, 180_000);

  it("covers every target the contract lists, and each writes what its format needs", async () => {
    if (opened === null) throw new Error("the group's before build did not run");
    expect(EXPORT_TARGETS).toHaveLength(7);
    expect(defaultPrintParams().export_target).toBe("bambu-3mf");
    const expected: Record<string, string[]> = {
      "bambu-3mf": ["framecraft.3mf"],
      "generic-3mf": ["framecraft.3mf"],
      stl: ["framecraft.stl"],
      "stl-parts-zip": ["framecraft-parts.zip"],
      obj: ["framecraft.obj", "framecraft.mtl"],
      step: ["framecraft.step"],
      "color-change-3mf": ["framecraft-colorchange.3mf"],
    };
    const seen = new Set<string>();
    for (const target of EXPORT_TARGETS) {
      const snapshot = await opened.run("export_target", target);
      expect(snapshot.target, target).toBe(target);
      expect(fileNames(snapshot.files), target).toEqual(expected[target]);
      expect(sidecarString(snapshot.sidecar, "export_target"), target).toBe(target);
      // What a reader of that format would look for, and the model inside it.
      if (target === "bambu-3mf") {
        expect(zipNames(snapshot.files[0].bytes)).toContain("Metadata/model_settings.config");
        // One build item: the whole model is one plate placed once.
        expect(bambuBuildItems(snapshot.files)).toHaveLength(1);
        expect(mustPart(snapshot.files, "base").triangles).toBeGreaterThan(1000);
      }
      if (target === "generic-3mf") expect(zipNames(snapshot.files[0].bytes)).not.toContain("Metadata/model_settings.config");
      if (target === "stl") {
        expect(stlTriangles(snapshot.files[0].bytes)).toBeGreaterThan(1000);
        // The single body spans the whole plate, in build space.
        const box = stlBbox(snapshot.files[0].bytes);
        expect(box.max[0] - box.min[0]).toBeCloseTo(180, 1);
        expect(box.min[2]).toBeCloseTo(0, 3);
      }
      if (target === "stl-parts-zip") {
        expect(zipNames(snapshot.files[0].bytes)).toContain("CREDITS.txt");
        expect(zipNames(snapshot.files[0].bytes).filter((name) => name.endsWith(".stl")).length).toBeGreaterThan(1);
      }
      if (target === "obj") expect(objGroups(snapshot.files)).toContain("base");
      if (target === "step") {
        expect(new TextDecoder().decode(snapshot.files[0].bytes.slice(0, 20))).toContain("ISO-10303-21");
        // Single-colour mode writes the welded solid as one shell.
        expect(stepShells(snapshot.files)).toBe(1);
      }
      if (target === "color-change-3mf") expect(zipNames(snapshot.files[0].bytes)).toContain("Metadata/custom_gcode_per_layer.xml");
      const signature = `${fileNames(snapshot.files).join(",")}|${snapshot.files.map((file) => file.mime).join(",")}|${snapshot.files.reduce((total, file) => total + file.bytes.length, 0)}`;
      expect(seen.has(signature), `${target} wrote the same file set as an earlier target`).toBe(false);
      seen.add(signature);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------
// The exemptions, and what stands in for a probe
// ---------------------------------------------------------------------------

describe("matrix: the exempt leaves", () => {
  let opened: MatrixGroup | null = null;

  beforeAll(async () => {
    opened = await openSharedBlock();
  }, 180_000);

  it("schema_version has no physical meaning and is echoed at the top of the sidecar", async () => {
    if (opened === null) throw new Error("the group's before build did not run");
    expect(EXEMPT.get("schema_version")).toContain("[V3.1-P1-2]");
    expect(sidecarValue(opened.before.sidecar, "schema_version")).toBe(4);
    const after = await opened.run("schema_version", 2);
    expect(sidecarValue(after.sidecar, "schema_version")).toBe(2);
    expect(after.result.regions.map((region) => region.region)).toEqual(opened.before.result.regions.map((region) => region.region));
  }, 120_000);

  it("colour.preview_theme is a viewer setting and is echoed at the top of the sidecar", async () => {
    if (opened === null) throw new Error("the group's before build did not run");
    expect(EXEMPT.get("colour.preview_theme")).toContain("[V3.1-P1-2]");
    expect(sidecarValue(opened.before.sidecar, "preview_theme")).toBe("dark");
    const after = await opened.run("colour.preview_theme", "light");
    expect(sidecarValue(after.sidecar, "preview_theme")).toBe("light");
    expect(after.result.stats.triangles).toBe(opened.before.result.stats.triangles);
  }, 120_000);

  it("colour.region_colors.attribution has no solid to colour, so no stage claims it", async () => {
    expect(EXEMPT.get("colour.region_colors.attribution")).toContain("[V3.1-P1-13]");
    const { claimedPaths } = await import("./graph");
    expect(claimedPaths().has("colour.region_colors.attribution")).toBe(false);
    expect(claimedPaths().has("colour.region_slots.attribution")).toBe(true);
  });

  it("part_colors.* is the v1 block and is claimed by no stage", async () => {
    const { claimedPaths } = await import("./graph");
    for (const path of ["part_colors.base", "part_colors.frame", "part_colors.buildings", "part_colors.roads", "part_colors.water", "part_colors.green", "part_colors.trees"] as const) {
      expect(EXEMPT.get(path), path).toContain("[V3.1-P1-2]");
      expect(claimedPaths().has(path), path).toBe(false);
    }
  });
});
