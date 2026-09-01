"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import type { PerspectiveCamera } from "three";

import AdjustmentsChip from "@/components/editor/AdjustmentsChip";
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
import type { AuditFinding } from "@/lib/engine/types";
import { freshEngineResult as engineFresh } from "@/lib/enginePreview";
import { loadGlyphFace, loadedGlyphFace } from "@/lib/fontGlyphs";
import { autoHeroIds, heroCandidates, heroCapMessage } from "@/lib/heroes";
import {
  cursorLabel,
  cursorOrder,
  cursorStepFor,
  moveCursor,
} from "@/lib/heroCursor";
import { specStrip } from "@/lib/hud";
import {
  buildAreas,
  buildBuildings,
  buildRoads,
  buildTrees,
  dilatedNotice,
  mergeNoticeMetres,
  treeFloorNoticeMetres,
} from "@/lib/preview";
import {
  buildPreviewText,
  facesNeeded,
  textLayers,
  textParamsKey,
  textTokenContext,
  type PreviewTextModel,
} from "@/lib/previewText";
import * as T from "@/lib/transform";
import {
  letteringWarnings,
  predictedTopDeps,
  predictedTopMm,
  sceneWarnings,
  warningDeps,
} from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";
import AreaSurfaces from "./AreaSurfaces";
import BasePlate from "./BasePlate";
import InstancedBuildings from "./InstancedBuildings";
import RegionMeshes from "./RegionMeshes";
import RoadRibbons from "./RoadRibbons";
import TreeInstances from "./TreeInstances";
import { paletteFor, readPreviewPalette, type PreviewPalette } from "./palette";

/**
 * The live 3D preview.
 *
 * Everything below is drawn in PRINT MILLIMETRES in the SceneGraph frame
 * (x east, y north, z up); the single `rotation` on the root group is the only
 * concession to three.js being y-up, so no component has to think in two
 * coordinate systems.
 *
 * Slider budget (02: under 33 ms): every `useMemo` below is keyed through
 * `previewDeps`, which names exactly the primitives that change its output --
 * never the `params` object, which `setParam` re-creates on every write. A
 * height slider therefore touches nothing except `InstancedBuildings`'s matrix
 * buffer.
 *
 * Preview approximations, all deliberate, all because the browser never runs
 * booleans (02):
 *  - buildings are oriented boxes, not their real footprints;
 *  - the minimum-feature repair is a per-footprint dilation, so neighbours that
 *    the bake would merge into one block are still drawn separately;
 *  - engraved roads and recessed water are drawn on the surface instead of cut
 *    into the slab;
 *  - lettering, the ornaments and the underside pockets are flat fills on the
 *    surface too, at the shared layout's own sizes and anchors, rather than
 *    grooves. What the bake refuses, the preview does not draw.
 * The note under the canvas says so, using the real threshold.
 */

/**
 * The memo keys of every derived preview layer, in one place.
 *
 * 02: "rebuild only the affected instance buffer when a slider moves". The
 * trap is that `store.setParam` rebuilds `params` by spread on every write, so
 * ANY dependency list that names `params` (or an object derived from it, such
 * as the `Thresholds` record) is invalidated by every slider tick -- including
 * the height sliders, which would re-run earcut over ~700 green polygons and
 * re-upload a fresh BufferGeometry per frame of a drag.
 *
 * Every entry below must therefore be a primitive read off `params`, or an
 * identity-stable object (`graph`). `CityPreview.test.ts` enforces both halves.
 */
