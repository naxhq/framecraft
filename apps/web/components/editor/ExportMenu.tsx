"use client";

import { notServedSentence } from "@/lib/colourMap";
import { EXPORT_TARGETS, EXPORT_TARGET_LABELS, type ExportTarget } from "@/lib/engine/export";
import { resolveProfile } from "@/lib/printers";
import { useEditorStore } from "@/store/editor";

/**
 * The export format picker, beside Export in the action bar.
 *
 * Compact on purpose: it is one control among five in a 23 rem rail, so it is
 * a native select sized to the row rather than a button wide enough to spell
 * out "Single-nozzle colour-change project (.3mf)". What a wide button would
 * have shown is not lost, though. Every option carries its one-line
 * description as a native `title`, and the SELECTED target's description is
 * rendered under the bar and pointed at by `aria-describedby`, so the answer
 * to "what does this format actually give me" is on screen for the format in
 * play and one hover away for the rest.
 *
 * Selecting a target writes `params.export_target` (through the ordinary
 * `setParam` path, so it round-trips through a share link and a project file
 * exactly like every other control) and immediately re-exports, so the
 * download links always match the format shown here. `bambu-3mf` is the
 * default, per `packages/contracts/schema/print_params.json`.
 */

/**
 * One line per target, in the terms 01 asks for: what the file IS and what
 * opens it, never how the writer works.
 *
 * `Record<ExportTarget, string>` rather than a lookup with a fallback: a
 * target added to the contract fails to compile here instead of shipping with
 * no description.
 */
export const EXPORT_TARGET_DESCRIPTIONS: Readonly<Record<ExportTarget, string>> = {
  "bambu-3mf":
    "A Bambu Studio project with every part on its own filament slot, so it opens ready to slice.",
  "generic-3mf":
    "A plain 3MF any slicer reads, as one object or one per region depending on the colour mode.",
  stl: "One STL body, the most portable format there is and the one that carries no colour.",
  "stl-parts-zip":
    "A zip holding one STL per region, so each part can be printed in its own filament.",
  obj: "An OBJ with an MTL beside it, the only target that carries the per-building colour tint.",
  step: "A faceted STEP AP214 solid, for CAD rather than for a slicer. The file is large.",
  "color-change-3mf":
    "A single-nozzle project with a colour change at each height band the geometry allows.",
};

/** Where the selected target's description is rendered, so the select can point at it. */
export const EXPORT_TARGET_DESCRIPTION_ID = "export-target-description";

export function ExportMenu() {
  const target = useEditorStore((state) => state.params.export_target ?? "bambu-3mf");
  const setParam = useEditorStore((state) => state.setParam);
  const requestExport = useEditorStore((state) => state.requestExport);

  const onChange = (value: ExportTarget): void => {
    setParam("export_target", value);
    void requestExport();
  };

  return (
    <>
      <label htmlFor="export_target" className="sr-only">
        Export format
      </label>
      <select
        id="export_target"
        data-testid="export-target-select"
        value={target}
        onChange={(event) => onChange(event.target.value as ExportTarget)}
        aria-describedby={EXPORT_TARGET_DESCRIPTION_ID}
        title="Choose a file format; Export writes it"
        className="w-24 shrink-0 rounded-milled border border-control bg-plate-raised px-1.5 text-2xs text-ink transition-colors hover:border-ink-faint"
      >
        {EXPORT_TARGETS.map((value) => (
          <option key={value} value={value} title={EXPORT_TARGET_DESCRIPTIONS[value]}>
            {EXPORT_TARGET_LABELS[value]}
          </option>
        ))}
      </select>
    </>
  );
}

/**
 * What the chosen format means, plus the two remarks that depend on the model
 * rather than on the format alone.
 *
 * Rendered in the action bar's notes area rather than under the select: a
 * three-line note inside the button row would push Preview and Export down the
 * column every time the tile count changed, which is the exact behaviour the
 * bar exists to stop.
 */
export function ExportTargetNotes() {
  const target = useEditorStore((state) => state.params.export_target ?? "bambu-3mf");
  const params = useEditorStore((state) => state.params);
  const plan = useEditorStore((state) => state.exportState.plan);
  const planIsForThisTarget =
    useEditorStore((state) => state.exportState.target) === "color-change-3mf" &&
    target === "color-change-3mf";
  const tiles = useEditorStore((state) => state.pipeline.result?.tiles);
  /**
   * Mirrors `lib/engine/export/index.ts:exportForTarget`'s own tiled-dispatch
   * condition exactly (`target === "bambu-3mf" && profile.vendor === "bambu"`):
   * that is the ONLY combination a tiled build writes as one multi-plate file.
   * Every other target -- including `color-change-3mf`, which is a plan for ONE
   * printed object and cannot become several plates of one -- comes back as a
   * zip of per-tile files (p4-engine, `[V3-P4-E5]`). Read from the real
   * dispatch condition rather than guessed a second time, so this note can
   * never drift from what an export actually produces.
   */
  const singleTiledFile = target === "bambu-3mf" && resolveProfile(params).vendor === "bambu";

  return (
    <div className="space-y-1">
      <p
        id={EXPORT_TARGET_DESCRIPTION_ID}
        data-testid="export-target-description"
        data-target={target}
        className="text-2xs leading-snug text-ink-faint"
      >
        {EXPORT_TARGET_LABELS[target]}. {EXPORT_TARGET_DESCRIPTIONS[target]}
      </p>

      {/*
        The single-nozzle target is explicitly labelled approximate: it can only
        separate regions that do not share a Z band, and which ones actually
        print in their own colour under the plan
        (`lib/engine/export/colorchange.ts:planColorChanges`'s `report[].served`,
        carried on `state.exportState.plan` once that target has been exported,
        and summarised by `lib/colourMap.ts:notServedSentence`) is shown here so
        the limitation is visible before a print starts rather than discovered
        after. `served` is the right question, not `separable`: a region can
        share Z layers with a neighbour (fail `separable`) and still get its own
        colour at the boundary (pass `served`), which the Chicago buildings do
        against the base (audit v3-02 finding 1's own follow-up note).
      */}
      {target === "color-change-3mf" && planIsForThisTarget && plan ? (
        <p data-testid="colour-change-band-report" className="text-2xs leading-snug text-ink-faint">
          {notServedSentence(plan)}
        </p>
      ) : null}

      {tiles && tiles.length > 1 ? (
        <p data-testid="tiled-export-note" className="text-2xs leading-snug text-ink-faint">
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
