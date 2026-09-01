/**
 * The printability audit: one catalogue of everything that can be wrong with a
 * finished model, and one function that returns the whole list.
 *
 * Findings are raised in two places and this module is the seam between them.
 * The solid pipeline raises what can only be known while the WASM handles are
 * alive (is this region a valid manifold, how many bodies does it have, did the
 * lettering refuse a line); this module raises everything that can be measured
 * from the finished meshes, the stats and the parameters, and it is what
 * assembles, orders and de-duplicates the final `EngineResult.findings`. A
 * caller that wants "what is wrong with this model" asks
 * {@link auditPrintability} and nothing else.
 *
 * The catalogue, with the module that words each one:
 *
 * | id | severity | raised by |
 * |---|---|---|
 * | `not-manifold` | error | `solid/validate.ts` (needs the solid) |
 * | `floating-island` | error / warning | `solid/validate.ts` + this file (regions and counts) |
 * | `exceeds-plate` | error | `solid/validate.ts` (against `params.plate_mm`) |
 * | `exceeds-profile-plate` | error | this file (against the ACTIVE printer profile) |
 * | `exceeds-height` | error | `solid/validate.ts` (the ACTIVE profile's ceiling) |
 * | `wall-too-thin` | error / warning | `solid/validate.ts` (the min-wall measurement) |
 * | `unsupported-overhang` | warning / info | this file |
 * | `buildings-merged` | info | this file |
 * | `slot-beyond-profile` | error | this file |
 * | `tile-exceeds-plate` | error | this file |
 * | `text-too-small` | warning | `solid/lettering.ts`, `solid/ornaments.ts` |
 * | `hanger-refused`, `bridge-unsupported`, `trees-*`, `hero-*`, ... | various | `solid/*` |
 *
 * Two rules about fixes hold for every finding in the catalogue, and
 * `rules.test.ts` enforces both:
 *
 * 1. **No fix may ever write `nozzle_mm`** (DECISIONS `[V3-P3-G12]`). It
 *    describes the hardware; halving it only halves the threshold the check
 *    compares against while the print fails exactly as before. The remedies for
 *    a feature that is too small for the nozzle are to make the MODEL bigger
 *    (a bigger plate, from the shared advisor) or to accept less city (a
 *    smaller radius, which lives in the SceneRequest and so can only be prose).
 * 2. **`safe` means the fix cannot make any other finding worse, and does not
 *    throw away geometry the user asked for.** The second half is not
 *    pedantry: "Auto-fix all safe issues" applies these without asking, and
 *    silently deleting the trees or the bridges from someone's model is not
 *    something to do unasked, however clean the result validates
 *    (DECISIONS `[V3-P4-E3]`).
 */

import type { PrintParams, SceneGraph } from "../../contracts";
import { PRINTER_PROFILES, resolveProfile, type PrinterProfile } from "../../printers";
import * as T from "../../transform";
import type {
  AuditFinding,
  EngineStats,
  RegionMesh,
  RegionName,
  Severity,
  TileResult,
} from "../types";
import { REGION_NAMES } from "../types";

// ---------------------------------------------------------------------------
// Constants (every one of them a documented ruling, `[V3-P4-E1]`)
// ---------------------------------------------------------------------------

/**
 * How far from vertical a downward-facing surface may lean before it needs
 * support, degrees.
 *
 * Measured from VERTICAL, which is the convention every slicer's "support
 * threshold" uses: a plumb wall is 0 degrees and a flat bridge is 90. 50 is one
 * step past the 45 degrees that FDM lore quotes and the 45 to 55 that Bambu
 * Studio, PrusaSlicer and Cura all default to somewhere within, which is the
 * right place for a WARNING: everything a normal profile prints unsupported is
 * below it, and everything above it is a surface the printer will either
 * support or spoil. It is a constant and not a parameter: the audit's job is to
 * describe the model, not to let the model be re-described until it passes.
 */
export const OVERHANG_LIMIT_DEG = 50;

/**
 * Downward faces at or under this height are the model sitting on the bed, mm.
 *
 * The underside of the base is one enormous downward-facing triangle set and it
 * needs no support at all, because the plate is under it. So is the floor of an
 * underside pocket, a keyhole ceiling and the first layer of anything. Half a
 * millimetre is two and a half layers at 0.2 mm.
 */
export const PLATE_SKIN_MM = 0.5;

/** Overhang area above this fraction of the model's surface is a warning. */
export const OVERHANG_WARN_FRACTION = 0.02;
/** Above this fraction it is worth mentioning. */
export const OVERHANG_INFO_FRACTION = 0.005;

