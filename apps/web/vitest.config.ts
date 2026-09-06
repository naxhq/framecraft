import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the `@/*` path alias from tsconfig.json so unit tests import the
    // same specifiers the app does.
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**", "e2e/**"],
    // `testTimeout` is deliberately NOT set here: vitest's 5 s default is what
    // the great majority of these 2 300-odd tests should be judged against, and
    // raising it globally would buy the handful of WASM-heavy builds their
    // headroom by giving every genuinely hung test that much longer to hang.
    // The ~130 places that need more say so themselves, as the trailing
    // argument to `it(...)` / `beforeAll(...)`, with the reason written next to
    // the number.
    //
    // Wall-clock ASSERTIONS -- the rows that read `expect(elapsed).toBeLessThan`
    // -- are a separate thing again: they scale with `VITEST_BUDGET_FACTOR`
    // (`lib/testBudget.ts`), the vitest sibling of the `E2E_BUDGET_FACTOR` every
    // spec under `e2e/` already uses. Default 1, so the number written in the
    // test is the local budget; `.github/workflows/ci.yml`'s `unit` job sets the
    // factor its runner measured. Raise the FACTOR for a slow box, never the
    // budget. The readings behind the committed value: docs/handoff/v3-07-perf.md
    // section 12.
  },
});
