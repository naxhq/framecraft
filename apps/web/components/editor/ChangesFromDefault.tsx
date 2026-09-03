"use client";

import type { PrintParams } from "@/lib/contracts";
import { labelled } from "@/lib/controlCatalog";
import { changedSettings, humanisePath, uncontrolledChanges } from "@/lib/settingsDiff";
import { Note } from "./Controls";

/**
 * "12 changed", and the list behind it.
 *
 * The counter answers the question a settings panel is worst at: what have I
 * actually moved? Every row names the setting, what the contract ships it as,
 * what it is now, and reverts that one field. Reset all is the same idea with
 * no aim.
 *
 * Two boundaries this widget is careful about:
 *
 *  - **Layout is not a setting** (DECISIONS `[V3.1-O6]`). Which groups are
 *    expanded, the search query and the theme never enter `PrintParams`, so
 *    they cannot reach this list. `lib/settingsDiff.test.ts` pins that.
 *  - **A revert is one undo step.** Each row writes exactly one top-level key
 *    through the store's own setter, which is one `set()` call, which is one
 *    entry in `store/history.ts`.
 *
 * It is NOT the floating history chip (`HistoryChip.tsx`), which counts undo
 * STEPS: two chips, two questions. "Three changes" there means three steps back
 * are available, including steps that put a value back to its default; "three
 * changed" here means three fields differ from the contract right now.
 */
export function ChangesChip({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const spec = labelled("changes-chip");
  return (
    <button
      type="button"
      id="changes-chip"
      data-testid="changes-chip"
      disabled={count === 0}
      aria-expanded={open}
      aria-controls={open ? "changes-list" : undefined}
      aria-label={
        count === 0 ? "Nothing changed from the defaults" : `${count} changed from the defaults`
      }
      aria-describedby="changes-chip-hint"
      title={spec.hint}
      onClick={onToggle}
      className="flex items-center gap-1 rounded-milled border border-line bg-plate-sunken px-1.5 py-0.5 text-2xs text-ink-muted transition-colors hover:border-ink-faint hover:text-ink disabled:cursor-default disabled:opacity-45"
    >
      {count === 0 ? "no changes" : `${count} changed`}
      {count > 0 ? (
        <span aria-hidden="true" className="text-ink-faint">
          {open ? "×" : "›"}
        </span>
      ) : null}
      <span id="changes-chip-hint" className="sr-only">
        {spec.hint}
      </span>
    </button>
  );
}

/** The rows behind the counter, each with its own revert. */
export function ChangesList({
  params,
  onRevert,
}: {
  params: PrintParams;
  onRevert: (path: string) => void;
}) {
  const rows = changedSettings(params);
  const others = uncontrolledChanges(params);
  const revert = labelled("changes-revert-*");

  return (
    <div
      id="changes-list"
      data-testid="changes-list"
      className="max-h-64 shrink-0 overflow-y-auto border-b border-line bg-plate-sunken px-4 py-2"
    >
      <h3 className="mb-1.5 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-ink-faint">
        Changed from default
      </h3>
      <span id="changes-revert-hint" className="sr-only">
        {revert.hint}
      </span>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li
            key={row.path}
            data-testid="changes-row"
            className="flex items-start justify-between gap-2 rounded-milled border border-line bg-plate px-2 py-1.5"
          >
            <span className="min-w-0">
              <span className="block text-2xs font-medium text-ink">{row.label}</span>
              <span className="block text-2xs text-ink-faint">
                {row.groupTitle === "" ? row.path : row.groupTitle}: {row.defaultText} is now{" "}
                <span className="text-ink-muted">{row.currentText}</span>
              </span>
            </span>
            <button
              type="button"
              data-testid={`changes-revert-${row.path}`}
              aria-label={`Revert ${row.label} to ${row.defaultText}`}
              aria-describedby="changes-revert-hint"
              title={revert.hint}
              onClick={() => onRevert(row.path)}
              className="shrink-0 rounded-milled border border-control bg-plate-raised px-1.5 py-0.5 text-2xs text-ink transition-colors hover:border-ink-faint"
            >
              {revert.label}
            </button>
          </li>
        ))}
      </ul>
      {others.length > 0 ? (
        <div className="mt-1.5">
          <Note testId="changes-uncontrolled">
            {others.length} more {others.length === 1 ? "field differs" : "fields differ"} from the
            default with no control in the panel to put {others.length === 1 ? "it" : "them"} back:{" "}
            {others.map((path) => humanisePath(path)).join(", ")}. Reset all still does.
          </Note>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <Note testId="changes-none">
          Every setting with a control is at the value the contract ships.
        </Note>
      ) : null}
    </div>
  );
}

export default ChangesList;
