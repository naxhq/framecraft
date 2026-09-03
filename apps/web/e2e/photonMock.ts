import { readFileSync } from "node:fs";
import path from "node:path";

import type { Page, Request, Route } from "@playwright/test";

/**
 * Photon and Nominatim route mocking for the search e2e suite ([V3-P9]).
 *
 * Neither geocoder may be reached from a test run: CI cannot depend on
 * somebody else's public endpoint being up, and a suite that hammered them
 * would be exactly the behaviour `lib/photon.ts`'s request policy exists to
 * prevent. Every spec that types into the search box routes both hosts to the
 * committed fixtures beside this file first.
 */

const FIXTURES = path.join(__dirname, "fixtures");

export const PHOTON_GLOB = "**/photon.komoot.io/**";
export const NOMINATIM_REVERSE_GLOB = "**/nominatim.openstreetmap.org/reverse**";
export const NOMINATIM_ANY_GLOB = "**/nominatim.openstreetmap.org/**";

let chicagoText: string | null = null;

/** Three results (a city, a road, a building) so every kind badge is exercised. */
export function photonChicagoBody(): string {
  if (chicagoText === null) {
    chicagoText = readFileSync(path.join(FIXTURES, "photon-chicago.json"), "utf-8");
  }
  return chicagoText;
}

export const PHOTON_EMPTY_BODY = JSON.stringify({ type: "FeatureCollection", features: [] });

let parisText: string | null = null;

/** One result 6600 km from the default Chicago pin, for the camera-follow test. */
export function photonParisBody(): string {
  if (parisText === null) {
    parisText = readFileSync(path.join(FIXTURES, "photon-paris.json"), "utf-8");
  }
  return parisText;
}

let reverseText: string | null = null;

function nominatimReverseBody(): string {
  if (reverseText === null) {
    reverseText = readFileSync(path.join(FIXTURES, "nominatim-reverse-chicago.json"), "utf-8");
  }
  return reverseText;
}

export interface PhotonMockOptions {
  /** HTTP status to answer with. Default 200. */
  status?: number;
  /** Response headers, e.g. `{ "Retry-After": "60" }`. */
  headers?: Record<string, string>;
  /** Body to answer with. Default: the Chicago fixture. */
  body?: string;
  /**
   * Hold the answer this long before fulfilling. Used to prove the abort: a
   * request still in flight when the next keystroke lands is the only kind
   * there is anything to abort.
   */
  delayMs?: number;
}

/** Route every Photon call to a fixture. Never reaches the network. */
export async function mockPhoton(page: Page, options: PhotonMockOptions = {}): Promise<void> {
  const status = options.status ?? 200;
  const body = options.body ?? photonChicagoBody();
  await page.route(PHOTON_GLOB, async (route: Route) => {
    if (options.delayMs !== undefined && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    try {
      await route.fulfill({
        status,
        contentType: "application/json",
        headers: options.headers,
        body,
      });
    } catch {
      // The page aborted this request while the handler was sleeping, which
      // is precisely what the abort test is asking for.
    }
  });
}

/**
 * Route the Nominatim reverse lookup the editor shell runs after a pin move.
 *
 * The fixture deliberately names a DIFFERENT place from every Photon fixture
 * ("Cook County", through Nominatim's own city-to-county fallback, against
 * Photon's "Chicago" and "Willis Tower"). If a pick's own name is ever
 * overwritten by the reverse lookup its pin move triggers, the assertion on
 * `#city_label` sees it. Two fixtures that both said "Chicago" hid that bug
 * completely (audit finding 7).
 */
export const NOMINATIM_REVERSE_CITY = "Cook County";

export async function mockNominatimReverse(page: Page): Promise<void> {
  await page.route(NOMINATIM_ANY_GLOB, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: nominatimReverseBody(),
    }),
  );
}

export interface PhotonWatch {
  /** Every Photon URL the page asked for, in order. */
  requests: string[];
  /** Every Photon URL whose request failed, with the browser's own reason. */
  failed: Array<{ url: string; reason: string }>;
}

function isPhoton(request: Request): boolean {
  return new URL(request.url()).hostname === "photon.komoot.io";
}

/**
 * Record every Photon request this page starts and every one that ends without
 * an answer. A superseded request shows up in `failed` with Chromium's
 * `net::ERR_ABORTED`, which is the observable proof that the client actually
 * cancelled it rather than quietly ignoring the reply.
 */
export function watchPhoton(page: Page): PhotonWatch {
  const watch: PhotonWatch = { requests: [], failed: [] };
  page.on("request", (request: Request) => {
    if (isPhoton(request)) watch.requests.push(request.url());
  });
  page.on("requestfailed", (request: Request) => {
    if (isPhoton(request)) {
      watch.failed.push({ url: request.url(), reason: request.failure()?.errorText ?? "unknown" });
    }
  });
  return watch;
}

/** Record every Nominatim request, so "the type-ahead never touches it" is checkable. */
export function watchNominatim(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request: Request) => {
    if (new URL(request.url()).hostname === "nominatim.openstreetmap.org") {
      urls.push(request.url());
    }
  });
  return urls;
}
