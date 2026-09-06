# v3.1 reach audit - does the feature get to a real user?

Audited against `[V3.1-O8]` and `[V3.1-O11]`: a claim that a feature reaches the
user is accepted only from a test that reads the user-visible surface, or from a
run of the real pipeline that produces the bytes.

**Git state audited.** Started at `af02c98` with 203 dirty files; the tree was
committed under me to `7d02e0e` ("Wave 5-7 checkpoint") at about 18:30 on
2026-09-03. Findings 1, 3 and 4 were re-checked against `7d02e0e` after that
commit and are in COMMITTED code. Finding 2 is in files that were being edited
while I ran (`apps/web/lib/engine/solid/{areas,manifold,repair}.ts`, mtimes
18:27-18:29) and must be re-checked by their owner. `apps/web/e2e/objects.spec.ts`
was also being edited during the audit; the diff I saw splits one test into two
and does not weaken it.

**Method.** Every user-facing control traced from the DOM element that renders
it, through the store, to the pipeline stage that claims the leaf, to the bytes.
Mounting checked at the JSX call site, not at the definition. Where no test read
the surface, I ran the real pipeline through the matrix harness and read the
exported parts.

---

## 1. HIGH - gate V3-1 is RED: no matrix probe for any `object_overrides` leaf

**The missing link.** All eleven `object_overrides[].*` leaves are in
`PRINT_PARAM_LEAF_PATHS` (`apps/web/lib/contracts.ts:934-944`), are claimed by
pipeline stages, and have controls in the viewport inspector - but
`apps/web/lib/engine/pipeline/matrix.probes.ts` has no probe for a single one of
them and `EXEMPT` does not list them. `matrix.test.ts:116` therefore fails.

**Reproduction** (committed tree `7d02e0e`, 0.6 s):

```
cd apps/web && npx vitest run lib/engine/pipeline/matrix.test.ts -t "has one probe per leaf"
```

```
AssertionError: these leaves have neither a probe nor an exemption:
  object_overrides[].osm_id, .layer, .hidden, .height_scale, .hero, .tint,
  .slot, .color, .road_mode, .width_scale, .raise_mm
```

`make gate` runs the whole vitest suite, so the local gate cannot be green as it
stands. `matrix.test.ts` reports "136 probes"; it should be 147.

