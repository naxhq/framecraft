/**
 * Slider commit gating.
 *
 * The radius and rotation sliders commit to `store.generate()`, which is a
 * POST /scene and, away from a preset, a live Overpass query. Before this
 * gate the input wired `onKeyUp={onCommit}` with no change detection, so
 * tabbing INTO the radius slider, tabbing on into the rotation slider and
 * releasing Shift while focused issued three server hits with zero value
 * change -- and five quick arrow taps issued five.
 *
 * `createCommitGate` and `isValueChangingKey` are the exact functions
 * `Controls.tsx` wires to `onChange` / `onPointerUp` / `onKeyUp`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PRINT_PARAMS } from "@/lib/contracts";
import {
  DEFAULT_MIRRORS,
  MemoryOverpassCache,
  fetchOverpass,
  resetBundledPresetManifest,
} from "@/lib/engine/osm/overpass";
import { whenSessionsIdleForTest } from "@/lib/engine/protocol";
import { INITIAL_LOCATION, useEditorStore } from "@/store/editor";
import {
  COMMIT_DEBOUNCE_MS,
  createCommitGate,
  isValueChangingKey,
} from "./Controls";

describe("isValueChangingKey", () => {
  it("accepts the keys a range input actually responds to", () => {
    for (const key of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
      "PageUp",
      "PageDown",
    ]) {
      expect(isValueChangingKey({ key })).toBe(true);
    }
  });

  it("ignores navigation, modifiers and chords", () => {
    for (const key of ["Tab", "Shift", "Control", "Alt", "Meta", "Escape", "Enter", "a"]) {
      expect(isValueChangingKey({ key })).toBe(false);
    }
    expect(isValueChangingKey({ key: "ArrowRight", ctrlKey: true })).toBe(false);
    expect(isValueChangingKey({ key: "ArrowRight", metaKey: true })).toBe(false);
    expect(isValueChangingKey({ key: "ArrowRight", altKey: true })).toBe(false);
  });
});

describe("createCommitGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not commit when nothing changed", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.commit();
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(run).not.toHaveBeenCalled();
  });

  it("commits once after a real change", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.markDirty();
    gate.commit();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);

    // A second release with no further change must not commit again.
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of arrow taps into one commit", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    for (let i = 0; i < 5; i += 1) {
      gate.markDirty();
      gate.commit();
      vi.advanceTimersByTime(60);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("commits again after the next change", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.markDirty();
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    gate.markDirty();
    gate.commit();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("drops a pending commit on unmount", () => {
    const run = vi.fn();
    const gate = createCommitGate(run);
    gate.markDirty();
    gate.commit();
    gate.cancel();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(run).not.toHaveBeenCalled();
  });
});

/**
 * The two kinds of request one preview can make, told apart at the spy.
 *
 * Since the site-performance work a preview may consult the build's own
 * bundled preset assets before it touches a mirror: one memoised GET for
 * `<base>/presets/index.json`, and on a hit one GET for the gzipped response.
 * Both go through the same global `fetch` this suite stubs, so a bare call
 * count no longer means "Overpass round trips" -- which is the invariant these
 * tests exist to hold. Each is therefore counted by what it actually is.
 */
type SpyCall = [input: unknown, init?: RequestInit];

/** A POST of Overpass QL to a mirror: one round trip against somebody's server. */
function overpassCalls(spy: ReturnType<typeof vi.fn>): SpyCall[] {
  return (spy.mock.calls as SpyCall[]).filter(([input, init]) => {
    const url = String(input);
    const body = init?.body === undefined ? "" : String(init.body);
    return DEFAULT_MIRRORS.includes(url) || body.includes("[out:json]");
  });
}

/** The same-origin GET for the bundled preset manifest. */
function manifestCalls(spy: ReturnType<typeof vi.fn>): SpyCall[] {
  return (spy.mock.calls as SpyCall[]).filter(([input]) =>
    String(input).endsWith("/presets/index.json"),
  );
}

