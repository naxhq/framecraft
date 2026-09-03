"use client";

import { useState } from "react";

/**
 * The failure surface for a run that broke and an export that was refused.
 *
 * Two rules, both of them the point of the component:
 *
 *  1. **The main text is readable.** One sentence naming what failed and
 *     where, in the words the engine used. No stack, no `at Object.<anonymous>`,
 *     no JSON. A traceback in the panel tells a user nothing and hides the one
 *     sentence that would have.
 *  2. **Nothing is swallowed.** Everything a bug report needs -- the message,
 *     the failing stage, the blocking finding ids, the stack when one crossed
 *     the wire, the app version and a hash of the parameters -- is one click
 *     away on `Copy details`, and that click also reveals the block, so a
 *     browser that refuses clipboard access still leaves the text selectable
 *     (the same fallback Copy link already uses).
 */
export interface ErrorDetailModel {
  /** One line: what failed, and where. Never a stack. */
  headline: string;
  /** The stage the engine named, or null when the failure was not a stage's. */
  stage: string | null;
  /** Finding ids the export gate refused on, when that is what happened. */
  findingIds: readonly string[];
  /** The copyable block: one `key: value` per line, newline separated. */
  detail: string;
}

export function ExportErrorDetail({
  model,
  testId,
}: {
  model: ErrorDetailModel;
  /** So a run failure and an export refusal are separately addressable. */
  testId: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
  const revealed = copyState !== "idle";

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(model.detail);
      setCopyState("copied");
    } catch {
      // Permission denied, or an insecure origin. The block below is the
      // fallback and is why the text is put in the DOM rather than only on a
      // clipboard we cannot verify.
      setCopyState("manual");
    }
  };

  return (
    <div
      data-testid={testId}
      data-stage={model.stage ?? ""}
      data-findings={model.findingIds.join(",")}
      className="space-y-1.5 rounded-milled border border-danger/40 bg-danger-soft px-2 py-1.5"
    >
      <p data-testid={`${testId}-message`} className="text-2xs leading-snug text-danger">
        {model.headline}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`${testId}-copy`}
          onClick={() => void copy()}
          className="rounded-milled border border-control bg-plate px-2 py-0.5 text-2xs font-medium text-ink transition-colors hover:border-ink-faint"
        >
          {copyState === "copied" ? "Details copied" : "Copy details"}
        </button>
        {copyState === "manual" ? (
          <span className="text-2xs text-ink-faint">
            Copying was blocked, so the details are below to select.
          </span>
        ) : null}
      </div>
      {revealed ? (
        <pre
          data-testid={`${testId}-block`}
          tabIndex={0}
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-milled border border-line bg-plate-sunken p-2 text-2xs text-ink-muted"
        >
          {model.detail}
        </pre>
      ) : null}
    </div>
  );
}

export default ExportErrorDetail;
