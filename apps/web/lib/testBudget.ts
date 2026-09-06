/**
 * Wall-clock budgets for the vitest suite, expressed against DECLARED hardware.
 *
 * A budget like "the 16k-element Chicago fixture normalises in under 1.5 s" is
 * a claim about a machine as much as about the code. Written as a bare number
 * it silently asserts THIS host's speed wherever it runs, so on a slower box it
 * goes red without anything having regressed -- and a failure that means
 * "GitHub gave us four cores today" teaches nobody anything and trains the team
 * to ignore the row.
 *
 * The Playwright side already solved this. Every spec under `e2e/` scales its
 * waits by `E2E_BUDGET_FACTOR` (default 1; the workflows that run on a hosted
 * runner set 3), so one threshold is written once and read against whatever
 * hardware is executing it. `smoke.spec.ts` even prints the pair -- "budget
 * 1200 ms at factor 3" -- so a reader of the log can tell a slow machine from a
 * slow function.
 *
 * This is that same mechanism for the vitest side: same parse, same default,
 * same rules. It carries its own name because the two runners are started from
 * different jobs and a hosted runner is not equally slower at both (WebGL under
 * SwiftShader and WASM booleans on the CPU are different penalties, measured
 * separately -- see docs/handoff/v3-07-perf.md section 12).
 *
 * The rules, which are the Playwright ones:
 *
 *   * The number written in the test is the LOCAL budget, at factor 1. It is
 *     what a developer runs against, and it does not move because CI is slow.
 *   * The factor is declared where it is set (`.github/workflows/ci.yml`, job
 *     `unit`) and justified by measurement: the ratio between the runner's
 *     readings and this host's for the SAME tests, not whatever makes today's
 *     number fit. The readings behind the committed value are in
 *     docs/handoff/v3-07-perf.md section 12.
 *   * A budget is an order-of-magnitude regression pin, not a stopwatch. On a
 *     slower box raise the FACTOR; never the budget.
 *
 * `|| 1` catches an unset, empty, non-numeric or zero value, so a typo in the
 * workflow falls back to the local budget (red on a slow runner) rather than to
 * `NaN * ms`, which compares false and would quietly pass everything.
 */
export const BUDGET_FACTOR = Number(process.env.VITEST_BUDGET_FACTOR ?? 1) || 1;