describe("keyboard navigation through the Location sliders", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Only the timers this suite measures: the commit gate's debounce. Not
    // `setImmediate`, which is how the engine yields to the event loop between
    // stages (`pipeline/runner.ts:yieldToEventLoop`): a fake one fires only on
    // a clock advance, so a run still going when a test ends would park on it,
    // `vi.useRealTimers()` would discard it unfired, and the realm's one
    // session would stay busy for every test after -- their requests queued
    // behind a job that can never reach the boundary where its cancel takes
    // effect. That is the state CI's zero-Overpass-calls failure was in.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    useEditorStore.setState({
      location: { ...INITIAL_LOCATION },
      params: { ...DEFAULT_PRINT_PARAMS },
      scene: {
        status: "idle",
        graph: null,
        message: null,
        request: null,
        hash: null,
        stale: false,
      },
    });
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    // The bundled-preset manifest probe is memoised per JS realm, hit or miss,
    // so each test owns its own memo rather than inheriting whatever ran
    // before it. The memo itself is asserted below, deliberately.
    resetBundledPresetManifest();
  });

  afterEach(async () => {
    // A preview starts a real pipeline run; without this it keeps going after
    // the test returns, on whatever state a later test happens to set.
    useEditorStore.getState().cancelPipeline();
    vi.useRealTimers();
    // The cancel is cooperative. The store's promise settles the moment the
    // cancel is posted, but the session's job stops only at its next stage
    // boundary (after the manifold load, on the realm's first run), and the
    // session is one per realm: a run the next test starts queues behind this
    // one and its request reaches `fetch` only once the old job has let go.
    // Whether that happened inside the next test's fake-timer window used to
    // depend on how far the abandoned run had got, which is the host's speed
    // -- CI measured zero Overpass calls where this machine measured one. So
    // every test hands the session on idle, and a run that cannot stop fails
    // this hook loudly instead of leaking into the next test.
    await whenSessionsIdleForTest();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The radius slider exactly as ParamPanel wires it. */
  const wire = () => {
    const store = useEditorStore.getState();
    const gate = createCommitGate(() => void store.generate());
    return {
      change: (value: number) => {
        gate.markDirty();
        store.setRadius(value);
      },
      keyUp: (key: string) => {
        if (isValueChangingKey({ key })) gate.commit();
      },
      pointerUp: () => gate.commit(),
    };
  };

  it("costs zero requests when the slider is only tabbed through", () => {
    const slider = wire();
    slider.keyUp("Tab");
    slider.keyUp("Shift");
    slider.keyUp("Tab");
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useEditorStore.getState().location.radius_m).toBe(INITIAL_LOCATION.radius_m);
  });

  it("costs zero requests when the pointer is pressed without dragging", () => {
    const slider = wire();
    slider.pointerUp();
    vi.advanceTimersByTime(COMMIT_DEBOUNCE_MS * 4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * A build with no bundled preset assets, which is what `npm run build`
   * produces: the manifest 404s and every query goes to a mirror.
   *
   * A fresh `Response` per call, never one shared instance: a body can only be
   * read once, so a single shared response would be drained by the manifest
   * probe and make the mirror's own reply look like a malformed one.
   */
  const serveNoBundle = (): void => {
    fetchSpy.mockImplementation(async (input: unknown) =>
      String(input).endsWith("/presets/index.json")
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ elements: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
  };

  it("costs one Overpass round trip for five arrow taps", async () => {
    serveNoBundle();
    const slider = wire();
    for (let i = 0; i < 5; i += 1) {
      slider.change(900 + (i + 1) * 10);
      slider.keyUp("ArrowRight");
      vi.advanceTimersByTime(60);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    // The commit gate's own timer is the only thing under test; everything
    // after it (ingest -> the engine worker's in-page fallback -> the bundled
    // asset probe -> Overpass' own cache lookup -> `fetch`) is a real Promise
    // chain with several microtask hops before the request actually goes out,
    // so the fake-timer advance has to let those settle too (`...Async`
    // flushes microtasks between each due timer, `advanceTimersByTime` does
    // not).
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS);

    // The invariant: five taps, ONE query against somebody's Overpass mirror.
    const overpass = overpassCalls(fetchSpy);
    expect(overpass).toHaveLength(1);
    // And the only other thing on the wire is the build's own manifest, once --
    // so the total is still accounted for to the call, rather than a count
    // loosened to absorb whatever else the page felt like doing.
    const manifest = manifestCalls(fetchSpy);
    expect(manifest).toHaveLength(1);
    expect(fetchSpy.mock.calls).toHaveLength(2);

    expect(useEditorStore.getState().location.radius_m).toBe(950);
    const [, init] = overpass[0];
    // The request body is the Overpass QL query text (never a `POST /scene`
    // JSON payload): the radius is built into its bbox, not a JSON field, so
    // this asserts on the query text itself.
    expect(String(init?.body)).toContain("[out:json]");
  });

  it("probes the bundled preset manifest once per realm, not once per preview", async () => {
    serveNoBundle();
    // Somebody already asked, and got a 404: this build ships no preset
    // assets. That answer is the realm's, not this caller's.
    await fetchOverpass(
      { lat: INITIAL_LOCATION.lat, lon: INITIAL_LOCATION.lon, radius_m: 400, rotation_deg: 0 },
      {
        // Its own transport for the mirrors, so this priming call contributes
        // nothing to the Overpass count the preview below is measured by.
        fetchImpl: vi.fn(async () => new Response("", { status: 500 })),
        assetFetchImpl: fetchSpy as unknown as typeof fetch,
        cache: new MemoryOverpassCache(),
        sleep: async () => undefined,
      },
    );
    expect(manifestCalls(fetchSpy)).toHaveLength(1);

    // A preview now: it goes to a mirror, and it does NOT ask again. On a
    // build without the assets that is the difference between one 404 per
    // session and one 404 per preview.
    const slider = wire();
    // A radius no other test in this file previews: the engine client keeps a
    // stage cache for the realm, so re-asking for one already built would be
    // served without a network call and would prove nothing here.
    slider.change(1200);
    slider.keyUp("ArrowRight");
    await vi.advanceTimersByTimeAsync(COMMIT_DEBOUNCE_MS);
    expect(useEditorStore.getState().location.radius_m).toBe(1200);
    expect(overpassCalls(fetchSpy)).toHaveLength(1);
    expect(manifestCalls(fetchSpy)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The primitives, as source
// ---------------------------------------------------------------------------

/**
 * A source guard, in the same spirit as `CityPreview.hud.test.ts`: these are
 * facts about the primitives that no unit test with a DOM would state as
 * clearly, and that the settings truth audit depends on.
 *
 * Every primitive has to be selectable by one stable handle (its own id, as a
 * `data-testid`) and every primitive has to attach its help string through
 * `aria-describedby` -- the audit's rule is that a control's description is
 * programmatically associated, not merely a tooltip.
 */
describe("the control primitives", () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "Controls.tsx"),
    "utf-8",
  );

  it("gives every primitive a data-testid equal to its id", () => {
    // Slider's range input, Toggle's switch, Segmented's radiogroup,
    // TextField's text input and SelectField's select: five elements, one
    // handle each.
    const handles = source.match(/data-testid=\{id\}/g) ?? [];
    expect(handles.length).toBe(5);
  });

  it("wires every hint through aria-describedby, never through title alone", () => {
    // The five primitives, plus `Field`, which describes a whole labelled
    // block the same way.
    const described = source.match(/aria-describedby=\{hint \? hintId : undefined\}/g) ?? [];
    expect(described.length).toBe(6);
    expect(source).toContain('const hintId = `${id}-hint`');
  });

  it("no longer exports the colour-well primitive the part-colour block used", () => {
    // The seven `part_colors` wells were the only caller (Task 2, DECISIONS
    // [V3.1-P1-2]); the per-region wells in the Colour group are plain inputs
    // inside their own row. Keeping an unused primitive around is how a
    // removed control quietly comes back.
    expect(source).not.toContain("export function ColorField");
  });

  it("exports a screen-reader description for a control with no room for a line", () => {
    expect(source).toContain("export function SrHint");
    expect(source).toContain('className="sr-only"');
  });
});
