"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { PrintParams } from "@/lib/contracts";
import { labelled } from "@/lib/controlCatalog";
import type { EngineBuilding } from "@/lib/engine/osm/types";
import {
  GROUPS,
  defaultCollapsed,
  loadCollapsed,
  saveCollapsed,
  summariseGroup,
  type CollapsedGroups,
  type GroupId,
} from "@/lib/groups";
import { effectiveHeroIds } from "@/lib/heroes";
import { isTypingTarget } from "@/lib/keyboard";
import {
  changeCount,
  changedInSection,
  sectionReset,
  topLevelKey,
  withDefaults,
} from "@/lib/settingsDiff";
import { groupsWithHits, hitsInGroup, searchSettings } from "@/lib/settingsSearch";
import { useEditorStore } from "@/store/editor";
import { ChangesChip, ChangesList } from "./ChangesFromDefault";
import CollapsibleGroup from "./CollapsibleGroup";
import { SrHint } from "./Controls";
import OutputPanel from "./OutputPanel";
import SettingsSearch, { SearchEmpty, SearchHits } from "./SettingsSearch";
import BridgesGroup from "./groups/BridgesGroup";
import BuildingsGroup from "./groups/BuildingsGroup";
import ColourGroup from "./groups/ColourGroup";
import FrameTextGroup from "./groups/FrameTextGroup";
import HeightsGroup from "./groups/HeightsGroup";
import LocationGroup from "./groups/LocationGroup";
import PrinterGroup from "./groups/PrinterGroup";
import RegionsGroup from "./groups/RegionsGroup";
import ScaleSizeGroup from "./groups/ScaleSizeGroup";
import SurfaceGroup from "./groups/SurfaceGroup";
import TerrainGroup from "./groups/TerrainGroup";

/**
 * The parameter panel: every control the contract exposes, sorted into eleven
 * collapsible groups plus the pinned Output section.
 *
 * Four rules hold this together:
 *
 *  - **Ranges come from `PARAM_RANGES`** in the GENERATED contracts, never from
 *    a number typed into a component, so a schema change moves the sliders.
 *  - **Every write goes through the store's own setters**, so export
 *    staleness, the `previewDeps` memo keys and the undo history keep working
 *    and nothing here can reach the network. A per-section reset and a revert
 *    are the same rule: one `set()` call, therefore one undo entry
 *    (`store/history.ts` records by subscribing, one entry per notification).
 *  - **Labels and help strings come from `lib/controlCatalog.ts`**, which is
 *    also what the search indexes, so the copy a user reads and the copy the
 *    search matches are one string.
 *  - **Layout is not a setting** (DECISIONS `[V3.1-O6]`): which groups are
 *    expanded and what is in the search box live in this component and in
 *    `localStorage`, never in `PrintParams`, so neither can reach the changes
 *    counter, a share link or a file.
 *
 * Output is pinned to the bottom rather than scrolling away with the rest:
 * Export is the primary action once a scene exists, and a primary action that
 * has to be scrolled to is not primary. Its collapse toggle folds the results
 * (status, downloads, stats) and never the action row.
 */
const BODIES: Record<Exclude<GroupId, "output">, () => ReactNode> = {
  location: LocationGroup,
  scale: ScaleSizeGroup,
  buildings: BuildingsGroup,
  heights: HeightsGroup,
  surface: SurfaceGroup,
  regions: RegionsGroup,
  bridges: BridgesGroup,
  terrain: TerrainGroup,
  frame: FrameTextGroup,
  colour: ColourGroup,
  printer: PrinterGroup,
};

const PARAM_GROUPS = GROUPS.filter((group) => group.id !== "output");

