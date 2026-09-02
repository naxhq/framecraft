"use client";

import { notServedSentence } from "@/lib/colourMap";
import { EXPORT_TARGETS, EXPORT_TARGET_LABELS, type ExportTarget } from "@/lib/engine/export";
import { resolveProfile } from "@/lib/printers";
import { useEditorStore } from "@/store/editor";

/**
 * The export format picker next to Export.
 *
 * Selecting a target writes `params.export_target` (through the ordinary
 * `setParam` path, so it round-trips through a share link and a project file
 * exactly like every other control) and immediately re-exports, so the download
 * links below always match the format shown here. `bambu-3mf` is the default,
 * per `packages/contracts/schema/print_params.json`.
 *
 * The single-nozzle colour-change target is explicitly labelled approximate:
 * it can only separate regions that do not share a Z band, and which ones
 * actually print in their own colour under the plan
 * (`lib/engine/export/colorchange.ts:planColorChanges`'s `report[].served`,
 * carried on `state.exportState.plan` once that target has actually been exported, and
 * summarised by `lib/colourMap.ts:notServedSentence`) is shown underneath so
 * the limitation is visible before a print starts, not discovered after.
 * `served` is the right question, not `separable`: a region can share Z
 * layers with a neighbour (fail `separable`) and still get its own colour at
 * the boundary (pass `served`), which the Chicago buildings do against the
 * base (audit v3-02 finding 1's own follow-up note).
 */
export function ExportMenu() {
  const params = useEditorStore((state) => state.params);
  const target = params.export_target ?? "bambu-3mf";
  const setParam = useEditorStore((state) => state.setParam);
  const requestExport = useEditorStore((state) => state.requestExport);
  const plan = useEditorStore((state) => state.exportState.plan);
  const planIsForThisTarget =
    useEditorStore((state) => state.exportState.target) === "color-change-3mf" && target === "color-change-3mf";
  const tiles = useEditorStore((state) => state.engine.result?.tiles);
  /**
   * Mirrors `lib/engine/export/index.ts:exportForTarget`'s own tiled-dispatch
   * condition exactly (`target === "bambu-3mf" && profile.vendor === "bambu"`):
   * that is the ONLY combination a tiled build writes as one multi-plate file.
   * Every other target -- including `color-change-3mf`, which is a plan for
   * ONE printed object and cannot become several plates of one -- comes back
   * as a zip of per-tile files (p4-engine, `[V3-P4-E5]`). Read from the real
   * dispatch condition rather than guessed a second time, so this note can
   * never drift from what an export actually produces.
   */
  const singleTiledFile = target === "bambu-3mf" && resolveProfile(params).vendor === "bambu";

  const onChange = (value: ExportTarget): void => {
    setParam("export_target", value);
    void requestExport();
  };

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <label htmlFor="export_target" className="sr-only">
        Export format
      </label>
      <select
        id="export_target"
        data-testid="export-target-select"
        value={target}
        onChange={(event) => onChange(event.target.value as ExportTarget)}
        title="Choose a file format; Export writes it"
        className="h-full rounded-milled border border-control bg-plate-raised px-2 py-2 text-sm text-ink transition-colors hover:border-ink-faint"
      >
        {EXPORT_TARGETS.map((value) => (
          <option key={value} value={value}>
            {EXPORT_TARGET_LABELS[value]}
          </option>
        ))}
      </select>
      {target === "color-change-3mf" && planIsForThisTarget && plan ? (
        <p
          data-testid="colour-change-band-report"
          className="max-w-[16rem] text-2xs leading-snug text-ink-faint"
        >
          Approximate: one nozzle, colour changes at the height bands the
          geometry allows. {notServedSentence(plan)}
        </p>
      ) : null}

      {tiles && tiles.length > 1 ? (
        <p
          data-testid="tiled-export-note"
          className="max-w-[16rem] text-2xs leading-snug text-ink-faint"
        >
          Tiling is on: {tiles.length} tiles ({tiles.map((tile) => tile.label).join(", ")}).{" "}
          {singleTiledFile
            ? `${tiles.length} tiles, one plate each, in a single Bambu Studio project.`
            : `${tiles.length} tiles, one ${EXPORT_TARGET_LABELS[target]} file each, in a zip named by tile.`}
        </p>
      ) : null}
    </div>
  );
}

export default ExportMenu;
