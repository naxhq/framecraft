# v3-04 shell (Task 4: the application shell)

Three resizable regions, either side hideable, the map or the viewport able to
take the whole window, and a layout that travels with the design without ever
becoming a print parameter (DECISIONS `[V3.1-O6]`).

## 1. The region model

`apps/web/lib/layout.ts` owns every rule; the components measure and render and
decide nothing.

| | map | viewport | settings |
|---|---|---|---|
| default width | 400 px (`--spacing-atlas`, 25rem) | the rest | 368 px (`--spacing-rail`, 23rem) |
| minimum | 240 px | 320 px | 288 px |
| maximum | 720 px | none | 560 px |
| collapsible | yes | no | yes |
| maximizable | yes | yes | no |

- **Sizes are pixels, not fractions.** A fraction re-reads as a different
  column on every screen; a pixel is what the user dragged. The two defaults
  mirror the design tokens, and `lib/layout.test.ts` parses those two
  declarations out of `app/globals.css` and fails if the mirror drifts, so the
  token file stays the source of the default.
- **The viewport has no size**, only a minimum: it is whatever the two
  boundaries leave. Hence two boundaries and not three sizes.
- **The fit.** When the row is too narrow, the side regions give the shortfall
  back in proportion to the slack each one has above its own minimum. If both
  are already at their floors the viewport goes under its minimum rather than
  the layout refusing to render. At 1000 px of room the default layout resolves
  to 341 / 320 / 339.
- **Nothing is ever unmounted.** A region that is off screen is `display:none`.
  The map therefore keeps its WebGL context and the viewport keeps its model
  across a maximize and back; MapLibre and react-three-fiber both watch their
  container with a ResizeObserver, and MapLibre's own `_containerDimensions`
  falls back to 400x300 rather than resizing to zero while it is away.
  `display:none` also takes a hidden region's controls out of the tab order,
  which a zero-width column with `overflow:hidden` would not have done.
- **Below `lg` nothing changes.** The map and the preview stack and the
  settings are a bottom sheet, exactly as in v3; every width is applied through
  an `lg:` utility and the dividers, rails and layout controls are `lg` and up.

