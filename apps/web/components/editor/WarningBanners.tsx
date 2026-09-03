"use client";

import { useMemo } from "react";

import { blockingWarnings } from "@/lib/adjustments";
import { sceneWarnings, warningDeps } from "@/lib/warnings";
import { useEditorStore } from "@/store/editor";

/**
 * The things that must never be collapsed: a scene that failed to load, a
 * location that has moved away from the model on screen, and the two warnings
 * that disable Export (01/A2 coverage, 04 stage 4's 60 mm ceiling).
 *
 * Everything else -- widened footprints, dropped patches, estimated heights,
 * the build's own remarks -- is informational and lives in the adjustments chip
 * over the viewport. The split is `lib/adjustments.ts`; the thresholds are
 * `lib/warnings.ts`, so the banner, the chip and the disabled button can never
 * disagree.
 */
export function WarningBanners() {
  const graph = useEditorStore((state) => state.scene.graph);
  const status = useEditorStore((state) => state.scene.status);
  const message = useEditorStore((state) => state.scene.message);
  const stale = useEditorStore((state) => state.scene.stale);
  const params = useEditorStore((state) => state.params);
  const shareNotice = useEditorStore((state) => state.shareNotice);
  const setShareNotice = useEditorStore((state) => state.setShareNotice);

  // Cheap: one pass over the buildings for the 60 mm height guard, and the
  // scene is already in memory. Memoised on the primitives that move it so a
  // theme toggle or an export does not recompute it.
  const blocking = useMemo(
    () => blockingWarnings(sceneWarnings(graph, params)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    warningDeps(graph, params),
  );

  const hasAny =
    (status === "error" && message) ||
    (stale && graph) ||
    blocking.length > 0 ||
    shareNotice !== null;
  if (!hasAny) return <div data-testid="warnings" className="hidden" />;

  return (
    <div data-testid="warnings" className="space-y-1.5 px-3 pt-3">
      {/*
        A restored design that has something to say: a shared link that could
        not be applied, or a project file that loaded from an older format
        (Task 13). Informational rather than an error -- nothing is broken --
        but it has to be SAID, or a link that silently did nothing reads as a
        bug in the product rather than as damage to the link, and a project
        that quietly changed format gives no clue why the next save writes a
        differently named file. Dismissible, because it is about a thing that
        already happened.
      */}
      {shareNotice !== null ? (
        <div
          role="status"
          data-testid="share-notice"
          className="flex items-start gap-2 rounded-milled border border-accent/40 bg-accent-soft px-3 py-2 text-2xs leading-snug text-ink"
        >
          <span className="min-w-0 flex-1">
            {shareNotice.charAt(0).toUpperCase() + shareNotice.slice(1)}
          </span>
          <button
            type="button"
            data-testid="share-notice-dismiss"
            aria-label="Dismiss this message"
            onClick={() => setShareNotice(null)}
            className="shrink-0 rounded-[2px] px-1 text-ink-muted transition-colors hover:text-ink"
          >
            ×
          </button>
        </div>
      ) : null}

      {status === "error" && message ? (
        <Banner tone="error" testId="scene-error">
          Could not load the scene: {message}
        </Banner>
      ) : null}

      {stale && graph ? (
        <Banner tone="info" testId="scene-stale">
          The location moved. Preview to rebuild the model for it.
        </Banner>
      ) : null}

      {blocking.map((warning) => (
        <Banner key={warning.id} tone="error" testId={`warning-${warning.id}`}>
          {warning.message}
        </Banner>
      ))}
    </div>
  );
}

const TONES = {
  info: "border-accent/40 bg-accent-soft text-ink",
  error: "border-danger/50 bg-danger-soft text-danger",
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
      className={`rounded-milled border px-3 py-2 text-2xs leading-snug ${TONES[tone]}`}
    >
      {children}
    </p>
  );
}

export default WarningBanners;