export const previewDeps = {
  /** `scale_mm_per_m` -> `usable_span_mm`: plate width and the frame only. */
  scale: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
  ],
  /** `thresholds_ground_m` reads the nozzle and the (numeric) scale. */
  thresholds: (scale: number | null, params: PrintParams): unknown[] => [
    scale,
    params.nozzle_mm,
  ],
  /** Hulls and oriented rectangles: scale + thresholds, never a height. */
  layout: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
  ],
  roads: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
    params.road_scale,
    params.road_mode,
  ],
  water: (
    graph: SceneGraph | null,
    scale: number | null,
    params: PrintParams,
  ): unknown[] => [graph, scale, params.nozzle_mm, params.water],
  green: (
    graph: SceneGraph | null,
    scale: number | null,
    params: PrintParams,
  ): unknown[] => [graph, scale, params.nozzle_mm],
  /**
   * The tree filter reads the nozzle too: `transform.tree_min_radius_mm` raises
   * the printed-radius floor above 04's 0.5 mm from a 0.47 mm nozzle up, and the
   * preview must hide exactly the trees the bake drops (DECISIONS [P5-web]).
   */
  trees: (graph: SceneGraph | null, params: PrintParams): unknown[] => [
    graph,
    params.plate_mm,
    params.frame,
    params.nozzle_mm,
    params.trees,
  ],
  /**
   * The predicted model top: the 60 mm guard and the HUD read it.
   *
   * `predictedTopDeps`, i.e. the HEIGHT half of `warningDeps` - not the whole
   * of it. `warningDeps` also names the hanger, the underside mark, `road_mode`
   * and `water`, because the OTHER block warning ([V2-P7-fix], the base a
   * hanger needs) moves with those; none of them changes how tall the model is
   * drawn, so keying this pass on them would re-run it for nothing.
   */
  height: (graph: SceneGraph | null, params: PrintParams): unknown[] =>
    predictedTopDeps(graph, params),
  /**
   * Frame lettering, the ornaments and the underside pockets.
   *
   * `textParamsKey` is a STRING of exactly the parameters that move a layout
   * (plate, frame, nozzle, city label, engravings, north arrow, scale bar,
   * underside mark, hanger) rather than those nested objects themselves: every
   * entry in these lists has to be a primitive or the graph, and a string
   * compares by value, so moving a height slider produces the same key and the
   * glyphs are not re-triangulated.
   *
   * `graph` is here because the token expansion reads the scene (`{scale}`,
   * `{coords}`, `{buildings}`); `rotation_deg` because the north arrow is
   * turned back by it; `date` because `{date}` is in it; `faces` because the
   * glyph outlines arrive asynchronously and the layer has to be built again
   * once they do.
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
 * store selector returning a FRESH `[]` when there is no engine result yet
 * reports "changed" to `useSyncExternalStore` on every render (a new
 * reference is never `Object.is`-equal to the last one), which reproduces as
 * "Maximum update depth exceeded" -- measured, not theoretical, in a real
 * browser click-through of the Chicago preset before this constant existed.
 */
const NO_FINDINGS: readonly AuditFinding[] = [];

/** Which token each lettering tone paints with. */
function textColour(tone: string, colours: PreviewPalette): string {
  if (tone === "embossed") return colours.textEmbossed;
  if (tone === "pocket") return colours.pocket;
  return colours.textEngraved;
}

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

