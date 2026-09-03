"use client";

import { useCallback } from "react";

import { PARAM_RANGES, type Label } from "@/lib/contracts";
import type { ResolvedLine } from "@/lib/engine/types";
import {
  LABEL_TEXT_MAX,
  labelCapMessage,
  labelCountText,
  labelDisplayText,
  labelKeyAction,
  labelSurfaceWord,
} from "@/lib/labelAnchor";
import { useEditorStore } from "@/store/editor";
import { Segmented, SelectField, Slider, TextField, Toggle } from "./Controls";

/**
 * The surface labels, listed (v3.1 Task 12).
 *
 * The viewport is where a label is placed and dragged (`scene/LabelGizmo.tsx`
 * moves it, the right-click inspector creates it); this card, docked in the
 * viewport's corner, is where it is NAMED and SET: the text, the cap height,
 * engrave or emboss, the depth, the face, and for a street whether the name
 * follows the bend. It is also the count against the cap, shown from the
 * first label on so the twelfth is never a surprise, and the one place a
 * refused label says why -- "not cut" with the engine's own reason, which is
 * the reason the export's sidecar carries.
 *
 * Every field writes one `labels[]` row through the store's label actions,
 * which clamp into the contract range and land in the undo history like any
 * slider. The card is mounted OUTSIDE the canvas (`scene/PreviewPane.tsx`), so
 * it may read the parameters it edits; nothing inside the canvas may.
 *
 * Its controls are catalogued in `lib/controlCatalog.ts` under `label_*_...`
 * and write `object-override` rather than naming leaves, for the same reason
 * the inspector's do: a section reset must never wipe a placed label.
 */
