import { readFileSync } from "node:fs";
import path from "node:path";

import type { Page, Request } from "@playwright/test";

/**
 * Overpass route mocking for the engine e2e suite (FrameCraft v3 E4).
 *
 * Since v3, `apps/web` never calls `services/bake` at all: ingest is a real
 * Overpass fetch made FROM THE BROWSER (`lib/engine/client.ts` -> the engine
 * worker -> `lib/engine/osm/overpass.ts`, one of three mirrors, all matching
 * `**\/api/interpreter`). The e2e suite must not depend on Overpass being
 * reachable or on its content staying stable, so every spec that generates a
 * scene routes this pattern to a committed fixture first.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let chicagoFixtureText: string | null = null;

/** The committed 16k-element Chicago Loop Overpass response (`docs/handoff/v3-02-ingest.md`). */
function chicagoFixtureBody(): string {
  if (chicagoFixtureText === null) {
    chicagoFixtureText = readFileSync(
      path.join(REPO_ROOT, "tests", "fixtures", "overpass-chicago-loop.json"),
      "utf-8",
    );
  }
  return chicagoFixtureText;
}

let tinyFixtureText: string | null = null;

/** A small (30-building), fast, VALIDATOR-CLEAN synthetic response -- see docs/handoff/v3-02-integration.md. */
function tinyLoopFixtureBody(): string {
  if (tinyFixtureText === null) {
    tinyFixtureText = readFileSync(
      path.join(REPO_ROOT, "tests", "fixtures", "overpass-tiny-loop.json"),
      "utf-8",
    );
  }
  return tinyFixtureText;
}

const EMPTY_OVERPASS_BODY = readFileSync(
  path.join(REPO_ROOT, "tests", "fixtures", "overpass-empty.json"),
  "utf-8",
);

const OVERPASS_ROUTE_GLOB = "**/api/interpreter";

/** Route every Overpass mirror call to the committed Chicago Loop fixture, so the "chicago-loop" preset ingests real, stable, offline data. */
export async function mockChicagoOverpass(page: Page): Promise<void> {
  await page.route(OVERPASS_ROUTE_GLOB, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: chicagoFixtureBody() }),
  );
}

/**
 * Route every Overpass mirror call to a small (30-building) synthetic
 * response: comfortably clears 01/A2's 20-building minimum, and -- unlike the
 * full Chicago fixture -- bakes and validates cleanly end to end
 * (`docs/handoff/v3-02-integration.md`'s "known gap" is scale-specific to
 * Chicago's complexity, not this engine's architecture).
 */
export async function mockTinyLoopOverpass(page: Page): Promise<void> {
  await page.route(OVERPASS_ROUTE_GLOB, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: tinyLoopFixtureBody() }),
  );
}

/** Route every Overpass mirror call to an empty response, for 01/A2's low-coverage path. */
export async function mockEmptyOverpass(page: Page): Promise<void> {
  await page.route(OVERPASS_ROUTE_GLOB, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: EMPTY_OVERPASS_BODY }),
  );
}

export interface OverpassCall {
  method: string;
  url: string;
}

/** Record every request this page makes to an Overpass mirror (mocked or not), the closest equivalent of the old server-call watcher. */
export function watchOverpass(page: Page): OverpassCall[] {
  const calls: OverpassCall[] = [];
  page.on("request", (request: Request) => {
    if (/\/api\/interpreter$/.test(new URL(request.url()).pathname)) {
      calls.push({ method: request.method(), url: request.url() });
    }
  });
  return calls;
}
