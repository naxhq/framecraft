/**
 * Hero buildings: the handful a user wants to stand out.
 *
 * The editor half only. Clicking a building in the preview toggles its
 * SceneGraph id in `PrintParams.hero_building_ids`; the build half (the
 * `true_height` multiplier, the `own_color` part and the block-merge
 * exemption) is the parts-export phase's, per DECISIONS [V2-P3].
 *
 * The cap is the contract's own `maxItems`. It is enforced here rather than by
 * letting the write through and hoping the server rejects it: a payload the
 * frozen schema refuses would fail the whole build with a validation error
 * instead of telling the user, at the moment of the click, that twelve is the
 * limit.
 */

import { PARAM_LIMITS } from "./contracts";
import type { PrintParams } from "./contracts";
import type { EngineBuilding } from "./engine/osm/types";
import { hero_ids, hero_true_height, ring_area_m2 } from "./transform";

/**
 * `print_params.json` -> `hero_building_ids.maxItems`, read from the GENERATED
 * contract rather than re-typed, so a schema change moves the cap, the notice
 * and the `n/12` badge together.
 */
export const HERO_CAP: number = PARAM_LIMITS.hero_building_ids.max_items;

export interface HeroToggle {
  /** The new list. Unchanged (same array contents) when the cap refused it. */
  ids: string[];
  /** True when the click was refused because the list is full. */
  capHit: boolean;
  /** What just happened, for the announcement. */
  action: "added" | "removed" | "refused";
}

/**
 * Toggle one id, newest last, refusing past the cap.
 *
 * Removal always works, including when the list is full -- otherwise a user who
 * reached twelve could never get back under it.
 */
export function toggleHeroId(
  ids: readonly string[],
  id: string,
  cap: number = HERO_CAP,
): HeroToggle {
  if (ids.includes(id)) {
    return { ids: ids.filter((value) => value !== id), capHit: false, action: "removed" };
  }
  if (ids.length >= cap) {
    return { ids: [...ids], capHit: true, action: "refused" };
  }
  return { ids: [...ids, id], capHit: false, action: "added" };
}

/** The message shown at the cap. */
export function heroCapMessage(cap: number = HERO_CAP): string {
  return `That is the limit: ${cap} hero buildings. Remove one to pick another.`;
}

/**
 * Index -> hero, for the InstancedMesh colour buffer.
 *
 * The preview draws buildings in `lib/preview.ts`'s order, which drops the
 * footprints the build drops, so the instance index is NOT the SceneGraph index
 * and the lookup has to go through the id.
 */
export function heroFlags(
  buildingIds: readonly string[],
  heroIds: readonly string[],
): boolean[] {
  const heroes = new Set(heroIds);
  return buildingIds.map((id) => heroes.has(id));
}

/**
 * A memo/effect key for "which buildings print at their HERO height", as one
 * string.
 *
 * `hero_building_ids` is an array, so it can never be a dependency in a list
 * that also has to be all-primitives (`warningDeps`, `matrixDeps`), and the
 * array's identity changes on every `setParam` write anyway. This is the exact
 * input `transform.hero_height_ids` reads: EMPTY while `hero_mode` is
 * `own_color`, because own-colour heroes are a colour change and must not
 * re-upload 994 instance matrices (`InstancedBuildings.test.ts`).
 */
export function heroHeightKey(params: PrintParams): string {
  if (!hero_true_height(params)) return "";
  return hero_ids(params).join(" ");
}

// ---------------------------------------------------------------------------
// Auto heroes (phase 3, PrintParams.hero_auto)
//
// `hero_auto.enabled` promotes the top-scoring buildings automatically, on
// top of whatever the user has clicked. A manual pick never gets evicted by
// an auto one: `autoHeroIds` always keeps every id in `manualIds`, however
// many there are, and only spends the auto quota (`hero_auto.count`) on ids
// that are not already there, itself bounded by `HERO_CAP`.
//
// The score has three terms, each normalised to 0..1 against the tallest
// building / largest footprint in the SAME scene, so it means something at
// any radius: how tall a building is relative to its neighbours, how big its
// footprint is relative to its neighbours, and how many landmark signals OSM
// carries for it. The landmark signals are exactly `normalize.ts:isLandmark`'s
// own inputs (`tourism`, `historic`, `wikidata`, `man_made=tower` -- folded
// into `landmark`, since the raw `man_made` tag value itself is not carried
// past ingest): a building with more than one of them scores higher than one
// with a single passing tag. `building=cathedral/church/tower` specifically
// is NOT inspectable here -- `EngineBuilding` does not carry the raw
// `building` tag value, only the derived `landmark` flag -- so those get
// credit only via `historic`/`tourism`/`wikidata` when OSM also carries one of
// those, which most churches and cathedrals do (DECISIONS [V3-P3-U]).
// ---------------------------------------------------------------------------

/** One scored building, sorted by `heroCandidates` best first. */
export interface HeroCandidate {
  id: string;
  /** OSM `name`, when present; `heroDisplayName`/`topHeroName` decide the fallback. */
  name?: string;
  heightM: number;
  areaM2: number;
  landmark: boolean;
  score: number;
}

/** The (up to) four landmark signals `EngineBuilding` carries past ingest. */
const LANDMARK_SIGNALS: ReadonlyArray<(b: EngineBuilding) => boolean> = [
  (b) => Boolean(b.tourism),
  (b) => Boolean(b.historic),
  (b) => Boolean(b.wikidata),
  (b) => Boolean(b.landmark),
];

function landmarkBonus(building: EngineBuilding): number {
  const hits = LANDMARK_SIGNALS.reduce((count, check) => count + (check(building) ? 1 : 0), 0);
  return hits / LANDMARK_SIGNALS.length;
}

