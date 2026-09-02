"use client";

import dynamic from "next/dynamic";

import PerfHud from "@/components/editor/PerfHud";

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

/**
 * The viewport column: the preview, plus the perf readout when perf mode is on.
 *
 * `PerfHud` renders `null` unless `?perf=1` (or the stored preference) is set,
 * and it lives out here rather than inside `CityPreview` so it survives the
 * empty/skeleton states -- a cold load with no scene yet is exactly when the
 * bundle and WASM rows are worth reading.
 */
export function PreviewPane() {
  return (
    <div className="relative h-full w-full">
      <CityPreview />
      <PerfHud />
    </div>
  );
}

export default PreviewPane;
