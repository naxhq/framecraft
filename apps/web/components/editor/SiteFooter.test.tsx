/**
 * What the footer and the About dialog actually say (Task 15).
 *
 * Rendered rather than source-scanned, and rendered with React's static
 * renderer rather than under a DOM, because this package's vitest environment
 * is `node`: `renderToStaticMarkup` runs the component tree for real, runs no
 * effects, and needs nothing to exist that does not.
 *
 * Three obligations are pinned here, and each of them has been forgotten by
 * some shipped product at some point: the attribution a licence requires, the
 * build identity a bug report needs, and the fact that neither of them is
 * TYPED into a component where it can drift from `apps/web/package.json`.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  COPYRIGHT_HOLDER,
  LICENCE_NAME,
  LICENCE_URL,
  PRODUCT_NAME,
  REPOSITORY_URL,
  buildInfo,
  buildStamp,
  copyrightLine,
} from "@/lib/version";
import AboutDialog from "./AboutDialog";
import SiteFooter from "./SiteFooter";

const footer = (): string => renderToStaticMarkup(<SiteFooter />);
const about = (): string => renderToStaticMarkup(<AboutDialog open onClose={() => {}} />);

describe("the footer", () => {
  it("names the product, the version, the commit and the build date, all from one source", () => {
    const markup = footer();
    expect(markup).toContain(buildStamp());
    expect(buildStamp()).toContain(PRODUCT_NAME);
    expect(buildStamp()).toContain(buildInfo().version);
  });

  it("carries the copyright holder", () => {
    expect(footer()).toContain(copyrightLine());
    expect(copyrightLine()).toContain(COPYRIGHT_HOLDER);
  });

  it("keeps the OpenStreetMap attribution word for word", () => {
    // A licence condition, not a credit line that may be reworded for space.
    expect(footer()).toContain("© OpenStreetMap contributors");
    expect(footer()).toContain("Photon");
    expect(footer()).toContain("Nominatim");
  });

  it("links the repository and the licence", () => {
    const markup = footer();
    expect(markup).toContain(`href="${REPOSITORY_URL}"`);
    expect(markup).toContain(`href="${LICENCE_URL}"`);
    expect(markup).toContain(`${LICENCE_NAME} licence`);
  });

  it("opens the About dialog rather than showing it, so the footer stays one line", () => {
    const markup = footer();
    expect(markup).toContain('data-testid="about-button"');
    expect(markup).not.toContain('data-testid="about-dialog"');
  });
});

describe("the About dialog", () => {
  it("is the desktop app's About window and shows the same build the footer does", () => {
    const markup = about();
    expect(markup).toContain(`About ${PRODUCT_NAME}`);
    expect(markup).toContain(buildInfo().version);
    expect(markup).toContain('data-about-row="version"');
    expect(markup).toContain('data-about-row="commit"');
    expect(markup).toContain('data-about-row="built"');
  });

  it("states the copyright, the licence and the map data terms", () => {
    const markup = about();
    expect(markup).toContain(COPYRIGHT_HOLDER);
    expect(markup).toContain(`${LICENCE_NAME} licence`);
    expect(markup).toContain("© OpenStreetMap contributors");
    expect(markup).toContain("Open Database Licence");
  });

  it("links the repository and the licence", () => {
    const markup = about();
    expect(markup).toContain(`href="${REPOSITORY_URL}"`);
    expect(markup).toContain(`href="${LICENCE_URL}"`);
  });

  it("renders nothing at all when closed", () => {
    expect(renderToStaticMarkup(<AboutDialog open={false} onClose={() => {}} />)).toBe("");
  });
});

/**
 * The identity strings must come from `lib/version.ts`, which reads them from
 * the package manifest and git. A literal typed into a component is exactly
 * the drift this task exists to remove, so it is a test failure rather than a
 * review comment.
 */
describe("no hand-maintained identity", () => {
  const sources = ["./SiteFooter.tsx", "./AboutDialog.tsx"] as const;

  it("has no version literal in either component", async () => {
    for (const source of sources) {
      const text = await readSource(source);
      expect(text, source).not.toMatch(/\b\d+\.\d+\.\d+\b/);
    }
  });

  it("has no copyright holder literal in either component", async () => {
    for (const source of sources) {
      const text = await readSource(source);
      expect(text, source).not.toContain(COPYRIGHT_HOLDER);
    }
  });
});

async function readSource(relative: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  return readFile(join(dirname(fileURLToPath(import.meta.url)), relative), "utf-8");
}
