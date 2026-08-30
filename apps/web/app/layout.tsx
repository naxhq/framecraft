import type { Metadata } from "next";
import type { ReactNode } from "react";
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
      <body className="flex min-h-screen flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <main className="flex-1">{children}</main>
        <footer className="border-t border-neutral-200 py-3 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          © OpenStreetMap contributors
        </footer>
      </body>
    </html>
  );
}
