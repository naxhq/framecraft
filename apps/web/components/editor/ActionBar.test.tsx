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

import type { PrintParams } from "@/lib/contracts";
import { planFor } from "@/lib/engine/pipeline";
import type { AuditFinding, EngineResult, RegionMesh } from "@/lib/engine/types";
import type { EditorState, PipelineProgress } from "@/store/editor";
import ActionBar, {
  BUILD_PLAN_IDS,
  EXPORT_PLAN_IDS,
  EXPORT_WRITER_IDS,
  exportFailureModel,
  exportProgressModel,
  paramsFingerprint,
  previewProgressModel,
  runFailureModel,
  statusLine,
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

describe("the status line", () => {
  const base = {
    cancelledAt: null,
    pipelineStatus: "ready",
    hasResult: true,
    exportLabel: "Not exported yet",
    exportPhase: "idle",
    running: false,
  };

  it("names the stage a cancel stopped at, until the next run", () => {
    expect(statusLine({ ...base, cancelledAt: "region-roads" })).toBe("Cancelled at roads.");
    expect(statusLine({ ...base, cancelledAt: "validate" })).toBe(
      "Cancelled at checking printability.",
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
    const settled = {
      scene: { ...BASE.scene, status: "ready" as const, graph: null, stale: false },
      pipeline: { ...BASE.pipeline, status: "ready" as const, stale: false, result: fakeResult(params) },
    };
    expect(renderToStaticMarkup(<ActionBar />)).toBeTruthy();
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
