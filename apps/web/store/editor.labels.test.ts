/**
 * The store's surface-label actions (v3.1 Task 12).
 *
 * Each one is a `setParam("labels", ...)` over `lib/labelAnchor.ts`'s pure
 * edits, so what is checked here is the STORE's part of the contract: the
 * write lands on `params.labels`, the selection follows it, the cap is a
 * flag rather than a silent drop, and a scene that is not there refuses
 * politely. The maths itself is `labelAnchor.test.ts`'s.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defaultPrintParams } from "@/lib/contracts";
import { building, road, scene, square } from "@/lib/engine/solid/fixture";
import { LABEL_CAP, labelScale } from "@/lib/labelAnchor";
import { useEditorStore } from "./editor";

const graph = scene({
  radiusM: 200,
  buildings: [{ ...building("w10-1", square(0, 0, 40), 20), osm_id: "w10", name: "The Rookery" }],
  roads: [{ ...road("w20-1", [[-100, 50], [100, 50]], 12), osm_id: "w20", name: "State St" }],
  water: [],
  green: [],
});

function labels() {
  return useEditorStore.getState().params.labels ?? [];
}

describe("surface labels", () => {
  beforeEach(() => {
    useEditorStore.setState((state) => ({
      params: defaultPrintParams(),
      scene: { ...state.scene, graph },
      selectedLabel: null,
      labelCapHit: false,
    }));
  });

  afterEach(() => {
    useEditorStore.getState().cancelPipeline();
  });

  it("adds a label at the object's centre, selects it, and refuses without a scene", () => {
    const store = useEditorStore.getState();
    expect(store.addLabel({ osmId: "w10", layer: "building" })).toBe(0);
    expect(labels()).toHaveLength(1);
    expect(labels()[0]).toMatchObject({ target_osm_id: "w10", layer: "building", surface: "building_top", u: 0.5, v: 0.5 });
    expect(useEditorStore.getState().selectedLabel).toBe(0);

    useEditorStore.setState((state) => ({ scene: { ...state.scene, graph: null } }));
    expect(useEditorStore.getState().addLabel({ osmId: "w20", layer: "road" })).toBeNull();
    expect(labels()).toHaveLength(1);
  });

  it("adds at the clicked plan point", () => {
    const scale = labelScale(graph, useEditorStore.getState().params);
    useEditorStore.getState().addLabel({ osmId: "w10", layer: "building" }, { xMm: 10 * scale, yMm: 10 * scale });
    expect(labels()[0].u).toBeCloseTo(0.75, 4);
    expect(labels()[0].v).toBeCloseTo(0.75, 4);
  });

  it("refuses the thirteenth with the cap flag, which the next write clears", () => {
    const store = useEditorStore.getState();
    for (let i = 0; i < LABEL_CAP; i += 1) expect(store.addLabel({ osmId: "w20", layer: "road" })).toBe(i);
    expect(store.addLabel({ osmId: "w10", layer: "building" })).toBeNull();
    expect(useEditorStore.getState().labelCapHit).toBe(true);
    expect(labels()).toHaveLength(LABEL_CAP);
    store.removeLabel(0);
    expect(useEditorStore.getState().labelCapHit).toBe(false);
    expect(labels()).toHaveLength(LABEL_CAP - 1);
  });

  it("moves, turns, nudges, resizes and patches the row it is told to, through setParam", () => {
    const store = useEditorStore.getState();
    store.addLabel({ osmId: "w10", layer: "building" });
    store.addLabel({ osmId: "w20", layer: "road" });
    const scale = labelScale(graph, useEditorStore.getState().params);

    store.moveLabel(0, 14 * scale, 6 * scale);
    expect(labels()[0].u).toBeCloseTo(0.85, 4);
    expect(labels()[0].v).toBeCloseTo(0.65, 4);
    expect(labels()[1].u).toBe(0.5);

    // Reading along the street (rotation 0), "left" is back along it.
    store.nudgeLabel(1, -10, 0);
    expect(labels()[1].u).toBeLessThan(0.5);
    expect(labels()[1].v).toBe(0.5);

    store.rotateLabel(1, 93);
    expect(labels()[1].rotation_deg).toBe(90);
    store.turnLabel(1, 5);
    expect(labels()[1].rotation_deg).toBe(95);

    store.resizeLabel(0, 1);
    expect(labels()[0].size_mm).toBe(5);
    store.resizeLabel(0, 100);
    expect(labels()[0].size_mm).toBe(8);

    const before = labels();
    store.patchLabel(0, { text: "Roof", mode: "emboss", follow: true });
    expect(labels()[0]).toMatchObject({ text: "Roof", mode: "emboss", follow: true });
    // Every one of those is a fresh array through `setParam`, never a mutation
    // of the one the history and the previous render hold.
    expect(labels()).not.toBe(before);
    expect(before[0].text).toBe("");
  });

  it("keeps the selection on the row it was on when another is removed", () => {
    const store = useEditorStore.getState();
    store.addLabel({ osmId: "w10", layer: "building" });
    store.addLabel({ osmId: "w20", layer: "road" });
    store.addLabel({ osmId: "w20", layer: "road" });
    store.selectLabel(2);
    store.removeLabel(0);
    expect(useEditorStore.getState().selectedLabel).toBe(1);
    store.removeLabel(1);
    expect(useEditorStore.getState().selectedLabel).toBeNull();
    expect(labels()).toHaveLength(1);
    store.removeLabel(7);
    expect(labels()).toHaveLength(1);
  });

  it("clears the selection and the cap flag on a reset", () => {
    const store = useEditorStore.getState();
    store.addLabel({ osmId: "w10", layer: "building" });
    useEditorStore.setState({ labelCapHit: true });
    store.resetParams();
    expect(labels()).toEqual([]);
    expect(useEditorStore.getState().selectedLabel).toBeNull();
    expect(useEditorStore.getState().labelCapHit).toBe(false);
  });
});
