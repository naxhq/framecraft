"use client";

import { EXPORT_TARGETS, EXPORT_TARGET_LABELS, type ExportTarget } from "@/lib/engine/export";
import { useEditorStore } from "@/store/editor";

/**
 * The export format picker next to Bake.
 *
 * Selecting a target writes `params.export_target` (through the ordinary
 * `setParam` path, so it round-trips through a share link and a project file
 * exactly like every other control) and immediately re-bakes, so the download
 * links below always match the format shown here. `bambu-3mf` is the default,
 * per `packages/contracts/schema/print_params.json`.
 *
 * The single-nozzle colour-change target is explicitly labelled approximate:
 * it can only separate regions that do not share a Z band, and the report of
 * which ones do not (`lib/engine/export/colorchange.ts:planColorChanges`,
 * carried on `state.bake.plan` once that target has actually been baked)
 * is shown underneath so the limitation is visible before a print starts,
 * not discovered after.
 */
export function ExportMenu() {
  const target = useEditorStore((state) => state.params.export_target ?? "bambu-3mf");
  const setParam = useEditorStore((state) => state.setParam);
  const requestBake = useEditorStore((state) => state.requestBake);
  const plan = useEditorStore((state) => state.bake.plan);
  const planIsForThisTarget =
    useEditorStore((state) => state.bake.target) === "color-change-3mf" && target === "color-change-3mf";

  const onChange = (value: ExportTarget): void => {
    setParam("export_target", value);
    void requestBake();
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
        title="Choose a file format; Bake exports it"
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
          geometry allows.{" "}
          {plan.inseparable.length > 0
            ? `${plan.inseparable.join(", ")} share layers with another region and print in whatever colour is loaded.`
            : "Every region separates cleanly by height."}
        </p>
      ) : null}
    </div>
  );
}

export default ExportMenu;
