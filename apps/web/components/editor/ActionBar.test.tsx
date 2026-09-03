/**
 * The action bar, the progress model, the failure surface and the skeleton
 * rule ([V3.1-T6]).
 *
 * The store is mocked rather than driven. `zustand`'s React binding reads
 * `getInitialState()` when React renders on the server, and
 * `renderToStaticMarkup` IS a server render, so a test that set the real store
 * and rendered would silently assert against the initial state forever.
 * Replacing the hook with a plain `selector(state)` is what makes a static
 * render a truthful picture of a given store state; everything else in the
 * module is the real thing.
 *
 * The load-bearing block is the last one. "No skeleton in the idle, error and
 * completed states" is the rule the whole task turns on, and it is asserted
 * over the four components that could break it -- the estimate card, the stats
 * card, the results panel and the bar itself -- by scanning the rendered HTML
 * for a `-skeleton` test id or the shimmer keyframe, rather than by naming the
 * one element that happened to be wrong.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock("@/store/editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/editor")>();
  const hook = (selector?: (state: unknown) => unknown): unknown =>
    selector === undefined ? store.state : selector(store.state);
  Object.assign(hook, {
    getState: () => store.state,
    getInitialState: () => store.state,
    setState: () => undefined,
    subscribe: () => () => undefined,
  });
  return { ...actual, useEditorStore: hook };
});

import { defaultPrintParams, type PrintParams, type SceneGraph } from "@/lib/contracts";
import { planFor } from "@/lib/engine/pipeline";
import {
  LEGACY_PROJECT_FILE_EXTENSION,
  PROJECT_FILE_ACCEPT,
  PROJECT_FILE_EXTENSION,
  buildProject,
  parseProject,
  serializeProject,
} from "@/lib/project";
import type { AuditFinding, EngineResult, RegionMesh } from "@/lib/engine/types";
import type { EditorState, PipelineProgress } from "@/store/editor";
import ActionBar, {
  BUILD_PLAN_IDS,
  EXPORT_PLAN_IDS,
  EXPORT_WRITER_IDS,
  INITIAL_RUN_WATCH,
  NO_OUTCOME,
  exportCancelledModel,
  exportFailureModel,
  exportProgressModel,
  failureNotice,
  paramsFingerprint,
  previewProgressModel,
  projectLoadNotices,
  runFailureModel,
  statusLine,
  stepRunOutcome,
  type RunOutcome,
} from "./ActionBar";
import EstimateCard from "./EstimateCard";
import ExportErrorDetail from "./ExportErrorDetail";
import OutputPanel from "./OutputPanel";
import StatsCard from "./StatsCard";

const real = await vi.importActual<typeof import("@/store/editor")>("@/store/editor");
const BASE = real.useEditorStore.getState();
const IDLE_PROGRESS = real.IDLE_PIPELINE_PROGRESS;

function setStore(patch: Partial<EditorState>): void {
  store.state = { ...BASE, ...patch } as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// A model just real enough for the cards to render one
// ---------------------------------------------------------------------------

function region(name: RegionMesh["region"], slot: number, volumeMm3: number): RegionMesh {
  return {
    region: name,
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
    volumeMm3,
    bbox: { min: [0, 0, 0], max: [180, 180, 6] },
    bodies: 1,
    slot,
    colorHex: "#d8d3c6",
  };
}

function fakeResult(params: PrintParams, findings: AuditFinding[] = []): EngineResult {
  const regions = [region("base", 1, 90_000), region("buildings", 2, 12_000)];
  return {
    regions,
    merged: region("base", 1, 100_000),
    stats: {
      scaleDenominator: 4000,
      minWallMm: 0.8,
      measuredMinWallMm: 0.94,
      buildings: 30,
      buildingsMerged: 0,
      buildingsDilated: 2,
      heightFallbacks: 0,
      triangles: 35_394,
      widthMm: 180,
      depthMm: 180,
      heightMm: 6.9,
      elapsedMs: 790,
    },
    findings,
    resolvedText: [],
    params,
  };
}

/** A SceneGraph just real enough for `scene.status: "ready"` to be a state the store could reach. */
function fakeGraph(): SceneGraph {
  const buildings = Array.from({ length: 30 }, (_, index) => ({
    id: `w${index}`,
    ring: [
      [0, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ] as Array<[number, number]>,
    holes: [],
    height_m: 12,
    height_source: "tag" as const,
    min_height_m: 0,
    is_tall: false,
  }));
  return {
    bounds: { min_x: -900, min_y: -900, max_x: 900, max_y: 900 },
    center: { lat: 41.8827, lon: -87.6233 },
    buildings,
    roads: [],
    water: [],
    green: [],
    trees: [],
    stats: { building_count: buildings.length, coverage: "good", height_tag_ratio: 0.5 },
  };
}

const EXCEEDS_HEIGHT: AuditFinding = {
  id: "exceeds-height",
  severity: "error",
  title: "The model is taller than the printer can build",
  detail: "It reaches 74.10 mm against a 60 mm ceiling.",
};

function progress(patch: Partial<PipelineProgress> = {}): PipelineProgress {
  return { ...IDLE_PROGRESS, ...patch };
}

beforeEach(() => {
  setStore({});
});

// ---------------------------------------------------------------------------

describe("the export's plan", () => {
  it("is the build's plan plus a tail, so a build's index counts against it", () => {
    // The whole export progress model rests on this: `planFor` filters ONE
    // registry in ONE order by phase, and `export` is the last phase, so a
    // `full` run walks a prefix of an `export` run. Asserted rather than
    // assumed, because a stage registered out of phase order would leave the
    // bar counting a build's step against the wrong denominator.
    expect(EXPORT_PLAN_IDS.slice(0, BUILD_PLAN_IDS.length)).toEqual([...BUILD_PLAN_IDS]);
    expect(EXPORT_PLAN_IDS.length).toBeGreaterThan(BUILD_PLAN_IDS.length);
  });

  it("adds exactly the export phase's own stages", () => {
    expect([...EXPORT_WRITER_IDS]).toEqual(
      planFor("export")
        .filter((stage) => stage.phase === "export")
        .map((stage) => stage.id),
    );
    expect(EXPORT_WRITER_IDS).toContain("export");
  });
});

describe("the progress model", () => {
  it("passes a Preview's own numbers through, and never invents an ETA", () => {
    const model = previewProgressModel(
      progress({ stage: "region-roads", index: 13, total: 71, phase: "region", etaMs: null }),
      4200,
    );
    expect(model).toEqual({
      kind: "preview",
      stage: "region-roads",
      index: 13,
      total: 71,
      phase: "region",
      elapsedMs: 4200,
      etaMs: null,
    });
  });

  it("counts an export's build half against the export plan's length", () => {
    const model = exportProgressModel(
      progress({ stage: "lettering", index: 40, total: BUILD_PLAN_IDS.length, phase: "geometry", etaMs: 2500 }),
      true,
      1000,
    );
    expect(model.kind).toBe("export");
    expect(model.stage).toBe("lettering");
    expect(model.index).toBe(40);
    expect(model.total).toBe(EXPORT_PLAN_IDS.length);
    expect(model.etaMs).toBe(2500);
  });

  it("stands on the writer stage, last of the plan, once the build is done", () => {
    const model = exportProgressModel(progress({ stage: "audit", index: 3, total: 4 }), false, 300);
    expect(model.stage).toBe(EXPORT_WRITER_IDS[EXPORT_WRITER_IDS.length - 1]);
    expect(model.index).toBe(EXPORT_PLAN_IDS.length - 1);
    expect(model.total).toBe(EXPORT_PLAN_IDS.length);
    // No previous run has ever timed the writer on its own, so there is no
    // honest "left" figure and the model carries none.
    expect(model.etaMs).toBeNull();
  });
});

/** A settled store: a model on screen, nothing running, nothing exported. */
const SETTLED_STATUS = {
  cancelledAt: null as string | null,
  pipelineStatus: "ready",
  hasResult: true,
  exportLabel: "Not exported yet",
  exportPhase: "idle",
  running: false,
};

describe("the status line", () => {
  const base = SETTLED_STATUS;

  it("names the stage a cancel stopped at, until the next run", () => {
    expect(statusLine({ ...base, cancelledAt: "region-roads" })).toBe("Cancelled at roads.");
    expect(statusLine({ ...base, cancelledAt: "validate" })).toBe(
      "Cancelled at checking printability.",
    );
  });

  it("says an EXPORT was cancelled rather than refused, ahead of the failed branch", () => {
    // The store puts a cancelled export in the same `failed` phase a refusal
    // lands in, so this branch has to win or the line reads "Export refused."
    // for something the user asked to stop ([V3.1-T6] 2).
    expect(
      statusLine({
        ...base,
        cancelledAt: "region-roads",
        exportCancelled: true,
        exportPhase: "failed",
        exportLabel: "No file written",
      }),
    ).toBe("Export cancelled at roads.");
    // A Preview cancel keeps the plainer word.
    expect(statusLine({ ...base, cancelledAt: "region-roads", exportCancelled: false })).toBe(
      "Cancelled at roads.",
    );
  });

  it("says what there is to do in each settled state", () => {
    expect(statusLine({ ...base, hasResult: false, pipelineStatus: "idle" })).toContain(
      "Nothing built yet",
    );
    expect(statusLine(base)).toContain("Model ready");
    expect(statusLine({ ...base, pipelineStatus: "error" })).toContain("could not be built");
    expect(statusLine({ ...base, exportPhase: "failed" })).toBe("Export refused.");
  });

  it("keeps the outdated export label, which is what EXPORT_STALE_NOTE goes with", () => {
    expect(
      statusLine({ ...base, exportPhase: "done", exportLabel: "Done (outdated)" }),
    ).toBe("Export: Done (outdated)");
  });
});

describe("the failure surface", () => {
  it("names the failing stage in the sentence and keeps the stack in the block", () => {
    const model = runFailureModel(
      {
        stage: "lettering",
        message: "font not found\n    at cutText (lettering.ts:44)",
        detail: "Error: font not found\n    at cutText",
      },
      "abc123",
    );
    expect(model.stage).toBe("lettering");
    expect(model.headline).toContain("lettering");
    expect(model.headline).toContain("font not found");
    // The sentence is one line: a traceback in the panel tells nobody anything.
    expect(model.headline).not.toContain("\n");
    expect(model.headline).not.toContain("at cutText");
    expect(model.detail).toContain("stage: lettering");
    expect(model.detail).toContain("at cutText");
    expect(model.detail).toContain("app: FrameCraft");
    expect(model.detail).toContain("params: abc123");
  });

  it("names the blocking findings when the printability gate refused the export", () => {
    const model = exportFailureModel(
      "export refused: the printability gate failed a check (exceeds-height): The model is taller than the printer can build. Fix the model, or export with force to ship it anyway.",
      fakeResult(BASE.params, [EXCEEDS_HEIGHT]),
      "abc123",
    );
    expect(model.findingIds).toEqual(["exceeds-height"]);
    expect(model.headline).toContain("exceeds-height");
    expect(model.stage).toBe("export");
    expect(model.detail).toContain("blocking: exceeds-height");
    expect(model.detail).toContain("60 mm ceiling");
  });

  it("still reads well for a refusal the editor made before the worker was asked", () => {
    const model = exportFailureModel("Preview a location first.", null, "abc123");
    expect(model.findingIds).toEqual([]);
    expect(model.stage).toBeNull();
    expect(model.headline).toBe("The export was refused: Preview a location first.");
  });

  it("renders the message and a Copy details button, with the block behind it", () => {
    const html = renderToStaticMarkup(
      <ExportErrorDetail
        model={runFailureModel({ stage: "validate", message: "boom", detail: null }, "hash")}
        testId="run-error-detail"
      />,
    );
    expect(html).toContain('data-testid="run-error-detail-message"');
    expect(html).toContain("checking printability");
    expect(html).toContain('data-testid="run-error-detail-copy"');
    expect(html).toContain("Copy details");
    // Behind the button: the block is not in the DOM until it is asked for.
    expect(html).not.toContain('data-testid="run-error-detail-block"');
  });

  it("gives the same parameters the same fingerprint and different ones a different one", () => {
    const a = paramsFingerprint(BASE.params);
    const b = paramsFingerprint({ ...BASE.params });
    const c = paramsFingerprint({ ...BASE.params, plate_mm: 200 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// Cancel is not a failure ([V3.1-T6] 2)
// ---------------------------------------------------------------------------

type WatchInput = Parameters<typeof stepRunOutcome>[1];

/**
 * Drive the watcher render by render and report what the bar would be showing
 * at the end -- exactly what `useRunOutcome`'s effect does, minus React.
 */
function watch(steps: readonly Partial<WatchInput>[]): RunOutcome {
  let seen = INITIAL_RUN_WATCH;
  let shown: RunOutcome = NO_OUTCOME;
  let input: WatchInput = {
    running: false,
    stage: "",
    result: null,
    pipelineStatus: "idle",
    sceneStatus: "idle",
    exportPhase: "idle",
  };
  for (const patch of steps) {
    input = { ...input, ...patch };
    const step = stepRunOutcome(seen, input);
    seen = step.seen;
    if (step.outcome !== null) shown = step.outcome;
  }
  return shown;
}

describe("telling a cancel from a failure", () => {
  const BUILT = fakeResult(BASE.params);
  const REBUILT = fakeResult(BASE.params);

  it("reads a Cancel pressed during an export as a cancelled EXPORT, naming the stage", () => {
    /*
      The exact chain the audit walked. `cancelPipeline` leaves
      `pipeline.error` null on purpose, `requestExport` sees its run resolve
      null with no error to quote and writes the fallback string, and the bar
      used to render that as "The export was refused: The engine could not build
      a model." -- false in both halves. Nothing in a single store SNAPSHOT can
      separate the two; the transition can.
    */
    const outcome = watch([
      // Export pressed: the phase moves and the run it needs starts, in one render.
      { running: true, exportPhase: "exporting", result: BUILT, pipelineStatus: "running" },
      { stage: "region-roads" },
      // Cancel: the store writes the cancelled pipeline and the failed export in
      // two `set` calls that React batches into ONE render, so by the time the
      // watcher looks the phase has already moved to `failed`.
      { running: false, exportPhase: "failed", pipelineStatus: "ready", result: BUILT },
    ]);
    expect(outcome).toEqual({ cancelledAt: "region-roads", exportCancelled: true });
  });

  it("reads a Cancel pressed during a Preview as a cancel, but not as an export's", () => {
    const outcome = watch([
      { running: true, pipelineStatus: "running", result: BUILT },
      { stage: "buildings" },
      { running: false, pipelineStatus: "ready", result: BUILT },
    ]);
    expect(outcome).toEqual({ cancelledAt: "buildings", exportCancelled: false });
  });

  it("says nothing about a run that finished: a NEW result is what finishing looks like", () => {
    expect(
      watch([
        { running: true, pipelineStatus: "running", result: BUILT },
        { stage: "validate" },
        { running: false, pipelineStatus: "ready", result: REBUILT },
      ]),
    ).toBe(NO_OUTCOME);
  });

  it("says nothing about a run that broke, which the run-failure surface owns", () => {
    expect(
      watch([
        { running: true, pipelineStatus: "running", result: BUILT },
        { stage: "lettering" },
        { running: false, pipelineStatus: "error", result: BUILT },
      ]),
    ).toBe(NO_OUTCOME);
    // An Overpass failure is reported on the SCENE and leaves the pipeline
    // `ready` with the last good model, so it has to be checked separately or
    // it reads as a cancel.
    expect(
      watch([
        { running: true, pipelineStatus: "running", result: BUILT },
        { stage: "fetch" },
        { running: false, pipelineStatus: "ready", sceneStatus: "error", result: BUILT },
      ]),
    ).toBe(NO_OUTCOME);
  });

  it("does not report a REFUSED export as cancelled: its run finished", () => {
    // [V3.1-P1-15]: the build lands, the writer runs, the gate refuses. The run
    // produced a new result, so nothing here was cancelled.
    expect(
      watch([
        { running: true, exportPhase: "exporting", pipelineStatus: "running", result: BUILT },
        { stage: "audit" },
        { running: false, pipelineStatus: "ready", result: REBUILT },
        { exportPhase: "failed" },
      ]),
    ).toBe(NO_OUTCOME);
  });

  it("does not report an export refused with no run at all as cancelled", () => {
    // The model was already fresh, so `requestExport` never started a run and
    // the gate refused the writer on its own.
    expect(watch([{ exportPhase: "exporting", result: BUILT }, { exportPhase: "failed" }])).toBe(
      NO_OUTCOME,
    );
  });

  it("retires a cancel when the next export starts, and when one finishes", () => {
    const cancelled: Partial<WatchInput>[] = [
      { running: true, exportPhase: "exporting", pipelineStatus: "running", result: BUILT },
      { stage: "region-roads" },
      { running: false, exportPhase: "failed", pipelineStatus: "ready", result: BUILT },
    ];
    expect(watch(cancelled).cancelledAt).toBe("region-roads");
    // "Cancelled at roads." must not still be under a fresh download link.
    expect(watch([...cancelled, { exportPhase: "exporting" }])).toBe(NO_OUTCOME);
    expect(watch([...cancelled, { exportPhase: "exporting" }, { exportPhase: "done" }])).toBe(
      NO_OUTCOME,
    );
  });

  it("still reports a cancel that arrived before the first stage was named", () => {
    const outcome = watch([
      { running: true, exportPhase: "exporting", pipelineStatus: "running", result: BUILT },
      { running: false, exportPhase: "failed", pipelineStatus: "ready", result: BUILT },
    ]);
    expect(outcome).toEqual({ cancelledAt: "", exportCancelled: true });
    expect(statusLine({ ...SETTLED_STATUS, cancelledAt: "", exportCancelled: true })).toBe(
      "Export cancelled.",
    );
  });

  it("writes a cancelled export's own detail block, and never the word refused", () => {
    const model = exportCancelledModel("region-roads", "abc123");
    expect(model.headline).toContain("cancelled");
    expect(model.headline).toContain("roads");
    expect(model.headline).toContain("stage \"region-roads\"");
    expect(model.headline).not.toContain("refused");
    expect(model.headline).not.toContain("could not");
    // The previous download is untouched, and the sentence says so, because the
    // panel below is still showing it.
    expect(model.headline).toContain("untouched");
    expect(model.stage).toBe("region-roads");
    expect(model.findingIds).toEqual([]);
    expect(model.detail).toContain("what: the export was cancelled");
    expect(model.detail).toContain("stage: region-roads");
    expect(model.detail).toContain("app: FrameCraft");
    expect(model.detail).toContain("params: abc123");
    expect(model.detail).not.toContain("blocking:");
  });

  it("routes a cancel and a refusal to two different surfaces", () => {
    const common = {
      pipelineError: null,
      pipelineRunning: false,
      exportPhase: "failed",
      result: fakeResult(BASE.params, [EXCEEDS_HEIGHT]),
      paramsHash: "abc123",
    };

    // The cancel: the store's message is the misleading fallback, and it is
    // NOT what reaches the screen.
    const cancelled = failureNotice({
      ...common,
      exportError: "The engine could not build a model.",
      outcome: { cancelledAt: "region-roads", exportCancelled: true },
    });
    expect(cancelled?.testId).toBe("export-cancelled-detail");
    expect(cancelled?.tone).toBe("note");
    expect(cancelled?.model.headline).not.toContain("could not build");
    expect(cancelled?.model.findingIds).toEqual([]);

    // The genuine refusal, same phase, same store snapshot apart from the
    // transition: named by finding, in the danger palette ([V3.1-P1-15]).
    const refused = failureNotice({
      ...common,
      exportError:
        "export refused: the printability gate failed a check (exceeds-height): The model is taller than the printer can build.",
      outcome: NO_OUTCOME,
    });
    expect(refused?.testId).toBe("export-error-detail");
    expect(refused?.tone).toBe("danger");
    expect(refused?.model.findingIds).toEqual(["exceeds-height"]);
    expect(refused?.model.stage).toBe("export");
    expect(refused?.model.detail).toContain("blocking: exceeds-height");

    // Neither can be mistaken for the other: the two surfaces never coexist.
    expect(cancelled?.testId).not.toBe(refused?.testId);
  });

  it("lets a broken RUN outrank the export's own report of it", () => {
    const notice = failureNotice({
      pipelineError: { stage: "lettering", message: "font not found", detail: null },
      pipelineRunning: false,
      exportPhase: "failed",
      exportError: "The engine could not build a model.",
      result: null,
      outcome: { cancelledAt: "lettering", exportCancelled: true },
      paramsHash: "abc123",
    });
    expect(notice?.testId).toBe("run-error-detail");
    expect(notice?.model.stage).toBe("lettering");
  });

  it("shows nothing at all when the export did not fail", () => {
    for (const phase of ["idle", "exporting", "done"]) {
      expect(
        failureNotice({
          pipelineError: null,
          pipelineRunning: false,
          exportPhase: phase,
          exportError: "stale message",
          result: null,
          outcome: { cancelledAt: "region-roads", exportCancelled: true },
          paramsHash: "abc123",
        }),
      ).toBeNull();
    }
  });

  it("renders the cancel in the quiet palette and the refusal in the danger one", () => {
    const cancelled = renderToStaticMarkup(
      <ExportErrorDetail
        model={exportCancelledModel("region-roads", "hash")}
        testId="export-cancelled-detail"
        tone="note"
      />,
    );
    expect(cancelled).toContain('data-tone="note"');
    expect(cancelled).not.toContain("bg-danger-soft");
    expect(cancelled).toContain('data-testid="export-cancelled-detail-copy"');

    const refused = renderToStaticMarkup(
      <ExportErrorDetail
        model={exportFailureModel("export refused: ...", fakeResult(BASE.params, [EXCEEDS_HEIGHT]), "hash")}
        testId="export-error-detail"
      />,
    );
    expect(refused).toContain('data-tone="danger"');
    expect(refused).toContain("bg-danger-soft");
    expect(refused).toContain('data-findings="exceeds-height"');
  });
});

/**
 * Loading a project file: which of the bar's two message slots gets filled
 * (Task 13).
 *
 * The rule is asserted on the pure function the change handler calls, because
 * the handler itself needs a real file input and this package's vitest
 * environment is `node`. The parse outcomes are the REAL ones, produced by
 * `parseProject` over real documents, so a change to the migration wording or
 * to which forms count as legacy fails here as well as in `lib/project.test.ts`.
 */
describe("the project file's two message slots", () => {
  const LOCATION = {
    lat: 41.8827,
    lon: -87.6233,
    radius_m: 900,
    rotation_deg: 0,
    preset_id: "chicago-loop",
  };
  const SAVED_AT = new Date("2026-08-29T12:00:00.000Z");
  const current = (): string =>
    serializeProject(buildProject(LOCATION, defaultPrintParams(), SAVED_AT, null));

  function legacyEnvelope(): string {
    const parsed = JSON.parse(current()) as Record<string, unknown>;
    delete parsed.app_version;
    parsed.version = 3;
    return JSON.stringify(parsed);
  }

  it("says nothing at all for a current file under its current name", () => {
    const slots = projectLoadNotices(parseProject(current(), `chicago${PROJECT_FILE_EXTENSION}`));
    expect(slots).toEqual({ error: null, notice: null });
  });

  it("fills the notice slot, not the error slot, for a version-3 envelope", () => {
    const slots = projectLoadNotices(parseProject(legacyEnvelope()));
    expect(slots.error).toBeNull();
    expect(slots.notice).toContain("project format 3");
    // The point of saying anything: the next Save writes a different filename.
    expect(slots.notice).toContain(PROJECT_FILE_EXTENSION);
  });

  it("fills the notice slot for a file loaded under the legacy extension", () => {
    const slots = projectLoadNotices(
      parseProject(current(), `chicago${LEGACY_PROJECT_FILE_EXTENSION}`),
    );
    expect(slots.error).toBeNull();
    expect(slots.notice).toContain(LEGACY_PROJECT_FILE_EXTENSION);
  });

  it("fills the error slot and clears the notice for a file that will not load", () => {
    const slots = projectLoadNotices(parseProject("not a project at all {"));
    expect(slots.notice).toBeNull();
    expect(slots.error).toContain("not valid JSON");
  });

  it("keeps both slots empty until a file is actually loaded", () => {
    setStore({});
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).not.toContain('data-testid="project-migrated"');
    expect(html).not.toContain('data-testid="project-error"');
  });

  it("offers both extensions in the load picker, or the legacy files are unselectable", () => {
    setStore({});
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).toContain(`accept="${PROJECT_FILE_ACCEPT}"`);
  });
});

describe("the bar itself", () => {
  it("offers Preview as the primary action with no scene, and Export disabled", () => {
    setStore({});
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).toContain('data-testid="preview-button"');
    expect(html).toContain('data-mode="preview"');
    expect(html).toContain("Preview");
    // Export cannot run without a scene, and says so rather than sitting dead.
    expect(html).toMatch(/data-testid="export-button"[^>]* disabled=/);
  });

  it("becomes Cancel while a run is in flight, and stays enabled", () => {
    setStore({
      pipeline: { ...BASE.pipeline, status: "running", progress: progress({ stage: "base", index: 2, total: 40 }) },
    });
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).toContain('data-mode="cancel"');
    expect(html).toContain(">Cancel<");
    expect(html).not.toMatch(/data-testid="preview-button"[^>]* disabled=/);
    // ...and the determinate progress control is up, naming the stage.
    expect(html).toContain('data-testid="run-progress"');
    expect(html).toContain('data-stage="base"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="40"');
  });

  it("re-enables Preview after a cancel, when the scene is current but the model is not", () => {
    const params = BASE.params;
    /*
      A REAL graph, not `graph: null`. `scene.status === "ready"` with no graph
      is a state the store cannot produce -- `generate()` only ever reaches
      `ready` with one -- and proving "Preview is disabled" against an
      impossible state proves nothing about the app ([V3.1-T6] 5).
    */
    const settled = {
      scene: { ...BASE.scene, status: "ready" as const, graph: fakeGraph(), stale: false },
      pipeline: { ...BASE.pipeline, status: "ready" as const, stale: false, result: fakeResult(params) },
    };
    setStore(settled);
    expect(renderToStaticMarkup(<ActionBar />)).toMatch(
      /data-testid="preview-button"[^>]* disabled=/,
    );
    // A cancelled run leaves the scene current and the model stale. Preview has
    // to come back, or the only way to start a build is to nudge a slider.
    setStore({ ...settled, pipeline: { ...settled.pipeline, stale: true } });
    expect(renderToStaticMarkup(<ActionBar />)).not.toMatch(
      /data-testid="preview-button"[^>]* disabled=/,
    );
  });

  it("keeps Preview live while the scene is being fetched, because the run already owns the button", () => {
    /*
      `scene.status === "loading"` with `pipeline.status === "running"` is the
      only shape the store can produce: `generate()` writes the loading scene
      and calls `startPipelineRun` in the same synchronous block. So the button
      is Cancel, and the `fetching` term that used to disable it and the
      "Previewing..." label it fed were both unreachable ([V3.1-T6] 5).
    */
    setStore({
      scene: { ...BASE.scene, status: "loading", graph: null },
      pipeline: { ...BASE.pipeline, status: "running", progress: progress({ stage: "fetch", index: 0, total: 40 }) },
    });
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).toContain('data-mode="cancel"');
    expect(html).toContain(">Cancel<");
    expect(html).not.toContain("Previewing...");
    expect(html).not.toMatch(/data-testid="preview-button"[^>]* disabled=/);
  });

  it("keeps Save, Load and Copy link on the bar", () => {
    const html = renderToStaticMarkup(<ActionBar />);
    for (const id of ["save-project-button", "load-project-button", "copy-link-button"]) {
      expect(html, id).toContain(`data-testid="${id}"`);
    }
  });

  it("carries the compact format selector and a one-line description of the target", () => {
    const html = renderToStaticMarkup(<ActionBar />);
    expect(html).toContain('data-testid="export-target-select"');
    expect(html).toContain('id="export_target"');
    expect(html).toContain('data-testid="export-target-description"');
    expect(html).toContain("ready to slice");
  });
});

// ---------------------------------------------------------------------------
// The skeleton rule
// ---------------------------------------------------------------------------

/** A skeleton, however it is spelled: a `-skeleton` test id or the shimmer keyframe. */
function skeletons(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/data-testid="([^"]*-skeleton)"/g)) found.push(match[1]);
  if (html.includes("fc-pulse")) found.push("fc-pulse shimmer");
  return found;
}

