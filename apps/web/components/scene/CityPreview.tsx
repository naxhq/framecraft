"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import { Canvas } from "@react-three/fiber";

import AdjustmentsChip from "@/components/editor/AdjustmentsChip";
import IssuesBadge from "@/components/editor/IssuesBadge";
import { collectAdjustments } from "@/lib/adjustments";
import {
  advisorDeps,
  applyAdvisorAction,
  detailAdvice,
  showsRecommendation,
  type AdvisorAction,
  type AdvisorTone,
} from "@/lib/advisor";
import type { PrintParams, SceneGraph } from "@/lib/contracts";
import type { EngineBuilding } from "@/lib/engine/osm/types";
import type { AuditFinding, RecessBand, RegionMesh } from "@/lib/engine/types";
import { previewView } from "@/lib/enginePreview";
import { loadGlyphFace, loadedGlyphFace } from "@/lib/fontGlyphs";
import { autoHeroIds, heroCandidates, heroCapMessage } from "@/lib/heroes";
import { mergeIssues } from "@/lib/issues";
import ObjectInspector, { type InspectorTarget } from "@/components/editor/ObjectInspector";
import { describeBuilding, nameBudgetWarning, objectAt, type HoverHit } from "@/lib/objectInfo";
import {
  CURSOR_LAYER_NOUNS,
  layerStepFor,
  layerStops,
  moveStop,
  stepLayer,
  stopAt,
  stopLabel,
  type CursorLayer,
} from "@/lib/objectCursor";
import { overrideLayerByRegion } from "@/lib/objectOverrides";
import { perfSpan } from "@/lib/perf";
import {
  cursorLabel,
  cursorOrder,
  cursorStepFor,
  moveCursor,
} from "@/lib/heroCursor";
import { specStrip, stageEtaText, stageOverlayText } from "@/lib/hud";
import { buildBuildings, dilatedNotice, treeFloorNoticeMetres } from "@/lib/preview";
import {
  buildPreviewText,
  facesNeeded,
  textParamsKey,
  textTokenContext,
  type PreviewTextModel,
} from "@/lib/previewText";
import * as T from "@/lib/transform";
import {
  heightCeilingMm,
  letteringWarnings,
  pipelineFailureWarning,
  predictedTopDeps,
  predictedTopMm,
  sceneWarnings,
  tintPreviewOnlyWarning,
  warningDeps,
} from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";
import ObjectPopover, { useObjectHover } from "./ObjectPopover";
import PreviewScene from "./PreviewScene";
import { tintMapOf } from "./RegionMeshes";
import {
  readPreviewPalette,
  readViewportMultipliers,
  readViewportPalette,
  DEFAULT_VIEWPORT_MULTIPLIERS,
} from "./palette";

/**
 * The live 3D preview.
 *
 * Since v3.1 the viewport draws ONE thing: the solids the pipeline finished
 * (`state.pipeline.regions`), at the export's own resolution, in the export's
 * own colours. The approximate stack that used to stand in for them -- the
 * constant frame bars, the oriented building boxes, the flat road ribbons, the
 * earcut water and green fills, the flat lettering fills -- is gone, and with
 * it the mechanism behind "the settings do nothing": a control that moves the
 * model now moves the model, and a control that appears to do nothing can only
 * be a pipeline stage that did not claim it.
 *
 * What that changes about this file:
 *
 *  - nothing rendered reads `PrintParams`, and since the v3-06 audit's finding
 *    C2 nothing inside `<Canvas>` is even HANDED one. Everything there lives in
 *    `PreviewScene`, whose props are pipeline output; the invisible pick
 *    proxies that used to be the one exception are gone, because the buildings
 *    mesh carries the per-building identity they existed to supply.
 *    `CityPreview.test.ts` enforces both halves.
 *  - a run in flight does not empty the viewport. The previous meshes stay up,
 *    dimmed, under an overlay naming the stage the worker is on, and each
 *    region is replaced on its own as it finishes.
 *  - the readouts below the canvas come from the finished model (its measured
 *    height, its triangle count) or from the shared transform pair, never from
 *    a second approximation of the same numbers.
 *
 * The HUD around the canvas still reads parameters, and must: the spec strip,
 * the detail advisor, the adjustments drawer and the Issues badge are all
 * statements ABOUT the settings, and the shared transform pair is what makes
 * them agree with the build rather than guess at it.
 */

/**
 * The memo keys of every derived HUD layer, in one place.
 *
 * The trap is that `store.setParam` rebuilds `params` by spread on every
 * write, so ANY dependency list that names `params` is invalidated by every
 * slider tick -- including the height sliders, which would re-run the hull
 * maths over every footprint and re-triangulate the glyphs on every frame of
 * a drag. Every entry below is therefore a primitive read off `params`, or an
 * identity-stable object (`graph`). `CityPreview.test.ts` enforces both halves.
 */
