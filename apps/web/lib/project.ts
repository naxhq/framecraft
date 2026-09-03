/**
 * The project file: a whole editor state as a downloadable `.framecraft.json`
 * document ([V3-P6]).
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
 * Loading is untrusted input, exactly like a share link: `parsePrintParams`
 * (`lib/share.ts`) is reused rather than re-implemented, so a project file
 * and a share link can never validate a field two different ways.
 */

import { defaultPrintParams, type PrintParams } from "./contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M } from "./geo";
import { parsePrintParams } from "./share";
import type { LocationState } from "@/store/editor";

/** The file's own format tag, checked before its version. */
export const PROJECT_FORMAT = "framecraft-project";

/** The project file schema this build writes and reads. */
export const PROJECT_VERSION = 3;

export const PROJECT_FILE_EXTENSION = ".framecraft.json";

export interface FrameCraftProject {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  /** ISO 8601, UTC: when the file was written. */
  saved_at: string;
  pin: { lat: number; lon: number };
  radius_m: number;
  rotation_deg: number;
  preset_id: string | null;
  /** The resolved place name at save time (`params.city_label`), for a human reading the file; restoring reads `params.city_label` itself, not this. */
  place: string;
  params: PrintParams;
}

/** The project object for the editor's current location and settings. */
export function buildProject(
  location: LocationState,
  params: PrintParams,
  now: Date = new Date(),
): FrameCraftProject {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    saved_at: now.toISOString(),
    pin: { lat: location.lat, lon: location.lon },
    radius_m: location.radius_m,
    rotation_deg: location.rotation_deg,
    preset_id: location.preset_id,
    place: params.city_label ?? "",
    params,
  };
}

export function serializeProject(project: FrameCraftProject): string {
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
export function downloadProject(project: FrameCraftProject): void {
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

export type ProjectLoadResult =
  | { ok: true; location: LocationState; params: PrintParams }
  | { ok: false; reason: string };

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse and validate a `.framecraft.json` document's text.
 *
 * Never throws: a project file is untrusted input exactly like a share link
 * (it may have been hand-edited, come from a future FrameCraft, or simply be
 * some other JSON file with the wrong extension), and every rejection names
 * what is wrong rather than leaving a half-restored editor.
 */
export function parseProject(text: string): ProjectLoadResult {
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
  if (record.version !== PROJECT_VERSION) {
    return {
      ok: false,
      reason:
        `this project file was saved by a different version of FrameCraft ` +
        `(version ${String(record.version)}); this one reads version ${PROJECT_VERSION}`,
    };
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
  };
}

/** A blank project, for a caller that wants the shape without a real save (tests, docs). */
export function emptyProject(now: Date = new Date()): FrameCraftProject {
  return buildProject(
    { lat: 0, lon: 0, radius_m: RADIUS_MIN_M, rotation_deg: 0, preset_id: null },
    defaultPrintParams(),
    now,
  );
}
