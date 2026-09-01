"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { EngineBuilding } from "@/lib/engine/osm/types";
import {
  GROUPS,
  defaultCollapsed,
  loadCollapsed,
  saveCollapsed,
  type CollapsedGroups,
  type GroupId,
} from "@/lib/groups";
import { HERO_CAP, effectiveHeroIds } from "@/lib/heroes";
import { useEditorStore } from "@/store/editor";
import CollapsibleGroup from "./CollapsibleGroup";
import OutputPanel from "./OutputPanel";
import BuildingsGroup from "./groups/BuildingsGroup";
import ColourGroup from "./groups/ColourGroup";
import FrameTextGroup from "./groups/FrameTextGroup";
import HeightsGroup from "./groups/HeightsGroup";
import LocationGroup from "./groups/LocationGroup";
import ScaleSizeGroup from "./groups/ScaleSizeGroup";
import SurfaceGroup from "./groups/SurfaceGroup";
import TerrainGroup from "./groups/TerrainGroup";

/**
 * The parameter panel: every control in 01's editor table plus schema_version
 * 2's personalisation set, sorted into seven collapsible groups.
 *
 * Two rules hold this together:
 *
 *  - **Ranges come from `PARAM_RANGES`** in the GENERATED contracts, never from
 *    a number typed into a component, so a schema change moves the sliders.
 *  - **Every write goes through `store.setParam`** (or `setNested`, which is
 *    `setParam` with an immutable spread), so bake staleness and the
 *    `previewDeps` memo keys keep working and nothing here can reach the
 *    network. `store/editor.test.ts` drives every key of the frozen contract
 *    through `setParam` with `fetch` spied on and fails if one ever does.
 *
 * Output is pinned to the bottom rather than scrolling away with the rest:
 * Bake is the primary action once a scene exists, and a primary action that
 * has to be scrolled to is not primary. Its collapse toggle folds the results
 * (status, downloads, stats) and never the action row.
 */
const BODIES: Record<Exclude<GroupId, "output">, () => ReactNode> = {
  location: LocationGroup,
  scale: ScaleSizeGroup,
  buildings: BuildingsGroup,
  heights: HeightsGroup,
  surface: SurfaceGroup,
  terrain: TerrainGroup,
  frame: FrameTextGroup,
  colour: ColourGroup,
};

export function ParamPanel() {
  const resetParams = useEditorStore((state) => state.resetParams);
  // Manual picks plus, once `hero_auto` is on, the auto-promoted ones -- the
  // same set that actually bakes (`store/editor.ts:currentHeroIds`), so the
  // badge never undercounts against what the HEROES section itself lists.
  const heroCount = useEditorStore((state) =>
    effectiveHeroIds(
      state.scene.graph ? (state.scene.graph.buildings as EngineBuilding[]) : undefined,
      state.params,
    ).length,
  );
  const engravingCount = useEditorStore(
    (state) => (state.params.engravings ?? []).length,
  );
  const colorMode = useEditorStore((state) => state.params.color_mode ?? "single");
  const terrainOn = useEditorStore((state) => state.params.terrain?.enabled ?? false);

  // Server-rendered as the defaults, then reconciled with localStorage after
  // mount. Reading storage during render would mismatch the HTML Next sent.
  const [collapsed, setCollapsed] = useState<CollapsedGroups>(defaultCollapsed);
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

  const toggle = useCallback((id: GroupId) => {
    setCollapsed((previous) => {
      const next = { ...previous, [id]: !previous[id] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  const badges: Partial<Record<GroupId, string | null>> = {
    buildings: heroCount > 0 ? `${heroCount}/${HERO_CAP} heroes` : null,
    frame:
      engravingCount > 0
        ? `${engravingCount} ${engravingCount === 1 ? "line" : "lines"}`
        : null,
    colour: colorMode === "parts" ? "7 parts" : null,
    terrain: terrainOn ? "on" : null,
  };

  const outputGroup = GROUPS[GROUPS.length - 1];

  return (
    <div className="flex h-full min-h-0 flex-col bg-plate">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="font-display text-2xs font-semibold uppercase tracking-[0.16em] text-ink">
          Model
        </h2>
        <button
          type="button"
          data-testid="reset-button"
          onClick={resetParams}
          className="rounded-milled px-1.5 py-0.5 text-2xs text-ink-muted transition-colors hover:bg-plate-raised hover:text-ink"
        >
          Reset all
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="param-groups">
        {GROUPS.filter((group) => group.id !== "output").map((group) => {
          const Body = BODIES[group.id as Exclude<GroupId, "output">];
          return (
            <CollapsibleGroup
              key={group.id}
              id={group.id}
              title={group.title}
              summary={group.summary}
              collapsed={collapsed[group.id]}
              onToggle={() => toggle(group.id)}
              badge={badges[group.id] ?? null}
            >
              <Body />
            </CollapsibleGroup>
          );
        })}
      </div>

      <section
        data-testid="group-output"
        data-collapsed={collapsed.output ? "true" : "false"}
        className="fc-scored shrink-0 bg-plate px-4 pb-4 pt-2"
      >
        <h3>
          <button
            type="button"
            data-testid="group-output-toggle"
            aria-expanded={!collapsed.output}
            // Names the RESULTS wrapper only. The action row (Generate / Bake)
            // and the predicted height are always rendered by design
            // (DECISIONS [V2-P4]), so pointing `aria-controls` at their
            // container announced "collapsed" over a region still on screen.
            aria-controls={collapsed.output ? undefined : "group-output-body"}
            aria-label={`${outputGroup.title}, ${
              collapsed.output ? "show results" : "hide results"
            }`}
            onClick={() => toggle("output")}
            className="mb-2 flex w-full items-center justify-between gap-2 rounded-milled py-1 text-left transition-colors hover:text-ink"
          >
            <span className="font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink">
              {outputGroup.title}
            </span>
            <span className="text-2xs text-ink-faint">
              {collapsed.output ? "show results" : "hide results"}
            </span>
          </button>
        </h3>
        <OutputPanel
          showResults={!collapsed.output}
          resultsId="group-output-body"
        />
      </section>
    </div>
  );
}

export default ParamPanel;
