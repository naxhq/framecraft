# v3-08 site performance: what the deployed site pays, and what it stops paying

Task 8 of the v3.1 run, against the measured baseline in
`docs/handoff/v3-00-baseline.md` Part B. Written after the fact, from the code
as it stands at the Wave 3 checkpoint `af02c98`: the agent that built this was
interrupted before it wrote anything down, so this note is a reading of the
tree plus measurements taken to close it, not a report from the author.

New files: `apps/web/public/sw.js`, `apps/web/lib/serviceWorker.ts` (+ its
tests), `apps/web/scripts/bundle-preset-assets.mjs`,
`apps/web/scripts/precompress.mjs`. Changed: `next.config.ts`,
`app/layout.tsx`, `app/page.tsx`, `lib/engine/osm/overpass.ts`,
`scripts/serve-static.mjs`, `.github/workflows/pages.yml`.

## 1. The hypotheses, and what the baseline decided

Every row is the baseline's own verdict (`v3-00-baseline.md` section 4), with
the deciding number, plus what this task did about it.

| Hypothesis | Verdict | Deciding number | What Task 8 did |
|---|---|---|---|
| WASM shipped uncompressed | **Ruled out** | `manifold.wasm` arrives `Content-Encoding: gzip`, 207 042 B on the wire against 541 470 B decoded (2.62:1) | nothing, correctly |
| No long cache lifetime on hashed assets | **Confirmed** | every response, content-hashed chunks included, carries `Cache-Control: max-age=600`, the same lifetime as the index HTML | the service worker, section 2 |
| Large eager chunks | **Confirmed** | 947 671 B of JS transfer and 3 356 322 B decoded across 19 files before the user touches anything | chunk splitting, section 3 -- which changes WHICH FILE, not how many bytes |
| No code splitting around the worker | **Ruled out for the heavy part** | the engine worker entry (36 820 B) loads at page load, but `manifold.wasm` (541 470 B) and the glyph tables (80 417 B) load only on the first build | nothing |
| Overpass live per user | **Confirmed, and dominant** | every preset click issues a live 842 B POST; 3 of 8 attempts got 504 after ~10 s, and 2 of 5 deployed flows never produced a preview within 180 s | bundled preset assets, section 4 |
| Cold-start work the desktop build skips | **Confirmed, quantified** | desktop skips 1 300 596 B of transfer plus the 207 042 B WASM fetch | out of scope here |

Two of the baseline's five qualifying notes bound what any of this can
achieve. **The cache lifetime is not fixable from inside the app**: GitHub
Pages sets `max-age=600` on everything and offers no per-path header control,
so the only cache lifetime this app can set for itself is a service worker's.
**Brotli is decided by the host too**: Chromium offers `br` and Pages answers
`gzip`, worth about 18 % of the JS and 23 % of the WASM, and shipping
precompressed files changes nothing there because Pages ignores them.

And the ordering that matters: **Overpass dominates the user-visible number by
an order of magnitude.** The median deployed preset-to-stats-card time was
43 845 ms, of which the Overpass round trip alone was 8 455 to 32 391 ms.
Nothing else measured is within a factor of ten of that, which is why the
bundled preset assets are the substance of this task and the byte work is the
tidying.

## 2. The service worker

`public/sw.js` (333 lines, served verbatim from `public/`, not bundled) and
`lib/serviceWorker.ts` (544 lines, the page half). The split exists because a
service worker must be a top-level file at the scope it controls, while the
decisions around it -- whether to register, what URL, which assets to hand
over, what to put on screen when a new build is waiting -- are ordinary
testable code.

Policy, one line each:

| Path | Strategy | Why |
|---|---|---|
| navigations | network first, cached copy as the offline fallback | a Pages deploy REPLACES the whole tree, so an HTML served from cache could name chunk URLs the origin no longer has |
| `/_next/static/**` | cache first, forever | the URLs carry a content hash, so a hit can never be stale and a new build simply asks for different URLs |
| `/presets/<sha1>.json.gz` | cache first, forever, own cache | content-addressed by the Overpass query sha1 and ~1.7 MB each, so they get their own entry cap rather than crowding the chunk cache |
| `/manifold/**`, `/maplibre/**`, `/icon.svg`, `/favicon.ico` | stale while revalidate | stable URLs whose bytes change only when a dependency does |
| everything else | untouched | cross-origin (OSM tiles, Overpass mirrors, Photon, Nominatim) never reaches a handler, and neither does any non-GET |