/** Net footprint area, holes subtracted, never negative. */
function footprintAreaM2(building: Pick<EngineBuilding, "ring" | "holes">): number {
  let area = ring_area_m2(building.ring);
  for (const hole of building.holes ?? []) area -= ring_area_m2(hole);
  return Math.max(0, area);
}

const HEIGHT_WEIGHT = 0.5;
const AREA_WEIGHT = 0.2;
const LANDMARK_WEIGHT = 0.3;

/**
 * Every building, scored and sorted best-first (ties broken by id, so the
 * order is total and does not depend on the array's original order).
 *
 * O(n log n) in the building count -- a few thousand at most, well inside the
 * 33 ms slider budget, but this is NOT itself gated by a slider: callers memo
 * it on the scene alone (`heroTokenInfo`, `store/editor.ts`'s engine job), not
 * on every PrintParams write.
 */
export function heroCandidates(buildings: readonly EngineBuilding[]): HeroCandidate[] {
  let maxHeight = 0;
  let maxArea = 0;
  const areas = buildings.map((building) => footprintAreaM2(building));
  for (let i = 0; i < buildings.length; i += 1) {
    if (buildings[i].height_m > maxHeight) maxHeight = buildings[i].height_m;
    if (areas[i] > maxArea) maxArea = areas[i];
  }
  const candidates = buildings.map((building, i) => {
    const normalizedHeight = maxHeight > 0 ? building.height_m / maxHeight : 0;
    const normalizedArea = maxArea > 0 ? areas[i] / maxArea : 0;
    const score =
      HEIGHT_WEIGHT * normalizedHeight +
      AREA_WEIGHT * normalizedArea +
      LANDMARK_WEIGHT * landmarkBonus(building);
    return {
      id: building.id,
      name: building.name,
      heightM: building.height_m,
      areaM2: areas[i],
      landmark: Boolean(building.landmark),
      score,
    };
  });
  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Manual ids, plus up to `count` more from `candidates`, never evicting a
 * manual pick and never exceeding `cap` in total.
 *
 * Manual ids come first and in their given order (the order the user picked
 * them in); the auto slots fill from the best-scoring candidate down,
 * skipping anything already manual, until `count` have been added or `cap` is
 * reached -- whichever comes first.
 */
export function autoHeroIds(
  candidates: readonly HeroCandidate[],
  manualIds: readonly string[],
  count: number,
  cap: number = HERO_CAP,
): string[] {
  const manual = Array.from(new Set(manualIds));
  const manualSet = new Set(manual);
  const result = [...manual];
  const quota = Math.max(0, Math.trunc(count));
  let added = 0;
  for (const candidate of candidates) {
    if (added >= quota) break;
    if (result.length >= cap) break;
    if (manualSet.has(candidate.id)) continue;
    result.push(candidate.id);
    added += 1;
  }
  return result;
}

/**
 * The ids that will actually build as heroes right now: manual alone with
 * `hero_auto` off, manual plus the top `hero_auto.count` otherwise.
 *
 * `buildings` is optional so a caller mid-Preview (no scene yet) still gets
 * the manual list rather than an empty one.
 */
export function effectiveHeroIds(
  buildings: readonly EngineBuilding[] | undefined,
  params: Pick<PrintParams, "hero_building_ids" | "hero_auto">,
): string[] {
  const manual = params.hero_building_ids ?? [];
  if (!params.hero_auto?.enabled || !buildings) return [...manual];
  const candidates = heroCandidates(buildings);
  return autoHeroIds(candidates, manual, params.hero_auto.count ?? 0);
}

/** What the HEROES panel shows for one candidate: its name, or a plain fallback. */
export function heroDisplayName(candidate: Pick<HeroCandidate, "name">): string {
  const trimmed = candidate.name?.trim();
  return trimmed ? trimmed : "unnamed building";
}

/**
 * The name of the highest-scoring building among `heroIds`, or null when none
 * are picked or the top one has no OSM name. `{hero}` (`lib/tokens.ts`) falls
 * back to the count text in either case.
 */
export function topHeroName(
  candidates: readonly HeroCandidate[],
  heroIds: readonly string[],
): string | null {
  if (heroIds.length === 0) return null;
  const heroSet = new Set(heroIds);
  const top = candidates.find((candidate) => heroSet.has(candidate.id));
  const name = top?.name?.trim();
  return name ? name : null;
}

/**
 * `heroHeightKey`, but over the EFFECTIVE hero set (manual plus, once
 * `hero_auto` is on, the auto-promoted ones) rather than the manual list
 * alone -- so the 60 mm height guard and the HUD's predicted height follow an
 * auto-promoted hero's true height exactly as they already do a manually
 * picked one (`lib/warnings.ts:predictedTopDeps`).
 *
 * `lib/transform.ts` is frozen to this phase's other builder and only ever
 * reads `params.hero_building_ids`; this composes the same true-height gate
 * (`hero_true_height`) with the effective id set on this side of that
 * boundary instead.
 */
export function effectiveHeroHeightKey(
  buildings: readonly EngineBuilding[] | undefined,
  params: PrintParams,
): string {
  if (!hero_true_height(params)) return "";
  return effectiveHeroIds(buildings, params).join(" ");
}

/** `{hero}`'s inputs in one call: how many heroes are picked right now, and the top one's name if it has one. */
export function heroTokenInfo(
  buildings: readonly EngineBuilding[] | undefined,
  params: Pick<PrintParams, "hero_building_ids" | "hero_auto">,
): { count: number; name: string | null } {
  const ids = effectiveHeroIds(buildings, params);
  if (!buildings || ids.length === 0) return { count: ids.length, name: null };
  return { count: ids.length, name: topHeroName(heroCandidates(buildings), ids) };
}
