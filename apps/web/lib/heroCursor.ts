/**
 * Picking a hero building without a mouse.
 *
 * Heroes could only be *added* by a raycast against the InstancedMesh, while
 * every control that *removes* one was fully keyboard-operable. That is WCAG
 * 2.1.1 Keyboard (Level A) on the headline feature of this phase, so the
 * preview now carries a building cursor: focus the viewport, arrow through the
 * buildings, Enter or Space to toggle the one under the cursor.
 *
 * **Why an ordered walk and not spatial navigation.** Arrow keys that move
 * "north" and "east" would have to agree with what the user sees, and
 * OrbitControls lets them spin the model to any heading — so "up" would mean
 * something different after every drag. A stable order avoids inventing a
 * frame, and the order chosen is the one that matches the task: heroes are
 * landmarks, so the walk starts at the tallest building and goes down. Three
 * presses gets you the three towers a person would have clicked.
 *
 * Pure data in, ids out: no three.js, no DOM, so the whole interaction is
 * unit-testable (`lib/heroCursor.test.ts`).
 */

/** The shape of a preview building this module needs. */
export interface CursorBuilding {
  id: string;
  height_m: number;
  width_mm: number;
  depth_mm: number;
}

/**
 * The walk order: tallest first, then largest footprint, then by id.
 *
 * Every tie-break is total and deterministic — two 40 m buildings with equal
 * footprints must not swap places between renders, or the cursor would jump
 * when nothing moved.
 */
export function cursorOrder<T extends CursorBuilding>(
  buildings: readonly T[],
): T[] {
  return [...buildings].sort((a, b) => {
    if (b.height_m !== a.height_m) return b.height_m - a.height_m;
    const areaA = a.width_mm * a.depth_mm;
    const areaB = b.width_mm * b.depth_mm;
    if (areaB !== areaA) return areaB - areaA;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export type CursorStep = "next" | "previous" | "first" | "last";

/**
 * Where the cursor lands, or null when there is nothing to point at.
 *
 * With no cursor yet, ANY step lands on the tallest building: the first arrow
 * press after focusing the viewport should show something, not step off the
 * front of a list the user cannot see.
 *
 * The walk clamps at both ends rather than wrapping. Wrapping 994 buildings
 * from the shed at the end back to the tower at the start is disorienting, and
 * `first`/`last` (Home/End) are there for jumping.
 */
export function moveCursor(
  order: readonly CursorBuilding[],
  currentId: string | null,
  step: CursorStep,
): string | null {
  if (order.length === 0) return null;
  if (step === "first") return order[0].id;
  if (step === "last") return order[order.length - 1].id;

  const index = currentId === null ? -1 : order.findIndex((b) => b.id === currentId);
  // No cursor, or a cursor on a building that has since been dropped from the
  // preview (a nozzle change can do that): start at the top.
  if (index === -1) return order[0].id;

  const next = step === "next" ? index + 1 : index - 1;
  if (next < 0 || next >= order.length) return order[index].id;
  return order[next].id;
}

/** `Building 3 of 994 · 132 m · hero` — what the live region announces. */
export function cursorLabel(
  order: readonly CursorBuilding[],
  currentId: string | null,
  heroIds: readonly string[],
): string | null {
  if (currentId === null) return null;
  const index = order.findIndex((building) => building.id === currentId);
  if (index === -1) return null;
  const building = order[index];
  const hero = heroIds.includes(currentId);
  return (
    `Building ${index + 1} of ${order.length} · ` +
    `${Math.round(building.height_m)} m` +
    (hero ? " · hero" : "")
  );
}

/** The key map for the viewport, or null when the key is not ours. */
export function cursorStepFor(event: {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): CursorStep | "toggle" | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
      return "previous";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "Enter":
    case " ":
      return "toggle";
    default:
      return null;
  }
}