Caps are entry counts, not byte counts, because `caches` has no size API: 240
chunks (about seven deploys' worth), 3 presets, 24 revalidating statics, 4
documents, oldest dropped first.

**Registration is production-only and permanent about it.** `next dev` serves
`_next/static` chunks whose URLs are NOT content-hashed, so a cache-first rule
would answer an edited chunk with the previous one and break Fast Refresh.
`shouldRegister` requires a service worker, a secure context,
`NODE_ENV !== "development"` and **not the desktop shell**.

That last clause was missing when this task was interrupted, and it was the
audit's blocker B1. `apps/desktop/src-tauri/tauri.conf.json` points
`frontendDist` at `apps/web/out`, so Tauri ships this exact static export with
`sw.js` in it, runs the production build, and serves it over a protocol
WebView2 treats as a secure context. Every other clause therefore passes
inside the app, and the worker installed there and began intercepting the
shell's own asset reads for nothing: the desktop bundle reads its files off
local disk, with no network round trip to save and no cache lifetime to
extend. All a worker added was a second copy of the bundle in Cache Storage
and a class of bug that could only be cleared from inside the app.
`isDesktopShell` is now part of `RegistrationEnvironment`, checked first, and
pinned by a test that refuses the shell with every other clause set to its
most favourable value.

**The kill switch: `?sw-off`.** This was the audit's B2, and it exists because
a cache-first worker is not an ordinary bug. The broken worker is the thing
serving the page, so a fix reaches a visitor only if the worker it replaces
lets it through. `?sw-off` needs no deploy: it unregisters every worker on the
origin, deletes every cache whose name starts with `framecraft-`, and
remembers the choice in `localStorage`, so the following navigation stays
clean once the query string is gone. `?sw-on` puts it back. Two details that
are the point rather than decoration:

- **It remembers.** A switch that only read the query string would be undone
  by the visitor's next click, which is the moment they most need it to hold.
- **It deletes only our own caches.** A Pages user site can host more than one
  app on one origin, and the other app's storage is not this switch's to
  remove.

It is documented in `RUNBOOK.md` section 8, which is where somebody looking at
a broken deploy will actually look.

**The update flow** turns on the registration URL carrying the build id.
`next.config.ts` inlines `NEXT_PUBLIC_BUILD_ID` (the short commit sha, or a
timestamp where git is unavailable, or an override from the environment), and
the page registers `sw.js?v=<build id>`. The worker's own bytes rarely change,
so a bare path would leave a visitor on the worker they installed months ago;
a new build id is a new script URL, which installs a new worker and parks it
in `waiting` while the old one still controls open tabs. That state raises a
token-built "A newer version of FrameCraft is ready" line with Reload and
Later, created imperatively rather than in a component because an update can
land before React has mounted, and idempotent so a second call does not stack
a second line. A 404 on a `_next/static` request posts the same message: that
page really is running a build the origin no longer serves.

**The warm-up** is the non-obvious part. A worker does not see the requests of
the page that registered it, because it is not controlling that page yet, so
without help the first cache HIT would be on the third navigation. The page
hands the worker its own Resource Timing URLs (same-origin, capped at 120) the
moment the worker is in control, and the worker fetches only the ones its own
`bucketFor` claims. Inside Pages' 600 s freshness window those fetches
normally transfer nothing at all: the warm-up converts a ten-minute HTTP cache
lifetime into a permanent one.

## 3. Chunk splitting

`next.config.ts` pins two webpack cache groups, production client build only:
`maplibre-gl` to `vendor-maplibre`, `three` and `@react-three` to
`vendor-three`.

It does **not** make the page load fewer bytes in any sense the `next build`
report can see, and the config now says that with numbers rather than in
prose. Both libraries are imported by components that mount on the landing
page, so they are on the critical path either way and only `components/**`
can change that. Nobody should read this block as a first-load optimisation.

The measurement that settles it is section 7.4. Two builds of the same commit
differing only in this block: identical first-load JS, 9 334 B and three
requests less on the wire with the split, and 8 594 B less on disk.

**One claim in the original comment was withdrawn, because it did not
survive.** It said the split keeps the vendor chunks byte-identical across a
deploy that only touches app code, where webpack would otherwise renumber and
re-hash them. Probed directly -- a new module added and imported from
`app/page.tsx`, then a rebuild -- `vendor-maplibre` and `vendor-three` kept
their content hashes WITH the groups, and the four mixed chunks holding the
same libraries kept theirs WITHOUT them. Webpack's deterministic module ids
already do that job on this config. The comment now records the probe instead
of the claim.

What is left is small and real, and is why the split stays rather than being
reverted: three fewer files, 9 kB less on a cold load, and two chunks named
after their contents (`vendor-maplibre` 955 074 B, `vendor-three` 906 057 B)
where the tree otherwise carries four opaque ones (542 986, 420 882, 383 194
and 359 552 B), so the service worker's cache policy and every measurement in
this note can name them.

## 4. Bundled preset responses

The six committed Overpass fixtures ship beside the site, gzipped, named by
the **sha1 of the Overpass query text** -- which is already
`lib/engine/osm/overpass.ts`'s cache key and already how
`refresh-fixtures` names a fixture. An asset therefore answers exactly one
query and cannot answer any other: nudge the pin, change the radius or rotate
the crop and the sha1 changes and the mirrors are asked, as before.

`scripts/bundle-preset-assets.mjs` writes them over the exported tree. It
verifies each fixture parses, has an `elements` array, and matches the element
count the index claims, because an asset that cannot be read back is worse
than no asset: the client would spend the download before falling back.

| preset | raw B | gzip B |
|---|---:|---:|
| chicago-loop | 12 725 477 | 1 738 011 |
| new-york-midtown | 13 501 888 | 1 795 001 |
| paris-eiffel | 12 860 764 | 1 569 518 |
| tokyo-shinjuku | 8 519 786 | 1 182 120 |
| london-city | 12 695 572 | 1 849 396 |
| san-francisco-fidi | 7 197 699 | 961 697 |
| **total** | **67 501 186** | **9 095 743** |

A visitor downloads only the preset they click.

**It is deliberately not part of `npm run build`**, for two reasons the script
states. The assets are 8.7 MB, which no local build, `next dev` run or desktop
bundle needs. And the e2e suite route-mocks `**/api/interpreter` and then
clicks the Chicago preset, several specs deliberately serving a small
synthetic response for speed; a bundled asset in the tree under test would
answer before the mock could, and those specs would silently start building
the real 992-building Chicago. Keeping it a separate, explicit step keeps the
tree the gate runs against identical to the tree it has always been.
`.github/workflows/pages.yml` runs it after `next build`.

**The manifest, and the one request it costs.** The client reads
`<base>/presets/index.json` before it looks for an asset, and that read is
memoised **once per JS realm, hit or miss**. A miss is memoised as hard as a
hit: on a build without the assets -- which is what every local `npm run build`
produces -- it is the only request the bundled path ever makes, and repeating
it per preview would turn one 404 per session into one 404 per preview. The
same-origin asset fetch is a separate injectable transport from the mirror
transport, because they are different things: in Node, where the export CLI
runs, a root-relative asset URL is correctly rejected outright.

`components/editor/Controls.test.ts` pins both halves separately, which is the
only way a count stays honest once a preview can make two KINDS of request:
five arrow taps cost exactly **one** Overpass round trip, identified by the
mirror URL or by `[out:json]` in the body, and exactly **one** manifest read,
and the two account for the total call count to the call. A second test drives
the memo directly: one manifest read per realm, not one per preview.

## 5. The first-run status line

`app/layout.tsx` renders a hidden `#fc-boot` status line and a small inline
script; `app/page.tsx` sets `data-fc-ready` on the document element when the
editor mounts.

What it is NOT is a skeleton. The static export prerenders the whole editor,
so a visitor sees the real shell at first contentful paint (104 ms median on
the deployed site, baseline 1.1) with no JavaScript run yet, and covering that
with a placeholder would replace a real paint with a fake one. What the shell
cannot show is that the map pane and the editor are still arriving, which on a
slow link is the difference between "loading" and "hung".

Three rules it keeps: it is hidden in the HTML and revealed only after 300 ms,
so a fast load never flashes it and a browser with JavaScript off never shows
it; it says only what is true, and never claims to be loading a 3D engine
because the manifold kernel is not part of a first run at all; and it cannot
outlive the load, being removed when the editor has mounted and the map canvas
exists, and unconditionally at a 10 s cap, so no idle state can keep it on
screen.

## 6. `serve-static.mjs` and `precompress.mjs`

The test server grew two behaviours, both because it is also the server this
task's numbers are measured on. It serves a `.br` or `.gz` sibling when the
client accepts that encoding, and it sends
`Cache-Control: public, max-age=31536000, immutable` on `/_next/static/**` and
`/presets/<sha1>.json.gz` instead of the blanket `no-store` it used to send.
The old blanket made a warm-load measurement meaningless: nothing could ever
be reused, which is why the baseline's local warm navigation transferred
exactly the same 3 616 857 B as its cold one.

`scripts/precompress.mjs` writes those siblings. It is worth doing for exactly
one consumer -- somebody self-hosting the static site behind a server that
honours precompressed files -- and it changes nothing on Pages, which ignores
them, or in the desktop shell, which has no wire. Already-compressed formats
are skipped: woff2 grows under gzip, and a `.json.gz` preset asset is a
payload the client inflates itself, not an encoding.

When this task was interrupted the consumer half shipped and nothing produced
the siblings (the audit's B5), so the saving reached nobody. It is now wired
in the one place its own header points at: `release.yml`'s `web-zip` job runs
it after the source-map delete and before the zip, so the release artifact --
the thing a self-hoster downloads -- carries them. It is deliberately NOT in
`pages.yml`, because Pages compresses on the fly, serves gzip and only gzip,
and ignores files a repo ships; adding it there would grow the deploy for no
effect. `RUNBOOK.md` section 6 lists it beside the local static-build recipe.

Measured on this build: 33 files, 5 557 822 B raw, 1 661 674 B gzip,
1 357 153 B brotli. **Brotli is worth 18.3 % against the gzip such a server
would otherwise produce**, which matches the 18.4 % the baseline predicted from
its own sample of four chunks.

**The release asset nearly triples, and that is the intended trade.** Zipping
`out/` without the siblings gives 1 935 172 B; with them, 4 964 854 B, 2.57
times larger, because the zip now carries three copies of every compressible
file. A zip whose whole purpose is to be unpacked behind a web server is the
one artifact where paying that is right, but anyone reading the release page
should know the growth is this step and not a regression. Measured by
`w7-swfix` on the root-base export.

## 7. Measured

Taken on 2026-09-03 against the Wave 3 checkpoint `af02c98`, in a git worktree
of that commit, on the same host as `v3-00-baseline.md` (Ryzen 9 9950X3D2,
Windows 11, Node v26.5.1, Chromium 151 headless through Playwright 1.62.1, no
GPU). The build is the `/framecraft` one Pages deploys, with the preset assets
bundled, served by `scripts/serve-static.mjs --base /framecraft` on
127.0.0.1:4510. Bytes are CDP `Network.loadingFinished` `encodedDataLength`,
same-origin only, which is the source the baseline's section 1.3 used.

### 7.1 What the build weighs

From `next build`'s own report:

| | baseline `7eda2d7` | `7eda2d7` + perf mode | this build |
|---|---:|---:|---:|
| `/` page JS | 156 kB | 160 kB | 190 kB |
| First Load JS | 259 kB | 264 kB | 293 kB |

**First-load JS went UP, and Task 8 is not what moved it.** Twenty commits of
v3.1 landed between the two builds -- the pipeline, the settings matrix's
catalog, the action bar, the search box, per-triangle building identity -- and
none of the four things this task did removes eager JavaScript. The chunk
groups shuffle the same bytes between files; the service worker and the preset
assets are about the SECOND visit and the ingest step. A first-load reduction
was never in this task's reach and is not claimed.

The exported tree, `out/` at the `/framecraft` base path:

| | files | raw B | gzip -9 B |
|---|---:|---:|---:|
| the app | 51 | 5 807 176 | 1 906 640 |
| the six preset responses | 6 | 9 095 743 | 9 083 862 |
| **total** | **57** | **14 902 919** | **10 990 502** |

The app half against the baseline's 52 files / 5 582 828 raw / 1 836 575 gzip:
about 224 kB more, over the same twenty commits. The preset half is new and is
not downloaded by a visitor who clicks one preset; it is 1.66 MB for Chicago.

The two vendor chunks the splitting created:

| chunk | B |
|---|---:|
| `vendor-maplibre.<hash>.js` | 955 074 |
| `vendor-three.<hash>.js` | 906 057 |

against the baseline's four mixed chunks holding the same libraries
(542 986 + 420 882 for maplibre-gl, 383 194 + 359 552 for three).

### 7.2 Cold visit and return visit, three runs each

The return visit models what Pages actually does to a visitor who comes back
more than ten minutes later: the HTTP cache is cleared between the two
navigations (CDP `Network.clearBrowserCache`), which is what `max-age=600`
expiring amounts to, while Cache Storage and the service worker registration
survive, which is what expiry does NOT touch.

| | cold | return visit |
|---|---:|---:|
| service worker blocked | 3 184 699 B / 17 requests | **3 184 699 B / 17 requests** |
| service worker allowed | 3 184 699 B / 17 requests | **0 B / 17 requests** |

Median, min and max are the same number in every cell: all six runs transferred
byte-identical totals, because this server sends the files uncompressed and
nothing on the page varies. The 17 requests are same-origin; OSM tiles are
cross-origin and excluded, as in the baseline.

**That is the whole point of the service worker, in one row.** A returning
visitor past the freshness window pays 3.18 MB again without it and nothing at
all with it, all 17 requests served out of Cache Storage with
`navigator.serviceWorker.controller` non-null. On Pages, which gzips, the same
3.18 MB is about 1.9 MB on the wire; the saving is the whole of it either way.

### 7.3 The Chicago preset: bundled asset against a live mirror

Same build, same server. `bundled` is the shipped path. `live` blocks the
build's own `/presets/**` so the client falls back to the mirrors exactly as a
build without the assets would, and really does query `overpass-api.de`. Three
runs each, no service worker in either arm, so a cached asset cannot make runs
2 and 3 free.

The ingest step alone (`overpass.fetch`, the perf-mode row that times reading
the OSM response however it is obtained):

| | median | min | max |
|---|---:|---:|---:|
| bundled asset | **184 ms** | 173 ms | 198 ms |
| live mirror, runs that answered | **5 496 ms** | 5 064 ms | 5 496 ms |
| live mirror, the run that did not | 163 776 ms, across 4 attempts, no model | | |

Preset click to the stats card, end to end:

| | median | min | max |
|---|---:|---:|---:|
| bundled asset | **16 900 ms** | 13 673 ms | 18 252 ms |
| live mirror | 16 691 ms (of 2 completed) | 16 175 ms | 17 206 ms |

Read those two tables together, because on their own the second is misleading.

**The ingest step is 30x faster and is no longer a coin flip.** 184 ms against
5 496 ms, and the bundled arm made zero requests to anybody's mirror (measured:
`overpass=0` in all three runs, one preset asset and one manifest read each).

**The end-to-end medians overlap, and that is honest.** On this host, on a fast
link, to a mirror that happened to be healthy, the engine build is 12.8 to
17.5 s and dwarfs a 5 s fetch, so removing the fetch moves the total by about
5 s inside its own run-to-run spread. What the bundled asset actually buys at
this end of the distribution is small.

**What it buys at the other end is the product working at all.** One of the
three live runs never produced a preview: the client spent 163.8 s across four
attempts against the mirrors and the test gave up at 180 s. That is the same
pathology the baseline measured on the deployed site -- 3 of 8 attempts 504ing
after ~10 s, and 2 of 5 flows with no preview inside 180 s -- reproduced here
1 time in 3. The bundled arm cannot produce it, because it never asks anyone.

### 7.4 Does the vendor chunk split pay?

The audit asked this directly (B3), and the honest answer needed an A/B rather
than a reading of the config. Two git worktrees of the same commit `af02c98`,
identical except that one has the `fcMaplibre` / `fcThree` cache groups removed
from `next.config.ts` and nothing else touched. Both built at the root base
path, both served by `scripts/serve-static.mjs`, both driven three times per
arm by the same script as 7.2.

| | first load JS | cold wire | cold requests | return visit, no SW | return visit, SW | JS on disk | JS files |
|---|---:|---:|---:|---:|---:|---:|---:|
| **with the split** | 293 kB | **3 184 328 B** | **17** | 3 184 328 B | **0 B** | 4 282 554 | 31 |
| without it | 293 kB | 3 193 662 B | 20 | 3 193 662 B | 0 B | 4 291 148 | 34 |
| difference | none | −9 334 B | −3 | −9 334 B | none | −8 594 | −3 |

Every run in each arm transferred a byte-identical total, so median, min and
max are one number per cell.

Four readings, in the order they matter:

1. **The first-load figure `next build` reports does not move at all.** 293 kB
   either way, down to the same 190 kB page chunk. Anyone hoping this block
   was a first-load win should stop here.
2. **It is worth 9 334 B and three requests on a cold load**, by consolidating
   four vendor-bearing chunks into two. Small, positive, free.
3. **The deploy-stability claim did not reproduce.** A new module imported
   from `app/page.tsx`, then a rebuild, left `vendor-maplibre` and
   `vendor-three` on their existing content hashes with the split -- and left
   the four mixed chunks on theirs without it. So the cache-invalidation the
   config comment used to justify itself with is prevented by webpack's
   deterministic module ids, not by these groups.
4. **The service worker's saving is identical in both arms, and dwarfs all of
   it.** 3.18 MB against 0 B on a return visit past the freshness window, in
   both columns. That is the change in this task that pays.

**Ruling: keep the split, and correct the comment.** It costs nothing, it is
marginally smaller on the wire and on disk, and it gives the two heaviest
chunks names that the worker's cache policy and this note can refer to.
Reverting it would add three files and 9 kB to every cold load to remove a
comment that was wrong, which is the worse trade. The comment in
`next.config.ts` now carries this table and withdraws the claim it could not
support.

**Since the Task 7 close-out the hook has a test, and it is a build, not a
reading of the config.** `apps/web/next.config.test.ts` bundles one entry
that imports the real `maplibre-gl`, `three`, `@react-three/fiber` and
`manifold-3d` out of this app's `node_modules` through the webpack Next
ships, in production mode on the client target, twice: once with the hook
applied exactly as `next build` applies it (`dev: false`, `isServer:
false`), once without. It then reads webpack's own stats for where every
module landed and the directory for what was written: every `maplibre-gl`
module is in `vendor-maplibre` and nothing else is; every `three` and
`@react-three` module is in `vendor-three`, `react` (which fiber pulls in)
is not; the control has neither chunk. Section 10.5's rule is proved the
same way, below. The whole file runs in a few seconds under `npm test`, so
the gate covers it without a `next build`.

**What this measurement does NOT do** is find the first-load reduction the
audit's B3 says was never attempted, and neither does anything else in Task 8.
`v3-00-baseline.md` section b names the two candidates -- maplibre behind the
first map interaction, three behind the first preset -- and both are real
`dynamic()` boundaries in `components/**` that nobody has moved. That work is
unstarted and is not this task's.

### 7.5 The nightly preset matrix, and the parity gap it found

`[V3.1-P7-4]` asked for one thing in this wave: the browser engine run over all
six presets in the nightly, beside the reference pipeline, each result put
through `make validate`. Two changes deliver it.

`apps/web/scripts/export-cli.ts` gained `--center <lat,lon>`. A raw Overpass
response carries no centre of its own (the centre is part of the request), and
the CLI hard-coded the Chicago Loop, so feeding it the Paris fixture cropped
Paris data around a point in Illinois. `scripts/ci-preset-matrix.sh` now reads
each preset's centre, radius and rotation out of the same committed
`fixtures/presets-index.json` the reference half uses, so both engines are
handed the identical request per city.

**Say this part plainly, because it is why nobody saw the defect.** Until this
flag existed, EVERY browser-engine run cropped around the Chicago Loop
whatever city's fixture it was handed. Chicago was therefore the only city the
browser engine was ever really given, and the other five were not being tested
badly, they were not being tested at all: feeding it the Paris response
selected whatever Paris geometry happened to fall within 900 m of a point in
Illinois, which is nothing. One city passing and five failing is not a sudden
regression in those five. It is the first time they have been built.

That the flag works is not an assertion, it is the footprint counts, which are
city-sized and all different where before five of six would have been empty
plates:

| preset | centre | rotation | footprints | triangles |
|---|---|---:|---:|---:|
| chicago-loop | 41.8827,-87.6233 | 0 | 992 | 171 338 |
| new-york-midtown | 40.7549,-73.984 | 29 | 2 594 | 117 500 |
| paris-eiffel | 48.8584,2.2945 | 0 | 2 627 | 180 676 |
| tokyo-shinjuku | 35.6896,139.7006 | 0 | 5 400 | 219 040 |
| london-city | 51.5155,-0.0922 | 0 | 2 108 | 209 766 |
| san-francisco-fidi | 37.7946,-122.3999 | 0 | 2 590 | 160 490 |

Radius is 900 m for all six. Every value above comes from
`fixtures/presets-index.json`, which is also where the matrix script reads
them, so a seventh preset needs no edit here.

Measured on the dev host, 2026-09-03. Browser engine, `--target generic-3mf`,
`fixtures/print-params-parts.json`, then `make validate` on each:

| preset | build | 3MF bytes | validator |
|---|---:|---:|---|
| chicago-loop | 6 s | 1 961 405 | **ALL CHECKS PASS** |
| new-york-midtown | 5 s | 1 340 272 | FAIL `min_wall`: 7 of 340 sampled regions under 0.720 mm, narrowest 0.134 mm |
| paris-eiffel | 6 s | 2 101 487 | FAIL `part_meshes`: buildings, 55 degenerate faces |
| tokyo-shinjuku | 8 s | 2 562 893 | FAIL `min_wall`: 10 of 465, narrowest 0.169 mm |
| london-city | 8 s | 2 443 252 | FAIL `min_wall`: 2 of 136, narrowest 0.206 mm, and `part_meshes` |
| san-francisco-fidi | 4 s | 1 854 456 | FAIL `min_wall`: 7 of 268, narrowest 0.205 mm |

37 s of builds and 34 s of validator runs, so about 71 s added to the job.

**Five of six fail, and the coverage is what found it.** Two controls say this
is a real engine defect and not an artefact of how the run is configured.

The parameter set is not the cause. Rebuilding Paris and New York with
`fixtures/print-params-default.json` instead of the parts profile fails too,
and slightly worse: Paris reports `degenerate_faces: 58 faces smaller than
1e-09 mm^2` at the top level, New York both `min_wall` and `degenerate_faces`.

The other engine is not the cause either. `python -m app.cli bake --preset
paris-eiffel`, the reference pipeline on the identical committed fixture,
builds in 15.7 s and the same validator says **ALL CHECKS PASS**.

So the browser engine and the reference engine disagree on five of the six
preset cities, and the one city they agree on, Chicago, is the only one the
browser engine had ever been run on. That is exactly the class of defect a
two-pipeline matrix exists to catch, and it was invisible while the browser
half was Chicago-only.

**What this means for the nightly.** The job is red on arrival. That is
recorded in `nightly.yml`'s own header comment, with the failing checks named,
so a reader does not mistake it for a regression introduced by this wave.
`nightly.yml` is advisory by design, never a merge gate, so the honest move is
to let it report the gap. The validation was not weakened, no expected-failure
ledger was added, and the job must not be silenced by dropping `make validate`
from the browser half. Fixing the engine is separate work and is not this
task's; nothing here diagnoses the degenerate faces or the thin walls beyond
locating them.

The timeout stays at 30 minutes: 221 s for the reference half plus the 71 s
above is about 4 min 52 s, and 30 minutes is roughly six times that.

#### Reproducing one city, for whoever fixes the geometry

One preset at a time, from the repo root. Substitute the fixture, centre and
rotation from the table above; `--rotation` matters only for New York, and
omitting it there is itself a way to see the crop move.

Each command below is wrapped in its own subshell, so every one of them starts
from the repo root and you can paste the block as it stands.

```sh
# build one city through the browser engine
( cd apps/web && npm run export:cli -- \
    --overpass ../../fixtures/f37cfe5a65e7a7b1c8753d51e41393edb335120f.json \
    --params ../../fixtures/print-params-parts.json \
    --center 48.8584,2.2945 --radius 900 --rotation 0 \
    --target generic-3mf --out ../../artifacts/preset-matrix/web-paris-eiffel.3mf )

# judge it. The validator wants an ABSOLUTE path.
make validate FILE="$(pwd)/artifacts/preset-matrix/web-paris-eiffel.3mf"

# the control: the same city through the reference pipeline, which passes
( cd services/bake && uv run python -m app.cli bake \
    --preset paris-eiffel --out ../../artifacts/preset-matrix/ref-paris.3mf )
make validate FILE="$(pwd)/artifacts/preset-matrix/ref-paris.3mf"
```

On this Windows host `make` is not on PATH in a fresh shell; the export line
for it is in `RUNBOOK.md` and in the host notes.

Both halves together, exactly as the nightly runs them, is
`sh scripts/ci-preset-matrix.sh` (227 s here, and it prints the built count and
the validated-clean count separately so a build failure is never read as a
validator failure).

Two things worth knowing before starting. The parts profile is not load
bearing: `fixtures/print-params-default.json` fails too, and on Paris it fails
harder, so pick whichever is easier to reason about. And the failures split
into two shapes that may or may not share a cause: `min_wall` on four cities,
where sampled regions come in under the 0.720 mm floor by a factor of up to
five, and degenerate faces on Paris and London, which is a mesh validity
problem rather than a thickness one.

At the time of writing the engine additionally cannot be imported at all,
because a pipeline stage claims `colour.region_slots.override_1` and the
generated contract does not declare it. That arrived with the v3-11
object-overrides work, several hours after the numbers above were taken on a
working tree, and it is unrelated to this parity gap. It will stop any
reproduction attempt at module load until it is resolved, so check that first
rather than concluding the commands here are wrong.

## 8. How to re-measure

```sh
cd apps/web
# PowerShell, not Git Bash: a value starting with a slash is mangled by MSYS
# path conversion into a Windows path.
$env:NEXT_PUBLIC_BASE_PATH = "/framecraft"; npm run build
node scripts/bundle-preset-assets.mjs --out out
node scripts/serve-static.mjs --dir out --port 4510 --base /framecraft
```

Then drive `http://127.0.0.1:4510/framecraft/` with Playwright:

- **Bytes.** One context per run. Navigate, wait for
  `document.documentElement.dataset.fcReady === "1"`, then network-idle; sum
  `encodedDataLength` from CDP `Network.loadingFinished` for same-origin URLs.
  Wait for `navigator.serviceWorker.ready`, send
  `Network.clearBrowserCache`, navigate again, and sum the second navigation
  separately. Run the whole thing twice, once with the context's
  `serviceWorkers: "block"` and once with `"allow"`; the difference between
  the two return-visit totals is the worker's entire contribution.
- **The preset.** Navigate to `?perf=1`, click `[data-preset-id="chicago-loop"]`,
  wait for `[data-testid="stats-card"]`, and read
  `window.__framecraftPerf.report()` for the `overpass.fetch` row. For the live
  arm, route `**/presets/**` to a 404 first. Block service workers in both
  arms. Count the requests by kind at the page: `/presets/<40 hex>.json.gz`,
  `/presets/index.json`, and anything matching `api/interpreter`.

The live arm queries a public volunteer mirror. Keep the run count small, and
record a run that times out rather than retrying until it passes -- that
outcome is data, and it is most of what this task exists to remove.

## 9. What is NOT finished

Rewritten after the closing pass. The Tauri gate (B1), the kill switch (B2),
the `precompress` wiring (B5), the chunk-split measurement (B3) and this
document (B4) are done and are described above. What is left:

**No e2e covers the first-run status line.** The `#fc-boot` reveal after
300 ms, its removal when the editor has mounted and the map canvas exists, and
its unconditional 10 s cap are asserted nowhere in a browser. The audit
checked all three by reading (B10) and found them right; that is not the same
as a test.

**Two MINORs from the audit are open, and neither is a correctness defect.**
B9: `trim` enumerates the whole cache on every single `put`, so a cold load
walks up to 240 entries per chunk cached. B13: the unreferenced debugging
probe `apps/web/scripts/_probe-scene-size.ts` is still committed.

**B6, the manifest in front of the first Overpass fetch, is measured rather
than fixed.** The audit is right that `fetchOverpass` awaits
`<base>/presets/index.json` before it contacts a mirror, whatever the
location, and that a user who drops a pin outside the six presets pays for a
lookup that cannot answer them. What that costs, from section 7.3's own runs:
the whole bundled ingest path -- manifest, asset, inflate -- is 173 to 198 ms,
and the live arm, which pays the manifest 404 and then queries a mirror, spent
5 064 to 5 496 ms on the mirror. The manifest is single-digit milliseconds
against that, once per JS realm rather than once per preview, and on the
deployed build it is a real 200 the bundled path needs and the worker then
caches. So it is a tidiness defect, not a latency one. The audit's own
smallest fix -- carry `preset_id` into `FetchOverpassOptions` and skip the
bundled path when it is null -- is still worth doing, and it is threading a
parameter through the pipeline rather than a performance change.

**No first-load JS reduction was attempted, by this task or by the closing
pass.** Section 7.4 says so with numbers. `v3-00-baseline.md` section b names
the two candidates, maplibre behind the first map interaction and three behind
the first preset; both are `dynamic()` boundaries in `components/**` that
nobody has moved.

---

## 10. Fixes: the worker's own tests, and the second copy of the WASM

A second closing pass, after the one section 9 describes. Everything below was
verified on this tree rather than read off the previous pass's claims: section
9 said `e2e/siteperf.spec.ts` was "new in this pass" and there was no such
file, and `public/sw.js` had not been touched since 2026-09-02 22:55.

### 10.0 One trap worth knowing before reading the rest

`page.waitForFunction` does NOT await an async predicate. The Promise it
returns is truthy on the first poll, so the wait resolves at once whatever the
answer would have been. Measured against this Playwright build: a predicate of
`async () => false` resolved in 14 ms against a 3 s timeout. Any wait that has
to read Cache Storage, the registration list or anything else behind a Promise
must go through `expect.poll`, which does await. `e2e/siteperf.spec.ts` uses
`expect.poll` for exactly those three waits and says why at the call site.
Nothing else in `e2e/` uses an async predicate; that was checked.

### 10.1 `public/sw.js` had no test of any kind, and now has 24

The largest gap in the task, named as such by section 9's first draft. Three
hundred lines of cache policy shipped to every visitor with nothing defending
them: `bucketFor`, `cacheFirst`, `staleWhileRevalidate`, `networkFirst`, the
entry-cap `trim`, the warm-up and the 404-on-a-chunk update message.

`lib/serviceWorkerScript.test.ts` is that test. It does not re-implement the
worker or copy any of it: it reads `public/sw.js` off disk and runs the shipped
bytes in a `node:vm` context holding a hand-built `self`, `caches` and `fetch`,
with the host's own `Response` and `Headers`. A change to the worker is a
change to what these tests run, which is the only arrangement in which they can
fail for the right reason.

| rows covered | what is asserted |
|---|---|
| `/_next/static/**` | a miss is fetched once and never again; a 404 is not cached and posts `update-ready`; the 240-entry cap drops oldest first |
| navigations | the network is asked every time even with a cached copy; the cached document comes back when the network is gone; a non-200 is not cached |
| `/presets/<sha1>.json.gz` | `install` precaches nothing and opens no cache; a fetched preset lands in its own cache and not the chunk cache; the cap of 3 drops oldest first; `/presets/index.json` is not claimed |
| `/manifold/**`, `/maplibre/**`, icons | the cached copy is served while the refresh goes out; the refresh is held open; 504 offline with nothing cached |
| the warm-up | only same-origin URLs its own buckets claim are adopted; what is already held is not re-fetched; a failed warm changes nothing |
| refusals | non-GET, cross-origin, ranged and unclaimed paths never reach a handler |
| lifecycle | `activate` deletes `framecraft-` caches it does not know, leaves other apps' alone, and claims the page; `skip-waiting` is honoured |
| sub-path | the same buckets match under `/framecraft/` as at the root |

24 tests, all passing. Run against the pre-fix worker (`git show
HEAD:apps/web/public/sw.js`) six of them fail, which is the before-and-after
for 10.2 and 10.3.

### 10.2 B8: the stale-while-revalidate refresh was not held open

`public/sw.js:183` `staleWhileRevalidate` started the background fetch and
returned the cached copy without handing the refresh to `event.waitUntil`. A
worker terminated between the return and the `cache.put` leaves the entry
stale, and because the next hit takes the same path and returns just as early,
it can stay stale for as long as no page is open long enough to finish one.

The handler now takes the `FetchEvent` and calls `event.waitUntil(network)`
(`public/sw.js:193`); the dispatch at the bottom of the file passes it through.
Pinned by "holds the refresh open with waitUntil, so a terminated worker cannot
strand a stale entry", which reads the event's own `waitUntil` list.

### 10.3 B7: the one cache that needed the build id now carries it

`STATIC_CACHE` is `framecraft-static-v1-<build id>` (`public/sw.js:84`, with
`BUILD_ID` moved above it at `:64`). Only that one. `/_next/static/**` and
`/presets/<sha1>.json.gz` are keyed by their own content, so a deploy asks for
different URLs and an old entry is unreachable rather than stale; keying those
by the build id would throw away a good copy on every deploy, which is the
opposite of the worker's purpose. The stale-while-revalidate bucket is the one
with STABLE URLs, and without a build id in the name a visitor ran one deploy
behind on the MapLibre worker pair until a second visit. The existing
`activate` sweep is what retires the previous build's copy, because it is a
`framecraft-` cache no longer in `KNOWN_CACHES`; no new code was needed for
that half. Three tests, including one asserting that the content-addressed
caches did NOT change name.

### 10.4 The e2e: `e2e/siteperf.spec.ts`

Six tests, and the design constraint is worth writing down because it decides
the shape. The suite's shared web server is `next dev`, where the worker
deliberately refuses to register, and `apps/web/out` does not exist on a runner
that never ran `next build`, which `nightly.yml`'s full suite does not. A spec
that needed either would have to skip, and this gate accepts no skip.

So the spec brings its own origin: a temp tree with the SHIPPED `public/sw.js`
copied in byte for byte, laid out with the export's paths, served by
`scripts/serve-static.mjs` on an OS-assigned port (`--port 0`; the server now
prints the port it actually bound, `scripts/serve-static.mjs:168`). It touches
neither the dev server nor `out/`.

- **The return visit costs the page every subresource and nothing else.**
  Cold load, wait for the worker to control the page and adopt what the load
  fetched, then CDP `Network.clearBrowserCache`, which is exactly what
  `max-age=600` expiring amounts to and leaves the registration and Cache
  Storage alone, then navigate again. Measured from the page's own Resource
  Timing on the fixture tree:

  | | subresources | document |
  |---|---:|---:|
  | cold | 90 991 B over 3 | 1 495 B |
  | return visit | **0 B** over 3 | 1 495 B |

  Every response also reports `fromServiceWorker()`. The origin-side half is
  asserted through Playwright's `request.serviceWorker()`: the worker makes no
  network request for any `/_next/static/**` URL, and it DOES re-request the
  document (network first) and `/manifold/manifold.wasm` (stale while
  revalidate), so the two policies that must go back out are proved to rather
  than passing by silence.

  **This corrects section 7.2's "0 B / 17 requests".** That row was taken with
  CDP `Network.loadingFinished` `encodedDataLength` on the page's session,
  which reports 0 for anything a service worker answered -- including the
  document, which the worker really does fetch from the network on every
  navigation. Resource Timing reports the document's bytes and the
  subresources' zero separately, so it can tell the two apart. The saving is
  the subresources, which is all of the weight and none of the document; the
  HTML is paid every visit and has to be.
- **A chunk the origin no longer serves** raises `update-ready` with
  `reason: "missing-chunk"` and the build id, in a real browser.
- **A preset response** is absent from Cache Storage until it is asked for,
  then lands in `framecraft-presets-v1` alone.
- **The desktop shell is refused for being the desktop shell.**
  `lib/platform.ts`'s `isTauri()` is `"__TAURI_INTERNALS__" in window` and
  nothing else, so the test injects that global before any bundle runs and
  asserts the recorded reason is `off:tauri`. The reason, not the absence of a
  worker: under `next dev` there would be no worker either way, so a test that
  only looked for one would pass with the gate deleted.
- **`?sw-off` retires every worker and every `framecraft-` cache, and no
  others.** The state the switch exists to rescue is built by hand first, since
  `next dev` registers nothing: a real registration under a scope the editor
  never navigates to, plus one cache under this app's prefix and one that is
  not ours. After the navigation the registrations are gone, the
  `framecraft-` cache is gone, `somebody-elses-cache` is untouched, and the
  flag is remembered; `?sw-on` forgets it again.
- **The app still asks for a worker.** `installServiceWorker` now writes its
  decision to `data-fc-sw` on the document element on every path
  (`lib/serviceWorker.ts:145`, `:196`, `:210`, `:519`), beside the existing
  `data-fc-ready`. The test fails two ways: the attribute is missing if
  `app/page.tsx` stopped calling the module, and the value is wrong if the
  environment gate stopped agreeing with the server under test. Under `next
  dev` the honest answer is `off:dev`, and the test additionally asserts there
  really is no controller; under `FRAMECRAFT_WEB_MODE=prod` it is `on` and the
  test waits for one.

`registrationDecision` is where the reason comes from, and `shouldRegister` is
now `registrationDecision(env) === "on"` so the two cannot drift. Five new unit
tests cover it, including that the desktop shell is blamed for its own refusal
rather than anything downstream of it.

### 10.5 The duplicate `manifold.wasm`

Root cause, which the audit did not have: one line of `manifold-3d`'s
emscripten glue.

```js
if (Module["locateFile"]) { return locateFile("manifold.wasm") }
return new URL("manifold.wasm", import.meta.url).href
```

webpack emits the file as an asset for the `new URL(..., import.meta.url)`
expression whether or not it can ever run, and here it cannot:
`lib/engine/solid/manifold.ts` passes `locateFile` on every non-Node path, so
the first branch always wins in a browser and the second is dead. That is where
`_next/static/media/manifold.<hash>.wasm` came from, and why the baseline
recorded it as never requested.

`next.config.ts:107` adds a client-only module rule matching
`manifold-3d/manifold.wasm` with `generator: { emit: false }`. The URL webpack
rewrites the expression to is unchanged, nothing reads it, and the file is not
written. The server compilation and vitest are untouched: both read the wasm
through `require.resolve("manifold-3d/manifold.wasm")` off disk.

Measured as a controlled pair: the same source tree copied out of the repo and
built twice, differing only in that rule, so nothing else could move.

| `out/` | files | bytes |
|---|---:|---:|
| without the rule | 51 | 5 960 875 |
| with the rule | 50 | 5 419 405 |

**541 470 B, one file, exactly.** The difference is the whole of it, which is
the check that the rule removed the dead copy and nothing else:
`out/manifold/manifold.wasm` -- the one `locateFile` points at -- is still
there, byte for byte, and `out/_next/static/media/manifold.<hash>.wasm` is
gone. It saves a visitor nothing, because nobody ever fetched it; it saves
541 kB in every Pages deploy, in the release zip and in each of the three
desktop installers.

That pair is now a test rather than a one-off (`next.config.test.ts`, see
section 3): the control build writes exactly one `.wasm` asset whose size is
the size of `node_modules/manifold-3d/manifold.wasm`, the hooked build writes
none and lists none in its stats, and the chunk holding the glue still
contains the `.wasm` URL the `new URL(..., import.meta.url)` expression was
rewritten to, which is the "kept the URL, skipped the file" the config
comment claims.

### 10.6 What `precompress.mjs` buys, and what it costs

Section 6 and `release.yml:105` say what it is for. Neither had the numbers.
Measured on the current root-base export, in a scratch copy:

| | files | bytes |
|---|---:|---:|
| compressible files in `out/` | 33 | 5 557 822 raw |
| what a server compressing on the fly sends | | 1 661 674 gzip |
| what the `.br` siblings let it send | | 1 357 153 brotli |

Brotli saves **18.3 %** against gzip, which is the number section 6 quotes and
is now measured rather than cited.

The cost is the release asset, and it is not small. Zipping `out/` without the
siblings gives **1 935 172 B**; with them, **4 964 854 B**, 2.57 times larger.
The siblings are already-compressed bytes, so the zip cannot recover them. That
is the trade the `web-zip` job makes: a self-hoster downloads 3 MB more once,
and every visitor to their site then gets 18.3 % less JavaScript on every cold
load. It is the right way round, and it is why the step is in `release.yml` and
in neither `pages.yml` (Pages ignores the siblings) nor `npm run build` (the
desktop bundle would carry 3 MB of siblings for a shell that reads its files
off local disk and has no wire to negotiate on).

### 10.7 Two gate failures, and what each of them turned out to be

A third pass, from `e2e/siteperf.spec.ts` failing twice identically in the
v3.1 gate. One was the spec's fault and one was the product's, and it is worth
saying which was which because they look the same from the report.

**The kill switch did not kill: a real defect, in the product.**
`?sw-off` unregistered every worker and deleted every `framecraft-` cache, and
then the caches came back. Measured on the real app, prod build, three runs:
`framecraft-immutable-v1` was present again within two seconds of the
teardown, every time.

The cause is one line of the service worker lifecycle that the switch was
written without. `registration.unregister()` stops a worker claiming FUTURE
clients; it does not evict the worker already CONTROLLING open pages, which
goes on handling every fetch of every open tab until the last one unloads. So
the `?sw-off` navigation was still being served by the very worker it had just
retired, and each subresource that load asked for went through `cacheFirst`
and re-created the cache the page had swept a moment earlier. The visitor who
reached for the switch was left with a live worker and a fresh cache, which is
the exact state the switch exists to escape -- and worse than no switch,
because it reports success.

The fix is a handshake, and the order in it is the whole of it.
`silenceController` (`lib/serviceWorker.ts`) posts `framecraft:kill` to the
controller and waits, bounded at 2 s, for `framecraft:killed`;
`selfDestruct` (`public/sw.js`) raises a one-way `disabled` flag, deletes the
`framecraft-` caches, unregisters, and answers. While `disabled` the fetch
handler returns without `respondWith`, so the page goes straight to the
network, and `putAndTrim` -- the one place every write goes through -- refuses,
so a handler already in flight when the kill arrived cannot re-create a swept
cache either. Only then does the page's own sweep run. The 2 s bound is not a
requirement: a worker that never answers is exactly the worker this switch is
for, so past it the page does what it did before, which is no worse than the
old behaviour.

Measured after, same probe, same build: the `framecraft-` caches stay gone for
the full 15 s while `somebody-elses-cache` is untouched, with
`navigator.serviceWorker.controller` still non-null -- inert, not evicted,
which is all the browser allows until the page unloads.

Nine new tests: five page-side (`serviceWorker.test.ts`, including that the
kill is sent BEFORE the sweep, which is the ordering the whole fix is) and four
worker-side in the vm sandbox (`serviceWorkerScript.test.ts`, including the
in-flight response that must not land).

**The desktop-shell refusal: the spec's fault, and it never reached the
assertion it was written for.** The test injected `__TAURI_INTERNALS__` and
nothing else, on the reasoning that `isTauri()` reads that global and nothing
else. True of the one function that DECIDES, and false of the app around it:
`tauri.conf.json` sets `withGlobalTauri`, so the real shell also has
`window.__TAURI__`, and everything else gated on `isTauri()` -- here
`DesktopProjectOpener`, mounted from the root layout -- calls
`__TAURI__.core.invoke`. Under the half-injected global `tauriApi()` threw out
of an effect, React unmounted the tree, `data-fc-ready` was never set and the
test spent its 300 s timeout on the app's boot, several layers from the
registration gate. So the fixture modelled a shell that has never shipped. It
now injects both globals, with `invoke` resolving null, which is the honest
answer for the two commands the opener sends.

**Both were mutation-probed after they went green**, since a test that passes
is worth what it costs to make it fail:

| mutation | result |
|---|---|
| the Tauri clause removed from `registrationDecision` | red: `Expected "off:tauri", Received "on"` |
| `silenceController` removed from the teardown | red: `Expected 0, Received 1` after the 15 s poll -- the original failure, exactly |
| the `disabled` guard removed from `putAndTrim` | red: the in-flight sandbox test only |

The spec passes 6/6 against both servers the gate can be pointed at: the
production export (`serve-static.mjs`, where the app really does register a
worker and the defect reproduced) and `next dev` (where it deliberately does
not).
