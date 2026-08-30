# FAILURES

Defects found by a gate or a test, written down instead of papered over.
Owner = the phase whose files must change. qa-gate does not modify application
code; it reports.

Format: one section per defect, newest last. Status: OPEN / FIXED (by whom).

---

## F1 — `npx tsc --noEmit` fails in `apps/web/lib/warnings.test.ts`

- **Found by**: P5 qa-gate, while type-checking the new `e2e/smoke.spec.ts`
  against the project's own `tsconfig.json`.
- **Owner**: web-editor (the file is a P5-web vitest test).
- **Severity**: low. It does **not** break `make gate`: `next build` type-checks
  only the app graph, `eslint .` is not type-aware, and vitest transpiles
  without checking. So this is a latent error that a stricter CI step (or an
  editor) surfaces, not a runtime or gate failure.
- **Status**: FIXED by P6 fixer (2026-08-29). The cast in `lib/warnings.test.ts`
  now takes the double hop (`as unknown as Record<string, unknown>`); the
  assertion is unchanged. To stop the class of error from coming back,
  `apps/web/package.json` gained `"typecheck": "tsc --noEmit"` and `make gate`
  step 2 now runs `npm run lint && npm run typecheck && npm test && npm run
  build`, so a type error anywhere in the project (tests, e2e specs, unreached
  modules) fails the gate instead of only showing up in an editor.
  Verify: `cd apps/web && npm run typecheck` -> rc 0.

Failing command (from `apps/web`), before the fix:

```
$ npx tsc --noEmit
lib/warnings.test.ts(179,8): error TS2352: Conversion of type 'PrintParams' to type 'Record<string, unknown>' may be a mistake because neither type sufficiently overlaps with the other. If this was intentional, convert the expression to 'unknown' first.
  Index signature for type 'string' is missing in type 'PrintParams'.
$ echo $?
2
```

The line is the `(moved as Record<string, unknown>)[key] = ...` write inside
`describe("warningDeps")`. TypeScript wants the double step
(`as unknown as Record<string, unknown>`) because `PrintParams` has no index
signature. The assertion the test makes is correct and must not be weakened;
only the cast needs the extra hop.

---

## F2 — `e2e/ui.spec.ts` asserted a premise `[V2-P5-fix]` had already deleted

- **Found by**: V2-P7 qa-gate, on the first authoritative `make gate` of the
  phase (2026-08-30).
- **Owner**: qa-gate (the file is a Playwright spec, which this phase owns).
  **No application code is at fault** — the app is behaving exactly as
  `[V2-P5-fix]` specified.
- **Severity**: gate-breaking. In `test.describe.configure({ mode: "serial" })`
  a failure takes the rest of the file with it, so this one assertion cost 13
  of the 25 acceptance tests (1 failed, 12 not run, reported as skipped).

Failing command and output:

```
$ make gate
...
  ✘  13 [chromium] › e2e\ui.spec.ts:259:5 › an engraving appears on the frame, and a refused one does not (18.7s)

    Error: expect(locator).toContainText(expected) failed
    Locator: getByTestId('engraving_0-fit')
    Expected substring: "Not cut"
    Received string:    "Cuts at 4.00 mm."
      at D:\VahidVibeProject\CityDesign3D\apps\web\e2e\ui.spec.ts:282:25

  1 failed
  12 did not run
  12 passed (3.0m)
gate: the Playwright suite FAILED
gate: 12 Playwright test(s) SKIPPED - the gate does not accept a skipped acceptance test
GATE FAIL
```

Diagnosis: the test got its refusal *for free* from the contract default. It
added an engraving row, took whatever cap height the contract seeded it with,
and asserted the panel said "Not cut". `[V2-P5-fix]` then raised
`engravings[].size_mm` from 3.0 mm to 4.0 mm **precisely so that a freshly
seeded engraving is printable** ("at 3.0 mm the DEFAULT face refuses six of the
eight" real strings). Measured against the shared math on this tree:

```
$ cd services/bake && uv run python -c "...lettering_layout for '{city}'='Chicago'..."
  2.0 refused=True    3.0 refused=True    3.25 refused=False
  4.0 refused=False   6.0 refused=False (fitted down to 5.16 mm)
```

So "Chicago" at the new 4.0 mm default cuts, and the test's whole premise was
gone. It had quietly turned into "the default is refused", which is the
opposite of what the contract now promises.

- **Status**: FIXED by V2-P7 qa-gate. The spec no longer infers the refused
  size: it now (1) **pins the new default** — `engraving_0_size_mm-value` reads
  `4.0 mm` and the verdict reads `Cuts at`, with rings drawn — then (2) sets
  3 mm explicitly, the old default, and requires `Not cut` **and the rings to
  go back to 0**, then (3) raises to 6 mm and requires exactly 8 rings again.
  That is strictly more coverage than before: the preview is now proved to take
  the letters *off* the plate when the verdict flips, not merely never to have
  put them on. Verify: `cd apps/web && npx playwright test --grep "an engraving
  appears on the frame"` -> 1 passed.
- **Note for whoever reads the V2-P6 handoff**: its "25 e2e, 0 skipped" was
  recorded against the pre-`[V2-P5-fix]` contract default. Nothing regressed
  between then and now; the two facts were just never re-checked together.

---

## Not defects (checked, and they hold)

Recorded here so the next phase does not re-investigate them:

- `GET /files/<name>.3mf` answers `application/octet-stream` (Python's
  `mimetypes` has no entry for `.3mf`, and Starlette 1.6's `FileResponse`
  falls back to octet-stream, not `text/plain`). The e2e asserts the content
  type is either that or the 3MF media type, and it passes.
- Baking Chicago with the sliders the smoke test moves (plate 200 mm, large
  building scale 120 %, base 4 mm) passes every validator: 200.000 x 200.000 x
  46.613 mm, min wall 0.829 mm, 75 886 triangles.
- `make validate` on a file whose PrintParams differ from the contract defaults
  FAILS `bounding_box` unless the bake's `<stem>.json` sidecar (or
  `--plate-mm`) tells it the plate size. That is the validator working, not a
  bug; the smoke test downloads the sidecar next to the `.3mf` for exactly this
  reason.