/**
 * Clearance left around a tile on its plate, mm per side.
 *
 * A tile has to fit the bed with room for the skirt or brim the slicer puts
 * around it; 5 mm is Bambu Studio's own default brim width plus a little. It is
 * used when SOLVING for a tile count, never when judging whether a model fits:
 * a model exactly as wide as the bed is printable, just tight, and the bounds
 * rule below says so with the raw numbers.
 */
export const PLATE_EDGE_MARGIN_MM = 5;

/**
 * How much of the model's size the user must be asked to give up before tiling
 * is offered instead of a smaller plate.
 *
 * Shrinking the plate is the simpler fix and it costs detail: every feature
 * scales with it. A tenth is worth taking silently; a quarter is not, and at
 * that point splitting the model over two beds keeps the city the size it was.
 */
export const PLATE_SHRINK_LIMIT = 0.75;

/** Highest usable square plate across the profile table, mm. Diagnostics only. */
export function largestProfilePlateMm(): number {
  let best = 0;
  for (const profile of Object.values(PRINTER_PROFILES)) {
    best = Math.max(best, Math.min(profile.plateXMm, profile.plateYMm));
  }
  return best;
}

// ---------------------------------------------------------------------------
// Overhangs
// ---------------------------------------------------------------------------

export interface OverhangReport {
  /** Area of the downward faces past the limit, mm2. */
  overhangMm2: number;
  /** Total surface area of the mesh, mm2. */
  surfaceMm2: number;
  /** `overhangMm2 / surfaceMm2`, 0 for an empty mesh. */
  fraction: number;
  /** The steepest lean found, degrees from vertical, or 0. */
  steepestDeg: number;
}

/**
 * Area-weighted downward-facing triangles past {@link OVERHANG_LIMIT_DEG}.
 *
 * The test is on the triangle normal, which manifold3d winds counter-clockwise
 * seen from outside, so a face whose normal points down is a face the printer
 * has to lay over air. The lean from vertical is `90 - angle(n, -z)`, so
 * "steeper than L degrees from vertical" is `-nz / |n| > cos(90 - L)`.
 *
 * Faces whose highest vertex is within {@link PLATE_SKIN_MM} of z = 0 are
 * skipped: that is the model sitting on the bed, not an overhang.
 */
export function overhangReport(
  mesh: Pick<RegionMesh, "positions" | "indices">,
  limitDeg: number = OVERHANG_LIMIT_DEG,
): OverhangReport {
  const p = mesh.positions;
  const idx = mesh.indices;
  // A face leaning `limitDeg` from vertical has -nz/|n| = cos(90 - limitDeg).
  const cosLimit = Math.cos(((90 - limitDeg) * Math.PI) / 180);
  let overhang = 0;
  let surface = 0;
  let steepest = 0;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const twiceArea = Math.hypot(nx, ny, nz);
    if (!(twiceArea > 0)) continue;
    const area = twiceArea / 2;
    surface += area;
    if (nz >= 0) continue;
    const down = -nz / twiceArea;
    if (!(down > cosLimit)) continue;
    const topZ = Math.max(p[a + 2], p[b + 2], p[c + 2]);
    if (topZ <= PLATE_SKIN_MM) continue;
    overhang += area;
    const leanDeg = 90 - (Math.acos(Math.min(1, down)) * 180) / Math.PI;
    if (leanDeg > steepest) steepest = leanDeg;
  }
  return {
    overhangMm2: overhang,
    surfaceMm2: surface,
    fraction: surface > 0 ? overhang / surface : 0,
    steepestDeg: steepest,
  };
}

// ---------------------------------------------------------------------------
// Islands
// ---------------------------------------------------------------------------

/**
 * One group of bodies in the assembled model that is not joined to the rest.
 *
 * Produced by `solid/validate.ts` (it needs the live solid to decompose) and
 * worded here, so the wording of every finding lives in one file.
 */
export interface IslandReport {
  /** The region the loose material belongs to, or null when it spans several. */
  region: RegionName | null;
  count: number;
  volumeMm3: number;
  /** True when the loose bodies never touch the bed either. */
  floating: boolean;
}

/**
 * The optional feature a loose island most likely came from, or null.
 *
 * Only these three can be switched off in `PrintParams` without redesigning the
 * model, so only these three can carry a one-click fix.
 */
