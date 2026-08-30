"use client";

import dynamic from "next/dynamic";

/**
 * react-three-fiber needs a real WebGL canvas, so the preview is client-only.
 * Everything three.js-shaped is behind this boundary; `lib/preview.ts` (the
 * geometry maths) stays importable from node so it can be unit-tested.
 */
const CityPreview = dynamic(() => import("./CityPreview"), {
  ssr: false,
  loading: () => (
    <div className="fc-drafting-sheet flex h-full w-full items-center justify-center text-2xs text-ink-faint">
      Loading preview...
    </div>
  ),
});

export function PreviewPane() {
  return <CityPreview />;
}

export default PreviewPane;
