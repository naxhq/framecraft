"use client";

import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { DEFAULT_PRINT_PARAMS, PARAM_LIMITS, PARAM_RANGES } from "@/lib/contracts";
import type { FrameStyle, HangerMagnet, NorthArrow, ScaleBar, UndersideMark } from "@/lib/contracts";
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
  const magnetInUse = params.hanger === "magnets" || separate.mount === "magnet";

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
        id="frame"
        label="Frame"
        checked={params.frame}
        onChange={(value) => setParam("frame", value)}
        hint="A 6 mm border standing 2 mm proud of the base. It costs 12 mm of plate, so the city inside gets smaller."
      />

      <Field
        label="Frame profile"
        hint="Every profile costs the same plate footprint as the plain lip; only the cross-section changes. A profile the engine has not built yet still previews as the plain lip and the Issues badge says so."
      >
        <div className="grid grid-cols-2 gap-1.5" data-testid="frame-profile-options" role="radiogroup" aria-label="Frame profile">
          {FRAME_PROFILES.map((option) => (
            <button
              key={option.value}
              type="button"
              data-testid={`frame-profile-${option.value}`}
              role="radio"
              aria-checked={(frameStyle.profile ?? "plain") === option.value}
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

        <div className="mt-3 space-y-3">
          <SelectField
            id="frame_style_corner"
            label="Corners"
            value={frameStyle.corner ?? "square"}
            options={CORNER_STYLES}
            disabled={!params.frame}
            onChange={(value) => setNested("frame_style", { corner: value })}
          />
          {(frameStyle.corner ?? "square") !== "square" ? (
            <Slider
              id="frame_style_corner_radius_mm"
              label="Corner radius"
              min={PARAM_RANGES.frame_style.corner_radius_mm.min}
              max={PARAM_RANGES.frame_style.corner_radius_mm.max}
              step={0.5}
              value={frameStyle.corner_radius_mm ?? PARAM_RANGES.frame_style.corner_radius_mm.default}
              display={`${(frameStyle.corner_radius_mm ?? PARAM_RANGES.frame_style.corner_radius_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { corner_radius_mm: value })}
            />
          ) : null}
          <Slider
            id="frame_style_lip_depth_mm"
            label="Lip depth"
            min={PARAM_RANGES.frame_style.lip_depth_mm.min}
            max={PARAM_RANGES.frame_style.lip_depth_mm.max}
            step={0.1}
            value={frameStyle.lip_depth_mm ?? PARAM_RANGES.frame_style.lip_depth_mm.default}
            display={`${(frameStyle.lip_depth_mm ?? PARAM_RANGES.frame_style.lip_depth_mm.default).toFixed(1)} mm`}
            disabled={!params.frame}
            hint="How far the lip's own moulding cuts into its 6 mm width."
            onChange={(value) => setNested("frame_style", { lip_depth_mm: value })}
          />
        </div>
      </Field>

      <Field label="Shadow gap" hint="A recessed groove between the frame and the base, as if the frame floats above the plate.">
        <Toggle
          id="frame_style_shadow_gap_enabled"
          label="Add a shadow gap"
          checked={shadowGap.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { shadow_gap: { ...shadowGap, enabled: value } })}
        />
        {shadowGap.enabled ? (
          <div className="mt-3 space-y-3">
            <Slider
              id="frame_style_shadow_gap_width_mm"
              label="Width"
              min={PARAM_RANGES.frame_style.shadow_gap.width_mm.min}
              max={PARAM_RANGES.frame_style.shadow_gap.width_mm.max}
              step={0.1}
              value={shadowGap.width_mm ?? PARAM_RANGES.frame_style.shadow_gap.width_mm.default}
              display={`${(shadowGap.width_mm ?? PARAM_RANGES.frame_style.shadow_gap.width_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { shadow_gap: { ...shadowGap, width_mm: value } })}
            />
            <Slider
              id="frame_style_shadow_gap_depth_mm"
              label="Depth"
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

      <Field label="Matting" hint="A recessed board between the frame and the city, like the mat around a photograph.">
        <Toggle
          id="frame_style_matting_enabled"
          label="Add matting"
          checked={matting.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { matting: { ...matting, enabled: value } })}
        />
        {matting.enabled ? (
          <div className="mt-3 space-y-3">
            <Slider
              id="frame_style_matting_width_mm"
              label="Width"
              min={PARAM_RANGES.frame_style.matting.width_mm.min}
              max={PARAM_RANGES.frame_style.matting.width_mm.max}
              step={0.5}
              value={matting.width_mm ?? PARAM_RANGES.frame_style.matting.width_mm.default}
              display={`${(matting.width_mm ?? PARAM_RANGES.frame_style.matting.width_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              hint="Plate the city loses to the matting, on top of what the frame itself already costs."
              onChange={(value) => setNested("frame_style", { matting: { ...matting, width_mm: value } })}
            />
            <Slider
              id="frame_style_matting_proud_mm"
              label="Standing proud"
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

      <Field label="Separate frame part" hint="Prints the frame as its own piece from the base, so each can be a different filament without a colour change.">
        <Toggle
          id="frame_style_separate_enabled"
          label="Print the frame separately"
          checked={separate.enabled ?? false}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { separate: { ...separate, enabled: value } })}
        />
        {separate.enabled ? (
          <div className="mt-3 space-y-3">
            <SelectField
              id="frame_style_separate_mount"
              label="Mount"
              value={separate.mount ?? "snap"}
              options={SEPARATE_MOUNTS}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { separate: { ...separate, mount: value } })}
            />
            <Slider
              id="frame_style_separate_tolerance_mm"
              label="Fit tolerance"
              min={PARAM_RANGES.frame_style.separate.tolerance_mm.min}
              max={PARAM_RANGES.frame_style.separate.tolerance_mm.max}
              step={0.05}
              value={separate.tolerance_mm ?? PARAM_RANGES.frame_style.separate.tolerance_mm.default}
              display={`${(separate.tolerance_mm ?? PARAM_RANGES.frame_style.separate.tolerance_mm.default).toFixed(2)} mm`}
              disabled={!params.frame}
              hint="Extra clearance between the two parts. Widen it if the frame prints too tight to seat."
              onChange={(value) => setNested("frame_style", { separate: { ...separate, tolerance_mm: value } })}
            />
          </div>
        ) : null}
      </Field>

      <Field label="Face texture" hint="A relief pattern cut into the frame's visible front face.">
        <SelectField
          id="frame_style_texture_pattern"
          label="Pattern"
          value={texture.pattern ?? "none"}
          options={TEXTURE_PATTERNS}
          disabled={!params.frame}
          onChange={(value) => setNested("frame_style", { texture: { ...texture, pattern: value } })}
        />
        {(texture.pattern ?? "none") !== "none" ? (
          <div className="mt-3 space-y-3">
            <Slider
              id="frame_style_texture_scale_mm"
              label="Pattern scale"
              min={PARAM_RANGES.frame_style.texture.scale_mm.min}
              max={PARAM_RANGES.frame_style.texture.scale_mm.max}
              step={0.1}
              value={texture.scale_mm ?? PARAM_RANGES.frame_style.texture.scale_mm.default}
              display={`${(texture.scale_mm ?? PARAM_RANGES.frame_style.texture.scale_mm.default).toFixed(1)} mm`}
              disabled={!params.frame}
              onChange={(value) => setNested("frame_style", { texture: { ...texture, scale_mm: value } })}
            />
            <Slider
              id="frame_style_texture_depth_mm"
              label="Pattern depth"
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

      <Field label="Hanger" hint="A fitting added to the back so the plate can go on a wall or an easel.">
        <SelectField
          id="hanger"
          label="Fitting"
          value={params.hanger ?? "none"}
          options={HANGERS}
          onChange={(value) => setParam("hanger", value)}
        />
        {magnetInUse ? (
          <div className="mt-3 space-y-3" data-testid="hanger-magnet-dims">
            <Slider
              id="hanger_magnet_diameter_mm"
              label="Magnet diameter"
              min={PARAM_RANGES.hanger_magnet.diameter_mm.min}
              max={PARAM_RANGES.hanger_magnet.diameter_mm.max}
              step={0.5}
              value={hangerMagnet.diameter_mm ?? PARAM_RANGES.hanger_magnet.diameter_mm.default}
              display={`${(hangerMagnet.diameter_mm ?? PARAM_RANGES.hanger_magnet.diameter_mm.default).toFixed(1)} mm`}
              onChange={(value) => setNested("hanger_magnet", { diameter_mm: value })}
            />
            <Slider
              id="hanger_magnet_thickness_mm"
              label="Magnet thickness"
              min={PARAM_RANGES.hanger_magnet.thickness_mm.min}
              max={PARAM_RANGES.hanger_magnet.thickness_mm.max}
              step={0.5}
              value={hangerMagnet.thickness_mm ?? PARAM_RANGES.hanger_magnet.thickness_mm.default}
              display={`${(hangerMagnet.thickness_mm ?? PARAM_RANGES.hanger_magnet.thickness_mm.default).toFixed(1)} mm`}
              onChange={(value) => setNested("hanger_magnet", { thickness_mm: value })}
            />
            <Slider
              id="hanger_magnet_count"
              label="Magnet count"
              min={PARAM_RANGES.hanger_magnet.count.min}
              max={PARAM_RANGES.hanger_magnet.count.max}
              step={1}
              value={hangerMagnet.count ?? PARAM_RANGES.hanger_magnet.count.default}
              display={String(hangerMagnet.count ?? PARAM_RANGES.hanger_magnet.count.default)}
              hint="Shared by the magnet hanger and a separate frame's magnet mount -- one pocket size either way."
              onChange={(value) => setNested("hanger_magnet", { count: value })}
            />
          </div>
        ) : null}
      </Field>
    </>
  );
}

export default FrameTextGroup;
