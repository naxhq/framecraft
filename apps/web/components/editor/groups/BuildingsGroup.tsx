"use client";

import { useMemo } from "react";

import { PARAM_RANGES } from "@/lib/contracts";
import type { PrintParams } from "@/lib/contracts";
import type { EngineBuilding } from "@/lib/engine/osm/types";
import {
  HERO_CAP,
  autoHeroIds,
  heroCandidates,
  heroCapMessage,
  heroDisplayName,
} from "@/lib/heroes";
import { useEditorStore } from "@/store/editor";
import { Field, Note, Slider, Toggle } from "../Controls";

/** Percent sliders move in 5-point steps; 0.05 of the underlying float. */
const PERCENT_STEP = 5;

/** Identity-stable fallback: a fresh `[]` per render would invalidate every useMemo keyed on it. */
const EMPTY_HERO_IDS: readonly string[] = [];

/**
 * What a hero row shows, in words. With NO SCENE at all (a fresh share-link
 * restore, before Preview has run: `store/editor.ts`'s own rule is that a
 * restore never fetches on its own) there is nothing to look a name up IN --
 * showing `heroDisplayName`'s "unnamed building" there would be a lie: it
 * reads as "checked, this building has no name" when the truth is "never
 * checked". The raw id is the honest, stable thing the share link actually
 * carries (matches the Remove button's own `aria-label`, which always names
 * it), and it is what a manual pick showed before hero names existed at all.
 * Once a scene exists, `heroDisplayName` takes over exactly as before,
 * "unnamed building" included for a real building that genuinely has none.
 */
function heroRowLabel(
  id: string,
  info: { heightM: number; name?: string } | undefined,
  hasScene: boolean,
): string {
  if (!hasScene) return id;
  return heroDisplayName(info ?? {});
}

/**
 * Buildings: the two height multipliers, the handful of buildings the user
 * wants to stand out (manual), and the auto-detection that promotes the
 * top-scoring ones on top of that (`hero_auto`, phase 3 3b).
 *
 * 01 states the height sliders as percentages while the frozen `PrintParams`
 * stores 0.5..2.0 floats, so these render `value * 100` and write `percent/100`.
 *
 * Auto-detected heroes are listed separately from the manual "Hero buildings"
 * list, read-only: `toggleHero` only ever edits `hero_building_ids`, so an
 * auto-only id offered the same Remove button would be misread as an ADD
 * (`toggleHeroId` toggles membership in the MANUAL array, which does not
 * contain it) rather than a removal. Turning off auto-detect, or lowering its
 * count, is how an auto pick goes away; clicking it in the preview promotes
 * it to a real manual pick instead, which does have a Remove button.
 */