**Task 11 itself does reach the user.** Rather than assume, I ran the eleven
leaves through `MatrixGroup` (the matrix's own harness) on the `block` scene in
`per_part` mode and read the written 3MF parts. Measured:

| leaf | effect measured on the EXPORTED file |
|---|---|
| `hidden = true` | buildings part 19509.255 → 9078.984 mm3 |
| `height_scale = 0.5` | buildings part 19509.255 → 14345.399 mm3 |
| `hero = "on"` | buildings part 19509.255 → 9078.984 mm3 |
| `slot = 3` | a new `override_1` part appears in the file |
| `color = "#B00020"` | a new `override_1` part appears in the file |
| `width_scale = 2` | roads part 761.685 → 1474.855 mm3 |
| `road_mode = "emboss"` | the road leaves `roads` for `override_1` |
| `tint = "#B00020"` | `result.buildingTints` 0 → 1 (preview and OBJ only, by design) |

So the defect is the missing evidence rung, not a dead feature. Two things stay
genuinely unverified end to end and the probes owed for them are not free:

- `raise_mm` - no matrix scene has a water or green polygon with an id.
  `lib/engine/solid/fixture.ts:area()` takes an optional `osmId` and every call
  in `lib/engine/pipeline/testScenes.ts` omits it, so an override row cannot
  name one. A probe needs a new fixture, not just a table row.
- `osm_id` and `layer` need a base row that already carries an effect (an
  `osm_id` probe over a row with no `hidden`/`height_scale`/… moves nothing,
  correctly), so their probes have to be written against an effect-bearing base.

**Severity.** High, because `[V3.1-O8]` was written for exactly this: Task 11's
docs and `DECISIONS [V3.1-P11-1]` describe the override regions as done, and the
one test suite whose job is to prove each leaf moves both surfaces has no row
for any of them. The e2e (`e2e/objects.spec.ts`) covers `slot`+`color` in the
file and `width_scale`+`hidden` in the preview only; six leaves have no
surface-reading test at all.

## 2. MEDIUM - three geometry unit tests red; re-check, probably in flight

Full `npx vitest run` on the tree as of 18:28: **4 failed, 2310 passed**. One is
finding 1. The other three:

- `lib/engine/solid/synthetic.test.ts:153` "keeps the hole through the solid"  - 
  `7281.282 > 7281.792` expected, off by 0.5 mm3.
- `lib/engine/solid/tiling.test.ts:477` "accounts for every cubic millimetre"  - 
  `snugLoss` is `-6.72e-9`, expected `>= 0`.
- `lib/engine/solid/engine.test.ts:461` "drapes every layer…" - the thin-wall
  detail read the singular branch of `validate.ts:338` ("The narrowest wall
  measures 0.559 mm…") where the test expects the plural ("N places are under
  it"), i.e. the build now finds one thin region where it used to find several.

All three land in `areas.ts` / `repair.ts` / `manifold.ts`, the three files that
were being edited while the suite ran. Not claimed as reach findings; handed to
whoever owns that edit to re-run after it settles.

## 3. LOW - the settings search cannot find the export-format select

`lib/settingsSearch.ts:50` excludes the whole `output` group from the index.
`export_target` is a real `PrintParams` leaf with a real control
(`ExportMenu.tsx`, catalogued as `export_target`), and it is in that group, so
typing "format", "STL" or "OBJ" into the settings search finds nothing. The
control's own help string says the search works "across every group"
(`controlCatalog.ts:1656`) and `README.md:52` says "A search box finds any
control by name". The label and object-override controls are in `output` too and
are equally unfindable, which is defensible (they are placed on an object, not
in a group); the export format is not - it is a settings-panel-shaped choice
that happens to be rendered in the action bar.

**Reproduction.** Open the editor, press `/`, type "format". No hits.

Fix is one of: index `output` and let the hit scroll to the action bar, or
correct both sentences. Either is a decision for the panel/search owner.

## 4. LOW - the build stamp and the About dialog are never read on a page

Task 15's identity surface. `components/editor/SiteFooter.test.tsx` renders with
`renderToStaticMarkup` under the `node` environment, where `buildInfo()` always
returns `0.0.0-unbuilt` with an empty commit (`lib/version.ts`, deliberately), so
nothing asserts that a BUILT page shows a real version, commit and date - the
one thing the stamp exists for. The dialog is rendered as markup but never
opened: no test clicks `about-button`, and no Playwright spec mentions the
footer's stamp or the dialog at all.

The footer's licence obligation is fine: `e2e/search.spec.ts:641-643` reads the
attribution, the Photon credit and the Nominatim credit off the live page.

**Suggested rung**: one assertion in an existing spec that `about-button`'s
`data-build-stamp` matches `/^FrameCraft \d+\.\d+\.\d+ · /`, and one that
clicking it opens `about-dialog`.

---

## What genuinely reaches the user

Checked to the bytes or to the rendered DOM, and found sound:

- **T4 shell.** `ResizableRegions` is mounted at `EditorShell.tsx:340`;
  `e2e/shell.spec.ts` drags the dividers, reloads, hides and maximizes each
  region, and proves the layout travels in a permalink (`:420`) and in a
  `.framecraft` file through the real Save and Load buttons (`:441`).
- **T5 panel.** All eleven parameter groups plus `output` are mounted
  (`ParamPanel.tsx:71-83`); `RegionsGroup` and `BridgesGroup` write through
  `setParam` on every control; `controlCatalog.test.ts` (passing) pins that every
  rendered control has a row, every row names a real leaf, and every leaf a
  control writes is claimed by a stage.
- **T6 action bar.** `e2e/actionbar.spec.ts` covers the cancel path during a
  plate resize, the refusal surface, the progress control and the format select,
  and measures the action row's rectangle across all three states.
- **T10 names and hover.** `e2e/objects.spec.ts` hovers the real solids and reads
  the popover's name and height source; the keyboard route (`Shift+F10`) is
  covered too.
- **T11 overrides.** Reaches the exported file - measured above, and
  `e2e/objects.spec.ts:270-278` reads `name="override_1"` and
  `displaycolor="#B00020FF"` out of the downloaded 3MF.
- **T12 labels.** `LabelsPanel` is mounted at `PreviewPane.tsx:53`, `LabelGizmo`
  at `PreviewScene.tsx:119` with real DOM handles inside drei `<Html>`;
  `e2e/labels.spec.ts` places, cuts, exports, drags, turns, resizes and removes
  one; `matrix.labels.ts` probes all twelve `labels[]` leaves and asserts the
  written buildings/roads part's positions or volume moved, not only the
  sidecar's report.
- **T13 project file and share link.** Both go through `parsePrintParams`;
  `share.ts:215-253` carries all eleven override leaves and all twelve label
  leaves, and `layout` rides as a sibling `l` / `layout` block in both. Unit
  round trips pass and the e2e proves the layout half on a live page.
- **T15 branding.** Footer and About dialog are mounted from the root layout;
  version and commit are inlined by `next.config.ts:59-63` from
  `scripts/version.mjs`. Only the tests are thin (finding 4).
- **T16 README.** Every `docs/assets/*.png` the README references exists.

No control was found that is defined but never mounted, and no
`PRINT_PARAM_LEAF_PATHS` entry was found without either a control or a row in
`controlCatalog.test.ts:CLAIMED_WITHOUT_A_CONTROL`.
