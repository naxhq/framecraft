"use client";

import { useMemo } from "react";

import { PARAM_RANGES } from "@/lib/contracts";
import type { PrintParams } from "@/lib/contracts";
import { HERO_CAP, heroCapMessage } from "@/lib/heroes";
import { useEditorStore } from "@/store/editor";
import { Field, Note, Slider } from "../Controls";

/** Percent sliders move in 5-point steps; 0.05 of the underlying float. */
const PERCENT_STEP = 5;

/**
 * Buildings: the two height multipliers, and the handful of buildings the user
 * wants to stand out.
 *
 * 01 states the height sliders as percentages while the frozen `PrintParams`
 * stores 0.5..2.0 floats, so these render `value * 100` and write `percent/100`.
 */
export function BuildingsGroup() {
  const params = useEditorStore((state) => state.params);
  const graph = useEditorStore((state) => state.scene.graph);
  const setParam = useEditorStore((state) => state.setParam);
  const toggleHero = useEditorStore((state) => state.toggleHero);
  const clearHeroes = useEditorStore((state) => state.clearHeroes);

  const heroes = params.hero_building_ids ?? [];

  const percent = (key: keyof PrintParams): number =>
    Math.round((params[key] as number) * 100);

  // Height in metres for each picked hero, so the list says something more
  // useful than an OSM way id.
  const heights = useMemo(() => {
    const map = new Map<string, number>();
    if (!graph) return map;
    for (const building of graph.buildings) map.set(building.id, building.height_m);
    return map;
  }, [graph]);

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
        hint="Click a building in the preview to pick it out. Heroes keep their true height and can take their own colour when the bake runs."
      >
        <div data-testid="hero-list" className="space-y-1">
          {heroes.length === 0 ? (
            <p className="text-2xs text-ink-faint">
              None picked. Click a building in the preview.
            </p>
          ) : (
            <>
              <ul className="space-y-1">
                {heroes.map((id) => (
                  <li
                    key={id}
                    data-testid="hero-item"
                    className="flex items-center justify-between gap-2 rounded-milled border border-line bg-plate-sunken py-1 pl-2 pr-1"
                  >
                    <span className="truncate text-2xs text-ink-muted">
                      {id}
                      {heights.has(id)
                        ? ` · ${(heights.get(id) as number).toFixed(0)} m`
                        : ""}
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
                ))}
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
      {heroes.length >= HERO_CAP ? (
        <Note tone="warn" testId="hero-cap-notice">
          {heroCapMessage()}
        </Note>
      ) : null}
    </>
  );
}

export default BuildingsGroup;
