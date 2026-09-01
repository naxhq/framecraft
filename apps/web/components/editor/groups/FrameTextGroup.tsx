"use client";

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { DEFAULT_PRINT_PARAMS, PARAM_LIMITS, PARAM_RANGES } from "@/lib/contracts";
import type { NorthArrow, ScaleBar, UndersideMark } from "@/lib/contracts";
import type { EngineBuilding } from "@/lib/engine/osm/types";
import { heroTokenInfo } from "@/lib/heroes";
import { textParamsKey } from "@/lib/previewText";
import { resolve_text, type TokenContext } from "@/lib/tokens";
import * as T from "@/lib/transform";
import { useEditorStore } from "@/store/editor";
import EngravingsEditor from "../EngravingsEditor";
import { Field, Note, SelectField, Slider, TextField, Toggle } from "../Controls";

const CORNERS = [
  { value: "ne" as const, label: "Top right" },
  { value: "nw" as const, label: "Top left" },
  { value: "se" as const, label: "Bottom right" },
  { value: "sw" as const, label: "Bottom left" },
];

const EDGES = [
  { value: "top" as const, label: "Top" },
  { value: "bottom" as const, label: "Bottom" },
  { value: "left" as const, label: "Left" },
  { value: "right" as const, label: "Right" },
];

const LENGTH_MODES = [
  { value: "auto" as const, label: "Auto" },
  { value: "fixed" as const, label: "Fixed" },
];

const HANGERS = [
  { value: "none" as const, label: "None" },
  { value: "keyhole" as const, label: "Keyhole slot" },
  { value: "magnets" as const, label: "Magnet pockets" },
];

/* The generated defaults, which are the all-defaults instance of each nested
   object (DECISIONS [V2-P2]); every property inside them is optional, so these
   are also the fallback when a share link omitted one entirely. */
const DEFAULT_NORTH_ARROW: NorthArrow = DEFAULT_PRINT_PARAMS.north_arrow ?? {};
const DEFAULT_SCALE_BAR: ScaleBar = DEFAULT_PRINT_PARAMS.scale_bar ?? {};
const DEFAULT_UNDERSIDE: UndersideMark = DEFAULT_PRINT_PARAMS.underside_mark ?? {};

/**
 * The border and everything written on it: lettering, a north arrow, a scale
 * bar, the mark underneath, and how the finished plate hangs.
 *
 * Every nested object is written through `store.setNested`, which rebuilds it
 * by spread -- a mutated nested object would keep its identity and no memo
 * would ever notice it changed.
 */
