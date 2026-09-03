/**
 * The object popover's markup: what a reader actually sees, per kind.
 *
 * `lib/objectInfo.test.ts` owns the CONTENT model; this owns the rendering of
 * it, and one rule about the rendering that matters more than the rest: an
 * unnamed object still fills the card. Most OpenStreetMap buildings have no
 * name, so a popover that shows a name or nothing would be blank on most of the
 * city, which is the failure this component exists to avoid.
 *
 * `ObjectCard` is rendered directly rather than through the imperative handle,
 * for the same reason `RegionMeshes.test.tsx` mocks react-three-fiber: the
 * vitest environment is Node with no DOM, and a card driven by pointer events
 * cannot be opened there. The handle and the throttle are covered by
 * `e2e/objects.spec.ts`, in a real browser with a real pointer.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AreaFeature, Building, Road } from "@/lib/contracts";
import { describeArea, describeBuilding, describeRoad } from "@/lib/objectInfo";
import { ObjectCard, ObjectPopover } from "./ObjectPopover";

const TOWER: Building = {
  id: "w1",
  ring: [
    [0, 0],
    [30, 0],
    [30, 30],
    [0, 30],
  ],
  holes: [],
  height_m: 92,
  height_source: "tag",
  min_height_m: 0,
  is_tall: true,
  name: "Marquette Building",
  kind: "building=commercial",
};

const SHED: Building = { ...TOWER, id: "w2", name: undefined, kind: "building=yes", height_source: "default", height_m: 8 };

const AVENUE: Road = {
  id: "w10",
  path: [
    [0, 0],
    [100, 0],
  ],
  width_m: 16,
  class: "primary",
  name: "South State Street",
};

const PARK: AreaFeature = {
  ring: [
    [0, 0],
    [60, 0],
    [60, 60],
    [0, 60],
  ],
  holes: [],
  name: "Grant Park",
  osm_id: "r99",
  kind: "leisure=park",
};

const card = (markup: string): string => markup.replace(/<[^>]+>/g, "|");

describe("ObjectCard", () => {
  it("shows a named building's name, type and printing facts", () => {
    const html = renderToStaticMarkup(
      <ObjectCard info={describeBuilding(TOWER, { hero: true, dilationM: 0.31 })} />,
    );
    const text = card(html);
    expect(text).toContain("Marquette Building");
    expect(text).toContain("Commercial");
    expect(text).toContain("92 m");
    expect(text).toContain("An OSM height tag");
    expect(text).toContain("900 m²");
    expect(text).toContain("Widened 0.31 m to reach the minimum wall");
    expect(text).toContain("Yes, this one is singled out");
  });

  it("fills the card for an unnamed building instead of leaving it blank", () => {
    const html = renderToStaticMarkup(
      <ObjectCard info={describeBuilding(SHED, { hero: false, dilationM: 0 })} />,
    );
    const text = card(html);
    // The heading is the type, and the second line says why there is no name.
    expect(text).toContain("Building");
    expect(text).toContain("No OpenStreetMap name");
    // ...and the facts are the same facts a named one gets.
    expect(text).toContain("8 m");
    expect(text).toContain("Estimated from the building type");
    expect(text).toContain("900 m²");
  });

  it("shows a road's width, length and how the match was made", () => {
    const text = card(renderToStaticMarkup(<ObjectCard info={describeRoad(AVENUE, 2.5)} />));
    expect(text).toContain("South State Street");
    expect(text).toContain("Primary road");
    expect(text).toContain("16 m");
    expect(text).toContain("100 m");
    expect(text).toContain("Nearest centreline, 2.5 m away");
  });

  it("shows an area's name and size", () => {
    const text = card(renderToStaticMarkup(<ObjectCard info={describeArea(PARK, "green", 0)} />));
    expect(text).toContain("Grant Park");
    expect(text).toContain("Park");
    expect(text).toContain("3,600 m²");
    expect(text).toContain("Inside the outline");
  });

  it("keeps every fact on its own labelled row", () => {
    const html = renderToStaticMarkup(
      <ObjectCard info={describeBuilding(TOWER, { hero: false, dilationM: 0 })} />,
    );
    expect(html.match(/<dt/g)?.length).toBe(4);
    expect(html.match(/<dd/g)?.length).toBe(4);
  });
});

describe("ObjectPopover", () => {
  it("mounts closed, out of the pointer's way and out of the accessibility tree", () => {
    const html = renderToStaticMarkup(<ObjectPopover />);
    expect(html).toContain('data-testid="object-popover"');
    // Closed: `hidden` is what takes it out of the layout, and there is no
    // content behind it to read.
    expect(html).toContain("hidden=");
    expect(html).toContain("pointer-events-none");
    // The keyboard route to the same buildings is the viewport's own cursor
    // readout, which IS a live region; announcing this one on every mouse move
    // would talk over it.
    expect(html).toContain('aria-hidden="true"');
  });
});