export function LabelsPanel() {
  const labels = useEditorStore((state) => state.params.labels ?? NO_LABELS);
  const graph = useEditorStore((state) => state.scene.graph);
  const selected = useEditorStore((state) => state.selectedLabel);
  const capHit = useEditorStore((state) => state.labelCapHit);
  const fresh = useEditorStore((state) => state.pipeline.status === "ready" && !state.pipeline.stale);
  const resolved = useEditorStore((state) => state.pipeline.result?.resolvedText ?? NO_LINES);
  const selectLabel = useEditorStore((state) => state.selectLabel);
  const patchLabel = useEditorStore((state) => state.patchLabel);
  const nudgeLabel = useEditorStore((state) => state.nudgeLabel);
  const turnLabel = useEditorStore((state) => state.turnLabel);
  const resizeLabel = useEditorStore((state) => state.resizeLabel);
  const removeLabel = useEditorStore((state) => state.removeLabel);

  const onRowKeyDown = useCallback(
    (index: number) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const action = labelKeyAction(event);
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      switch (action.kind) {
        case "nudge":
          nudgeLabel(index, action.dxMm, action.dyMm);
          break;
        case "turn":
          turnLabel(index, action.deltaDeg);
          break;
        case "resize":
          resizeLabel(index, action.deltaMm);
          break;
        case "remove":
          removeLabel(index);
          break;
        case "deselect":
          selectLabel(null);
          break;
        default: {
          const never: never = action;
          throw new Error(`unknown label key action ${String(never)}`);
        }
      }
    },
    [nudgeLabel, removeLabel, resizeLabel, selectLabel, turnLabel],
  );

  if (labels.length === 0 && !capHit) return null;

  return (
    <section
      data-testid="labels-panel"
      aria-label="Surface labels"
      className="pointer-events-auto absolute right-3 top-12 flex max-h-[60%] w-60 flex-col overflow-y-auto rounded-milled border border-line bg-plate/95 p-2 text-2xs text-ink shadow-raised"
    >
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-2xs font-semibold text-ink">Labels</h2>
        <p data-testid="labels-count" className="text-ink-muted">
          {labelCountText(labels.length)}
        </p>
      </header>
      {capHit ? (
        <p data-testid="labels-cap" role="alert" className="mt-1 text-ink-muted">
          {labelCapMessage()}
        </p>
      ) : null}
      <ul role="list" aria-label="Placed labels" className="mt-1.5 flex flex-col gap-1">
        {labels.map((label, index) => {
          const line = fresh ? resolved.find((row) => row.id === `label-${index}`) : undefined;
          const status = line === undefined ? "pending" : line.status === "cuts" ? "cut" : "skipped";
          const isSelected = selected === index;
          return (
            <li
              key={index}
              data-testid={`label-item-${index}`}
              data-label-layer={label.layer}
              data-label-u={label.u ?? PARAM_RANGES.labels.u.default}
              data-label-v={label.v ?? PARAM_RANGES.labels.v.default}
              data-label-rotation={label.rotation_deg ?? PARAM_RANGES.labels.rotation_deg.default}
              data-label-size={label.size_mm ?? PARAM_RANGES.labels.size_mm.default}
              data-label-status={status}
              className={`rounded-milled border ${isSelected ? "border-line-strong" : "border-transparent"}`}
            >
              <button
                type="button"
                data-testid={`label-row-${index}`}
                aria-pressed={isSelected}
                aria-label={`Label ${index + 1}, ${labelDisplayText(label, graph)}, on the ${labelSurfaceWord(label.layer)}${
                  status === "skipped" ? ", not cut" : ""
                }`}
                onClick={() => selectLabel(isSelected ? null : index)}
                onKeyDown={onRowKeyDown(index)}
                className="flex w-full items-baseline justify-between gap-2 rounded-milled px-1.5 py-1 text-left hover:bg-plate-raised focus-visible:outline-none"
              >
                <span className="truncate font-medium text-ink">{labelDisplayText(label, graph)}</span>
                <span className="shrink-0 text-ink-faint">
                  {labelSurfaceWord(label.layer)}
                  {status === "skipped" ? " · not cut" : ""}
                </span>
              </button>
              {isSelected ? (
                <LabelFields
                  index={index}
                  label={label}
                  placeholder={labelDisplayText({ ...label, text: "" }, graph)}
                  line={line}
                  onPatch={patchLabel}
                  onRemove={removeLabel}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const NO_LABELS: readonly Label[] = [];
const NO_LINES: readonly ResolvedLine[] = [];

const MODES = [
  { value: "engrave", label: "Engrave" },
  { value: "emboss", label: "Emboss" },
] as const;

const FONTS = [
  { value: "sans", label: "Sans" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
] as const;

/** The selected label's own fields. */
function LabelFields({
  index,
  label,
  placeholder,
  line,
  onPatch,
  onRemove,
}: {
  index: number;
  label: Label;
  /** What the label says when its text is empty: the target's OSM name. */
  placeholder: string;
  line: ResolvedLine | undefined;
  onPatch: (index: number, patch: Partial<Omit<Label, "target_osm_id" | "layer" | "surface">>) => void;
  onRemove: (index: number) => void;
}) {
  const size = label.size_mm ?? PARAM_RANGES.labels.size_mm.default;
  const depth = label.depth_mm ?? PARAM_RANGES.labels.depth_mm.default;
  const rotation = label.rotation_deg ?? PARAM_RANGES.labels.rotation_deg.default;
  return (
    <div className="flex flex-col gap-2 border-t border-line px-1.5 pb-1.5 pt-2">
      {line !== undefined && line.status === "skipped" ? (
        <p data-testid={`label-item-${index}-reason`} role="status" className="text-ink-muted">
          Not cut: {line.reason ?? "the engine gave no reason"}
        </p>
      ) : null}
      <TextField
        id={`label_${index}_text`}
        label="Text"
        value={label.text ?? ""}
        placeholder={placeholder}
        maxLength={LABEL_TEXT_MAX}
        meta={`${(label.text ?? "").length}/${LABEL_TEXT_MAX}`}
        onChange={(text) => onPatch(index, { text })}
      />
      <Slider
        id={`label_${index}_size`}
        label="Cap height"
        value={size}
        min={PARAM_RANGES.labels.size_mm.min}
        max={PARAM_RANGES.labels.size_mm.max}
        step={0.25}
        display={`${size.toFixed(2)} mm`}
        onChange={(size_mm) => onPatch(index, { size_mm })}
      />
      <Segmented
        id={`label_${index}_mode`}
        label="Cut"
        value={label.mode ?? "engrave"}
        options={MODES}
        onChange={(mode) => onPatch(index, { mode })}
      />
      <Slider
        id={`label_${index}_depth`}
        label={label.mode === "emboss" ? "Height" : "Depth"}
        value={depth}
        min={PARAM_RANGES.labels.depth_mm.min}
        max={PARAM_RANGES.labels.depth_mm.max}
        step={0.05}
        display={`${depth.toFixed(2)} mm`}
        onChange={(depth_mm) => onPatch(index, { depth_mm })}
      />
      <SelectField
        id={`label_${index}_font`}
        label="Face"
        value={label.font ?? "sans"}
        options={FONTS}
        onChange={(font) => onPatch(index, { font })}
      />
      <Slider
        id={`label_${index}_rotation`}
        label="Turn"
        value={rotation}
        min={PARAM_RANGES.labels.rotation_deg.min}
        max={PARAM_RANGES.labels.rotation_deg.max}
        step={1}
        display={`${rotation.toFixed(0)}°`}
        onChange={(rotation_deg) => onPatch(index, { rotation_deg })}
      />
      {label.layer === "road" ? (
        <Toggle
          id={`label_${index}_follow`}
          label="Follow the street"
          checked={label.follow ?? false}
          onChange={(follow) => onPatch(index, { follow })}
        />
      ) : null}
      <button
        type="button"
        data-testid={`label_${index}_remove`}
        onClick={() => onRemove(index)}
        className="self-start rounded-milled border border-control px-2 py-1 text-2xs text-ink hover:border-ink-faint"
      >
        Remove label
      </button>
    </div>
  );
}

export default LabelsPanel;
