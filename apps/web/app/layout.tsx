import type { Metadata } from "next";
import type { ReactNode } from "react";

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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="flex min-h-screen flex-col bg-bench text-ink">
        <main className="flex-1">{children}</main>
        {/*
          The OSM attribution is a licence obligation, not decoration: it is in
          the layout so it survives every route, and it is also written into the
          3MF metadata and CREDITS.txt by the export.
        */}
        <footer className="fc-scored flex items-center justify-center gap-2 bg-bench px-4 py-2 text-2xs text-ink-faint">
          <span aria-hidden="true" className="h-px w-6 bg-line-strong" />
          <span>Map data © OpenStreetMap contributors</span>
          <span aria-hidden="true" className="h-px w-6 bg-line-strong" />
        </footer>
      </body>
    </html>
  );
}
