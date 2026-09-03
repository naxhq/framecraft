/*
 * FrameCraft service worker.
 *
 * WHY IT EXISTS. The site is a static export on GitHub Pages, and Pages sends
 * `Cache-Control: max-age=600` on EVERY response, content-hashed
 * `_next/static/**` chunks included (measured, `docs/handoff/v3-00-baseline.md`
 * section 1.5). There is no per-path header control on Pages, so a visitor
 * returning more than ten minutes later revalidates all 33 resources and pays
 * the round trips again. A service worker is the only cache lifetime this app
 * can set for itself.
 *
 * STRATEGY, one line each:
 *
 *   documents (navigations)   network first, cached copy as the offline
 *                             fallback. NEVER cache-first: a Pages deploy
 *                             REPLACES the whole tree, so an HTML served from
 *                             cache could name chunk URLs that no longer
 *                             exist on the origin.
 *   /_next/static/**          cache first, forever. The URLs carry a content
 *                             hash, so a hit can never be stale, and a new
 *                             build simply asks for different URLs.
 *   /presets/<sha1>.json.gz   cache first, forever, in its own small cache.
 *                             Content-addressed by the Overpass query sha1
 *                             and about 1.7 MB each, so they get their own
 *                             entry cap instead of crowding the chunk cache.
 *   /manifold/**, /maplibre/**, /icon.svg, /favicon.ico
 *                             stale while revalidate. Stable URLs whose bytes
 *                             change only when a dependency does, so serve the
 *                             cached copy and refresh it in the background.
 *   everything else           untouched. Cross-origin requests (OSM tiles,
 *                             Overpass mirrors, Photon, Nominatim) never reach
 *                             a handler here, and neither does any non-GET.
 *
 * UPDATES. `lib/serviceWorker.ts` registers this file as `sw.js?v=<build id>`,
 * so a new deploy is a new script URL, which installs a new worker. While the
 * old worker still controls open tabs the new one sits in `waiting`, and the
 * page shows a "reload to update" affordance. A 404 on a `_next/static`
 * request (the mid-session deploy case: the old build's chunks are gone from
 * the origin) posts the same message, because that page really is running a
 * build the origin no longer serves. The stale-while-revalidate cache is named
 * after the build id as well, so activating a new worker retires the previous
 * build's copies of the stable-URL assets instead of leaving a visitor one
 * deploy behind on them until a second visit.
 *
 * GETTING RID OF THIS THING. `?sw-off` on any page of the site unregisters
 * every worker on the origin and deletes every `framecraft-` cache, and
 * remembers the choice, so a bad worker can be retired without a deploy and
 * without waiting for a cache lifetime. `?sw-on` puts it back. The switch
 * lives in `lib/serviceWorker.ts` because it has to work when THIS file is
 * the broken part; RUNBOOK.md section 8 is where it is written down for
 * whoever is looking at a broken deploy.
 *
 * This file is served verbatim from `public/`; it is not bundled, not
 * TypeScript, and eslint ignores `public/**`. Its behaviour is pinned by
 * `lib/serviceWorkerScript.test.ts`, which runs THESE bytes in a sandbox, and
 * by `e2e/siteperf.spec.ts`, which runs them in a browser.
 */

/* global self, caches, clients, fetch, Response, URL */

const SCHEMA = "v1";

/** The build id `lib/serviceWorker.ts` put on the registration URL, or "" in a hand-registered worker. */
const BUILD_ID = new URL(self.location.href).searchParams.get("v") ?? "";

const CHUNK_CACHE = `framecraft-immutable-${SCHEMA}`;
/*
 * The ONE cache keyed by the build id, and the only one that may be.
 *
 * `/_next/static/**` and `/presets/<sha1>.json.gz` are keyed by their own
 * CONTENT -- a webpack content hash, an Overpass query sha1 -- so a deploy
 * asks for different URLs and an old entry is unreachable rather than stale.
 * Keying those caches by the build id would throw away a perfectly good copy
 * on every deploy, which is the opposite of what this worker is for.
 *
 * `/manifold/**`, `/maplibre/**` and the icons have STABLE URLs whose bytes
 * change when a dependency does, and they are stale-while-revalidate, so
 * without a build id in the name a visitor runs one deploy behind on the
 * MapLibre worker pair until a second visit. Putting the build id here retires
 * them with the build that produced them; the `activate` sweep below is what
 * deletes the previous build's copy, because it is a `framecraft-` cache that
 * is no longer in `KNOWN_CACHES`.
 */
