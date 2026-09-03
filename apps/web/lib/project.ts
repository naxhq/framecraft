/**
 * The project file: a whole editor state as a `.framecraft` document
 * ([V3-P6], extension and envelope revised for v3.1 Task 13).
 *
 * A permalink (`lib/share.ts`) and a project file solve two different
 * problems that look alike: a link is for handing a design to someone else
 * over chat, bounded by what a URL can carry (`SHARE_LINK_LENGTH_LIMIT`); a
 * project file is for keeping a design of your own, with no length ceiling at
 * all and a format that survives being renamed, emailed as an attachment, or
 * put under version control next to the rest of a project. It carries the
 * WHOLE `PrintParams` object (not a diff against the default), because a
 * file on disk should still mean the same thing after a future default
 * changes -- it is not asking to be replayed against "whatever FrameCraft
 * currently defaults to" the way a short link is.
 *
 * ## Why the container is plain JSON and not gzip
 *
 * Measured, not assumed. A MAXIMAL project -- every optional block set, eight
 * engravings at the contract's `maxItems` with 120-character texts, twelve
 * hero ids, a custom printer profile with 400 characters of change G-code, a
 * sixteen-slot gradient, the full frame style, and both per-object lists at
 * their `maxItems` (24 overrides, 12 labels) -- serialises to 19 907 bytes of
 * indented JSON, which gzip -9 takes to 2 076. Saving 17.8 kB is not worth
 * making the file unreadable in a text editor, unsearchable by `grep`,
 * undiffable in git and unopenable by anything that does not know FrameCraft.
 * A pathological hypothetical measured alongside it -- an override AND a label
 * for all 992 buildings of the Chicago Loop, which the contract's item caps do
 * not currently allow -- is 369 kB, still nothing for a local file. The
 * threshold at which this decision would be worth revisiting is a maximal
 * project in the megabytes, and nothing on the roadmap puts it there.
 *
 * ## Loading is untrusted input
 *
 * Exactly like a share link: `parsePrintParams` (`lib/share.ts`) is reused
 * rather than re-implemented, so a project file and a share link can never
 * validate a field two different ways, and every rejection names what is
 * wrong rather than leaving a half-restored editor.
 *
 * The one place the envelope is deliberately LAX where the settings block is
 * strict: an unknown top-level key is carried through as an extra rather than
 * refused (see `ProjectExtras`). A settings key this build does not know is a
 * value that would silently not apply, which is a refusal; a whole block this
 * build does not know is a block a NEWER FrameCraft wrote, and dropping it on
 * the floor would quietly destroy the user's work the next time they saved.
 */

import { adoptLayoutPayload, currentLayoutPayload } from "@/store/layout";
import { defaultPrintParams, type PrintParams } from "./contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M } from "./geo";
import { layoutFromPayload, type LayoutPayload, type LayoutState } from "./layout";
import { parsePrintParams } from "./share";
import { appVersion } from "./version";
import type { LocationState } from "@/store/editor";

/** The file's own format tag, checked before its version. */
export const PROJECT_FORMAT = "framecraft-project";

/** The project file schema this build WRITES. */
export const PROJECT_VERSION = 4;

/**
 * Every envelope revision this build READS, oldest first.
 *
 * 3 is what FrameCraft 3.0 wrote, as `.framecraft.json`. It is structurally a
 * version-4 file minus `app_version`, so it is migrated by filling that in
 * rather than by moving any data, and the user is told once (see
 * `migrationNotice`).
 */
export const READABLE_PROJECT_VERSIONS: readonly number[] = [3, PROJECT_VERSION];

/** The extension this build writes. */
export const PROJECT_FILE_EXTENSION = ".framecraft";

/** What FrameCraft 3.0 wrote. Still opens; never written again. */
export const LEGACY_PROJECT_FILE_EXTENSION = ".framecraft.json";

