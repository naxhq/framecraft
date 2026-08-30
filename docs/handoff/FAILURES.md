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