const STATIC_CACHE = `framecraft-static-${SCHEMA}-${BUILD_ID}`;
const PRESET_CACHE = `framecraft-presets-${SCHEMA}`;
const DOCUMENT_CACHE = `framecraft-documents-${SCHEMA}`;
const KNOWN_CACHES = [CHUNK_CACHE, STATIC_CACHE, PRESET_CACHE, DOCUMENT_CACHE];

/*
 * Entry caps, not byte caps: `caches` has no size API, so the only budget a
 * worker can enforce is a count. A build ships 31 .js files, so 240 chunk
 * entries is roughly seven deploys' worth of hashed URLs before the oldest is
 * dropped, and dropping it costs one refetch. Presets are ~1.7 MB each and a
 * user visits at most a few, so three is a session's worth.
 */
const MAX_CHUNK_ENTRIES = 240;
const MAX_PRESET_ENTRIES = 3;
const MAX_STATIC_ENTRIES = 24;
const MAX_DOCUMENT_ENTRIES = 4;

const UPDATE_MESSAGE = "framecraft:update-ready";
const SKIP_WAITING_MESSAGE = "framecraft:skip-waiting";
const WARM_MESSAGE = "framecraft:warm";

/** The path this worker is scoped to, always with a trailing slash ("/" or "/framecraft/"). */
const SCOPE_PATH = new URL(self.registration.scope).pathname;

/** Strip the scope prefix, so every matcher below is written against the root-relative path. */
function scopedPath(url) {
  const { pathname } = url;
  if (SCOPE_PATH !== "/" && pathname.startsWith(SCOPE_PATH)) {
    return pathname.slice(SCOPE_PATH.length - 1);
  }
  return pathname;
}

function isChunk(path) {
  return path.startsWith("/_next/static/");
}

function isPresetAsset(path) {
  return /^\/presets\/[0-9a-f]{40}\.json\.gz$/.test(path);
}

function isRevalidatingStatic(path) {
  return (
    path.startsWith("/manifold/") ||
    path.startsWith("/maplibre/") ||
    path === "/icon.svg" ||
    path === "/favicon.ico"
  );
}

/** Drop the oldest entries once a cache is over its cap. `cache.keys()` is in insertion order. */
async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) {
    await cache.delete(keys[i]);
  }
}

async function putAndTrim(cacheName, request, response, max) {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  await trim(cache, max);
}

async function tellClients(message) {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of all) client.postMessage(message);
}

/**
 * Cache first. A hit is returned without touching the network; a miss is
 * fetched, stored and returned. Only 200 responses are stored: a 404 from a
 * deploy that removed the old build's chunks must never become a cache entry.
 */
async function cacheFirst(request, cacheName, max) {
  const cached = await caches.match(request, { cacheName });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.status === 200) {
    await putAndTrim(cacheName, request, response.clone(), max);
  } else if (response.status === 404 && isChunk(scopedPath(new URL(request.url)))) {
    // The origin no longer serves this build's chunks: a deploy landed while
    // this page was open. The page cannot recover on its own.
    await tellClients({ type: UPDATE_MESSAGE, reason: "missing-chunk", buildId: BUILD_ID });
  }
  return response;
}

/**
 * Serve the cached copy at once and refresh it in the background; on a miss,
 * wait for the network.
 *
 * The refresh is handed to `event.waitUntil` rather than left to run loose.
 * A worker terminated between returning the cached copy and the `cache.put`
 * would otherwise leave the entry stale, and because the next hit takes this
 * same path and returns just as early, it could stay stale for as long as the
 * page is never open long enough to finish one. `waitUntil` is what keeps the
 * worker alive until the put lands.
 */
