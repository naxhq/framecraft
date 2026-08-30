"use client";

import { useMemo } from "react";

import { sceneWarnings, warningDeps } from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";

/**
 * Coverage, estimated-height and 60 mm-ceiling warnings (01/A2, 03 "Height
 * inference", 04 stage 4). The `block` level ones also disable Bake -- see
 * `lib/warnings.ts`, which owns the thresholds so the banner and the button can
 * never disagree.
 */
export function WarningBanners() {
  const graph = useEditorStore((state) => state.scene.graph);
  const status = useEditorStore((state) => state.scene.status);
  const message = useEditorStore((state) => state.scene.message);
  const stale = useEditorStore((state) => state.scene.stale);
  const params = useEditorStore((state) => state.params);

  // Cheap: one pass over the buildings for the 60 mm height guard, and the
  // scene is already in memory. Memoised on the primitives that move it so a
  // theme toggle or a bake poll does not recompute it.
  const warnings = useMemo(
    () => sceneWarnings(graph, params),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    warningDeps(graph, params),
  );

  return (
    <div className="space-y-2" data-testid="warnings">
      {status === "error" && message ? (
        <Banner tone="error" testId="scene-error">
          Could not load the scene: {message}
        </Banner>
      ) : null}

      {stale && graph ? (
        <Banner tone="info" testId="scene-stale">
          The location changed. Click Generate to refresh the preview.
        </Banner>
      ) : null}

      {warnings.map((warning) => (
        <Banner
          key={warning.id}
          tone={warning.level === "block" ? "error" : "warn"}
          testId={`warning-${warning.id}`}
        >
          {warning.message}
        </Banner>
      ))}
    </div>
  );
}

const TONES = {
  info: "border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200",
  warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200",
  error:
    "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
} as const;

function Banner({
  tone,
  testId,
  children,
}: {
  tone: keyof typeof TONES;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <p
      role="status"
      data-testid={testId}
      className={`rounded-md border px-3 py-2 text-xs ${TONES[tone]}`}
    >
      {children}
    </p>
  );
}

export default WarningBanners;