Components: `components/editor/ResizableRegions.tsx` (the row, the dividers,
the rails, the small-screen sheet) and `components/editor/PaneChrome.tsx` (the
header's four layout toggles, and the rail a hidden column leaves behind).
`EditorShell` keeps the header, the keyboard and the four after-mount effects,
and deliberately does not subscribe to the layout store: a drag writes a width
on every pointer move, and a re-render there would rebuild the three region
elements and take the map and the 3D scene down with them on every frame.

### Controls

| control | testid | what it does |
|---|---|---|
| divider | `layout-handle-map`, `layout-handle-settings` | `role="separator"`, `aria-orientation="vertical"`, `aria-controls` the region, `aria-valuenow/min/max` as whole percentages of the region area, `tabindex=0` |
| hide a side column | `layout-collapse-map`, `layout-collapse-settings` | `aria-pressed`; disabled while a region is maximized, with the reason in the title |
| maximize | `layout-maximize-map`, `layout-maximize-viewport` | `aria-pressed`; the label becomes **Restore** while it holds the window |
| restore a hidden column | `layout-rail-map`, `layout-rail-settings` | a 28 px full-height button standing where the column was |

Divider keys: arrows nudge 16 px, Shift+arrow and Page Up/Down 64 px, Home and
End go to that boundary's two limits, Enter (or Space) resets it, and a
double-click does the same with a pointer. Every accessible name begins with
the words printed on the button (WCAG 2.5.3).

### The settings column's slots

Stated in `EditorShell` and nowhere else: the action bar first, fixed, outside
anything that scrolls, then the panel, which holds the scrolling groups and
pins the results under them. Warnings live in the viewport column
(`WarningBanners`), progress in the action bar's own status slot and in the
viewport's stage overlay. `e2e/shell.spec.ts` measures the action row's
bounding box and the group list's scroll position across a run, an export
refusal and a finished export, and asserts all three are unchanged.

## 2. Persistence

| where | key | holds |
|---|---|---|
| this browser | `framecraft.layout.v1` | the payload below, or nothing at all when the layout is the default (a reset removes the key) |
| a project file | `layout`, a sibling of `params` | the same payload, omitted when default |
| a permalink | `l`, a sibling of `p` | the same payload, omitted when default |

Payload, with every default left out:

```json
{ "map": 512, "settings": 300, "collapsed": ["settings"], "maximized": "viewport" }
```

The store reads `localStorage` in an effect after mount (`hydrateLayout`),
declared before the share-link effect so a link that carries a layout wins over
the one this device happened to have. Sizes are per device on purpose: the
right width for a settings column is a fact about the screen it is read on.

**Loose on purpose.** A layout can never make a link or a file refuse to open:
sizes are clamped rather than rejected, unknown keys are ignored, and a payload
naming nothing usable restores nothing and leaves this browser's layout alone.
That is the opposite of the rule an unknown SETTING gets, and deliberately so
-- a half-applied model is invisible to the user, a layout that stayed put is
not. `decodeShare` and `parseProject` apply the layout themselves, once the
payload is accepted, so a link restores the same way through `loadShared` and
through the recent-designs list, and a project file restores through the Load
button without the button having to know the field exists. `encodeShare`,
`shareUrl` and `buildProject` default their layout argument to what is on
screen for the same reason; passing `null` writes a payload with no layout.

**Not a print parameter.** Nothing above touches `PrintParams`, so it cannot
hash into a pipeline stage, cannot appear in `PRINT_PARAM_LEAF_PATHS` (asserted),
cannot count as a change from default in `lib/settingsDiff.ts`, and is not an
undoable step in `store/history.ts`, which snapshots the editor store alone.

## 3. Shortcuts

Added to `lib/keyboard.ts`, the single source the shortcut sheet renders:

| key | action |
|---|---|
| M | give the map the whole window, or hand it back |
| V | give the 3D preview the whole window, or hand it back |
| `[` | hide the map column, or bring it back |
| `]` | hide the settings column, or bring it back |

All four obey the two standing rules (never inside a typing target, never under
a modifier, so Ctrl+V is still paste) and the overlay rule: nothing acts while
the shortcut sheet, the issues drawer, the adjustments drawer or the history
list is open. Escape is deliberately unchanged -- it still closes the outermost
overlay and otherwise cancels the run in flight, rather than gaining a third
meaning. The sheet also gains one display-only row for the divider keys.

## 4. Tests

| file | tests |
|---|---|
| `lib/layout.test.ts` (new) | 50 |
| `store/layout.test.ts` (new) | 15 |
| `components/editor/ResizableRegions.test.tsx` (new) | 10 |
| `lib/keyboard.test.ts` (+2) | 20 |
| `e2e/shell.spec.ts` (new) | 8 |

`npm run lint` and `npx tsc --noEmit` are clean for every file this task owns.
The 95 unit tests all pass. The e2e spec was written but NOT run here: another
agent held the build lock (a full `--project=chromium` run was in flight
against the static build on :3000), so running it is the orchestrator's.

The e2e spec covers: a pointer drag that survives a reload and a double-click
reset; the divider's ARIA and its six keys; a Tab walk that reaches all six new
controls with a name and a focus ring; a maximize that leaves the MapLibre
canvas node and its GL context in place and the model on screen; both collapse
rails; the settings-column measurement above; and the layout's round trip
through the Copy link button and through the real Save/Load project files.

Two file-scoped additions outside the task's own files, both additive: the two
new components are declared out of scope in `lib/controlCatalog.test.ts`'s
partition (they write no setting), and `lib/keyboard.test.ts`'s list of
documented actions names the four new ones.

## 5. Found, not fixed (not this task's files)

**A project file cannot be loaded back today.** `lib/contracts.ts` now defaults
`schema_version` to 4, and `lib/share.ts`'s `PRINT_PARAM_SPEC` still pins the
literal to `2 | 3`. A project file carries the whole `PrintParams` object, so
it carries `schema_version: 4`, and `parseProject` refuses it with "this
project file's settings is not valid (schema_version must be 2 or 3)". Six
tests in `lib/project.test.ts` are red for this reason, independently of this
task. Share links are unaffected: `paramsDiff` drops a key equal to its
default, so the version never travels in a link. The layout tests here pin
`schema_version: 3` explicitly so they measure the layout and not the settings
contract.
