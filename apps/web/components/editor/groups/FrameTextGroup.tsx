"use client";

import { useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { DEFAULT_PRINT_PARAMS, PARAM_LIMITS, PARAM_RANGES } from "@/lib/contracts";
import { labelled, sectionProps } from "@/lib/controlCatalog";
import type { FrameStyle, HangerMagnet, NorthArrow, ScaleBar, UndersideMark } from "@/lib/contracts";
import type { EngineBuilding } from "@/lib/engine/osm/types";
import { heroTokenInfo } from "@/lib/heroes";
import { textParamsKey } from "@/lib/previewText";
import { resolve_text, type TokenContext } from "@/lib/tokens";
import * as T from "@/lib/transform";
import { useEditorStore } from "@/store/editor";
import EngravingsEditor from "../EngravingsEditor";
import { Field, Note, SelectField, Slider, TextField, Toggle, radioGroupKeyDown } from "../Controls";

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
  { value: "cleat" as const, label: "French cleat" },
  { value: "easel" as const, label: "Easel foot" },
];

/**
 * Every `frame_style.profile` option, a one-line description, and a tiny
 * 24 px cross-section glyph -- a side-on slice through the lip, base at the
 * bottom, frame material hatched with straight strokes so the shape reads
 * even at icon size. Every path is `currentColor`: no colour value lives
 * here, only geometry, so the swatch scan in `design-tokens.test.ts` (which
 * only walks `components/**`/`app/**` for a raw hex, not for an SVG path)
 * has nothing to flag and the icon still re-themes with the panel text
 * colour in light and dark.
 */
const FRAME_PROFILES: ReadonlyArray<{
  value: NonNullable<FrameStyle["profile"]>;
  label: string;
  hint: string;
  path: string;
}> = [
  {
    value: "plain",
    label: "Plain",
    hint: "A flat-topped lip, square inside and out.",
    path: "M2 20h20 M2 20V9h20v11",
  },
  {
    value: "chamfer",
    label: "Chamfer",
    hint: "The inner top edge is cut back at an angle.",
    path: "M2 20h20 M2 20V9h20v6l-5 5",
  },
  {
    value: "stepped",
    label: "Stepped",
    hint: "The lip steps down once toward the plate.",
    path: "M2 20h20 M2 20V9h13v5h7v6",
  },
  {
    value: "bevel_in",
    label: "Bevel in",
    hint: "The top slopes down toward the picture, like a mount board.",
    path: "M2 20h20 M2 20V9h20v3l-14 8",
  },
  {
    value: "bullnose",
    label: "Bullnose",
    hint: "A rounded, quarter-round top edge.",
    path: "M2 20h20 M2 20V9h14a6 6 0 0 1-6 6v5",
  },
  {
    value: "ogee",
    label: "Ogee",
    hint: "An S-curved moulding profile, classic picture-frame shape.",
    path: "M2 20h20 M2 20V9h14c0 3 -4 2 -4 5s4 2 4 6",
  },
  {
    value: "floating",
    label: "Floating",
    hint: "The frame sits apart from the base with a visible gap (pairs with the shadow gap below).",
    path: "M2 20h6V9h14v6h-6v5",
  },
];

/** The profile ids in display order: the radiogroup's arrow-key sequence. */
const FRAME_PROFILE_VALUES = FRAME_PROFILES.map((option) => option.value);

const CORNER_STYLES = [
  { value: "square" as const, label: "Square" },
  { value: "mitred" as const, label: "Mitred" },
  { value: "rounded" as const, label: "Rounded" },
];

const SEPARATE_MOUNTS = [
  { value: "snap" as const, label: "Snap-fit" },
  { value: "magnet" as const, label: "Magnet" },
];

const TEXTURE_PATTERNS = [
  { value: "none" as const, label: "None" },
  { value: "brush" as const, label: "Brushed" },
  { value: "knurl" as const, label: "Knurled" },
  { value: "hatch" as const, label: "Hatched" },
  { value: "dots" as const, label: "Dotted" },
];

/* The generated defaults, which are the all-defaults instance of each nested
   object (DECISIONS [V2-P2]); every property inside them is optional, so these
   are also the fallback when a share link omitted one entirely. */
