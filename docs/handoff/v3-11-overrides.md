# v3.1 Task 11 — per-object overrides, finished

What a right-click on the model can decide about ONE object, and how each of
those decisions reaches the plate, the screen and the file. The contract field
(`object_overrides`, schema 4), the engine readers
(`lib/engine/solid/overrides.ts`) and the menu itself
(`components/editor/ObjectInspector.tsx`) landed earlier in the task; this note
covers the four things that finished it.

Ruling in force: `[V3.1-P11-1]` — an override region takes its slot and colour
from its OWN override entry, with a fallback to the parent layer's. There is no
`colour.region_slots.override_1` leaf and no stage may read one; the engine died
at module load the first time one was fabricated.

---

## 1. The keyboard reaches everything the right-click reaches

The inspector acts on four layers. Before this, the viewport's cursor walked
BUILDINGS only (`lib/heroCursor.ts`, tallest first), so three quarters of the
menu — a road's width and mode, a lake's or a park's raise, either one's colour
or hiding — could only be opened with a pointer. That is WCAG 2.1.1 Keyboard
(Level A) on a real function, not a nicety.

`lib/objectCursor.ts` is the other three layers, and it is deliberately a
SECOND module rather than a change to `heroCursor`: the building walk is over
the repaired preview footprints, which only the editor's own layout pass knows,
and Enter on a building still means "make it a hero".

| key | what it does in the viewport |
| --- | --- |
| ← → ↑ ↓ | walk the current layer (clamped, not wrapping) |
| Page Down / Page Up | change layer: buildings → roads → water → green, skipping any this scene has nothing on |
| Home / End | first / last on the layer |
| Enter / Space | a building becomes a hero; on the other three layers it opens the menu, which is the only thing there is to do to them |
| Menu key, Shift+F10 | open the menu on the object under the cursor, whatever its layer |

The order on each layer is the fact that ranks it — a road by length, a polygon
by ground area — with a total tie-break, so a cursor never moves when nothing
moved. Each stop carries the SAME `ObjectInfo` a hover over that object would
produce, which is what makes the menu opened from the keyboard the menu opened
from the pointer, keyed by the same base OSM id.

The live region (`#preview-cursor-status`) announces `Road 3 of 412 · Michigan
Avenue · 1.2 km`, the canvas's `aria-label` states the whole key map, and the
shortcut sheet (`lib/keyboard.ts`) lists all three viewport rows.

**Focus.** The menu's items are `tabIndex={-1}` with roving focus, so focus is
MOVED to them by script — and a script-moved focus after a right-click does not
match `:focus-visible` in any browser, which left the one item the arrows were
about to act on with no mark at all until the second press. They now carry an
explicit `focus:` ring drawn inside their own box. The group headings inside
`role="menu"` are `aria-hidden`: a bare `<p>` is not a child role a menu allows,
and the `role="group"` around them already carries the same words as its
accessible name.

## 2. What the preview draws

Nothing needed adding: since v3.1 the viewport draws the pipeline's own solids,
so a hide, a height, a width and a raise arrive as changed geometry, and a slot
or a colour arrives as a NEW `override_N` region carrying its own `slot` and
`colorHex` from `overrideRegionStyle`. `RegionMeshes` draws whatever regions the
store holds, and `interactionHandlers` asks the MESH rather than the region name
whether it carries buildings — a recoloured street is not a hero waiting to be
picked. What this task added is the proof (section 3) and
`overrideLayerByRegion`, which tells the hover resolver which layer an
`override_N` hit came out of without anything inside the canvas reading a
parameter.

## 3. The proof, at the user's own surface

Per `[V3.1-O8]` a passing unit test is not evidence that a feature reached
anyone. `apps/web/e2e/objects.spec.ts` now carries four override tests, all
green against a production build:

| test | what it reads | time |
| --- | --- | --- |
| a filament chosen in the right-click menu reaches the preview | `data-region-versions` gains `override_1` — a mesh replaced ON SCREEN — after a real right-click on a swept-for building in the Chicago fixture | 23 s |
| ...and the same choice reaches the exported file | the downloaded Bambu project: `Metadata/model_settings.config` has a part named `override_1` whose own `extruder` is 3, and `project_settings.config`'s `filament_colour[2]` is `#B00020`, the colour picked in the menu | 4 s |
| the object menu opens on a road from the keyboard | Page Down → the readout says `Road 1 of N`; Shift+F10 opens the menu with `data-inspector-layer="road"`; the focused element is a `menuitem*` inside `role="menu"` with a non-`none` outline; one ArrowRight on the width slider rebuilds the roads region | 17 s |
| an override is one undo step, and the changes counter names it | the changes chip counts one more, its drawer names `Object overrides`, the history drawer names `Building w…: hidden`, Ctrl+Z removes it and Ctrl+Shift+Z brings it back | 4 s |

The default export target is the Bambu project, which writes one object per
region whatever `color_mode` says, so the file test moves no control it is not
about.

## 4. Undo, redo and the changes counter

Both already covered overrides through `setParam` — one `set()` call, one
history entry, one more field differing from the contract — but the history
LABEL and its coalescing key were the array's, not the object's, so two
buildings hidden inside the 800 ms window folded into one undo step and one of
the two hides could not be recovered. `store/history.ts` now keys an override
change by `layer|osm_id` and labels it `Building w123: hidden` (or `… back to
its layer's settings` when the row is dropped), so each object is its own step.

The counter counts an override through `uncontrolledChanges`: the leaves are
real settings with no control IN THE PANEL, which is exactly what the inspector
is — there is no list of every building in a city to put in a group. Reset all
still clears them.

## Known, and not this task's

* **`a11y.spec.ts`'s tab walk is red, on this tree and on a build that predates
  every change here.** The settings column's pinned Output section and the
  search hint intercept pointer events over the group toggles once the list is
  scrolled, so `group-buildings-toggle` cannot be clicked. Verified twice: the
  same interception, on the same locator, against the 03:53 static build. The
  other three a11y tests pass, axe included — 0 violations in both themes across
  five states. Whoever owns the settings column should take the interception.
* The engine unit suites (`lib/engine/**`, and `store/editor.test.ts` where it
  runs the real pipeline) were failing on `surface-overrides: Cannot redefine
  property: buildings` while this was written, from edits landing in
  `pipeline/runner.ts`, `pipeline/stages.ts` and `solid/areas.ts` minutes
  earlier. Nothing in this task touches `lib/engine/`.
* A right-click on the frame, the base or the matting opens the same menu with
  the settings jumps for that region. There is no keyboard route to THAT menu,
  and deliberately: every jump it offers is a settings group the Tab order
  already reaches directly.
