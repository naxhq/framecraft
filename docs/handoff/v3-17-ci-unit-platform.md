# v3.1 CI: the two unit failures that were platform, not speed

Run `34034936993` (push of `03949f9`, ubuntu-latest, Node 22) failed the
`unit (vitest)` job on four tests while the same suite passed on the Windows
development host (Central Time, Node 26). Two of the four were wall-clock
budgets on a slower runner and are handled elsewhere. The other two were
behavioural and are recorded here, with the evidence, because both had been
read as "CI is flaky" and neither was.

## 1. `export/tiles.test.ts` — the single-plate Bambu hash

**Symptom.** `writes exactly the bytes it wrote before tiling existed`:
expected `bca6c6aa…` (the pin), CI produced `b68e0835…`. Same commit, same
fixture, same fflate 0.8.3 from the same lockfile.

**Cause.** The bytes were a function of the host's timezone. fflate writes the
MS-DOS timestamp of every zip entry from the Date's *local* fields
(`getFullYear`, `getMonth`, `getDate`, `getHours`, …; `fflate/lib/index.cjs`
line 1889). `zipEntries` handed it a UTC instant — the test's `CREATED`,
`2026-01-01T00:00:00Z` — which is `2025-12-31 18:00:00` on a Central Time
clock and `2026-01-01 00:00:00` on a UTC one, and the difference is written
into all 22 local-header and central-directory stamps in the file. Nothing in
the model, the metadata, the mesh, the plate or the config parts differed.

**Evidence.**
- With the old writer, `TZ=UTC npx vitest run lib/engine/export/tiles.test.ts`
  on the Windows host produces `b68e0835…` exactly — CI's number — while the
  same command in the host's own zone produces the pin. Same machine, same
  Node, one variable.
- Every pin in that test's history (`7e4d0580`, `7b82383f`, `42c5cd56`,
  `bca6c6aa`) was taken on this Central Time host. CI never agreed: the
  2026-09-02 run (`33611314264`) shows the same `×` on this test in its log;
  the job was green because `npm test 2>&1 | tee vitest.log` masked vitest's
  exit code. The v3-14 workflow gates properly, which is why it surfaced now.

**Fix.** `lib/engine/export/zip.ts` stamps the entries itself, from the UTC
fields, by overwriting the time/date words in every local header and central
directory entry after `zipSync` (`dosStamp`, `stampEntries`; a `readStamps`
reader beside them so a test can check what was written without trusting the
writer). No shifted-Date trick: that would still differ in a host zone whose
spring-forward gap contained the instant's UTC wall time.

**Verification of the new pin, on both sides.** The number is now
`b68e0835…`, which is (a) what CI computed natively on ubuntu/UTC/Node 22,
(b) what this host computes in Central Time after the fix, and (c) what this
host computes under `TZ=UTC` after the fix. `zip.test.ts` pins the invariant
by construction: it switches `process.env.TZ` through UTC, America/Chicago,
Asia/Kolkata, Pacific/Kiritimati and Pacific/Pago_Pago — asserting first that
the switch took (the local hour of the default mtime reads 0, 18, 5, 14, 13)
— and requires identical bytes and a decoded stamp of `2000-01-01 00:00:00`
in every zone. `tiles.test.ts` additionally decodes every header of the
pinned file to `2026-01-01 00:00:00`, so a zone-dependent writer fails there
even on a host whose zone happens to match the pinning machine's.

## 2. `components/editor/Controls.test.ts` — zero Overpass calls

**Symptom.** `probes the bundled preset manifest once per realm, not once per
preview`: the assertion that failed (line 303) is `overpassCalls(fetchSpy)`
having length 1 — CI saw `[]`. The manifest count never got to run. Not a
case-sensitivity or fetch-mock difference: the manifest probe itself fired
(the priming assertion two lines up passed).

**Cause.** The previous test's abandoned pipeline run was still holding the
realm's one `PipelineSession`. `store.generate()` posts a run to a
module-level `PipelineClient` (inline transport under vitest); a run arriving
while another is in flight is queued and the running one is asked to stop
*at its next stage boundary* (`protocol.ts:enqueue`, `runner.ts` checks
`aborted()` between stages). `cancelPipeline()` in `afterEach` posts that
cancel, and the client rejects the store's promise immediately — but the
session stays busy until the running stage ends, and on the realm's first run
that includes the manifold WASM load. Two host-speed-dependent things then
decided the outcome:

1. Whether the old run had reached a boundary by the time the next test's
   commit-gate timer fired. If not, the next run was queued and its `fetch`
   stage — the Overpass request under test — had not started when the
   assertion ran.
2. Whether the old run's next inter-stage yield (`runner.ts:yieldToEventLoop`,
   `setImmediate` in Node) was scheduled while the suite's fake clock was
   installed. Vitest fakes `setImmediate` by default; a fake one fires only on
   a clock advance, and `vi.useRealTimers()` discards pending fake timers
   unfired. A run parked there never reaches the abort check, the session is
   busy for the rest of the file, and every later run queues forever.

**Evidence.** A diagnostic copy of the suite (deleted, not committed) with a
wrapper logging every fake timer scheduled: at teardown the abandoned run was
mid-`context`, with a fake `setImmediate` from `runner.ts:441` pending; after
`useRealTimers()` the next test's run stayed queued (`pipeline.progress.stage`
empty, 0 Overpass calls after the tick and still 0 after 3 s of real time).
Forcing the condition needs only 50 ms of real time passing before teardown
— reproducible on this Windows host at will, so it is not Linux.

**Fix.** Test-side, in `Controls.test.ts`: fake only the timers the suite
measures (`setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`Date`,
not `setImmediate`), so the engine's yields are never parked on a clock the
test throws away; and in `afterEach`, after the cancel, `await
whenSessionsIdleForTest()` so every test starts on an idle session and a run
that cannot stop fails the hook loudly instead of leaking. That seam is new in
`lib/engine/protocol.ts` (beside `resetOverpassCacheForTest`): a session
records idle waiters and resolves them when it has neither a running nor a
queued job. No product behaviour changed: superseding at the next stage
boundary is by design and correct in a Worker; the hazard exists only where a
test fakes the timers the engine yields on. With the fix, the forced 50 ms
condition passes (1 Overpass call, 1 manifest call) and the real suite passes
three consecutive runs.

## What was not done

No threshold, pin or assertion was weakened. The pin moved once, to the
value both platforms now produce, with the reasoning in the test's own
comment. `DECISIONS.md` was not edited (orchestrator's call).