const SURFACES: ReadonlyArray<readonly [string, () => React.ReactElement]> = [
  ["EstimateCard", () => <EstimateCard />],
  ["StatsCard", () => <StatsCard />],
  ["OutputPanel", () => <OutputPanel />],
  ["ActionBar", () => <ActionBar />],
];

describe("no skeleton in a settled state", () => {
  const params = BASE.params;

  const STATES: ReadonlyArray<readonly [string, Partial<EditorState>]> = [
    ["idle", { pipeline: { ...BASE.pipeline, status: "idle", result: null } }],
    [
      "error",
      {
        pipeline: {
          ...BASE.pipeline,
          status: "error",
          result: null,
          error: { stage: "validate", message: "boom", detail: null },
        },
      },
    ],
    [
      "completed",
      { pipeline: { ...BASE.pipeline, status: "ready", stale: false, result: fakeResult(params) } },
    ],
  ];

  for (const [stateName, patch] of STATES) {
    for (const [surface, render] of SURFACES) {
      it(`${surface} shows none in the ${stateName} state`, () => {
        setStore(patch);
        const html = renderToStaticMarkup(render());
        expect(skeletons(html), `${surface} / ${stateName}`).toEqual([]);
      });
    }
  }

  it("shows one only while a FIRST build is in flight, with nothing to show yet", () => {
    setStore({ pipeline: { ...BASE.pipeline, status: "running", result: null } });
    expect(skeletons(renderToStaticMarkup(<EstimateCard />))).toContain("estimate-card-skeleton");
  });

  it("keeps a previous estimate on screen, dimmed and labelled, while a rebuild runs", () => {
    setStore({
      pipeline: { ...BASE.pipeline, status: "running", stale: true, result: fakeResult(params) },
    });
    const html = renderToStaticMarkup(<EstimateCard />);
    expect(skeletons(html)).toEqual([]);
    expect(html).toContain('data-testid="estimate-card"');
    expect(html).toContain('data-stale="true"');
    expect(html).toContain("from the previous build");
    expect(html).toContain("opacity-60");
    // The numbers are still there: that is the whole point of not blanking them.
    expect(html).toContain('data-testid="estimate-total"');
  });

  it("keeps the stats numbers too, labelled as the previous computation", () => {
    setStore({
      pipeline: { ...BASE.pipeline, status: "running", stale: true, result: fakeResult(params) },
    });
    const html = renderToStaticMarkup(<StatsCard />);
    expect(skeletons(html)).toEqual([]);
    expect(html).toContain("previous computation");
    expect(html).toContain("35,394");
  });
});

describe("the results panel", () => {
  it("renders its five slots in the same order every run", () => {
    setStore({ pipeline: { ...BASE.pipeline, status: "ready", result: fakeResult(BASE.params) } });
    const html = renderToStaticMarkup(<OutputPanel />);
    const order = [...html.matchAll(/data-testid="result-slot-([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["estimate", "export", "text", "stats", "recent"]);
  });

  it("keeps the slots when there is nothing in them, so nothing below moves", () => {
    setStore({});
    const html = renderToStaticMarkup(<OutputPanel />);
    const order = [...html.matchAll(/data-testid="result-slot-([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["estimate", "export", "text", "stats", "recent"]);
    // An idle export shows no status block at all, which `e2e/ui.spec.ts` pins.
    expect(html).not.toContain('data-testid="export-status"');
  });

  it("holds no action: the bar owns those now", () => {
    setStore({});
    const html = renderToStaticMarkup(<OutputPanel />);
    for (const id of ["preview-button", "export-button", "export-target-select", "copy-link-button"]) {
      expect(html, id).not.toContain(`data-testid="${id}"`);
    }
  });
});