function droppableFeature(
  region: RegionName | null,
  params: PrintParams,
  stats: EngineStats,
): { label: string; patch: Record<string, unknown> } | null {
  if (region === "parks" && params.trees === true && (stats.trees ?? 0) > 0) {
    return { label: "Turn off the tree markers", patch: { trees: false } };
  }
  if ((region === "roads" || region === "rail") && (stats.bridges ?? 0) > 0 && params.bridges?.enabled !== false) {
    return {
      label: "Turn off the raised bridge decks",
      patch: { bridges: { ...(params.bridges ?? {}), enabled: false } },
    };
  }
  if (region === "lettering") {
    return { label: "Turn off the inlaid lettering", patch: { engravings: [] } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export interface AuditInput {
  params: PrintParams;
  scene: SceneGraph;
  /** The ground radius the SceneGraph was built with, metres. */
  radiusM: number;
  regions: readonly RegionMesh[];
  /** The welded solid: the ONLY mesh the surface and volume rules may read. */
  merged: RegionMesh;
  stats: EngineStats;
  /** Findings raised while building, already worded by their own module. */
  built: readonly AuditFinding[];
  /** Loose bodies found in the assembly, from `solid/validate.ts`. */
  islands?: readonly IslandReport[];
  /** Defaults to `resolveProfile(params)`. */
  profile?: PrinterProfile;
  tiles?: readonly TileResult[];
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/**
 * Every finding for one finished model, ordered error first, de-duplicated.
 *
 * Never throws and never re-runs geometry: it reads the meshes it is given.
 */
export function auditPrintability(input: AuditInput): AuditFinding[] {
  const profile = input.profile ?? resolveProfile(input.params);
  const out: AuditFinding[] = [];
  const add = (finding: AuditFinding | null): void => {
    if (finding === null) return;
    if (out.some((f) => f.id === finding.id && f.detail === finding.detail)) return;
    out.push(finding);
  };
  // The bake's own findings go through the same door, so a rule that raises
  // the same thing twice (a refusal reported per piece, a solid checked per
  // region) is said once.
  for (const finding of input.built) add(finding);

  add(profilePlateFinding(input, profile));
  for (const finding of slotFindings(input, profile)) add(finding);
  add(overhangFinding(input));
  add(mergedBuildingsFinding(input));
  for (const finding of islandFindings(input)) add(finding);
  for (const finding of tileFindings(input, profile)) add(finding);

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** The model's printed footprint, mm, from the welded solid. */
function footprint(input: AuditInput): { width: number; depth: number; height: number } {
  const box = input.merged.bbox;
  const width = box.max[0] - box.min[0];
  const depth = box.max[1] - box.min[1];
  const height = box.max[2] - box.min[2];
  if (width > 0 && depth > 0) return { width, depth, height };
  // An empty merged solid (a scene with nothing in it) falls back to the stats,
  // which are computed over the regions.
  return { width: input.stats.widthMm, depth: input.stats.depthMm, height: input.stats.heightMm };
}

/**
 * Does the model fit the printer the user picked?
 *
 * Judged against the RAW plate, with no margin: a model exactly as wide as the
 * bed does print, and telling someone their 180 mm model does not fit their
 * 180 mm bed would be false. The margin only appears in the REMEDY, where it
 * buys the tile a skirt.
 */
function profilePlateFinding(input: AuditInput, profile: PrinterProfile): AuditFinding | null {
  if (input.tiles !== undefined && input.tiles.length > 1) return null;
  const { width, depth } = footprint(input);
  if (!(width > 0) || !(depth > 0)) return null;
  const tolerance = 0.01;
  if (width <= profile.plateXMm + tolerance && depth <= profile.plateYMm + tolerance) return null;

  const usable = Math.min(profile.plateXMm, profile.plateYMm) - 2 * PLATE_EDGE_MARGIN_MM;
  const fitPlate = Math.floor(Math.min(usable, T.PLATE_MAX_MM));
  const shrink = fitPlate / input.params.plate_mm;
  const detail =
    `It measures ${width.toFixed(1)} x ${depth.toFixed(1)} mm against the ` +
    `${profile.label}'s ${profile.plateXMm} x ${profile.plateYMm} mm bed.`;

  if (fitPlate >= T.PLATE_MIN_MM && shrink >= PLATE_SHRINK_LIMIT) {
    return {
      id: "exceeds-profile-plate",
      severity: "error",
      title: "The model is bigger than the printer's bed",
      detail: `${detail} A ${fitPlate} mm plate fits it, with room for a skirt.`,
      fix: {
        label: `Print it on a ${fitPlate} mm plate`,
        safe: false,
        patch: { plate_mm: fitPlate },
      },
    };
  }

  const cols = Math.max(1, Math.ceil(width / Math.max(1, profile.plateXMm - 2 * PLATE_EDGE_MARGIN_MM)));
  const rows = Math.max(1, Math.ceil(depth / Math.max(1, profile.plateYMm - 2 * PLATE_EDGE_MARGIN_MM)));
  return {
    id: "exceeds-profile-plate",
    severity: "error",
    title: "The model is bigger than the printer's bed",
    detail:
      `${detail} Shrinking it to fit would cost ` +
      `${Math.round(100 * (1 - Math.max(0, shrink)))} % of its size, so it is worth ` +
      `splitting it into ${cols} x ${rows} tiles instead.`,
    fix: {
      label: `Split it into ${cols} x ${rows} tiles`,
      safe: false,
      patch: {
        tiling: { ...(input.params.tiling ?? {}), enabled: true, cols, rows },
      },
    },
  };
}

/** Regions assigned to a filament slot the printer does not have. */
function slotFindings(input: AuditInput, profile: PrinterProfile): AuditFinding[] {
  const beyond = input.regions.filter((region) => region.slot > profile.slots);
  if (beyond.length === 0) return [];
  const names = [...new Set(beyond.map((region) => region.region))].sort(
    (a, b) => REGION_NAMES.indexOf(a) - REGION_NAMES.indexOf(b),
  );
  const slots = [...new Set(beyond.map((region) => region.slot))].sort((a, b) => a - b);
  const table = { ...(input.params.colour?.region_slots ?? {}) } as Record<string, number>;
  for (const name of names) table[name] = profile.slots;
  return [
    {
      id: "slot-beyond-profile",
      severity: "error",
      title:
        names.length === 1
          ? `The ${names[0]} region is on a filament slot this printer does not have`
          : `${names.length} regions are on filament slots this printer does not have`,
      detail:
        `${names.join(", ")} ${names.length === 1 ? "is" : "are"} on slot ` +
        `${slots.join(", ")}, and the ${profile.label} addresses ${profile.slots} ` +
        `${profile.slots === 1 ? "slot" : "slots"}. The exporter would write a slot the ` +
        "slicer cannot fill.",
      fix: {
        label: `Move ${names.length === 1 ? "it" : "them"} to slot ${profile.slots}`,
        safe: true,
        patch: { colour: { ...(input.params.colour ?? {}), region_slots: table } },
      },
    },
  ];
}

/**
 * Downward faces the printer cannot lay over air.
 *
 * No fix: there is no parameter that removes an overhang. What the detail does
 * instead is name the two things that produce them in this model, so the reader
 * knows whether to turn supports on or to change the design.
 */
function overhangFinding(input: AuditInput): AuditFinding | null {
  const report = overhangReport(input.merged);
  if (report.fraction < OVERHANG_INFO_FRACTION || report.surfaceMm2 <= 0) return null;
  const severity: Severity = report.fraction >= OVERHANG_WARN_FRACTION ? "warning" : "info";
  const percent = (100 * report.fraction).toFixed(1);
  const causes: string[] = [];
  if ((input.stats.bridges ?? 0) > 0) causes.push("bridge decks stand clear of the ground");
  if (input.stats.terrainReliefMm !== undefined) causes.push("terrain leans back under itself");
  if ((input.stats.trees ?? 0) > 0) causes.push("the tree canopies flare outward");
  if (input.params.frame && input.params.frame_style?.profile === "floating") {
    causes.push("the floating frame profile is undercut");
  }
  const because =
    causes.length === 0
      ? "It is worth a look in the slicer preview before printing."
      : `Most of it is where ${causes.join(", and ")}.`;
  return {
    id: "unsupported-overhang",
    severity,
    title:
      severity === "warning"
        ? "Part of the model overhangs steeply enough to need support"
        : "A little of the model overhangs steeply",
    detail:
      `${percent} % of the surface (${report.overhangMm2.toFixed(0)} mm2 of ` +
      `${report.surfaceMm2.toFixed(0)} mm2) leans more than ${OVERHANG_LIMIT_DEG} degrees ` +
      `from vertical, the steepest at ${report.steepestDeg.toFixed(0)} degrees. ` +
      `${because} Faces within ${PLATE_SKIN_MM} mm of the bed are not counted; they rest on it.`,
  };
}

/**
 * Buildings the minimum-feature repair welded into one block.
 *
 * This is the number that explains why a printed city has fewer buildings than
 * the map does, and it is a fact about the SCALE rather than a fault, so it is
 * an info with the ground distance in it and no fix: the remedies (a bigger
 * plate, a smaller radius) belong to the detail advisor, which says them with
 * a solved number attached.
 */
function mergedBuildingsFinding(input: AuditInput): AuditFinding | null {
  const merged = input.stats.buildingsMerged;
  if (merged <= 0) return null;
  const scale = input.stats.scaleDenominator > 0 ? 1000 / input.stats.scaleDenominator : 0;
  const gapM = scale > 0 ? T.min_gap_mm(input.params) / scale : 0;
  return {
    id: "buildings-merged",
    severity: "info",
    title: `${merged} buildings were merged into their neighbours`,
    detail:
      `At 1:${Math.round(input.stats.scaleDenominator)} a ${input.params.nozzle_mm} mm nozzle ` +
      `cannot leave a gap under ${gapM.toFixed(1)} m of ground, so ${merged} building(s) ` +
      `closer than that print as one block. ${input.stats.buildings} block(s) came out of ` +
      `${input.scene.buildings.length} footprints. A bigger plate or a smaller radius is ` +
      "what separates them.",
    region: "buildings",
  };
}

/** Loose bodies: material that is not joined to the rest of the model. */
function islandFindings(input: AuditInput): AuditFinding[] {
  const islands = input.islands ?? [];
  const out: AuditFinding[] = [];
  for (const island of islands) {
    if (island.count <= 0) continue;
    const where = island.region === null ? "the model" : `the ${island.region} region`;
    const drop = droppableFeature(island.region, input.params, input.stats);
    const finding: AuditFinding = {
      id: "floating-island",
      severity: "error",
      title:
        island.count === 1
          ? `One piece of ${where} is not joined to the rest`
          : `${island.count} pieces of ${where} are not joined to the rest`,
      detail:
        `${island.count} ${island.count === 1 ? "body" : "bodies"} totalling ` +
        `${island.volumeMm3.toFixed(2)} mm3 ${island.count === 1 ? "is" : "are"} separate from ` +
        `the plate. ${
          island.floating
            ? "They do not even reach the bed, so the printer would lay them over air."
            : "They stand on the bed but nothing holds them to the model, so they will come away."
        }`,
      ...(island.region === null ? {} : { region: island.region }),
      ...(drop === null
        ? {}
        : {
            fix: {
              label: drop.label,
              // Removing content the user asked for is never applied unasked.
              safe: false,
              patch: drop.patch,
            },
          }),
    };
    out.push(finding);
  }
  return out;
}

/** Every tile has to fit the bed on its own. */
function tileFindings(input: AuditInput, profile: PrinterProfile): AuditFinding[] {
  const tiles = input.tiles ?? [];
  if (tiles.length === 0) return [];
  const tolerance = 0.01;
  const oversize = tiles.filter((tile) => {
    const width = tile.bbox.max[0] - tile.bbox.min[0];
    const depth = tile.bbox.max[1] - tile.bbox.min[1];
    return width > profile.plateXMm + tolerance || depth > profile.plateYMm + tolerance;
  });
  if (oversize.length === 0) return [];
  const widest = oversize.reduce((worst, tile) => {
    const span = Math.max(tile.bbox.max[0] - tile.bbox.min[0], tile.bbox.max[1] - tile.bbox.min[1]);
    const worstSpan = Math.max(worst.bbox.max[0] - worst.bbox.min[0], worst.bbox.max[1] - worst.bbox.min[1]);
    return span > worstSpan ? tile : worst;
  }, oversize[0]);
  const cols = Math.max(
    1,
    Math.ceil(input.stats.widthMm / Math.max(1, profile.plateXMm - 2 * PLATE_EDGE_MARGIN_MM)),
  );
  const rows = Math.max(
    1,
    Math.ceil(input.stats.depthMm / Math.max(1, profile.plateYMm - 2 * PLATE_EDGE_MARGIN_MM)),
  );
  return [
    {
      id: "tile-exceeds-plate",
      severity: "error",
      title: `${oversize.length} tile(s) are still bigger than the bed`,
      detail:
        `Tile ${widest.label} measures ` +
        `${(widest.bbox.max[0] - widest.bbox.min[0]).toFixed(1)} x ` +
        `${(widest.bbox.max[1] - widest.bbox.min[1]).toFixed(1)} mm against the ` +
        `${profile.label}'s ${profile.plateXMm} x ${profile.plateYMm} mm bed. ` +
        `${cols} x ${rows} tiles would fit.`,
      fix: {
        label: `Split it into ${cols} x ${rows} tiles`,
        safe: false,
        patch: { tiling: { ...(input.params.tiling ?? {}), enabled: true, cols, rows } },
      },
    },
  ];
}