/**
 * What a file input's `accept` should offer.
 *
 * `.json` and the MIME type are in the list because the legacy extension IS a
 * `.json` file to every OS file picker on the planet: a picker filtering on
 * `.framecraft.json` alone matches nothing, since only the last extension of a
 * double extension is ever considered. The cost is that a picker also offers
 * unrelated JSON files, which `parseProject` refuses by name in the UI.
 */
export const PROJECT_FILE_ACCEPT = `${PROJECT_FILE_EXTENSION},${LEGACY_PROJECT_FILE_EXTENSION},.json,application/json`;

/**
 * Blocks of a project this build does not itself understand.
 *
 * Per-object overrides (Task 11) and surface labels (Task 12) do NOT come
 * through here: both landed inside `PrintParams` as `object_overrides` and
 * `labels`, so a project file carries them exactly the way it carries a plate
 * size, and this module needed no field for either. What is left is the case
 * they would have been: a top-level block a FUTURE FrameCraft adds beside
 * `params` and `layout`. The reader keeps whatever it does not recognise here
 * and the writer puts it back unchanged, which is what makes the format
 * forward compatible in the only sense a user cares about -- opening a file in
 * an older build and saving it again does not delete the parts that build
 * could not show.
 *
 * Keys the reader consumes itself (`format`, `version`, `params`, `layout`,
 * and the rest of `FrameCraftProject`) never appear here.
 */
export type ProjectExtras = Readonly<Record<string, unknown>>;

export interface FrameCraftProject {
  format: typeof PROJECT_FORMAT;
  /** The FILE format's revision, which moves for its own reasons; `params.schema_version` is the contract revision the settings were written against. */
  version: typeof PROJECT_VERSION;
  /** The FrameCraft build that wrote the file, e.g. `3.1.0`. Informational: nothing branches on it, it is there so a bug report can name a build. */
  app_version: string;
  /** ISO 8601, UTC: when the file was written. */
  saved_at: string;
  pin: { lat: number; lon: number };
  radius_m: number;
  rotation_deg: number;
  preset_id: string | null;
  /** The resolved place name at save time (`params.city_label`), for a human reading the file; restoring reads `params.city_label` itself, not this. */
  place: string;
  /**
   * Every setting: the hero building selection (`hero_building_ids`,
   * `hero_mode`, `hero_auto`), the per-object overrides and surface labels
   * (`object_overrides`, `labels`), and the contract revision all of them were
   * written against (`schema_version`). Written whole, never as a diff.
   */
  params: PrintParams;
  /**
   * The shell layout the design was framed in (DECISIONS `[V3.1-O6]`):
   * column widths, a collapsed side, a maximized region.
   *
   * A sibling of `params` and never a member of it, because layout is not a
   * print parameter: it must not hash into a pipeline stage and must not read
   * as a change from default in the settings diff. Optional, and absent
   * whenever the layout is simply the default.
   */
  layout?: LayoutPayload;
}

/** A project plus whatever blocks this build does not know about. */
export type WrittenProject = FrameCraftProject & ProjectExtras;

/**
 * The project object for the editor's current location and settings.
 *
 * `layout` defaults to what is on screen, for the same reason `encodeShare`'s
 * does: saving a design saves the way it was framed, without the Save button
 * having to know this field exists. `extras` is how a caller adds a block this
 * module does not model -- it is written verbatim, and a key that collides
 * with one of the modelled fields is ignored rather than allowed to overwrite
 * it.
 */
export function buildProject(
  location: LocationState,
  params: PrintParams,
  now: Date = new Date(),
  layout: LayoutPayload | null = currentLayoutPayload(),
  extras: ProjectExtras = {},
): WrittenProject {
  const known: FrameCraftProject = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app_version: appVersion(),
    saved_at: now.toISOString(),
    pin: { lat: location.lat, lon: location.lon },
    radius_m: location.radius_m,
    rotation_deg: location.rotation_deg,
    preset_id: location.preset_id,
    place: params.city_label ?? "",
    params,
    ...(layout === null ? {} : { layout }),
  };
  return { ...stripKnownKeys(extras), ...known };
}