export function ParamPanel() {
  const params = useEditorStore((state) => state.params);
  const resetParams = useEditorStore((state) => state.resetParams);
  const radiusM = useEditorStore((state) => state.location.radius_m);
  const rotationDeg = useEditorStore((state) => state.location.rotation_deg);
  // Manual picks plus, once `hero_auto` is on, the auto-promoted ones -- the
  // same set that actually builds (`store/editor.ts:currentHeroIds`), so the
  // header never undercounts against what the HEROES section itself lists.
  const heroCount = useEditorStore((state) =>
    effectiveHeroIds(
      state.scene.graph ? (state.scene.graph.buildings as EngineBuilding[]) : undefined,
      state.params,
    ).length,
  );

  // Server-rendered as the defaults, then reconciled with localStorage after
  // mount. Reading storage during render would mismatch the HTML Next sent.
  const [collapsed, setCollapsed] = useState<CollapsedGroups>(defaultCollapsed);
  useEffect(() => {
    setCollapsed(loadCollapsed());
  }, []);

  const [query, setQuery] = useState("");
  const [changesOpen, setChangesOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const toggle = useCallback((id: GroupId) => {
    setCollapsed((previous) => {
      const next = { ...previous, [id]: !previous[id] };
      saveCollapsed(next);
      return next;
    });
  }, []);

  // Slash focuses the search, the way every list of settings behaves. Refused
  // inside a text field (so "/" in a place name types a slash) and refused with
  // any modifier, which leaves Shift+/ to the shortcut sheet ("?").
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "/") return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTypingTarget(event.target as { tagName?: string; type?: string } | null)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const searching = query.trim() !== "";
  const hits = useMemo(() => (searching ? searchSettings(query) : []), [query, searching]);
  const hitGroups = useMemo(() => groupsWithHits(hits), [hits]);

  const changed = useMemo(() => changeCount(params), [params]);
  const changedPerGroup = useMemo(() => {
    const out = {} as Record<GroupId, number>;
    for (const group of GROUPS) out[group.id] = changedInSection(params, group.id).length;
    return out;
  }, [params]);

  // A drawer with nothing left in it closes behind itself.
  useEffect(() => {
    if (changed === 0) setChangesOpen(false);
  }, [changed]);

  /** One top-level key, written through the store: one `set()`, one undo entry. */
  const writeKey = useCallback(<K extends keyof PrintParams>(key: K, next: PrintParams) => {
    useEditorStore.getState().setParam(key, next[key]);
  }, []);

  const resetSection = useCallback(
    (group: GroupId) => {
      const store = useEditorStore.getState();
      const next = sectionReset(store.params, group);
      if (next === store.params) return;
      const keys = new Set(changedInSection(store.params, group).map((path) => topLevelKey(path)));
      const only = [...keys];
      // One key goes through `setParam`, which is also what reschedules the
      // terrain job for the two fields that need it. More than one key has to
      // land in a SINGLE store write or undo would take the reset back in
      // pieces, and `applyHistorySnapshot` is the only setter that writes the
      // whole params object without also marking the scene stale or refetching.
      if (only.length === 1) writeKey(only[0], next);
      else store.applyHistorySnapshot({ location: store.location, params: next });
    },
    [writeKey],
  );

  const revert = useCallback(
    (path: string) => {
      const store = useEditorStore.getState();
      const next = withDefaults(store.params, [path]);
      if (next === store.params) return;
      writeKey(topLevelKey(path), next);
    },
    [writeKey],
  );

  const focusControl = useCallback((testId: string) => {
    // The testId is a catalog constant, never user input.
    const target = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    target.focus();
  }, []);

  const outputGroup = GROUPS[GROUPS.length - 1];
  const visibleGroups = searching
    ? PARAM_GROUPS.filter((group) => hitGroups.has(group.id))
    : PARAM_GROUPS;

  return (
    <div className="flex h-full min-h-0 flex-col bg-plate">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="font-display text-2xs font-semibold uppercase tracking-[0.16em] text-ink">
          Model
        </h2>
        <div className="flex items-center gap-1.5">
          <ChangesChip
            count={changed}
            open={changesOpen}
            onToggle={() => setChangesOpen(!changesOpen)}
          />
          <button
            type="button"
            data-testid="reset-button"
            onClick={resetParams}
            aria-describedby="reset-button-hint"
            title={labelled("reset-button").hint}
            className="rounded-milled px-1.5 py-0.5 text-2xs text-ink-muted transition-colors hover:bg-plate-raised hover:text-ink"
          >
            {labelled("reset-button").label}
          </button>
        </div>
        <SrHint id="reset-button-hint">{labelled("reset-button").hint}</SrHint>
      </div>

      <SettingsSearch
        query={query}
        onQuery={setQuery}
        hitCount={hits.length}
        inputRef={searchRef}
      />

      {changesOpen && changed > 0 ? <ChangesList params={params} onRevert={revert} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="param-groups">
        {searching && visibleGroups.length === 0 ? (
          <SearchEmpty query={query.trim()} onClear={() => setQuery("")} />
        ) : null}
        {visibleGroups.map((group) => {
          const Body = BODIES[group.id as Exclude<GroupId, "output">];
          // A search opens the groups its hits are in and leaves the stored
          // state alone, so clearing the box puts the panel back as it was.
          const groupHits = searching ? hitsInGroup(hits, group.id) : [];
          const isCollapsed = searching ? false : collapsed[group.id];
          return (
            <CollapsibleGroup
              key={group.id}
              id={group.id}
              title={group.title}
              summary={group.summary}
              state={summariseGroup(group.id, params, { heroCount, radiusM, rotationDeg })}
              collapsed={isCollapsed}
              onToggle={() => toggle(group.id)}
              onReset={() => resetSection(group.id)}
              resetDisabled={changedPerGroup[group.id] === 0}
              changedCount={changedPerGroup[group.id]}
            >
              <SearchHits
                group={group.id}
                hits={groupHits}
                query={query}
                onFocusControl={focusControl}
              />
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
            // Names the RESULTS wrapper only. The action row (Preview / Export)
            // and the predicted height are always rendered by design
            // (DECISIONS [V2-P4]), so pointing `aria-controls` at their
            // container announced "collapsed" over a region still on screen.
            aria-controls={collapsed.output ? undefined : "group-output-body"}
            aria-label={`${outputGroup.title}, ${
              collapsed.output ? "show results" : "hide results"
            }`}
            aria-describedby="group-output-toggle-hint"
            title={labelled("group-output-toggle").hint}
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
        <SrHint id="group-output-toggle-hint">{labelled("group-output-toggle").hint}</SrHint>
        <OutputPanel
          showResults={!collapsed.output}
          resultsId="group-output-body"
        />
      </section>
    </div>
  );
}

export default ParamPanel;
