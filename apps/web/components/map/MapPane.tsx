"use client";

import dynamic from "next/dynamic";

/**
 * MapLibre GL touches `window` at import time and paints into a canvas, so it
 * must never be rendered on the server. This wrapper is the only place that
 * imports it, behind `ssr: false`.
 */
const LocationPicker = dynamic(() => import("./LocationPicker"), {
  ssr: false,
  loading: () => (
    <div className="fc-drafting-sheet flex h-full w-full items-center justify-center text-2xs text-ink-faint">
      Loading map...
    </div>
  ),
});

export function MapPane() {
  return <LocationPicker />;
}

export default MapPane;