export function serializeProject(project: WrittenProject): string {
  return JSON.stringify(project, null, 2);
}

/** A filesystem-safe stem: the place name (or "framecraft") plus the save date, no path separators or control characters. */
export function projectFilename(project: FrameCraftProject): string {
  const place = project.place.trim();
  const stem = (place !== "" ? place : "framecraft")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const date = project.saved_at.slice(0, 10);
  return `${stem || "framecraft"}-${date}${PROJECT_FILE_EXTENSION}`;
}

/**
 * Trigger a browser download of the project as a file, via a Blob object URL.
 * No-op outside a browser (SSR, a non-DOM test) -- there is nothing to
 * download to.
 */
export function downloadProject(project: WrittenProject): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const text = serializeProject(project);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = projectFilename(project);
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    // Deferred: revoking synchronously has been observed to cancel the
    // download itself on a couple of browsers before the click is handled.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface ProjectLoadOk {
  ok: true;
  location: LocationState;
  params: PrintParams;
  layout: LayoutState | null;
  /** Blocks this build does not model, kept so saving again does not drop them. */
  extras: ProjectExtras;
  /** The build that wrote the file (`app_version`), or the empty string for a version-3 file, which had no such field. */
  savedBy: string;
  /**
   * One sentence to show the user ONCE when the file was in an older form,
   * or null when it was already current. Never a reason to refuse a file:
   * a migration is something that happened, not something that went wrong.
   */
  migrated: string | null;
}

export type ProjectLoadResult = ProjectLoadOk | { ok: false; reason: string };

/** Field names `FrameCraftProject` models itself; everything else in an envelope is an extra. */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "format",
  "version",
  "app_version",
  "saved_at",
  "pin",
  "radius_m",
  "rotation_deg",
  "preset_id",
  "place",
  "params",
  "layout",
]);

function stripKnownKeys(source: ProjectExtras): ProjectExtras {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!KNOWN_KEYS.has(key)) kept[key] = value;
  }
  return kept;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True when `filename` is one of FrameCraft 3.0's `.framecraft.json` files. */
export function isLegacyProjectFilename(filename: string): boolean {
  return filename.toLowerCase().endsWith(LEGACY_PROJECT_FILE_EXTENSION);
}

/**
 * The one sentence a migrated file puts on screen.
 *
 * Exported and pure so the wording is pinned by a test rather than by reading
 * the UI, and so the same sentence serves the Load button and the desktop
 * app's open-with path. Returns null for an empty list, which is what "this
 * file was already current" looks like.
 */
export function migrationNotice(forms: readonly string[]): string | null {
  if (forms.length === 0) return null;
  const list =
    forms.length === 1 ? forms[0] : `${forms.slice(0, -1).join(", ")} and ${forms[forms.length - 1]}`;
  return (
    `This project was saved by an older FrameCraft (${list}). ` +
    `It was migrated and loaded; saving it writes a ${PROJECT_FILE_EXTENSION} file.`
  );
}

/**
 * Parse and validate a project document's text.
 *
 * `filename` is optional and only ever affects the migration NOTICE: the
 * bytes decide whether a file loads, so a `.framecraft` file whose envelope
 * says version 3 is still migrated, and a `.framecraft.json` file whose
 * envelope is current still says so. Never throws: a project file is
 * untrusted input exactly like a share link (it may have been hand-edited,
 * come from a future FrameCraft, or simply be some other JSON file with the
 * wrong extension).
 */
