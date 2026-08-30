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
    <div className="flex h-full w-full items-center justify-center bg-neutral-100 text-xs text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
      Loading preview...
    </div>
  ),
});

export function PreviewPane() {
  return <CityPreview />;
}

export default PreviewPane;
