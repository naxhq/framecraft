import type { Metadata } from "next";
import type { ReactNode } from "react";

import DesktopProjectOpener from "@/components/editor/DesktopProjectOpener";
import SiteFooter from "@/components/editor/SiteFooter";

/*
 * Both typefaces are SELF-HOSTED: these two imports pull the woff2 files out
 * of node_modules and Next serves them from this origin under
 * /_next/static/media. Nothing is fetched from fonts.googleapis.com or
 * fonts.gstatic.com at runtime, which `e2e/ui.spec.ts` asserts. Licences:
 * apps/web/licences/ (both SIL OFL 1.1).
 */
import "@fontsource-variable/archivo";
import "@fontsource-variable/ibm-plex-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "FrameCraft",
  description:
    "Turn a map location into a 3D-printable framed miniature city.",
};

/**
 * Applied before the first paint so the theme never flashes. Mirrors
 * `store/editor.ts`: localStorage key `framecraft-theme`, falling back to the
 * OS preference on first visit.
 */
const THEME_BOOTSTRAP = `
(function () {
  try {
    var stored = window.localStorage.getItem("framecraft-theme");
    var dark = stored
      ? stored === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  } catch (e) {}
})();
`;

/**
 * The first-run status line.
 *
 * What it is NOT: a skeleton. The static export prerenders the whole editor,
 * so a visitor sees the real shell at first contentful paint (104 ms median on
 * the deployed site, `docs/handoff/v3-00-baseline.md` 1.1) with no JavaScript
 * run yet. Covering that with a placeholder would replace a real paint with a
 * fake one. What the shell cannot show is that the map pane and the editor are
 * still arriving, which on a slow link is the difference between "loading" and
 * "hung", and that is the only thing this line says.
 *
 * Three rules it keeps:
 *   - It is hidden in the HTML and revealed only after 300 ms, so a fast load
 *     never flashes it and a browser with JavaScript off never shows it.
 *   - It says only what is true. The manifold WASM kernel is NOT part of a
 *     first run (it is fetched on the first build, baseline section a), so
 *     this line never claims to be loading a 3D engine.
 *   - It cannot outlive the load. It is removed when the editor has mounted
 *     and the map canvas exists, and unconditionally at the cap, so no idle
 *     state can ever keep it on screen (v3-02's finding on idle skeletons).
 */
const BOOT_STATUS = `
(function () {
  var el = document.getElementById("fc-boot");
  if (!el) return;
  var label = document.getElementById("fc-boot-label");
  var REVEAL_MS = 300;
  var MAP_GRACE_MS = 3000;
  var CAP_MS = 10000;
  var shown = false;
  var finished = false;
  var mapDeadline = 0;
  var timer = 0;
  var started = Date.now();

  function finish() {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    if (el.parentNode) el.parentNode.removeChild(el);
  }
  function ready() {
    return document.documentElement.getAttribute("data-fc-ready") === "1";
  }
  function mapReady() {
    return document.querySelector(".maplibregl-canvas") !== null;
  }
  function tick() {
    var elapsed = Date.now() - started;
    if (elapsed >= CAP_MS) { finish(); return; }
    if (ready()) {
      if (mapReady()) { finish(); return; }
      if (mapDeadline === 0) mapDeadline = elapsed + MAP_GRACE_MS;
      if (elapsed >= mapDeadline) { finish(); return; }
      if (shown && label) label.textContent = "Loading the map";
      return;
    }
    if (!shown && elapsed >= REVEAL_MS) {
      shown = true;
      el.removeAttribute("hidden");
    }
  }
  timer = setInterval(tick, 100);
  tick();
})();
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="flex min-h-screen flex-col bg-bench text-ink">
        {/*
          Renders nothing. It is here, and not inside the editor, so that a
          project file the desktop app was launched with (or double-clicked
          while it was already running) cannot arrive while a route is still
          mounting. A no-op in a browser tab.
        */}
        <DesktopProjectOpener />
        <main className="flex-1">{children}</main>
        <div
          id="fc-boot"
          hidden
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-md border border-line-strong bg-plate-raised px-3 py-1.5 text-2xs text-ink-muted shadow-lg"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
          <span id="fc-boot-label">Starting FrameCraft</span>
        </div>
        {/*
          The footer is in the LAYOUT, not in the editor, because the OSM
          attribution it carries is a licence obligation and has to survive
          every route; the same credit is written into the 3MF metadata and
          CREDITS.txt by the export. It also names the build (version, commit,
          date) and the copyright holder, all of them read from
          `lib/version.ts` rather than typed. See `components/editor/SiteFooter`.
        */}
        <SiteFooter />
        {/* Last in the body, so `document.body` and #fc-boot both exist when it runs. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT_STATUS }} />
      </body>
    </html>
  );
}