export function parseProject(text: string, filename = ""): ProjectLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "this file is not valid JSON, so it was not loaded" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "this file is not a FrameCraft project, so it was not loaded" };
  }
  const record = parsed as Record<string, unknown>;

  if (record.format !== PROJECT_FORMAT) {
    return {
      ok: false,
      reason:
        "this file is not a FrameCraft project (its format is missing or unrecognised), so it was not loaded",
    };
  }
  const version = record.version;
  if (typeof version !== "number" || !READABLE_PROJECT_VERSIONS.includes(version)) {
    return {
      ok: false,
      reason:
        `this project file was saved by a different version of FrameCraft ` +
        `(version ${String(version)}); this one reads version ` +
        `${READABLE_PROJECT_VERSIONS.join(" and ")}`,
    };
  }

  const migratedForms: string[] = [];
  if (version !== PROJECT_VERSION) migratedForms.push(`project format ${version}`);
  if (isLegacyProjectFilename(filename)) {
    migratedForms.push(`the ${LEGACY_PROJECT_FILE_EXTENSION} extension`);
  }

  const rawPin = record.pin;
  const pinFields =
    rawPin !== null && typeof rawPin === "object" && !Array.isArray(rawPin)
      ? (rawPin as Record<string, unknown>)
      : {};
  const lat = num(pinFields.lat);
  const lon = num(pinFields.lon);
  const radius = num(record.radius_m);
  const rotation = num(record.rotation_deg);
  if (lat === null || lat < -90 || lat > 90) {
    return { ok: false, reason: "this project file's pin latitude is missing or out of range, so it was not loaded" };
  }
  if (lon === null || lon < -180 || lon > 180) {
    return { ok: false, reason: "this project file's pin longitude is missing or out of range, so it was not loaded" };
  }
  if (radius === null || radius < RADIUS_MIN_M || radius > RADIUS_MAX_M) {
    return { ok: false, reason: "this project file's radius is missing or out of range, so it was not loaded" };
  }
  if (rotation === null || rotation < 0 || rotation > 360) {
    return { ok: false, reason: "this project file's rotation is missing or out of range, so it was not loaded" };
  }
  const rawPreset = record.preset_id;
  const presetId =
    rawPreset === null || rawPreset === undefined
      ? null
      : typeof rawPreset === "string" && rawPreset.length <= 64
        ? rawPreset
        : undefined;
  if (presetId === undefined) {
    return { ok: false, reason: "this project file's preset id is not valid, so it was not loaded" };
  }

  // `parsePrintParams` also carries a pre-v3.1 file's `part_colors` block into
  // `colour.region_colors` (DECISIONS [V3.1-P1-2]). It is done there rather
  // than here on purpose: a project file and a share link must never migrate a
  // payload two different ways, exactly as they must never validate one two
  // different ways.
  const parsedParams = parsePrintParams(record.params ?? {});
  if (!parsedParams.ok) {
    return {
      ok: false,
      reason: `this project file's settings ${parsedParams.reason}, so it was not loaded`,
    };
  }

  /*
    The author's framing, restored (DECISIONS [V3.1-O6]).

    Applied here, on a file that has already been accepted whole, for the same
    reason `decodeShare` applies a link's: the document carries it, so opening
    the document restores it, and a caller that forgot to pass it on would be a
    caller that silently dropped half of what the file says. A file with no
    `layout` block -- every project saved before this field, and every project
    whose author never moved a boundary -- leaves this browser's own layout
    exactly where it was, and nothing about the layout can make a file refuse
    to load.
  */
  const layout = record.layout === undefined ? null : layoutFromPayload(record.layout);
  if (layout !== null) adoptLayoutPayload(record.layout);

  const savedBy = typeof record.app_version === "string" ? record.app_version : "";

  return {
    ok: true,
    location: {
      lat,
      lon,
      radius_m: radius,
      rotation_deg: rotation,
      preset_id: presetId,
    },
    params: parsedParams.params,
    layout,
    extras: stripKnownKeys(record),
    savedBy,
    migrated: migrationNotice(migratedForms),
  };
}

/** A blank project, for a caller that wants the shape without a real save (tests, docs). */
export function emptyProject(now: Date = new Date()): WrittenProject {
  return buildProject(
    { lat: 0, lon: 0, radius_m: RADIUS_MIN_M, rotation_deg: 0, preset_id: null },
    defaultPrintParams(),
    now,
  );
}
