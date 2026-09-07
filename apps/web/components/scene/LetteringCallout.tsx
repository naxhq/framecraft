"use client";

import { useMemo } from "react";
import { Html } from "@react-three/drei";

import type { RecessBand, ResolvedLine } from "@/lib/engine/types";

/**
 * What each line of frame lettering says, drawn ON the line, legibly, at any
 * zoom ([V3.1-U8]).
 *
 * Why this exists, stated plainly because the honest version is unflattering.
 * `[V3.1-U3]` fixed a real defect -- the recess band's top bound WAS the frame's
 * own lip, so the lip was darkened by exactly as much as the letters cut into
 * it and the text could not be seen at any zoom in any viewport -- and I then
 * claimed engraved text "can be seen in the preview". I had verified that with
 * a short word, in the light viewport, dollied right in. The author checked a
 * forty-character line at whole-plate zoom in the dark viewport and still could
 * not see it, which is the zoom people actually work at.
 *
 * The geometry was never the problem after that fix, and neither, mostly, was
 * the contrast: at whole-plate zoom a 4 mm cap height on a 180 mm plate is
 * about 17 screen pixels tall with strokes under two pixels wide, and nothing
 * done to the COLOUR of a sub-two-pixel stroke makes it read as a word. That is
 * a fact about the medium, so the preview has to say what the model says rather
 * than only show it. `[V3.1-U5]`'s contrast work still stands and still matters
 * once you zoom in; this is what carries the same information out to the zoom
 * where the shading cannot.
 *
 * It is a CAPTION and never a picture of the engraving: it is drawn in the
 * interface's own type, at a fixed screen size, in the viewport's ink rather
 * than the filament's, and it says what will be cut. Nothing here is an attempt
 * to fake the letters, because a preview that draws text the printer will not
 * produce is the settings complaint all over again.
 *
 * Pipeline output only, like everything else inside the canvas: the position
 * and the face come from the band the `lettering` stage emitted, and the words
 * come from `EngineResult.resolvedText`. No `PrintParams` field is read here,
 * which `CityPreview.test.ts` holds this whole directory to.
 */

/** Bands the caption is for: the frame's own lettering, and only when it names its line. */
export function calloutBands(bands: readonly RecessBand[]): RecessBand[] {
  return bands.filter(
    (band) => band.region === "frame" && band.kind === "lettering" && band.lineId !== undefined && band.xyMm !== undefined,
  );
}

/** The centre of a band's footprint, and which way the text runs. */
export function calloutPlacement(band: RecessBand): {
  x: number;
  y: number;
  z: number;
  /** True when the band is taller than it is wide, i.e. a left or right edge. */
  vertical: boolean;
} {
  const [minX, minY, maxX, maxY] = band.xyMm ?? [0, 0, 0, 0];
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: band.faceZMm ?? band.zMm[1],
    vertical: maxY - minY > maxX - minX,
  };
}

/**
 * The text a band should carry, or null.
 *
 * A line the build SKIPPED is deliberately captioned too, and says so: "not
 * cut" on the frame is the single most useful thing the viewport can tell
 * someone who typed a line and is looking for it. A skipped line has no band
 * of its own, so it never reaches this function; what does reach it is a line
 * that was cut, and the empty case is a band whose line has gone.
 */
export function calloutText(line: ResolvedLine | undefined): string | null {
  if (line === undefined) return null;
  const text = line.text.trim();
  return text === "" ? null : text;
}

export function LetteringCallout({
  bands,
  resolvedText,
  color,
}: {
  bands: readonly RecessBand[];
  resolvedText: readonly ResolvedLine[];
  /** The viewport's own ink token, so the caption reads as interface and not as filament. */
  color: string;
}) {
  const captions = useMemo(() => {
    const byId = new Map(resolvedText.map((line) => [line.id, line]));
    return calloutBands(bands)
      .map((band) => {
        const text = calloutText(byId.get(band.lineId as string));
        return text === null ? null : { band, text, key: band.lineId as string };
      })
      .filter((entry): entry is { band: RecessBand; text: string; key: string } => entry !== null);
  }, [bands, resolvedText]);

  if (captions.length === 0) return null;

  return (
    <>
      {captions.map(({ band, text, key }) => {
        const at = calloutPlacement(band);
        return (
          <Html
            key={key}
            position={[at.x, at.y, at.z]}
            center
            // Always on top of the model: a caption occluded by the buildings
            // it sits beside is a caption that failed at its one job. `zIndexRange`
            // keeps it under the panels and drawers, which are real interface.
            zIndexRange={[20, 0]}
            style={{ pointerEvents: "none" }}
          >
            <span
              data-testid="lettering-callout"
              style={{
                color,
                whiteSpace: "nowrap",
                fontSize: "10px",
                letterSpacing: "0.08em",
                // Rotated to run along a left or right edge, so the caption
                // lies the way the cut does rather than across it.
                transform: at.vertical ? "rotate(-90deg)" : undefined,
                display: "inline-block",
                // A hairline of the viewport's own background behind the text,
                // because the frame is the darkest region in every palette and
                // interface ink on it is exactly the contrast problem this
                // component exists to route around.
                padding: "1px 4px",
                borderRadius: "2px",
                background: "color-mix(in srgb, currentColor 12%, transparent)",
                backdropFilter: "blur(2px)",
              }}
            >
              {text}
            </span>
          </Html>
        );
      })}
    </>
  );
}

export default LetteringCallout;
