"use client";

import { useEffect, useRef, useState } from "react";

import { isTauri } from "@/lib/platform";
import {
  LICENCE_NAME,
  LICENCE_URL,
  OSM_CREDIT,
  PRODUCT_NAME,
  REPOSITORY_URL,
  buildDateLabel,
  buildInfo,
  commitLabel,
  copyrightLine,
} from "@/lib/version";

/**
 * What this build is, in one place a bug report can be copied from.
 *
 * Reached from the footer's build stamp in a browser tab, and it is the
 * desktop app's About dialog: the desktop shell renders this same bundle, so
 * giving it a second, native About window would mean maintaining two answers
 * to one question and letting them drift. What it adds over the footer line is
 * the full ISO build instant, the licence terms in words, and which of the two
 * runtimes is showing it -- the three things a footer has no room for and a
 * bug report always needs.
 *
 * The modal mechanics mirror `ShortcutSheet`: `role="dialog"` + `aria-modal`,
 * focus moved in on open and returned on close, Escape and a backdrop click
 * both dismiss, and Tab is kept inside.
 */
export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  /*
    Resolved after mount, never during render.

    `isTauri()` reads `window`, and this component is inside a statically
    prerendered tree: asking during render would make the server's HTML and the
    browser's first render disagree about a line of text, which is a hydration
    error rather than a nice touch.
  */
  const [runtime, setRuntime] = useState<string>("");
  useEffect(() => {
    setRuntime(isTauri() ? "Desktop app" : "Web app");
  }, []);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = (document.activeElement as HTMLElement) ?? null;
    panelRef.current?.focus();
    return () => {
      returnFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Version", buildInfo().version],
    ["Commit", commitLabel()],
    ["Built", buildDateLabel() === "" ? "unknown" : buildDateLabel()],
    ...(runtime === "" ? [] : [["Running as", runtime] as const]),
  ];

  return (
    <div
      data-testid="about-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bench/80 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = panelRef.current?.querySelectorAll<HTMLElement>("a[href], button");
          if (!focusable || focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="w-full max-w-sm rounded-panel border border-line bg-plate p-5 shadow-lifted"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2
              id="about-dialog-title"
              className="font-display text-md font-semibold tracking-tight text-ink"
            >
              About {PRODUCT_NAME}
            </h2>
            <p className="mt-0.5 text-2xs text-ink-faint">
              Turn a map location into a 3D-printable framed miniature city.
            </p>
          </div>
          <button
            type="button"
            data-testid="about-dialog-close"
            onClick={onClose}
            aria-label={`Close the About ${PRODUCT_NAME} dialog`}
            className="rounded-milled border border-control px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
          >
            Close
          </button>
        </div>

        <dl className="space-y-2" data-testid="about-rows">
          {rows.map(([label, value]) => (
            <div key={label} data-about-row={label.toLowerCase()} className="flex items-baseline justify-between gap-4">
              <dt className="text-2xs text-ink-faint">{label}</dt>
              <dd className="text-right text-2xs tabular-nums text-ink">{value}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-4 text-2xs text-ink-muted" data-testid="about-copyright">
          {copyrightLine()}. Released under the {LICENCE_NAME} licence.
        </p>

        {/*
          The OSM credit is a licence obligation and appears wherever the
          product identifies itself: here, in the page footer, engraved on the
          model, in the exported file's metadata and in its CREDITS.txt.
        */}
        <p className="mt-1 text-2xs text-ink-muted" data-testid="about-attribution">
          Map data {OSM_CREDIT}, available under the Open Database Licence.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <a
            href={REPOSITORY_URL}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="about-repository"
            className="rounded-milled border border-control px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
          >
            Repository
          </a>
          <a
            href={LICENCE_URL}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="about-licence"
            className="rounded-milled border border-control px-2 py-1 text-2xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink"
          >
            {LICENCE_NAME} licence
          </a>
        </div>
      </div>
    </div>
  );
}

export default AboutDialog;
