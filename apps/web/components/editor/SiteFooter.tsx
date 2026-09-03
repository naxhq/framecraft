"use client";

import { useState } from "react";

import {
  LICENCE_NAME,
  LICENCE_URL,
  REPOSITORY_URL,
  buildStamp,
  copyrightLine,
} from "@/lib/version";
import AboutDialog from "./AboutDialog";

/**
 * The line at the bottom of every page: who made this, which build it is, and
 * whose data it is built from.
 *
 * Three obligations meet here and none of them is decoration.
 *
 *  - **Attribution.** The OSM credit is a licence condition, which is why this
 *    lives in the root layout rather than in the editor: it survives every
 *    route. Photon and Nominatim join it ([V3-P9]) because the app queries
 *    both by name. The same sentence is written into the 3MF metadata, the
 *    CREDITS.txt of an export, and engraved on the model itself.
 *  - **Identity.** Product, version, commit and build date, all from
 *    `lib/version.ts` and therefore from `apps/web/package.json` and git --
 *    never typed here. A screenshot of a bug is worth answering only if it
 *    says which build it came from.
 *  - **Terms.** The repository and the licence, one click away, on the page
 *    rather than in a README nobody opens.
 *
 * The build stamp is a button, not text: it opens the About dialog, which is
 * the same dialog the desktop app shows and carries the parts a one-line
 * footer has no room for.
 */
export function SiteFooter() {
  const [aboutOpen, setAboutOpen] = useState(false);

  const dot = (
    <span aria-hidden="true" className="text-ink-faint/60">
      ·
    </span>
  );

  return (
    <>
      <footer className="fc-scored flex flex-wrap items-center justify-center gap-x-2 gap-y-1 bg-bench px-4 py-2 text-2xs text-ink-faint">
        <span aria-hidden="true" className="h-px w-6 bg-line-strong" />
        <button
          type="button"
          data-testid="about-button"
          data-build-stamp={buildStamp()}
          onClick={() => setAboutOpen(true)}
          title="What this build is"
          className="rounded-milled px-1 text-ink-muted transition-colors hover:text-ink"
        >
          {buildStamp()}
        </button>
        {dot}
        <span data-testid="footer-copyright">{copyrightLine()}</span>
        {dot}
        {/*
          The attribution sentence, unchanged and unabbreviated: the same
          string the search popover's own footer carries, where the two
          geocoding services are actually being used.
        */}
        <span data-testid="footer-attribution">
          Search by Photon (komoot), geocoding by Nominatim, map data © OpenStreetMap
          contributors
        </span>
        {dot}
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="footer-repository"
          className="text-ink-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
        >
          Repository
        </a>
        {dot}
        <a
          href={LICENCE_URL}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="footer-licence"
          className="text-ink-muted underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink"
        >
          {LICENCE_NAME} licence
        </a>
        <span aria-hidden="true" className="h-px w-6 bg-line-strong" />
      </footer>
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}

export default SiteFooter;