const DEFAULT_NORTH_ARROW: NorthArrow = DEFAULT_PRINT_PARAMS.north_arrow ?? {};
const DEFAULT_SCALE_BAR: ScaleBar = DEFAULT_PRINT_PARAMS.scale_bar ?? {};
const DEFAULT_UNDERSIDE: UndersideMark = DEFAULT_PRINT_PARAMS.underside_mark ?? {};
const DEFAULT_FRAME_STYLE: FrameStyle = DEFAULT_PRINT_PARAMS.frame_style ?? {};
const DEFAULT_HANGER_MAGNET: HangerMagnet = DEFAULT_PRINT_PARAMS.hanger_magnet ?? {};

/**
 * The border and everything written on it: lettering, a north arrow, a scale
 * bar, the mark underneath, and how the finished plate hangs.
 *
 * Every nested object is written through `store.setNested`, which rebuilds it
 * by spread -- a mutated nested object would keep its identity and no memo
 * would ever notice it changed.
 */
export function FrameTextGroup() {
  const profileGroupRef = useRef<HTMLDivElement | null>(null);
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
  const frameStyle = params.frame_style ?? DEFAULT_FRAME_STYLE;
  const shadowGap = frameStyle.shadow_gap ?? DEFAULT_FRAME_STYLE.shadow_gap ?? {};
  const matting = frameStyle.matting ?? DEFAULT_FRAME_STYLE.matting ?? {};
  const separate = frameStyle.separate ?? DEFAULT_FRAME_STYLE.separate ?? {};
  const texture = frameStyle.texture ?? DEFAULT_FRAME_STYLE.texture ?? {};
  const hangerMagnet = params.hanger_magnet ?? DEFAULT_HANGER_MAGNET;
  const magnetMountInUse = (separate.enabled ?? false) && separate.mount === "magnet";
  const wallMagnetsOnly = params.hanger === "magnets" && !magnetMountInUse;

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
   * adjustments drawer through the preview, and the build reports them again for
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
        {...labelled("frame")}
        checked={params.frame}
        onChange={(value) => setParam("frame", value)}
      />

      <Field {...sectionProps("frame-profile")}>
        {/*
          A real radiogroup, not seven buttons wearing the role. It cannot be a
          `Segmented` (each option draws a cross-section glyph), so it takes
          `Controls.radioGroupKeyDown` and a roving tabIndex instead: one Tab
          stop, arrows move the selection, Home and End jump to the ends. The
          pattern lives in one function so the two groups cannot drift.
        */}
        <div
          ref={profileGroupRef}
          className="grid grid-cols-2 gap-1.5"
          data-testid="frame-profile-options"
          role="radiogroup"
          aria-label={labelled("frame-profile-*").label}
          aria-describedby="frame-profile-hint"
          onKeyDown={radioGroupKeyDown(
            FRAME_PROFILE_VALUES,
            frameStyle.profile ?? "plain",
            (value) => setNested("frame_style", { profile: value }),
            profileGroupRef,
            !params.frame,
          )}
        >
          {FRAME_PROFILES.map((option) => (
            <button
              key={option.value}
              type="button"
              data-testid={`frame-profile-${option.value}`}
              role="radio"
              aria-checked={(frameStyle.profile ?? "plain") === option.value}
              tabIndex={(frameStyle.profile ?? "plain") === option.value ? 0 : -1}
              title={option.hint}
              disabled={!params.frame}
              onClick={() => setNested("frame_style", { profile: option.value })}
              className={`flex items-center gap-2 rounded-milled border px-2 py-1.5 text-left text-2xs transition-colors disabled:opacity-45 ${
                (frameStyle.profile ?? "plain") === option.value
                  ? "border-primary bg-primary/10 text-ink"
                  : "border-control bg-plate-raised text-ink-muted hover:border-ink-faint"
              }`}
            >
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" className="shrink-0">
                <path
                  d={option.path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {option.label}
            </button>
          ))}
        </div>
        <p id="frame-profile-hint" className="mt-1.5 text-xs leading-snug text-ink-faint">
          {labelled("frame-profile-*").hint}
        </p>

        <div className="mt-3 space-y-3">
          <SelectField
            {...labelled("frame_style_corner")}
            value={frameStyle.corner ?? "square"}
            options={CORNER_STYLES}
            disabled={!params.frame}
            onChange={(value) => setNested("frame_style", { corner: value })}
          />
          {(frameStyle.corner ?? "square") !== "square" ? (
            <Slider
              {...labelled("frame_style_corner_radius_mm")}
              min={PARAM_RANGES.frame_style.corner_radius_mm.min}
              max={PARAM_RANGES.frame_style.corner_radius_mm.max}
              step={0.5}
              value={frameStyle.corner_radius_mm ?? PARAM_RANGES.frame_style.corner_radius_mm.default}
              display={`${(frameStyle.corner_radius_mm ?? PARAM_RANGES.frame_style.corner_radius_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { corner_radius_mm: value })}
            />
          ) : null}
          {/*
            Back with its geometry, and not a moment before ([V3.1-P2-6]).
            `frame_style.lip_depth_mm` was removed in the settings truth audit
            because `solid/frame.ts` resolved it into `FrameStyle.lipDepthMm`
            and nothing read that field. [V3.1-P2-2] landed the sight-edge
            rebate it names, so the slider now cuts a real step: this deep by
            `transform.FRAME_SIGHT_EDGE_MM` (1.0 mm) wide, round the opening.
          */}
          <Slider
            {...labelled("frame_style_lip_depth_mm")}
            min={PARAM_RANGES.frame_style.lip_depth_mm.min}
            max={PARAM_RANGES.frame_style.lip_depth_mm.max}
            step={0.1}
            value={frameStyle.lip_depth_mm ?? PARAM_RANGES.frame_style.lip_depth_mm.default}
            display={`${(frameStyle.lip_depth_mm ?? PARAM_RANGES.frame_style.lip_depth_mm.default).toFixed(1)} mm`}
            disabled={!params.frame}
            onChange={(value) =>
              setNested("frame_style", { lip_depth_mm: Number(value.toFixed(2)) })
            }
          />
        </div>
      </Field>

      <Field {...sectionProps("shadow-gap")}>
        <Toggle
          {...labelled("frame_style_shadow_gap_enabled")}
          checked={shadowGap.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { shadow_gap: { ...shadowGap, enabled: value } })}
        />
        {shadowGap.enabled ? (
          <div className="mt-3 space-y-3">
            <Slider
              {...labelled("frame_style_shadow_gap_width_mm")}
              min={PARAM_RANGES.frame_style.shadow_gap.width_mm.min}
              max={PARAM_RANGES.frame_style.shadow_gap.width_mm.max}
              step={0.1}
              value={shadowGap.width_mm ?? PARAM_RANGES.frame_style.shadow_gap.width_mm.default}
              display={`${(shadowGap.width_mm ?? PARAM_RANGES.frame_style.shadow_gap.width_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { shadow_gap: { ...shadowGap, width_mm: value } })}
            />
            <Slider
              {...labelled("frame_style_shadow_gap_depth_mm")}
              min={PARAM_RANGES.frame_style.shadow_gap.depth_mm.min}
              max={PARAM_RANGES.frame_style.shadow_gap.depth_mm.max}
              step={0.1}
              value={shadowGap.depth_mm ?? PARAM_RANGES.frame_style.shadow_gap.depth_mm.default}
              display={`${(shadowGap.depth_mm ?? PARAM_RANGES.frame_style.shadow_gap.depth_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { shadow_gap: { ...shadowGap, depth_mm: value } })}
            />
          </div>
        ) : null}
      </Field>

      <Field {...sectionProps("matting")}>
        <Toggle
          {...labelled("frame_style_matting_enabled")}
          checked={matting.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { matting: { ...matting, enabled: value } })}
        />
        {matting.enabled ? (
          <div className="mt-3 space-y-3">
            <Slider
              {...labelled("frame_style_matting_width_mm")}
              min={PARAM_RANGES.frame_style.matting.width_mm.min}
              max={PARAM_RANGES.frame_style.matting.width_mm.max}
              step={0.5}
              value={matting.width_mm ?? PARAM_RANGES.frame_style.matting.width_mm.default}
              display={`${(matting.width_mm ?? PARAM_RANGES.frame_style.matting.width_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { matting: { ...matting, width_mm: value } })}
            />
            <Slider
              {...labelled("frame_style_matting_proud_mm")}
              min={PARAM_RANGES.frame_style.matting.proud_mm.min}
              max={PARAM_RANGES.frame_style.matting.proud_mm.max}
              step={0.1}
              value={matting.proud_mm ?? PARAM_RANGES.frame_style.matting.proud_mm.default}
              display={`${(matting.proud_mm ?? PARAM_RANGES.frame_style.matting.proud_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { matting: { ...matting, proud_mm: value } })}
            />
          </div>
        ) : null}
      </Field>

      <Field {...sectionProps("separate-frame")}>
        <Toggle
          {...labelled("frame_style_separate_enabled")}
          checked={separate.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { separate: { ...separate, enabled: value } })}
        />
        {separate.enabled ? (
          <div className="mt-3 space-y-3">
            <SelectField
              {...labelled("frame_style_separate_mount")}
              value={separate.mount ?? "snap"}
              options={SEPARATE_MOUNTS}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { separate: { ...separate, mount: value } })}
            />
            <Slider
              {...labelled("frame_style_separate_tolerance_mm")}
              min={PARAM_RANGES.frame_style.separate.tolerance_mm.min}
              max={PARAM_RANGES.frame_style.separate.tolerance_mm.max}
              step={0.05}
              value={separate.tolerance_mm ?? PARAM_RANGES.frame_style.separate.tolerance_mm.default}
              display={`${(separate.tolerance_mm ?? PARAM_RANGES.frame_style.separate.tolerance_mm.default).toFixed(2)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { separate: { ...separate, tolerance_mm: value } })}
            />
          </div>
        ) : null}
      </Field>

      <Field {...sectionProps("face-texture")}>
        <SelectField
          {...labelled("frame_style_texture_pattern")}
          value={texture.pattern ?? "none"}
          options={TEXTURE_PATTERNS}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { texture: { ...texture, pattern: value } })}
        />
        {(texture.pattern ?? "none") !== "none" ? (
          <div className="mt-3 space-y-3">
            <Slider
              {...labelled("frame_style_texture_scale_mm")}
              min={PARAM_RANGES.frame_style.texture.scale_mm.min}
              max={PARAM_RANGES.frame_style.texture.scale_mm.max}
              step={0.1}
              value={texture.scale_mm ?? PARAM_RANGES.frame_style.texture.scale_mm.default}
              display={`${(texture.scale_mm ?? PARAM_RANGES.frame_style.texture.scale_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { texture: { ...texture, scale_mm: value } })}
            />
            <Slider
              {...labelled("frame_style_texture_depth_mm")}
              min={PARAM_RANGES.frame_style.texture.depth_mm.min}
              max={PARAM_RANGES.frame_style.texture.depth_mm.max}
              step={0.05}
              value={texture.depth_mm ?? PARAM_RANGES.frame_style.texture.depth_mm.default}
              display={`${(texture.depth_mm ?? PARAM_RANGES.frame_style.texture.depth_mm.default).toFixed(2)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { texture: { ...texture, depth_mm: value } })}
            />
          </div>
        ) : null}
      </Field>

      <Field {...sectionProps("lettering")}>
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
          Everything on this list is cut into the frame: the profile, the
          corners, the shadow gap, the matting, the separate part, the face
          texture, the lettering, the north arrow and the scale bar. Turn on
          Frame to use any of them.
        </Note>
      ) : null}

      <Field {...sectionProps("north-arrow")}>
        <Toggle
          {...labelled("north_arrow_enabled")}
          checked={northArrow.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("north_arrow", { enabled: value })}
        />
        {northArrow.enabled ? (
          <div className="mt-3 space-y-3">
            <SelectField
              {...labelled("north_arrow_corner")}
              value={northArrow.corner ?? "ne"}
              options={CORNERS}
              disabled={!params.frame}
              onChange={(value) => setNested("north_arrow", { corner: value })}
            />
            <Slider
              {...labelled("north_arrow_size_mm")}
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

      <Field {...sectionProps("scale-bar")}>
        <Toggle
          {...labelled("scale_bar_enabled")}
          checked={scaleBar.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("scale_bar", { enabled: value })}
        />
        {scaleBar.enabled ? (
          <div className="mt-3 space-y-3">
            <SelectField
              {...labelled("scale_bar_edge")}
              value={scaleBar.edge ?? "bottom"}
              options={EDGES}
              disabled={!params.frame}
              onChange={(value) => setNested("scale_bar", { edge: value })}
            />
            <SelectField
              {...labelled("scale_bar_length_mode")}
              value={scaleBar.length_mode ?? "auto"}
              options={LENGTH_MODES}
              disabled={!params.frame}
              onChange={(value) => setNested("scale_bar", { length_mode: value })}
            />
            {scaleBar.length_mode === "fixed" ? (
              <Slider
                {...labelled("scale_bar_length_m")}
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

      <Field {...sectionProps("underside-mark")}>
        <Toggle
          {...labelled("underside_mark_enabled")}
          checked={underside.enabled ?? false}
          onChange={(value) => setNested("underside_mark", { enabled: value })}
        />
        {underside.enabled ? (
          <div className="mt-3 space-y-2">
            <TextField
              {...labelled("underside_mark_template")}
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
                        ? `nothing yet: the {${emptyToken}} token has no value`
                        : "nothing yet: the template has no text"}
                    </span>
                  )}
                </p>
              );
            })()}
            {/*
              [V3-P6]: the standing copy the engine's attribution work
              enforces (`lib/engine/solid/attribution.ts`) -- this text is
              APPENDED after the mandatory credit, never a replacement for
              it, whatever this template resolves to.
            */}
            <p className="text-2xs leading-snug text-ink-faint">
              This text is appended to the FrameCraft and OpenStreetMap credit
              that every model carries underneath, whatever you write here.
            </p>
          </div>
        ) : null}
      </Field>

      <Field {...sectionProps("hanger")}>
        <SelectField
          {...labelled("hanger")}
          value={params.hanger ?? "none"}
          options={HANGERS}
          onChange={(value) => setParam("hanger", value)}
        />
        {wallMagnetsOnly ? (
          <Note testId="hanger-magnet-fixed-note">
            The wall pockets are a fixed 6.1 mm across and 3.1 mm deep, sized
            for the magnets FrameCraft assumes. The three sliders below appear
            once the frame prints separately on a magnet mount, which is the
            only thing they size.
          </Note>
        ) : null}
        {magnetMountInUse ? (
          <div className="mt-3 space-y-3" data-testid="hanger-magnet-dims">
            <Slider
              {...labelled("hanger_magnet_diameter_mm")}
              min={PARAM_RANGES.hanger_magnet.diameter_mm.min}
              max={PARAM_RANGES.hanger_magnet.diameter_mm.max}
              step={0.5}
              value={hangerMagnet.diameter_mm ?? PARAM_RANGES.hanger_magnet.diameter_mm.default}
              display={`${(hangerMagnet.diameter_mm ?? PARAM_RANGES.hanger_magnet.diameter_mm.default).toFixed(1)} mm`}
              onChange={(value) => setNested("hanger_magnet", { diameter_mm: value })}
            />
            <Slider
              {...labelled("hanger_magnet_thickness_mm")}
              min={PARAM_RANGES.hanger_magnet.thickness_mm.min}
              max={PARAM_RANGES.hanger_magnet.thickness_mm.max}
              step={0.5}
              value={hangerMagnet.thickness_mm ?? PARAM_RANGES.hanger_magnet.thickness_mm.default}
              display={`${(hangerMagnet.thickness_mm ?? PARAM_RANGES.hanger_magnet.thickness_mm.default).toFixed(1)} mm`}
              onChange={(value) => setNested("hanger_magnet", { thickness_mm: value })}
            />
            <Slider
              {...labelled("hanger_magnet_count")}
              min={PARAM_RANGES.hanger_magnet.count.min}
              max={PARAM_RANGES.hanger_magnet.count.max}
              step={1}
              value={hangerMagnet.count ?? PARAM_RANGES.hanger_magnet.count.default}
              display={String(hangerMagnet.count ?? PARAM_RANGES.hanger_magnet.count.default)}
              onChange={(value) => setNested("hanger_magnet", { count: value })}
            />
          </div>
        ) : null}
      </Field>
    </>
  );
}

export default FrameTextGroup;