export function CityPreview() {
  const graph = useEditorStore((state) => state.scene.graph);
  const status = useEditorStore((state) => state.scene.status);
  const params = useEditorStore((state) => state.params);
  const theme = useEditorStore((state) => state.theme);
  const engineStatus = useEditorStore((state) => state.engine.status);
  const engineResult = useEditorStore((state) => state.engine.result);
  const engineStale = useEditorStore((state) => state.engine.stale);
  const engineFindings = useEditorStore((state) => state.engine.result?.findings ?? NO_FINDINGS);
  const bakeWarnings = useMemo(
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
  const colours = paletteFor(params, themed, params.part_colors);

  const scale = useMemo(
    () =>
      graph ? T.scale_mm_per_m(params, T.radius_m_from_bounds(graph.bounds)) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.scale(graph, params),
  );
  // `scale` is a number, so an identical recomputation is identity-stable and
  // the layers below are not invalidated by it. `thresholds` is an object, so
  // it must be keyed on the nozzle alone or every slider tick re-triangulates.
  const thresholds = useMemo(
    () => (scale === null ? null : T.thresholds_ground_m(params, scale)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.thresholds(scale, params),
  );

  // The footprint layout depends only on the parameters that move the scale
  // (plate, frame) and the thresholds (nozzle). Height sliders must NOT
  // invalidate it: rebuilding 5000 convex hulls per frame blows the budget.
  const layout = useMemo(
    () =>
      graph
        ? buildBuildings(graph, params)
        : { buildings: [], dilatedCount: 0, droppedCount: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.layout(graph, params),
  );

  const roads = useMemo(
    () => (graph ? buildRoads(graph, params) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.roads(graph, params),
  );

  const water = useMemo(
    () =>
      graph && scale !== null && thresholds !== null && params.water
        ? buildAreas(graph.water, params, scale, thresholds)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.water(graph, scale, params),
  );

  const green = useMemo(
    () =>
      graph && scale !== null && thresholds !== null
        ? buildAreas(graph.green, params, scale, thresholds)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.green(graph, scale, params),
  );

  const trees = useMemo(
    () => (graph ? buildTrees(graph, params) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    previewDeps.trees(graph, params),
  );

  // --- frame lettering, ornaments and the underside ------------------------
  //
  // The glyph outlines are ~280 KB per face and are fetched only when a layout
  // actually names one, so the build runs twice for a face's first use: once
  // reporting it missing (drawing nothing), then again once it has landed.
  // `faceVersion` is what makes the second run happen.
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
  const textDraw = useMemo(
    () => textLayers(textModel, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [textModel, params.base_thickness_mm, params.frame],
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
      // `setRadius` marks the scene stale and retires the bake, `generate`
      // fetches. The plate is a plain parameter write and stays client-side.
      applyAdvisorAction(action, {
        setRadius,
        generate: () => void generate(),
        setParam: (key, value) => setParam(key, value),
      });
    },
    [setRadius, generate, setParam],
  );

  // 04 stage 4 caps the model at 60 mm and the bake refuses to start above it.
  // Showing the number on the canvas is what makes the disabled Bake button
  // legible while the height sliders move.
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
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...warningDeps(graph, params), textParamsKey(params), today],
  );

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
        bakeWarnings,
        // The shared layout's own messages, verbatim: an auto-fitted size, a
        // dropped character, a refused engraving. They are informational -- the
        // bake reports the same strings -- so they belong in the drawer with
        // the rest of "what the pipeline quietly did".
        textNotices: textModel.notices,
      }),
    [
      warnings,
      dilatedNote,
      layout.droppedCount,
      treeFloor,
      params.nozzle_mm,
      bakeWarnings,
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

  const approximationNote =
    thresholds === null
      ? ""
      : "Preview is approximate: the bake merges buildings closer than " +
        `${mergeNoticeMetres(thresholds).toFixed(1)} m, and roads, water, ` +
        "lettering, the ornaments and the underside marks are drawn as flat " +
        "fills here instead of being cut into the plate. Sizes, anchors and " +
        "refusals are the bake's own.";

  const baseTop = T.base_top_mm(params);
  const roadZ = T.road_z_mm(params);
  const waterZ = T.water_z_mm(params);
  // The real thing, when there is one to show: `RegionMeshes` replaces every
  // approximate instanced/flat-fill layer below (base, frame, water, green,
  // roads, buildings, trees, lettering) the moment a fresh `EngineResult`
  // lands, so the preview and a downloaded file can never disagree. See
  // `lib/enginePreview.ts:freshEngineResult`'s own docstring for what "fresh"
  // means and why a stale result is never shown here.
  const freshEngineResult = engineFresh({ status: engineStatus, result: engineResult, stale: engineStale });
  // Manual picks plus, once `hero_auto` is on, the auto-promoted ones -- the
  // same effective set `store/editor.ts:currentHeroIds` bakes with, so the
  // preview highlight and the keyboard cursor's "hero" announcement never
  // disagree with what a click on Bake would actually produce. Deps are
  // primitives/identity-stable references only (`graph`, the hero arrays),
  // never `params` itself or `params.hero_auto` -- `setParam` rebuilds
  // `params` by spread on every write, and this scores every building.
  const manualHeroIds = params.hero_building_ids ?? NO_HEROES;
  const heroAutoEnabled = params.hero_auto?.enabled ?? false;
  const heroAutoCount = params.hero_auto?.count ?? 0;
  const heroIds = useMemo(() => {
    if (!heroAutoEnabled || !graph) return manualHeroIds;
    const candidates = heroCandidates(graph.buildings as EngineBuilding[]);
    return autoHeroIds(candidates, manualHeroIds, heroAutoCount);
  }, [graph, manualHeroIds, heroAutoEnabled, heroAutoCount]);
  /*
    A hero takes the printed hero filament only in a mode that actually gives it
    one. In `true_height` the pick is still shown -- it has to be, or a click
    would look like it did nothing -- but in a colour that does not claim to be
    a material (DECISIONS [V2-P6]).
  */
  const heroColour = T.hero_own_color(params) ? colours.hero : colours.heroPick;

  // --- the keyboard path to a hero (lib/heroCursor.ts) --------------------
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const order = useMemo(() => cursorOrder(layout.buildings), [layout.buildings]);
  const cursorText = cursorLabel(order, cursorId, heroIds);

  const onViewportKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const step = cursorStepFor(event);
      if (step === null) return;
      event.preventDefault();
      if (step === "toggle") {
        if (cursorId !== null) toggleHero(cursorId);
        return;
      }
      setCursorId((current) => moveCursor(order, current, step));
    },
    [cursorId, order, toggleHero],
  );

  if (!graph || scale === null || thresholds === null) {
    return status === "loading" ? <PreviewSkeleton /> : <PreviewEmpty />;
  }

  return (
    <div
      className="relative h-full w-full"
      /*
        What is actually drawn on the frame and the underside, so an e2e can see
        that enabling an engraving put geometry on the plate rather than only a
        line in the panel. It counts RINGS, so a refused engraving -- which the
        bake will not cut and this does not draw -- leaves it unchanged.
      */
      data-preview-text-count={textModel.shapeCount}
    >
      {/*
        The viewport is a focus stop with its own key handling: Tab reaches it,
        arrows walk the buildings tallest-first, Enter toggles the one under the
        cursor. Before this, a hero could only be ADDED with a mouse while every
        control that removed one was keyboard-operable -- WCAG 2.1.1, Level A.
        `role="application"` is what tells a screen reader to pass the arrow
        keys through to this widget instead of using them to browse.
      */}
      <Canvas
        shadows="percentage"
        dpr={[1, 2]}
        camera={{ position: [140, 170, 190], fov: 40, near: 1, far: 5000 }}
        data-testid="preview-canvas"
        tabIndex={0}
        role="application"
        aria-label="3D preview. Arrow keys move the building cursor, Enter picks a hero building."
        aria-describedby="preview-cursor-status"
        onKeyDown={onViewportKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <color attach="background" args={[colours.background]} />
        <ambientLight intensity={0.65} />
        {/* Sky and ground bounce are tokens too: they were the last two raw
            colour literals in this file, and they set how the model reads. */}
        <hemisphereLight args={[colours.sky, colours.bounce, 0.5]} />
        <directionalLight
          position={[180, 260, 160]}
          intensity={1.5}
          castShadow
          shadow-mapSize={[1024, 1024]}
        />
        <directionalLight position={[-160, 120, -140]} intensity={0.4} />

        <FitView plateMm={params.plate_mm} trigger={graph} />

        {/* Print space is z-up; three is y-up. One rotation, once. */}
        <group rotation={[-Math.PI / 2, 0, 0]}>
          {/*
            The real thing, the moment there is a fresh one: every RegionMesh
            the engine produced, replacing every approximate layer below so the
            preview and a downloaded file can never disagree (E4 brief, item 3).
          */}
          {freshEngineResult ? <RegionMeshes regions={freshEngineResult.regions} /> : null}

          {!freshEngineResult ? (
            <BasePlate params={params} baseColor={colours.base} frameColor={colours.frame} />
          ) : null}
          {!freshEngineResult && water.length > 0 && waterZ !== null ? (
            <AreaSurfaces
              areas={water}
              zMm={baseTop + Math.max(waterZ, 0.02)}
              color={colours.water}
            />
          ) : null}
          {!freshEngineResult ? (
            <AreaSurfaces
              areas={green}
              zMm={baseTop + T.green_z_mm(params)}
              color={colours.green}
            />
          ) : null}
          {!freshEngineResult && roads && roadZ !== null ? (
            <RoadRibbons
              ribbons={roads}
              zMm={baseTop + Math.max(roadZ, 0.04)}
              color={colours.road}
            />
          ) : null}
          {/*
            Hero-picking (click and the keyboard cursor) has no equivalent on
            the fused region mesh, which carries no per-building identity, so
            this stays mounted and interactive even once RegionMeshes is what
            is actually seen -- `hidden` only turns off its own draw and its
            own shadow.
          */}
          <InstancedBuildings
            buildings={layout.buildings}
            params={params}
            scale={scale}
            color={colours.building}
            heroColor={heroColour}
            cursorColor={colours.cursor}
            heroIds={heroIds}
            cursorId={focused ? cursorId : null}
            onPick={(id) => {
              setCursorId(id);
              toggleHero(id);
            }}
            hidden={Boolean(freshEngineResult)}
          />
          {!freshEngineResult ? (
            <TreeInstances trees={trees} baseTopMm={baseTop} color={colours.tree} />
          ) : null}

          {/*
            Frame lettering, the north arrow, the scale bar, the underside mark
            and the hanger pockets. Flat fills at the SHARED layout's own sizes
            and anchors (`transform.lettering_layout`, the function the bake
            cuts from), two-sided because the underside half is looked at from
            below. Once RegionMeshes is showing, its own `lettering` region (or
            the frame's embossed letters) is the real cut -- these flat fills
            would only sit on top of it.
          */}
          {!freshEngineResult
            ? textDraw.map((textLayer) => (
                <AreaSurfaces
                  key={textLayer.key}
                  areas={textLayer.areas}
                  zMm={textLayer.z_mm}
                  color={textColour(textLayer.tone, colours)}
                  doubleSide
                />
              ))
            : null}
        </group>

        <Grid
          position={[0, -0.02, 0]}
          args={[1200, 1200]}
          cellSize={10}
          cellThickness={0.5}
          sectionSize={50}
          sectionThickness={0.8}
          cellColor={colours.grid}
          sectionColor={colours.grid}
          fadeDistance={900}
          fadeStrength={1.5}
          infiniteGrid
        />
        <OrbitControls makeDefault enableDamping dampingFactor={0.1} />
      </Canvas>

      {/* The chip docks top-left, over the model's own empty corner. */}
      <div className="pointer-events-none absolute left-3 top-3 flex flex-col items-start gap-2">
        {/*
          Subtle, not blocking: the instanced approximation stays fully
          interactive and on screen the whole time a newer engine job runs
          underneath it, so there is never a flicker back to an empty canvas
          -- this badge is the only thing that says a fresher result is on
          its way (E4 brief, item 3).
        */}
        {engineStatus === "computing" ? (
          <span
            role="status"
            data-testid="engine-updating"
            className="rounded-milled border border-line bg-plate/95 px-2 py-1 text-2xs text-ink-muted shadow-raised"
          >
            Updating model...
          </span>
        ) : null}
        <AdjustmentsChip adjustments={adjustments} />
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
          className={
            focused && cursorText
              ? "rounded-milled border border-control bg-plate/95 px-2 py-1 text-2xs text-ink shadow-raised"
              : "sr-only"
          }
        >
          {focused && cursorText
            ? cursorText
            : "Arrow keys move a building cursor; Enter picks it as a hero."}
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
        string the bake engraves; the height is the number the server's own
        60 mm guard compares; the wall is what every thin footprint is repaired
        to. It is the signature element of this editor and it earns the space.
      */}
      {/*
        ONE compact row. It used to be a `items-stretch` flex with a long
        sentence in the last cell, so every cell inherited the tallest height:
        159 px at 1280x800, 22% of the viewport, with the readouts sitting on
        118 px of empty plate and the bottom fifth of the model behind it. The
        label and value now sit on one line, and the approximation note is
        clamped to a single line with the full text on its `title` (it is still
        complete in the DOM, so a screen reader and `toContainText` both get all
        of it).
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
            feature repair, 0-100, from the same shared predicates the canvas
            draws with (`transform.detail_report`). The band is stated in a WORD
            as well as a colour -- a hue alone would carry it only to people who
            can see the hue.
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

          <div
            data-testid="preview-stats"
            className="flex min-w-0 flex-1 items-baseline gap-2 bg-plate/95 px-3 py-1 text-2xs text-ink-muted"
          >
            {/*
              What was repaired or dropped is NOT repeated here: it is in the
              adjustments drawer, and saying it twice is what made the old UI
              read as a wall of remarks.
            */}
            <span className="shrink-0">
              {layout.buildings.length} buildings · {trees.length} trees
            </span>
            <span
              data-testid="preview-approximation"
              title={approximationNote}
              className="truncate text-ink-faint"
            >
              {approximationNote}
            </span>
          </div>
        </div>
      </div>


      {predictedTop !== null && predictedTop >= T.MAX_HEIGHT_MM ? (
        <span
          data-testid="preview-too-tall"
          className="pointer-events-none absolute bottom-16 left-3 rounded-milled bg-danger px-2 py-1 text-2xs font-medium text-primary-ink shadow-raised"
        >
          Over the 60 mm print ceiling — the bake will refuse this.
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
 * Before anything is generated. An empty screen is an invitation to act, so it
 * says what to do, in order, and how to do it from the keyboard.
 */
function PreviewEmpty() {
  return (
    <div
      data-testid="preview-empty"
      className="fc-drafting-sheet flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <p className="font-display text-2xs uppercase tracking-[0.18em] text-ink-faint">
        Nothing built yet
      </p>
      <h2 className="max-w-sm font-display text-xl font-semibold tracking-tight text-ink">
        Pick a place, and it becomes an object.
      </h2>
      <ol className="max-w-sm space-y-1 text-left text-sm text-ink-muted">
        <li>1. Choose a preset city, or click the map to drop the pin.</li>
        <li>2. Generate. The scene arrives in a few seconds.</li>
        <li>3. Tune it. The preview follows every control instantly.</li>
        <li>4. Bake, and download the .3mf.</li>
      </ol>
      <p className="text-2xs text-ink-faint">
        Keyboard: G generate · B bake · R reset · ? for the full list
      </p>
    </div>
  );
}

/** While `POST /scene` is in flight: the shape of what is coming, not a spinner. */
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

/** Frame the plate whenever a new scene arrives or the plate size changes. */
function FitView({ plateMm, trigger }: { plateMm: number; trigger: unknown }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as {
    target: { set: (x: number, y: number, z: number) => void };
    update: () => void;
  } | null;

  useEffect(() => {
    const distance = plateMm * 1.15;
    camera.position.set(distance * 0.72, distance * 0.86, distance * 0.95);
    camera.far = distance * 30;
    camera.updateProjectionMatrix();
    controls?.target.set(0, 0, 0);
    controls?.update();
  }, [camera, controls, plateMm, trigger]);

  return null;
}

export default CityPreview;
