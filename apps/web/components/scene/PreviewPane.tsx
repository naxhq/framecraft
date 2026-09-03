"use client";

import dynamic from "next/dynamic";

import PerfHud from "@/components/editor/PerfHud";
import { useEditorStore } from "@/store/editor";

/**
 * react-three-fiber needs a real WebGL canvas, so the preview is client-only.
 * Everything three.js-shaped is behind this boundary; `lib/preview.ts` (the
 * footprint maths the pick proxies use) stays importable from node so it can
 * be unit-tested.
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
 * The viewport column: the preview, its own light/dark switch, and the perf
 * readout when perf mode is on.
 *
 * The viewport theme lives HERE rather than in the settings panel (v3.1): it
 * changes nothing about the object and nothing about the exported bytes, so it
 * is a property of looking at the model, not of the model. It is one of the
 * four matrix exemptions for exactly that reason (`[V3.1-P1-2]`), and putting
 * it on the viewport is what makes the exemption honest -- everything left in
 * the settings panel moves both the preview and the file. It still writes the
 * same `colour.preview_theme` field, so a project file and a shared link
 * round-trip it unchanged.
 *
 * `data-fc-viewport-theme` sits on this wrapper, not on the canvas, so the
 * tokens it selects (`app/globals.css`) are inherited by the empty and
 * skeleton states too, and `PerfHud` renders `null` unless perf mode is on --
 * it lives out here so it survives those states, since a cold load with no
 * scene yet is exactly when the bundle and WASM rows are worth reading.
 */
export function PreviewPane() {
  const previewTheme = useEditorStore((state) => state.params.colour?.preview_theme ?? "dark");
  const setNested = useEditorStore((state) => state.setNested);

  return (
    <div className="relative h-full w-full" data-fc-viewport-theme={previewTheme}>
      <CityPreview />
      <PerfHud />
      {/*
        Docked top-right so it never collides with the adjustments and issues
        badges at top-left.
      */}
      <div className="pointer-events-none absolute right-3 top-3">
        <button
          type="button"
          data-testid="preview-theme-toggle"
          aria-label={`Switch preview to ${previewTheme === "dark" ? "light" : "dark"}`}
          title={`Preview theme: ${previewTheme}`}
          onClick={() =>
            setNested("colour", { preview_theme: previewTheme === "dark" ? "light" : "dark" })
          }
          className="pointer-events-auto rounded-milled border border-control bg-plate/95 px-2 py-1 text-2xs text-ink shadow-raised transition-colors hover:border-ink-faint"
        >
          {previewTheme === "dark" ? "Dark viewport" : "Light viewport"}
        </button>
      </div>
    </div>
  );
}

export default PreviewPane;