export function BuildingsGroup() {
  const params = useEditorStore((state) => state.params);
  const graph = useEditorStore((state) => state.scene.graph);
  const setParam = useEditorStore((state) => state.setParam);
  const setNested = useEditorStore((state) => state.setNested);
  const toggleHero = useEditorStore((state) => state.toggleHero);
  const clearHeroes = useEditorStore((state) => state.clearHeroes);

  const heroes = params.hero_building_ids ?? EMPTY_HERO_IDS;
  const autoEnabled = params.hero_auto?.enabled ?? false;
  const autoCount = params.hero_auto?.count ?? 3;

  const percent = (key: keyof PrintParams): number =>
    Math.round((params[key] as number) * 100);

  const candidates = useMemo(
    () => (graph ? heroCandidates(graph.buildings as EngineBuilding[]) : []),
    [graph],
  );

  // Height/name in one lookup, so the list says something more useful than a
  // bare OSM way id.
  const byId = useMemo(() => {
    const map = new Map<string, { heightM: number; name?: string }>();
    for (const candidate of candidates) {
      map.set(candidate.id, { heightM: candidate.heightM, name: candidate.name });
    }
    return map;
  }, [candidates]);

  const autoIds = useMemo(
    () => (autoEnabled ? autoHeroIds(candidates, heroes, autoCount) : heroes),
    [candidates, heroes, autoEnabled, autoCount],
  );
  const autoOnlyIds = useMemo(
    () => autoIds.filter((id) => !heroes.includes(id)),
    [autoIds, heroes],
  );
  const effectiveCount = autoIds.length;

  return (
    <>
      <Slider
        id="small_scale"
        label="Small building scale"
        min={PARAM_RANGES.small_scale.min * 100}
        max={PARAM_RANGES.small_scale.max * 100}
        step={PERCENT_STEP}
        value={percent("small_scale")}
        display={`${percent("small_scale")} %`}
        onChange={(value) => setParam("small_scale", value / 100)}
        hint="Height multiplier for buildings under 40 m."
      />

      <Slider
        id="large_scale"
        label="Large building scale"
        min={PARAM_RANGES.large_scale.min * 100}
        max={PARAM_RANGES.large_scale.max * 100}
        step={PERCENT_STEP}
        value={percent("large_scale")}
        display={`${percent("large_scale")} %`}
        onChange={(value) => setParam("large_scale", value / 100)}
        hint="Height multiplier for buildings 40 m and over. Push this too far and the model passes the 60 mm print ceiling."
      />

      <Field
        label="Hero buildings"
        hint="Click a building in the preview to pick it out. Heroes keep their true height and can take their own colour when the model is built."
      >
        <div data-testid="hero-list" className="space-y-1">
          {heroes.length === 0 ? (
            <p className="text-2xs text-ink-faint">
              None picked. Click a building in the preview.
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {heroes.map((id) => {
                  const info = byId.get(id);
                  return (
                    <li
                      key={id}
                      data-testid="hero-item"
                      className="flex items-center justify-between gap-2 rounded-milled border border-line bg-plate-sunken py-1 pl-2 pr-1"
                    >
                      <span className="truncate text-2xs text-ink-muted">
                        {heroRowLabel(id, info, Boolean(graph))}
                        {info ? ` · ${info.heightM.toFixed(0)} m` : ""}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleHero(id)}
                        aria-label={`Remove hero building ${id}`}
                        className="rounded-[2px] px-1.5 py-0.5 text-2xs text-ink-faint transition-colors hover:bg-plate-raised hover:text-danger"
                      >
                        Remove
                      </button>
                    </li>
                  );
                })}
              </ul>
              <div className="flex items-center justify-between gap-2 pt-0.5">
                <span className="text-2xs text-ink-faint">
                  {heroes.length} of {HERO_CAP} picked
                </span>
                <button
                  type="button"
                  onClick={clearHeroes}
                  className="text-2xs text-accent underline-offset-2 hover:underline"
                >
                  Clear all
                </button>
              </div>
            </>
          )}
        </div>
      </Field>

      {/*
        A statement of state, not of the last event: the list is full. The
        response to a REFUSED click is shown in the viewport instead, next to
        where the click happened, because this group may well be collapsed.
      */}
      {effectiveCount >= HERO_CAP ? (
        <Note tone="warn" testId="hero-cap-notice">
          {heroCapMessage()}
        </Note>
      ) : null}

      <Toggle
        id="hero_auto_enabled"
        label="Auto-detect heroes"
        checked={autoEnabled}
        onChange={(value) => setNested("hero_auto", { enabled: value })}
        hint="Promotes the tallest, biggest-footprint and most landmark-tagged buildings automatically, on top of anything picked by hand."
      />

      <Slider
        id="hero_auto_count"
        label="Auto-detected count"
        min={PARAM_RANGES.hero_auto.count.min}
        max={PARAM_RANGES.hero_auto.count.max}
        step={1}
        value={autoCount}
        display={String(autoCount)}
        onChange={(value) => setNested("hero_auto", { count: value })}
        disabled={!autoEnabled}
        hint="How many buildings to promote automatically. Manual picks are never evicted for one of these."
      />

      {autoEnabled ? (
        <Field label="Auto-detected">
          <div data-testid="hero-auto-list" className="space-y-1">
            {autoOnlyIds.length === 0 ? (
              <p className="text-2xs text-ink-faint">
                {graph ? "No further buildings stood out here." : "Preview a location first."}
              </p>
            ) : (
              <ul className="space-y-1">
                {autoOnlyIds.map((id) => {
                  const info = byId.get(id);
                  return (
                    <li
                      key={id}
                      data-testid="hero-auto-item"
                      className="truncate rounded-milled border border-line bg-plate-sunken px-2 py-1 text-2xs text-ink-muted"
                    >
                      {heroRowLabel(id, info, Boolean(graph))}
                      {info ? ` · ${info.heightM.toFixed(0)} m` : ""}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Field>
      ) : null}
    </>
  );
}

export default BuildingsGroup;