export const previewDeps = {
  /** `scale_mm_per_m` -> `usable_span_mm`: plate width and the frame only. */
  scale: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
  ],
  /**
   * The HUD's footprint pass: hulls, oriented rectangles and the repair widths,
   * keyed on the parameters that move the scale (plate, frame) and the
   * thresholds (nozzle). Height sliders must NOT invalidate it: rebuilding
   * 5000 convex hulls per frame blows the budget, and none of what this feeds
   * (the building count, the keyboard cursor's order, the dilation each
   * popover reports, the adjustments drawer's counts) moves with a height.
   *
   * It used to place the invisible pick proxies as well; those are gone (v3-06
   * audit, finding C2) and nothing keyed on this is drawn any more.
   */
  layout: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
  ],
  /**
   * The predicted model top: the 60 mm guard and the HUD read it.
   *
   * `predictedTopDeps`, i.e. the HEIGHT half of `warningDeps` - not the whole
   * of it. `warningDeps` also names the hanger, the underside mark, `road_mode`
   * and `water`, because the OTHER block warning ([V2-P7-fix], the base a
   * hanger needs) moves with those; none of them changes how tall the model is
   * predicted to be, so keying this pass on them would re-run it for nothing.
   */
  height: (graph: SceneGraph | null, params: PrintParams): unknown[] =>
    predictedTopDeps(graph, params),
  /**
   * The lettering layout: how many glyph rings the shared layout produces, and
   * what it had to say about them (an auto-fitted size, a dropped character, a
   * refused engraving).
   *
   * NOT a rendered layer any more -- the engine cuts the real letters -- but
   * `transform.lettering_layout` is the function the engine cuts FROM, so this
   * is the one place the editor can count the rings and read the refusals
   * without waiting for a run. `textParamsKey` is a STRING of exactly the
   * parameters that move a layout, so moving a height slider produces the same
   * key and the glyphs are not re-triangulated.
   */
  text: (
    graph: SceneGraph | null,
    params: PrintParams,
    rotationDeg: number,
    date: string,
    faces: number,
  ): unknown[] => [graph, textParamsKey(params), rotationDeg, date, faces],
  /**
   * The detail advisor. `transform.detail_report` walks every ring in the
   * scene, so it must not run on a height slider; these are the parameters that
   * move the scale, the thresholds and the tree filter it reads.
   */
  advisor: (
    graph: SceneGraph | null,
    params: PrintParams,
    radiusM: number | null,
  ): unknown[] => advisorDeps(graph, params, radiusM),
} as const;

/** Identity-stable fallback: a fresh `[]` per render would re-run an effect. */
const NO_HEROES: readonly string[] = [];
/**
 * Identity-stable fallback for a zustand selector, for the same reason: a
 * store selector returning a FRESH `[]` when there is no result yet reports
 * "changed" to `useSyncExternalStore` on every render (a new reference is
 * never `Object.is`-equal to the last one), which reproduces as "Maximum
 * update depth exceeded" -- measured, not theoretical, in a real browser
 * click-through of the Chicago preset before this constant existed.
 */
const NO_FINDINGS: readonly AuditFinding[] = [];
const NO_BANDS: readonly RecessBand[] = [];

/**
 * The advisor band, as a design token.
 *
 * The three state tokens, not three new ones: "most of this city survived",
 * "it is losing its small buildings" and "it will print as blocks" are exactly
 * the positive / warn / danger ladder the rest of the editor already uses, and
 * those three are the pairs `lib/contrast.test.ts` already holds to 4.5:1 on
 * this surface.
 */
const BAND_TEXT: Record<AdvisorTone, string> = {
  positive: "text-positive",
  warn: "text-warn",
  danger: "font-semibold text-danger",
};

/**
 * `region:version` pairs for the regions currently on screen, published on the
 * viewport so an end-to-end test can time a change from an input event to the
 * exact moment the affected region's mesh was replaced.
 *
 * A version, not a hash: the worker only re-sends a region whose
 * `finish-<region>` key moved, so a new `RegionMesh` object IS a changed hash,
 * and the counter moves at the moment the mesh reaches the screen rather than
 * at the end of the whole run. `data-region-hashes` publishes the worker's own
 * keys as well, which arrive with the finished result.
 */
function useRegionVersions(regions: ReadonlyMap<string, RegionMesh>): string {
  const seen = useRef(new Map<string, { mesh: RegionMesh; version: number }>());
  return useMemo(() => {
    const current = seen.current;
    const parts: string[] = [];
    for (const [name, mesh] of regions) {
      const hit = current.get(name);
      const version = hit === undefined || hit.mesh !== mesh ? (hit?.version ?? 0) + 1 : hit.version;
      current.set(name, { mesh, version });
      parts.push(`${name}:${version}`);
    }
    for (const name of [...current.keys()]) {
      if (!regions.has(name)) current.delete(name);
    }
    return parts.join(" ");
  }, [regions]);
}

/**
 * The `<Canvas>` and everything in it, re-rendered only when one of ITS props
 * moved (`[V3.1-P7-34]`).
 *
 * Two things this memo is for, both measured on the smoke test's software-GL
 * host, where one frame of this scene is about 60 ms of main thread:
 *
 * 1. The loop is `frameloop="demand"`: a frame is rendered when something
 *    changed, not sixty times a second regardless. The model is static
 *    between changes, and every change that should move the picture reaches
 *    three.js as a React prop (a new region mesh, the dimming, a tint, the
 *    theme) or as an OrbitControls `change` event (drei invalidates on it,
 *    damping included), so each asks for exactly the frame it needs. With
 *    `always`, an idle preview kept the main thread busy for the whole of
 *    every frame, and a lettering edit paid for that three times over before
 *    its mesh could reach the screen: the 80 ms debounce timer waited for a
 *    frame boundary to fire, the worker's region message waited for the next
 *    one to be handled, and the replaced mesh waited for a third to be seen.
 *    That was 137 to 217 ms before the worker was even asked and another 25
 *    to 30 after it answered, against 116 to 142 ms of actual engine work.
 *
 * 2. `CityPreview` re-renders on every store write the viewport reads, which
 *    during a run is every stage event, and a re-render of `<Canvas>` itself
 *    is a frame: r3f re-applies its configuration in a layout effect on each
 *    render, and (as of @react-three/fiber 9.7) its size comparison never
 *    matches the measured rect it is handed, so every render calls `setSize`
 *    on the root store, whose subscription invalidates the loop. Keeping the
 *    canvas behind a memo of the props the scene actually reads turns eighty
 *    stage events into zero frames; the DOM around it (the overlay, the
 *    chips, the data attributes) still re-renders as before.
 */