export function FrameTextGroup() {
  const params = useEditorStore((state) => state.params);
  const graph = useEditorStore((state) => state.scene.graph);
  const { lat, lon, radius_m, rotation_deg } = useEditorStore(
    useShallow((state) => ({
      lat: state.location.lat,
      lon: state.location.lon,
      radius_m: state.location.radius_m,
      rotation_deg: state.location.rotation_deg,
    })),
  );
  const setParam = useEditorStore((state) => state.setParam);
  const setNested = useEditorStore((state) => state.setNested);

  /**
   * `{date}` is pinned at mount, like `CityPreview`'s own copy: the shared
   * token table never reads a clock, the caller supplies the date
   * (DECISIONS [V2-P2]), and a fresh `new Date()` per render made this memo's
   * value change identity on every keystroke.
   */
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  const northArrow = params.north_arrow ?? DEFAULT_NORTH_ARROW;
  const scaleBar = params.scale_bar ?? DEFAULT_SCALE_BAR;
  const underside = params.underside_mark ?? DEFAULT_UNDERSIDE;

  /**
   * What `{hero}` says right now: the effective count (manual plus, once
   * `hero_auto` is on, the auto-promoted ones) and the top one's name, if it
   * has one (`lib/heroes.ts`, phase 3 `[V3-P3-U]`). `graph.buildings` is
   * structurally an `EngineBuilding[]` at runtime -- see
   * `lib/engine/osm/types.ts`.
   */
  const heroInfo = useMemo(
    () => heroTokenInfo(graph ? (graph.buildings as EngineBuilding[]) : undefined, params),
    // Same discipline as the context memo below: primitives/identity-stable
    // references only, never `params` itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, params.hero_building_ids, params.hero_auto?.enabled, params.hero_auto?.count],
  );

  /**
   * What the tokens say right now. The date is supplied by the caller and
   * never read inside the token table (DECISIONS [V2-P2]), so this is the one
   * place the clock is consulted.
   */
  const context: TokenContext = useMemo(
    () => {
      const sceneRadius = graph ? T.radius_m_from_bounds(graph.bounds) : radius_m;
      return {
        lat: graph ? graph.center.lat : lat,
        lon: graph ? graph.center.lon : lon,
        scale_mm_per_m: graph ? T.scale_mm_per_m(params, sceneRadius) : 0,
        radius_m: sceneRadius,
        date: today,
        buildings: graph ? graph.stats.building_count : 0,
        city: params.city_label ?? "",
        country: params.place?.country ?? "",
        state: params.place?.state ?? "",
        neighbourhood: params.place?.neighbourhood ?? "",
        author: params.place?.author ?? "",
        hero_count: heroInfo.count,
        hero_name: heroInfo.name ?? undefined,
      };
    },
    // NEVER `params`: `store.setParam` rebuilds it by spread on every write, so
    // a dependency on the object missed on every slider tick, colour change and
    // hero pick, rebuilt this context with a fresh identity, and re-ran
    // `lettering_layout` below each time -- the exact trap `CityPreview`'s
    // `previewDeps` exists to avoid (audit v2-06 finding 7). These are all the
    // primitives the context actually reads: the scale is `usable_span_mm`,
    // i.e. the plate and the frame; `place` and `heroInfo` feed
    // `{country}`/`{state}`/`{neighbourhood}`/`{author}`/`{hero}` ([V3-P1]).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      graph,
      lat,
      lon,
      radius_m,
      today,
      params.plate_mm,
      params.frame,
      params.city_label,
      params.place?.country,
      params.place?.state,
      params.place?.neighbourhood,
      params.place?.author,
      heroInfo.count,
      heroInfo.name,
    ],
  );

  /**
   * The shared layout for the parameters as they stand.
   *
   * The panel shows each line's VERDICT next to the line itself -- the fitted
   * size, or the refusal and the size that would work -- because that is where
   * the user is when they choose a cap height. The same messages also reach the
   * adjustments drawer through the preview, and the bake reports them again for
   * the same parameters; all three are one string from one function.
   */
  const layout = useMemo(
    () => T.lettering_layout(params, context, rotation_deg),
    // `textParamsKey` is the same string `previewDeps.text` is keyed on: a JSON
    // dump of exactly the nine parameters a layout is a function of. Comparing
    // by value is what makes a `setNested` write that changed nothing, and any
    // write to a parameter this does not read, free.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [textParamsKey(params), context, rotation_deg],
  );

  return (
    <>
      <Toggle
        id="frame"
        label="Frame"
        checked={params.frame}
        onChange={(value) => setParam("frame", value)}
        hint="A 6 mm border standing 2 mm proud of the base. It costs 12 mm of plate, so the city inside gets smaller."
      />

      <Field
        label="Lettering"
        hint="Cut into the frame edges. Up to eight lines."
      >
        <EngravingsEditor
          engravings={params.engravings ?? []}
          onChange={(next) => setParam("engravings", next)}
          context={context}
          fits={layout.engravings.map((engraving) => engraving.fit)}
          disabled={!params.frame}
        />
      </Field>

      {!params.frame ? (
        <Note tone="warn" testId="frame-off-notice">
          The north arrow and the scale bar live on the frame. Turn on Frame
          to use them.
        </Note>
      ) : null}

      <Field label="North arrow">
        <Toggle
          id="north_arrow_enabled"
          label="Show a north arrow"
          checked={northArrow.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("north_arrow", { enabled: value })}
        />
        {northArrow.enabled ? (
          <div className="mt-3 space-y-3">
            <SelectField
              id="north_arrow_corner"
              label="Corner"
              value={northArrow.corner ?? "ne"}
              options={CORNERS}
              disabled={!params.frame}
              onChange={(value) => setNested("north_arrow", { corner: value })}
            />
            <Slider
              id="north_arrow_size_mm"
              label="Size"
              min={PARAM_RANGES.north_arrow.size_mm.min}
              max={PARAM_RANGES.north_arrow.size_mm.max}
              step={0.1}
              value={northArrow.size_mm ?? PARAM_RANGES.north_arrow.size_mm.default}
              display={`${(northArrow.size_mm ?? PARAM_RANGES.north_arrow.size_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("north_arrow", { size_mm: value })}
            />
          </div>
        ) : null}
      </Field>

      <Field label="Scale bar">
        <Toggle
          id="scale_bar_enabled"
          label="Show a scale bar"
          checked={scaleBar.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("scale_bar", { enabled: value })}
        />
        {scaleBar.enabled ? (
          <div className="mt-3 space-y-3">
            <SelectField
              id="scale_bar_edge"
              label="Edge"
              value={scaleBar.edge ?? "bottom"}
              options={EDGES}
              disabled={!params.frame}
              onChange={(value) => setNested("scale_bar", { edge: value })}
            />
            <SelectField
              id="scale_bar_length_mode"
              label="Length"
              value={scaleBar.length_mode ?? "auto"}
              options={LENGTH_MODES}
              disabled={!params.frame}
              onChange={(value) => setNested("scale_bar", { length_mode: value })}
              hint="Auto picks a round distance that fits the edge."
            />
            {scaleBar.length_mode === "fixed" ? (
              <Slider
                id="scale_bar_length_m"
                label="Ground length"
                min={PARAM_RANGES.scale_bar.length_m.min}
                max={PARAM_RANGES.scale_bar.length_m.max}
                step={10}
                value={scaleBar.length_m ?? PARAM_RANGES.scale_bar.length_m.default}
                display={`${scaleBar.length_m ?? PARAM_RANGES.scale_bar.length_m.default} m`}
                disabled={!params.frame}
                onChange={(value) => setNested("scale_bar", { length_m: value })}
              />
            ) : null}
          </div>
        ) : null}
      </Field>

      <Field label="Underside mark">
        <Toggle
          id="underside_mark_enabled"
          label="Mark the underside"
          checked={underside.enabled ?? false}
          onChange={(value) => setNested("underside_mark", { enabled: value })}
          hint="Cut into the bottom of the base, where it never shows on a shelf."
        />
        {underside.enabled ? (
          <div className="mt-3 space-y-2">
            <TextField
              id="underside_mark_template"
              label="Template"
              value={underside.template ?? ""}
              maxLength={PARAM_LIMITS.underside_mark.template.max_length}
              meta={`${(underside.template ?? "").length}/${
                PARAM_LIMITS.underside_mark.template.max_length
              }`}
              onChange={(value) => setNested("underside_mark", { template: value })}
            />
            {(() => {
              const resolved = resolve_text(underside.template ?? "", context);
              const emptyToken = resolved.tokens.find((t) => t.empty)?.token ?? null;
              return (
                <p
                  data-testid="underside_mark-preview"
                  className="rounded-milled border border-line bg-plate-raised px-2 py-1 text-2xs text-ink-muted"
                >
                  Cuts as:{" "}
                  {resolved.text ? (
                    <span className="text-ink">{resolved.text}</span>
                  ) : (
                    <span className="text-ink-faint">
                      {emptyToken !== null
                        ? `nothing yet — the {${emptyToken}} token has no value`
                        : "nothing yet — the template has no text"}
                    </span>
                  )}
                </p>
              );
            })()}
          </div>
        ) : null}
      </Field>

      <SelectField
        id="hanger"
        label="Hanger"
        value={params.hanger ?? "none"}
        options={HANGERS}
        onChange={(value) => setParam("hanger", value)}
        hint="A fitting added to the back so the plate can go on a wall."
      />
    </>
  );
}

export default FrameTextGroup;