async function staleWhileRevalidate(event, request, cacheName, max) {
  const cached = await caches.match(request, { cacheName });
  const network = fetch(request)
    .then(async (response) => {
      if (response.status === 200) {
        await putAndTrim(cacheName, request, response.clone(), max);
      }
      return response;
    })
    .catch(() => null);
  event.waitUntil(network);
  if (cached) return cached;
  const response = await network;
  if (response) return response;
  return new Response("offline", { status: 504, statusText: "offline" });
}

/** Network first, cached document as the offline fallback. */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.status === 200) {
      await putAndTrim(DOCUMENT_CACHE, request, response.clone(), MAX_DOCUMENT_ENTRIES);
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request, { cacheName: DOCUMENT_CACHE });
    if (cached) return cached;
    throw err;
  }
}

/** Which cache a path belongs in, and its cap, or null for a path this worker does not hold. */
function bucketFor(path) {
  if (isChunk(path)) return { cacheName: CHUNK_CACHE, max: MAX_CHUNK_ENTRIES };
  if (isPresetAsset(path)) return { cacheName: PRESET_CACHE, max: MAX_PRESET_ENTRIES };
  if (isRevalidatingStatic(path)) return { cacheName: STATIC_CACHE, max: MAX_STATIC_ENTRIES };
  return null;
}

/**
 * Adopt assets the page already loaded, on the load that first registered this
 * worker.
 *
 * A worker does not see the requests of the page that registered it: it is not
 * controlling that page yet. Without this, the first CACHE HIT would be on the
 * third navigation (nav 2 populates, nav 3 hits). `lib/serviceWorker.ts` sends
 * the page's own Resource Timing URLs the moment the worker is in control, and
 * they are still inside Pages' 600 s freshness window, so adopting them
 * normally transfers nothing at all: it converts a ten-minute HTTP cache
 * lifetime into a permanent one.
 */
async function warm(urls) {
  await Promise.all(
    urls.map(async (raw) => {
      let url;
      try {
        url = new URL(raw, self.location.href);
      } catch {
        return;
      }
      if (url.origin !== self.location.origin) return;
      const bucket = bucketFor(scopedPath(url));
      if (bucket === null) return;
      const existing = await caches.match(url.href, { cacheName: bucket.cacheName });
      if (existing) return;
      try {
        const response = await fetch(url.href);
        if (response.status === 200) {
          await putAndTrim(bucket.cacheName, url.href, response, bucket.max);
        }
      } catch {
        // A warm is an optimisation; a failed one changes nothing.
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  /*
   * Nothing is precached, and `skipWaiting` is NOT called here. Two reasons,
   * in order of weight. A new worker must WAIT while an older one controls
   * open tabs, because that is the state the "reload to update" affordance
   * reports; taking over silently would remove the only moment the page can
   * tell the user a new build exists. And a first-ever registration activates
   * immediately anyway, since there is no worker to wait for.
   */
  event.waitUntil(Promise.resolve());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("framecraft-") && !KNOWN_CACHES.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data.type !== "string") return;
  if (data.type === SKIP_WAITING_MESSAGE) {
    self.skipWaiting();
    return;
  }
  if (data.type === WARM_MESSAGE && Array.isArray(data.urls)) {
    event.waitUntil(warm(data.urls));
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  // Same-origin only. Tiles, Overpass, Photon and Nominatim are somebody
  // else's cache policy and this worker has no business in them.
  if (url.origin !== self.location.origin) return;
  // A ranged request must reach the network: a cached full response would be
  // the wrong answer to a 206.
  if (request.headers.has("range")) return;

  const path = scopedPath(url);

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(networkFirst(request));
    return;
  }
  if (isChunk(path)) {
    event.respondWith(cacheFirst(request, CHUNK_CACHE, MAX_CHUNK_ENTRIES));
    return;
  }
  if (isPresetAsset(path)) {
    event.respondWith(cacheFirst(request, PRESET_CACHE, MAX_PRESET_ENTRIES));
    return;
  }
  if (isRevalidatingStatic(path)) {
    event.respondWith(staleWhileRevalidate(event, request, STATIC_CACHE, MAX_STATIC_ENTRIES));
  }
});