const PreviewCanvas = memo(function PreviewCanvas({
  onKeyDown,
  onFocus,
  onBlur,
  ...scene
}: ComponentProps<typeof PreviewScene> & {
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
}) {
  return (
    <Canvas
      frameloop="demand"
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: [140, 170, 190], fov: 40, near: 1, far: 5000 }}
      data-testid="preview-canvas"
      tabIndex={0}
      role="application"
      aria-label="3D preview. Arrow keys move the object cursor, Page Up and Page Down change layer between buildings, roads, water and green space, Enter picks a hero building or opens the menu for anything else, and the Menu key or Shift+F10 opens that menu on the object under the cursor."
      aria-describedby="preview-cursor-status"
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <PreviewScene {...scene} />
    </Canvas>
  );
});

export function CityPreview() {
  const graph = useEditorStore((state) => state.scene.graph);
  const status = useEditorStore((state) => state.scene.status);
  const params = useEditorStore((state) => state.params);
  const theme = useEditorStore((state) => state.theme);
  const previewTheme = useEditorStore((state) => state.params.colour?.preview_theme ?? "dark");
  const regions = useEditorStore((state) => state.pipeline.regions);
  const regionHashes = useEditorStore((state) => state.pipeline.regionHashes);
  const pipelineStatus = useEditorStore((state) => state.pipeline.status);
  const pipelineStale = useEditorStore((state) => state.pipeline.stale);
  const pipelineResult = useEditorStore((state) => state.pipeline.result);
  const pipelineError = useEditorStore((state) => state.pipeline.error);
  const progressStage = useEditorStore((state) => state.pipeline.progress.stage);
  const engineFindings = useEditorStore((state) => state.pipeline.result?.findings ?? NO_FINDINGS);
  const buildWarnings = useMemo(
    () =>
      engineFindings
        .filter((finding) => finding.severity !== "info")
        .map((finding) => `${finding.title}: ${finding.detail}`),
    [engineFindings],
  );
  const toggleHero = useEditorStore((state) => state.toggleHero);
  const heroCapHit = useEditorStore((state) => state.heroCapHit);
  const rotationDeg = useEditorStore((state) => state.location.rotation_deg);
  const setRadius = useEditorStore((state) => state.setRadius);
  const setParam = useEditorStore((state) => state.setParam);
  const generate = useEditorStore((state) => state.generate);

  /**
   * `{date}` expands to a date the CALLER supplies -- the shared token table
   * never reads a clock (DECISIONS [V2-P2]). Taken once per mount so it is a
   * stable memo key rather than a value that changes under the text layer at
   * midnight.
   */
  const [today] = useState(() => new Date().toISOString().slice(0, 10));

  // Read straight off <html>, so `.dark` re-themes the canvas from the same
  // token set as the panels around it (components/scene/palette.ts). The theme
  // is a real argument -- it keys the palette cache -- so this memo needs no
  // dependency exemption.
  const themed = useMemo(() => readPreviewPalette(theme), [theme]);

  /**
   * `colour.preview_theme` is a SEPARATE switch from the app's own `theme`,
   * scoped to `data-fc-viewport-theme` on the wrapper `PreviewPane` renders
   * (`app/globals.css`) rather than to `.dark` on `<html>`, so flipping it
   * never touches the panels around the viewport. Read through an effect (not
   * a memo) because the values live on a DOM node: the attribute has to be
   * committed before the computed style reflects it. `[V3-P5-C]`.
   */
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewportPalette, setViewportPalette] = useState(() =>
    readViewportPalette(null, themed),
  );
  const [multipliers, setMultipliers] = useState(DEFAULT_VIEWPORT_MULTIPLIERS);
  useEffect(() => {
    setViewportPalette(readViewportPalette(viewportRef.current, themed));
    setMultipliers(readViewportMultipliers(viewportRef.current));
  }, [previewTheme, themed]);

  const scale = useMemo(
    () =>
      graph ? T.scale_mm_per_m(params, T.radius_m_from_bounds(graph.bounds)) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.scale(graph, params),
  );

  // The footprint pass, now a HUD-only one: the building count in the spec
  // strip, the keyboard cursor's tallest-first order, the repair widths the
  // object popover reports, and the adjustments drawer's dilated/dropped
  // counts. Nothing it produces is drawn or raycast any more.
  const layout = useMemo(
    () =>
      graph
        ? buildBuildings(graph, params)
        : { buildings: [], dilatedCount: 0, droppedCount: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.layout(graph, params),
  );

  // --- the lettering layout (counted and reported, never drawn) ------------
  //
  // The glyph outlines are ~280 KB per face and are fetched only when a layout
  // actually names one, so the layout runs twice for a face's first use: once
  // reporting it missing, then again once it has landed. `faceVersion` is what
  // makes the second run happen.
  const [faceVersion, setFaceVersion] = useState(0);
  const facesKey = useMemo(
    () => facesNeeded(params).join(","),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [textParamsKey(params)],
  );
  useEffect(() => {
    const missing = (facesKey === "" ? [] : facesKey.split(",")).filter(
      (face) => loadedGlyphFace(face) === null,
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(
      // A face that fails to load must not take the whole preview with it: the
      // rest of the model is still correct, and the panel still shows the text.
      missing.map((face) => loadGlyphFace(face).catch(() => null)),
    ).then(() => {
      if (!cancelled) setFaceVersion((version) => version + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [facesKey]);

  const textModel: PreviewTextModel = useMemo(
    () =>
      buildPreviewText(
        params,
        textTokenContext(graph, params, today),
        rotationDeg,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.text(graph, params, rotationDeg, today, faceVersion),
  );

  // --- the detail advisor --------------------------------------------------
  const sceneRadiusM = graph ? T.radius_m_from_bounds(graph.bounds) : null;
  const advice = useMemo(
    () => detailAdvice(graph, params, sceneRadiusM),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.advisor(graph, params, sceneRadiusM),
  );
  const onAdvisorAction = useCallback(
    (action: AdvisorAction) => {
      // The radius goes through exactly the path a slider release takes:
      // `setRadius` marks the scene stale and retires the model, `generate`
      // fetches. The plate is a plain parameter write and stays client-side.
      applyAdvisorAction(action, {
        setRadius,
        generate: () => void generate(),
        setParam: (key, value) => setParam(key, value),
      });
    },
    [setRadius, generate, setParam],
  );

  // 04 stage 4 caps the model at 60 mm and the engine refuses to start above
  // it. Showing the number on the canvas is what makes the disabled Export
  // button legible while the height sliders move.
  const predictedTop = useMemo(
    () => predictedTopMm(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.height(graph, params),
  );

  const warnings = useMemo(
    () => [
      ...sceneWarnings(graph, params),
      // The Issues badge integration for rule 4/5 ([V3-P1]): one warn-level
      // entry per line (or the underside mark) that resolves empty, naming
      // the exact token, and one info-level entry when the frame is off with
      // lettering configured for it.
      ...letteringWarnings(params, textTokenContext(graph, params, today)),
      ...tintPreviewOnlyWarning(params),
      // Names the ingest left out to keep the scene inside the transfer budget
      // (Task 10). Empty on every scene inside it, which is every scene up to
      // twice the Chicago fixture's density.
      ...nameBudgetWarning(graph),
      // A stage that threw is a warning for the user like any other: the
      // Issues badge is the one place findings and failures are reported.
      ...pipelineFailureWarning(pipelineError),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...warningDeps(graph, params), textParamsKey(params), today, params.colour?.tint?.enabled, params.export_target, pipelineError],
  );

  /**
   * The Issues badge's own list (phase 4, [V3-P4-U]): every client warning
   * above, merged with the live engine's own findings, engine winning a
   * shared id (`lib/issues.ts:mergeIssues`).
   */
  const issues = useMemo(() => mergeIssues(warnings, engineFindings), [warnings, engineFindings]);

  const treeFloor =
    scale === null || !params.trees ? null : treeFloorNoticeMetres(params, scale);
  const dilatedNote =
    layout.dilatedCount > 0 && scale !== null
      ? dilatedNotice(layout.dilatedCount, params, scale)
      : null;

  const adjustments = useMemo(
    () =>
      collectAdjustments({
        warnings,
        dilatedNote,
        droppedCount: layout.droppedCount,
        treeFloorMetres: treeFloor,
        nozzleMm: params.nozzle_mm,
        buildWarnings,
        // The shared layout's own messages, verbatim: an auto-fitted size, a
        // dropped character, a refused engraving. They are informational -- the
        // engine reports the same strings -- so they belong in the drawer with
        // the rest of "what the pipeline quietly did".
        textNotices: textModel.notices,
      }),
    [
      warnings,
      dilatedNote,
      layout.droppedCount,
      treeFloor,
      params.nozzle_mm,
      buildWarnings,
      textModel.notices,
    ],
  );

  // Same discipline as the layers: the strip re-derives the predicted top, so
  // it is keyed on the height inputs plus the nozzle (which moves the wall).
  const spec = useMemo(
    () => specStrip(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...previewDeps.height(graph, params), params.nozzle_mm],
  );

  // --- what the viewport is showing ---------------------------------------
  const view = previewView({
    status: pipelineStatus,
    stale: pipelineStale,
    regions,
    result: pipelineResult,
  });
  const regionVersions = useRegionVersions(regions);
  const recessBands = pipelineResult?.recessBands ?? NO_BANDS;
  // The camera follows the real model once there is one, and the plate the
  // controls ask for until then.
  const frameWidthMm = pipelineResult?.stats.widthMm ?? params.plate_mm;

  // Manual picks plus, once `hero_auto` is on, the auto-promoted ones -- the
  // same effective set the `heroes` stage resolves in the worker, so the
  // keyboard cursor's "hero" announcement never disagrees with what the model
  // actually prints. Deps are primitives/identity-stable references only.
  const manualHeroIds = params.hero_building_ids ?? NO_HEROES;
  const heroAutoEnabled = params.hero_auto?.enabled ?? false;
  const heroAutoCount = params.hero_auto?.count ?? 0;
  const heroIds = useMemo(() => {
    if (!heroAutoEnabled || !graph) return manualHeroIds;
    const candidates = heroCandidates(graph.buildings as EngineBuilding[]);
    return autoHeroIds(candidates, manualHeroIds, heroAutoCount);
  }, [graph, manualHeroIds, heroAutoEnabled, heroAutoCount]);

  // --- the keyboard path to a hero (lib/heroCursor.ts) --------------------
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const order = useMemo(() => cursorOrder(layout.buildings), [layout.buildings]);

  /**
   * ...and the keyboard path to everything ELSE the right-click reaches
   * (`lib/objectCursor.ts`, v3.1 Task 11).
   *
   * The inspector acts on four layers, so the cursor has to reach four layers
   * or three quarters of it would be pointer-only -- WCAG 2.1.1, Level A, on a
   * real function. PageDown and PageUp change layer, the arrows walk within
   * one, and the building layer keeps the walk and the Enter it always had.
   *
   * The three surface layers are built from the SceneGraph rather than from
   * `layout`, which is the buildings' own repair pass; they are memoised on
   * `graph` alone, so no parameter write rebuilds them.
   */
  const [cursorLayer, setCursorLayer] = useState<CursorLayer>("building");
  const [surfaceKey, setSurfaceKey] = useState<string | null>(null);
  const roadStops = useMemo(() => layerStops(graph, "road"), [graph]);
  const waterStops = useMemo(() => layerStops(graph, "water"), [graph]);
  const greenStops = useMemo(() => layerStops(graph, "green"), [graph]);
  const surfaceStops =
    cursorLayer === "road" ? roadStops : cursorLayer === "water" ? waterStops : greenStops;
  const layerCounts = useMemo(
    () => ({
      building: order.length,
      road: roadStops.length,
      water: waterStops.length,
      green: greenStops.length,
    }),
    [order.length, roadStops.length, waterStops.length, greenStops.length],
  );

  const cursorText =
    cursorLayer === "building"
      ? cursorLabel(order, cursorId, heroIds)
      : stopLabel(cursorLayer, surfaceStops, surfaceKey);

  // --- the pointer path to "what is this?" (lib/objectInfo.ts) -------------
  //
  // Everything the resolver needs, and nothing that changes per frame. The
  // hero set and the repair widths are the only two facts about a printed
  // object that do not live in the SceneGraph, so they are lifted here once
  // rather than re-derived on every move.
  const heroIdSet = useMemo(() => new Set(heroIds), [heroIds]);
  const dilationById = useMemo(() => {
    const out = new Map<string, number>();
    for (const building of layout.buildings) {
      if (building.dilation_m > 0) out.set(building.id, building.dilation_m);
    }
    return out;
  }, [layout.buildings]);

  /**
   * `override_N` -> the layer that region's group came out of (v3.1 Task 11).
   *
   * An override region holds whatever objects the user gave the same printed
   * treatment, so its NAME cannot say whether a hit on it is a building or a
   * road. Nothing drawn in the viewport may read a parameter to find out, so
   * the answer is resolved here - where reading them is allowed - and handed to
   * the resolver as data.
   */
  const overrideList = params.object_overrides;
  const overrideLayers = useMemo(
    () => overrideLayerByRegion(params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overrideList],
  );

  const resolveHover = useCallback(
    (hit: HoverHit) =>
      graph === null || scale === null
        ? null
        : objectAt(graph, hit, {
            scaleMmPerM: scale,
            heroIds: heroIdSet,
            dilationById,
            overrideLayers,
          }),
    [graph, scale, heroIdSet, dilationById, overrideLayers],
  );
  const { popoverRef, onHover } = useObjectHover(resolveHover, viewportRef);

  // --- the right-click path to "change this one thing" ---------------------
  const [inspector, setInspector] = useState<{ target: InspectorTarget; at: { x: number; y: number } } | null>(
    null,
  );
  const closeInspector = useCallback(() => setInspector(null), []);

  /**
   * A right-click on the model. `RegionMeshes` raycasts on the context-menu
   * event alone, so this is called for every region, including the base and the
   * frame that no hover reaches; `hit` is null for a click on empty sky.
   */
  const onInspect = useCallback(
    (hit: HoverHit | null, clientX: number, clientY: number) => {
      const box = viewportRef.current?.getBoundingClientRect();
      const at = { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
      const info = hit === null ? null : resolveHover(hit);
      if (info === null) {
        setInspector({ target: { kind: "region", region: hit?.region ?? null }, at });
        return;
      }
      // A merged block and an unattributed polygon reach this with `osmId`
      // null. They are still objects and still say what they are; what they
      // cannot carry is an override, because there is no OSM element to key one
      // by, and the menu says exactly that rather than offering controls whose
      // rows nothing would ever match.
      setInspector({ target: { kind: "object", info, osmId: info.osmId, layer: info.layer }, at });
    },
    [resolveHover],
  );

  /**
   * The per-building tints the engine computed, as the lookup the meshes want.
   *
   * `EngineResult` is a fresh object per run, so this memo is keyed on the
   * array it carries; `RegionMeshes` keys its geometry cache on the CONTENTS
   * (`tintsKeyOf`), so a run that reproduces the same colours re-shades
   * nothing. Until the v3-06 audit's finding C1 this value had no reader at
   * all: the engine computed the tints, the OBJ exporter wrote them, and the
   * preview painted every building the region's one flat colour while the
   * Issues badge said otherwise.
   */
  const tints = useMemo(
    () => tintMapOf(pipelineResult?.buildingTints),
    [pipelineResult?.buildingTints],
  );

  /**
   * A click on a building's own solid. `RegionMeshes` maps the hit triangle
   * through `triangleOwner` to a SceneGraph id, so this is handed the same id
   * the keyboard cursor toggles, from the geometry the user actually clicked.
   */
  const onPickBuilding = useCallback(
    (id: string) => {
      setCursorId(id);
      toggleHero(id);
    },
    [toggleHero],
  );

  /**
   * The keyboard's own way into the inspector.
   *
   * The two keys a context menu is opened with everywhere else - the Menu key
   * and Shift+F10 - on the object the viewport's cursor is already on, which is
   * the same building Enter would toggle. It opens at the middle of the
   * viewport rather than at a projected position: the cursor is a list
   * position, not a screen point, and putting the menu where the building
   * happens to be would move it under the user between two presses.
   */
  const openInspectorForCursor = useCallback(() => {
    const box = viewportRef.current?.getBoundingClientRect();
    const at = { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 };
    // A road, a lake or a park: the stop already carries the same `ObjectInfo`
    // a hover over it would have produced, so the menu that opens is the menu
    // the pointer opens, keyed by the same base OSM id.
    if (cursorLayer !== "building") {
      const stop = stopAt(surfaceStops, surfaceKey);
      if (stop === null) return;
      setInspector({
        target: { kind: "object", info: stop.info, osmId: stop.info.osmId, layer: stop.info.layer },
        at,
      });
      return;
    }
    if (graph === null || cursorId === null) return;
    const building = graph.buildings.find((candidate) => candidate.id === cursorId);
    if (building === undefined) return;
    const info = describeBuilding(building, {
      hero: heroIdSet.has(building.id),
      dilationM: dilationById.get(building.id) ?? 0,
    });
    setInspector({
      target: { kind: "object", info, osmId: info.osmId, layer: info.layer },
      at,
    });
  }, [cursorId, cursorLayer, dilationById, graph, heroIdSet, surfaceKey, surfaceStops]);

  const onViewportKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        openInspectorForCursor();
        return;
      }
      // PageDown / PageUp: the layer the walk is on. It lands on the biggest
      // thing there at once, so the readout says where the cursor went rather
      // than leaving a keyboard user to guess and press again.
      const layerStep = layerStepFor(event);
      if (layerStep !== null) {
        event.preventDefault();
        const next = stepLayer(cursorLayer, layerStep, layerCounts);
        if (next === cursorLayer) return;
        setCursorLayer(next);
        if (next !== "building") {
          const stops = next === "road" ? roadStops : next === "water" ? waterStops : greenStops;
          setSurfaceKey(stops[0]?.key ?? null);
        }
        return;
      }
      const step = cursorStepFor(event);
      if (step === null) return;
      event.preventDefault();
      if (step === "toggle") {
        // Enter acts on what the cursor is on, and what "act" means is what the
        // layer HAS: a building becomes a hero, and a road, a lake or a park -
        // none of which can be one - opens the inspector, which is the only
        // thing there is to do to them.
        if (cursorLayer === "building") {
          if (cursorId !== null) toggleHero(cursorId);
        } else {
          openInspectorForCursor();
        }
        return;
      }
      if (cursorLayer === "building") {
        setCursorId((current) => moveCursor(order, current, step));
        return;
      }
      setSurfaceKey((current) => moveStop(surfaceStops, current, step));
    },
    [
      cursorId,
      cursorLayer,
      greenStops,
      layerCounts,
      openInspectorForCursor,
      order,
      roadStops,
      surfaceStops,
      toggleHero,
      waterStops,
    ],
  );

  // The canvas's own DOM handlers, identity-stable so that `PreviewCanvas`'s
  // memo holds: the key handler closes over the cursor state and is rebuilt
  // whenever that moves, which must not re-render the canvas (see the memo).
  const viewportKeyDownRef = useRef(onViewportKeyDown);
  viewportKeyDownRef.current = onViewportKeyDown;
  const onCanvasKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => viewportKeyDownRef.current(event), []);
  const onCanvasFocus = useCallback(() => setFocused(true), []);
  const onCanvasBlur = useCallback(() => setFocused(false), []);

  if (!graph || scale === null) {
    return status === "loading" ? <PreviewSkeleton /> : <PreviewEmpty />;
  }

  return (
    <div
      ref={viewportRef}
      className="relative h-full w-full"
      /*
        How many rings of lettering the SHARED layout puts on the plate -- the
        same `transform.lettering_layout` the engine cuts from -- so an e2e can
        see that enabling an engraving really adds geometry rather than only a
        line in the panel. A refused engraving, which the engine will not cut,
        leaves it unchanged.
      */
      data-preview-text-count={textModel.shapeCount}
      /* What the pipeline is doing, and which region meshes are on screen.
         `data-region-versions` moves the moment a region's mesh is replaced;
         `data-region-hashes` carries the worker's own keys, which arrive with
         the finished result. */
      data-pipeline-status={pipelineStatus}
      data-pipeline-stage={progressStage}
      data-pipeline-dimmed={view.dimmed ? "true" : "false"}
      data-region-versions={regionVersions}
      data-region-hashes={Object.entries(regionHashes)
        .map(([region, hash]) => `${region}:${hash}`)
        .join(" ")}
    >
      {/*
        The viewport is a focus stop with its own key handling: Tab reaches it,
        arrows walk the buildings tallest-first, Enter toggles the one under the
        cursor. Before this, a hero could only be ADDED with a mouse while every
        control that removed one was keyboard-operable -- WCAG 2.1.1, Level A.
        `role="application"` is what tells a screen reader to pass the arrow
        keys through to this widget instead of using them to browse.
      */}
      <PreviewCanvas
        onKeyDown={onCanvasKeyDown}
        onFocus={onCanvasFocus}
        onBlur={onCanvasBlur}
        regions={regions}
        recessBands={recessBands}
        dimmed={view.dimmed}
        dimOpacity={multipliers.dim}
        recessShade={multipliers.recess}
        tiles={pipelineResult?.tiles}
        tileColor={themed.tileLine}
        background={viewportPalette.background}
        sky={viewportPalette.sky}
        bounce={viewportPalette.bounce}
        gridColor={viewportPalette.grid}
        plateMm={frameWidthMm}
        fitTrigger={graph}
        tints={tints}
        onPick={onPickBuilding}
        onHover={onHover}
        onInspect={onInspect}
      />

      {/*
        The object popover. It sits over the canvas, not in it: nothing it does
        re-renders the scene, and a pointer move costs one style write.
      */}
      <ObjectPopover ref={popoverRef} />

      {/*
        The right-click inspector. It reads and writes `PrintParams`, which is
        why it lives in `components/editor/` and is rendered here as a sibling
        of the canvas rather than inside it.
      */}
      {inspector === null ? null : (
        <ObjectInspector target={inspector.target} at={inspector.at} onClose={closeInspector} />
      )}

      {/* The chip docks top-left, over the model's own empty corner. */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-2">
        {/*
          The stage overlay. It replaces the old "Updating model..." badge with
          the thing the worker is actually doing, because the model under it is
          still on screen (dimmed) and the only question left is what is being
          rebuilt and roughly how much of it is left.
        */}
        <PipelineStageOverlay />
        <AdjustmentsChip adjustments={adjustments} />
        <IssuesBadge issues={issues} />
        {/*
          The cursor readout: visible so a sighted keyboard user can see where
          the walk has reached, and a live region so a screen-reader user hears
          it. It stays in the DOM when the viewport is not focused because the
          canvas's `aria-describedby` points at it.
        */}
        <span
          id="preview-cursor-status"
          role="status"
          aria-live="polite"
          data-testid="preview-cursor"
          data-cursor-layer={cursorLayer}
          className={
            focused && cursorText
              ? "rounded-milled border border-control bg-plate/95 px-2 py-1 text-2xs text-ink shadow-raised"
              : "sr-only"
          }
        >
          {focused && cursorText
            ? cursorText
            : `Arrow keys move a cursor over the ${CURSOR_LAYER_NOUNS[
                cursorLayer
              ].toLowerCase()} layer; Page Up and Page Down change layer; Enter picks a hero or opens the object menu; the Menu key opens it anywhere.`}
        </span>
        {heroIds.length > 0 ? (
          <span
            data-testid="hero-hint"
            className="rounded-milled border border-line bg-plate/95 px-2 py-1 text-2xs text-ink-muted shadow-raised"
          >
            {heroIds.length} hero {heroIds.length === 1 ? "building" : "buildings"} ·
            click one again to drop it
          </span>
        ) : null}
        {/*
          A refused click is answered where the click happened. The Buildings
          group carries the same limit as a statement of state, but it may be
          collapsed, and a click that silently does nothing reads as a bug.
        */}
        {heroCapHit ? (
          <span
            role="status"
            data-testid="hero-cap-hit"
            className="rounded-milled border border-warn/40 bg-warn-soft px-2 py-1 text-2xs text-warn shadow-raised"
          >
            {heroCapMessage()}
          </span>
        ) : null}
      </div>

      {/*
        The spec strip: the three numbers that describe this as a printed
        object. Scale comes from the mirrored token table, so it is the same
        string the engine engraves; the height is the number the 60 mm guard
        compares; the wall is what every thin footprint is repaired to.
      */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0">
        {/*
          One line of advice, and the two remedies it names as buttons. It only
          appears when the band is fair or poor AND the shared math actually has
          something to say -- a permanent advice bar over a healthy model is
          just furniture. The numbers are solved by `transform.recommend_*`, so
          "Use 540 m" is the radius that fixes it, not a nudge in a direction.
        */}
        {advice !== null && advice.sentence !== null && showsRecommendation(advice.chip.band) ? (
          <div
            data-testid="detail-recommendation"
            className="pointer-events-auto flex items-center gap-2 border-t border-line bg-plate/95 px-3 py-1"
          >
            <p className="min-w-0 flex-1 truncate text-2xs text-ink-muted" title={advice.sentence}>
              {advice.sentence}
            </p>
            {advice.actions.map((action) => (
              <button
                key={action.kind}
                type="button"
                data-testid={`advisor-use-${action.kind}`}
                data-value={action.value}
                aria-label={action.ariaLabel}
                onClick={() => onAdvisorAction(action)}
                className="shrink-0 rounded-milled border border-control px-2 py-0.5 text-2xs text-ink transition-colors hover:border-ink-faint hover:bg-plate-raised"
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-px border-t border-line bg-line">
          {spec.map((item) => (
            <div
              key={item.testId}
              data-testid={item.testId}
              className="flex items-baseline gap-1.5 bg-plate/95 px-3 py-1"
            >
              <span className="font-display text-2xs uppercase tracking-[0.16em] text-ink-faint">
                {item.label}
              </span>
              <span
                className={`text-sm ${
                  item.tone === "danger" ? "font-semibold text-danger" : "text-ink"
                }`}
              >
                {item.value}
              </span>
            </div>
          ))}
          {/*
            The fourth instrument: how much of this city survives the minimum
            feature repair, 0-100, from the same shared predicates the engine
            builds with (`transform.detail_report`). The band is stated in a
            WORD as well as a colour -- a hue alone would carry it only to
            people who can see the hue.
          */}
          {advice !== null ? (
            <div
              data-testid="detail-health"
              data-band={advice.chip.band}
              data-score={advice.chip.score}
              title={advice.chip.ariaLabel}
              className="flex items-baseline gap-1.5 bg-plate/95 px-3 py-1"
            >
              <span className="font-display text-2xs uppercase tracking-[0.16em] text-ink-faint">
                Detail
              </span>
              <span className={`text-sm ${BAND_TEXT[advice.chip.tone]}`}>
                {advice.chip.value}
              </span>
            </div>
          ) : null}

          {/*
            How many buildings the scene carries after the minimum-feature
            repair, and -- once a model exists -- how many triangles the file
            would carry. The building count is the scene's, so it is settled
            the moment a Preview lands and does not move again under the same
            scene; the triangle count is the MODEL's, measured, and says so.
            The full measured table stays in the sidebar's Output group: a
            predicted number and a built number must never sit in the same
            table (DECISIONS [P5-web]).
          */}
          <div
            data-testid="preview-stats"
            className="flex min-w-0 flex-1 items-baseline gap-2 bg-plate/95 px-3 py-1 text-2xs text-ink-muted"
          >
            <span className="shrink-0">{layout.buildings.length} buildings</span>
            <span data-testid="preview-triangles" className="truncate text-ink-faint">
              {pipelineResult === null
                ? "Building the model..."
                : `${pipelineResult.stats.triangles.toLocaleString()} triangles, exactly the ones the file carries.`}
            </span>
          </div>
        </div>
      </div>

      {predictedTop !== null && predictedTop >= heightCeilingMm(params) ? (
        <span
          data-testid="preview-too-tall"
          className="pointer-events-none absolute bottom-16 left-3 rounded-milled bg-danger px-2 py-1 text-2xs font-medium text-primary-ink shadow-raised"
        >
          Over the {heightCeilingMm(params).toFixed(0)} mm printer height ceiling. The
          model will be refused.
        </span>
      ) : null}
      {treeFloor !== null ? (
        <span
          data-testid="preview-tree-floor"
          className="pointer-events-none absolute bottom-16 right-3 rounded-milled border border-line bg-plate/95 px-2 py-1 text-2xs text-ink-muted shadow-raised"
        >
          A {params.nozzle_mm} mm nozzle drops trees under {treeFloor.toFixed(1)} m of
          site radius.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The stage overlay, as its own subscriber.
 *
 * A run reports every stage twice (start and done) -- 142 events on a full
 * Chicago plan -- and each one writes `state.pipeline.progress`. Reading that
 * from `CityPreview` re-rendered the whole viewport, its memos and its scene
 * subtree on all 142; reading it HERE re-renders one span. Measured: the
 * overlay's own derivation is 1 ms in total across a run, and the main thread
 * is left to the renderer.
 */
function PipelineStageOverlay() {
  const running = useEditorStore((state) => state.pipeline.status === "running");
  const progress = useEditorStore((state) => state.pipeline.progress);
  const cancelPipeline = useEditorStore((state) => state.cancelPipeline);
  // Perf mode only: `perfSpan` is a boolean read with perf mode off.
  const overlay = perfSpan("preview.overlay", () => ({
    text: stageOverlayText(progress),
    eta: stageEtaText(progress),
  }));
  if (!running || overlay.text === null) return null;
  return (
    <span
      role="status"
      data-testid="pipeline-stage-overlay"
      data-stage={progress.stage}
      data-index={progress.index}
      data-total={progress.total}
      className="pointer-events-auto flex items-center gap-2 rounded-milled border border-line bg-plate/95 px-2 py-1 text-2xs text-ink-muted shadow-raised"
    >
      <span>
        {overlay.text}
        {overlay.eta === null ? "" : ` · ${overlay.eta}`}
      </span>
      {/*
        Stopping is the user's, not only ours. A run is superseded
        automatically by the next write, but a long one (a plate resize on a
        dense city) has to be abandonable without moving a control back and
        forth: the worker stops at its next stage boundary and the model
        already on screen stays exactly where it is.
      */}
      <button
        type="button"
        data-testid="pipeline-cancel"
        aria-label="Stop building the model"
        onClick={cancelPipeline}
        className="rounded-milled border border-control px-1.5 py-0.5 text-2xs text-ink transition-colors hover:border-ink-faint hover:bg-plate-raised"
      >
        Stop
      </button>
    </span>
  );
}

/**
 * Before anything is previewed: the plate the model will fill, and what to do
 * next. An empty screen is an invitation to act, so it says what to do, in
 * order, and how to do it from the keyboard.
 */
function PreviewEmpty() {
  return (
    <div
      data-testid="preview-empty"
      className="fc-drafting-sheet flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center"
    >
      {/* The plate outline: the object's own footprint, at rest. */}
      <div
        data-testid="preview-plate-outline"
        aria-hidden="true"
        className="h-32 w-32 rounded-plate border-2 border-dashed border-line-strong"
      />
      <h2 className="max-w-sm font-display text-xl font-semibold tracking-tight text-ink">
        Preview a location to build the model
      </h2>
      <ol className="max-w-sm space-y-1 text-left text-sm text-ink-muted">
        <li>1. Choose a preset city, or click the map to drop the pin.</li>
        <li>2. Preview. The model arrives in a few seconds.</li>
        <li>3. Tune it. Every control rebuilds the model as you move it.</li>
        <li>4. Export, and download the .3mf.</li>
      </ol>
      <p className="text-2xs text-ink-faint">
        Keyboard: G preview · B export · R reset · ? for the full list
      </p>
    </div>
  );
}

/** While the OpenStreetMap fetch is in flight: the shape of what is coming, not a spinner. */
function PreviewSkeleton() {
  return (
    <div
      data-testid="preview-skeleton"
      className="fc-drafting-sheet flex h-full w-full flex-col items-center justify-center gap-4 p-6"
      role="status"
      aria-live="polite"
    >
      <div className="h-40 w-40 animate-[fc-pulse_1.6s_ease-in-out_infinite] rounded-plate border border-line-strong bg-plate">
        <div className="m-3 h-10 rounded-milled bg-plate-sunken" />
        <div className="mx-3 mb-3 h-16 rounded-milled bg-plate-sunken" />
      </div>
      <p className="text-2xs text-ink-muted">
        Fetching the scene from OpenStreetMap...
      </p>
    </div>
  );
}

export default CityPreview;
