"use client";

import MapPane from "@/components/map/MapPane";
import PreviewPane from "@/components/scene/PreviewPane";
import BakeButton from "./BakeButton";
import ParamPanel from "./ParamPanel";
import PresetRow from "./PresetRow";
import StatsCard from "./StatsCard";
import ThemeToggle from "./ThemeToggle";
import WarningBanners from "./WarningBanners";

/**
 * The editor layout from 01's user flow: map + presets on the left, the live
 * 3D preview in the middle, the parameter panel and the Generate / Bake column
 * on the right. The persistent "© OpenStreetMap contributors" footer lives in
 * app/layout.tsx so it survives every route.
 */
export function EditorShell() {
  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <div className="flex items-baseline gap-3">
          <h1 className="text-base font-semibold">FrameCraft</h1>
          <p className="hidden text-xs text-neutral-500 sm:block dark:text-neutral-400">
            Pick a spot, tune it, print it.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)_22rem]">
        <section className="flex min-h-0 flex-col border-neutral-200 lg:border-r dark:border-neutral-800">
          <div className="border-b border-neutral-200 p-3 dark:border-neutral-800">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Presets
            </h2>
            <PresetRow />
          </div>
          <div className="min-h-64 flex-1">
            <MapPane />
          </div>
        </section>

        <section className="flex min-h-0 flex-col">
          <div className="min-h-64 flex-1">
            <PreviewPane />
          </div>
          <div className="border-t border-neutral-200 p-3 dark:border-neutral-800">
            <WarningBanners />
          </div>
        </section>

        <aside className="flex min-h-0 flex-col border-neutral-200 lg:border-l dark:border-neutral-800">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ParamPanel />
          </div>
          <div className="space-y-3 border-t border-neutral-200 p-4 dark:border-neutral-800">
            <BakeButton />
            <StatsCard />
          </div>
        </aside>
      </div>
    </div>
  );
}

export default EditorShell;
