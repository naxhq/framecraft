/**
 * The keyboard path to a hero building.
 *
 * The defect this closes: heroes could only be ADDED with a mouse, while every
 * control that removed one was keyboard-operable — WCAG 2.1.1 (Level A) on the
 * feature this phase exists to add. The interaction is pure data here so it can
 * be tested without a WebGL context; `e2e/ui.spec.ts` drives the real canvas.
 */

import { describe, expect, it } from "vitest";

import {
  cursorLabel,
  cursorOrder,
  cursorStepFor,
  moveCursor,
  type CursorBuilding,
} from "./heroCursor";

const b = (
  id: string,
  height_m: number,
  width_mm = 10,
  depth_mm = 10,
): CursorBuilding => ({ id, height_m, width_mm, depth_mm });

const SCENE: CursorBuilding[] = [
  b("shed", 4),
  b("tower", 210),
  b("block", 40),
  b("hall", 40, 30, 30),
];

describe("cursorOrder", () => {
  it("puts the tallest first: heroes are landmarks", () => {
    expect(cursorOrder(SCENE).map((building) => building.id)).toEqual([
      "tower",
      "hall",
      "block",
      "shed",
    ]);
  });

  it("breaks a height tie by footprint, then by id", () => {
    // hall and block are both 40 m; hall is 900 mm^2 against block's 100.
    const order = cursorOrder(SCENE).map((building) => building.id);
    expect(order.indexOf("hall")).toBeLessThan(order.indexOf("block"));

    const twins = [b("w2", 40), b("w1", 40)];
    expect(cursorOrder(twins).map((t) => t.id)).toEqual(["w1", "w2"]);
  });

  it("is stable: the same input always gives the same order", () => {
    const once = cursorOrder(SCENE).map((building) => building.id);
    const twice = cursorOrder([...SCENE].reverse()).map((building) => building.id);
    expect(twice).toEqual(once);
  });

  it("does not mutate its input", () => {
    const input = [...SCENE];
    cursorOrder(input);
    expect(input.map((building) => building.id)).toEqual(
      SCENE.map((building) => building.id),
    );
  });
});

describe("moveCursor", () => {
  const order = cursorOrder(SCENE);

  it("lands on the tallest building on the first press, whatever the key", () => {
    expect(moveCursor(order, null, "next")).toBe("tower");
    expect(moveCursor(order, null, "previous")).toBe("tower");
    expect(moveCursor(order, null, "first")).toBe("tower");
  });

  it("walks forwards and backwards", () => {
    expect(moveCursor(order, "tower", "next")).toBe("hall");
    expect(moveCursor(order, "hall", "next")).toBe("block");
    expect(moveCursor(order, "block", "previous")).toBe("hall");
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(moveCursor(order, "tower", "previous")).toBe("tower");
    expect(moveCursor(order, "shed", "next")).toBe("shed");
  });

  it("jumps to either end", () => {
    expect(moveCursor(order, "block", "first")).toBe("tower");
    expect(moveCursor(order, "block", "last")).toBe("shed");
  });

  it("recovers when the cursor's building has left the preview", () => {
    // A nozzle change drops sub-detail footprints, so the id under the cursor
    // can vanish between renders. That must not strand the cursor.
    expect(moveCursor(order, "a-building-that-was-dropped", "next")).toBe("tower");
  });

  it("has nothing to point at in an empty scene", () => {
    expect(moveCursor([], null, "next")).toBeNull();
    expect(moveCursor([], "tower", "first")).toBeNull();
  });
});

describe("cursorLabel", () => {
  const order = cursorOrder(SCENE);

  it("says where the cursor is and how tall the building is", () => {
    expect(cursorLabel(order, "tower", [])).toBe("Building 1 of 4 · 210 m");
    expect(cursorLabel(order, "shed", [])).toBe("Building 4 of 4 · 4 m");
  });

  it("says when the building under the cursor is already a hero", () => {
    expect(cursorLabel(order, "tower", ["tower"])).toBe(
      "Building 1 of 4 · 210 m · hero",
    );
    expect(cursorLabel(order, "tower", ["hall"])).not.toContain("hero");
  });

  it("has nothing to announce without a cursor", () => {
    expect(cursorLabel(order, null, [])).toBeNull();
    expect(cursorLabel(order, "gone", [])).toBeNull();
  });
});

describe("cursorStepFor", () => {
  it("maps both axes to the walk, so either arrow pair works", () => {
    expect(cursorStepFor({ key: "ArrowRight" })).toBe("next");
    expect(cursorStepFor({ key: "ArrowDown" })).toBe("next");
    expect(cursorStepFor({ key: "ArrowLeft" })).toBe("previous");
    expect(cursorStepFor({ key: "ArrowUp" })).toBe("previous");
    expect(cursorStepFor({ key: "Home" })).toBe("first");
    expect(cursorStepFor({ key: "End" })).toBe("last");
  });

  it("toggles on Enter and Space, the two keys a button answers to", () => {
    expect(cursorStepFor({ key: "Enter" })).toBe("toggle");
    expect(cursorStepFor({ key: " " })).toBe("toggle");
  });

  it("leaves everything else, and every chord, to the browser", () => {
    for (const key of ["b", "g", "Tab", "Escape", "PageDown", "?"]) {
      expect(cursorStepFor({ key }), key).toBeNull();
    }
    expect(cursorStepFor({ key: "ArrowRight", ctrlKey: true })).toBeNull();
    expect(cursorStepFor({ key: "Enter", metaKey: true })).toBeNull();
  });
});
