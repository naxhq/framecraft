"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import type { HoverHit, ObjectInfo } from "@/lib/objectInfo";

/**
 * "What is this?", answered where the pointer is.
 *
 * The viewport draws the pipeline's solids and nothing else, so an object in it
 * has no label, no legend and no list beside it: the only way to ask what a
 * particular building or road IS, and what it will print like, is to point at
 * it. This is that answer, as a DOM overlay over the canvas rather than
 * anything inside it.
 *
 * Three properties it has to have, and how each is got:
 *
 *  - **It never re-renders the scene.** Nothing here is a prop of anything
 *    inside `<Canvas>`. The pointer position is written straight onto the
 *    card's `style` through a ref, so a move costs one style write and no
 *    React work at all; the CONTENT is state, and it is set only when the
 *    object under the cursor actually changes (`show` bails out on an
 *    unchanged `ObjectInfo.key`), so a slow sweep across one building
 *    re-renders this component once.
 *  - **It is throttled.** {@link HOVER_THROTTLE_MS} between resolutions, with a
 *    trailing pass so the object the pointer STOPPED on is the one described,
 *    which a leading-edge-only throttle drops.
 *  - **It is suppressed during a camera drag.** Orbiting sweeps the pointer
 *    across the whole model; a popover chasing that is noise over the thing the
 *    user is trying to look at. Any pointer press hides it and holds it hidden
 *    until the release, and a wheel (zoom) hides it too.
 *
 * `aria-hidden`: this is a pointer-only affordance and duplicates nothing a
 * keyboard user can reach, so announcing it would be a live region firing on
 * every mouse move. The keyboard path to the same buildings is the viewport's
 * own cursor readout (`CityPreview.tsx`, `#preview-cursor-status`), which is a
 * real live region and stays the accessible route.
 */

/** How often a pointer move may be resolved to an object, milliseconds. */
export const HOVER_THROTTLE_MS = 60;

/** Gap between the pointer and the card's near corner, pixels. */
const POINTER_OFFSET_PX = 14;

export interface ObjectPopoverHandle {
  /** Describe `info` at a viewport-relative pixel position. */
  show(info: ObjectInfo, xPx: number, yPx: number): void;
  hide(): void;
}

export const ObjectPopover = forwardRef<ObjectPopoverHandle>(function ObjectPopover(_props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const atRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [state, setState] = useState<{ open: boolean; info: ObjectInfo | null }>({
    open: false,
    info: null,
  });

  /**
   * Place the card, flipping it back over the pointer when it would leave the
   * viewport. Measured from the host, which is the viewport's own box.
   */
  const place = useCallback((xPx: number, yPx: number) => {
    atRef.current = { x: xPx, y: yPx };
    const card = cardRef.current;
    const host = hostRef.current;
    if (card === null || host === null || card.hidden) return;
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    let left = xPx + POINTER_OFFSET_PX;
    let top = yPx + POINTER_OFFSET_PX;
    if (left + width > host.clientWidth) left = Math.max(0, xPx - POINTER_OFFSET_PX - width);
    if (top + height > host.clientHeight) top = Math.max(0, yPx - POINTER_OFFSET_PX - height);
    card.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      show(info, xPx, yPx) {
        setState((previous) =>
          previous.open && previous.info?.key === info.key ? previous : { open: true, info },
        );
        place(xPx, yPx);
      },
      hide() {
        setState((previous) => (previous.open ? { open: false, info: previous.info } : previous));
      },
    }),
    [place],
  );

  // A hidden card has no size, so the placement that opened it could not know
  // how far it reaches and could not flip it away from an edge. Place it again
  // now that it is in the layout, at the position it was opened for.
  useEffect(() => {
    if (!state.open) return;
    place(atRef.current.x, atRef.current.y);
  }, [state.open, state.info, place]);

  const info = state.info;
  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        ref={cardRef}
        data-testid="object-popover"
        data-object-key={info?.key ?? ""}
        data-object-layer={info?.layer ?? ""}
        data-object-named={info === null ? "" : String(info.named)}
        data-object-hero={info === null ? "" : String(info.hero)}
        data-height-source={info?.heightSource ?? ""}
        data-pick-method={info?.method ?? ""}
        hidden={!state.open || info === null}
        className="absolute left-0 top-0 max-w-[15rem] rounded-milled border border-line bg-plate/95 px-2 py-1.5 shadow-raised will-change-transform"
      >
        {info === null ? null : <ObjectCard info={info} />}
      </div>
    </div>
  );
});

/**
 * The card's contents: the heading, the type line and the printing facts.
 *
 * Its own component so it can be rendered without a canvas, a pointer or an
 * imperative handle (`ObjectPopover.test.tsx`). An UNNAMED object still fills
 * it: the heading falls back to the type ("Footway", "Building"), the second
 * line says plainly that OpenStreetMap has no name for it rather than sitting
 * empty, and the facts below are the same facts either way.
 */
export function ObjectCard({ info }: { info: ObjectInfo }) {
  return (
    <>
      <p
        data-testid="object-popover-title"
        className="truncate font-display text-2xs font-semibold text-ink"
        title={info.title}
      >
        {info.title}
      </p>
      <p data-testid="object-popover-type" className="truncate text-2xs text-ink-faint">
        {info.named ? info.typeLabel : "No OpenStreetMap name"}
      </p>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-2xs">
        {info.rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-ink-faint">{row.label}</dt>
            <dd className="text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/**
 * The hover machinery, as one hook: the throttle, the drag suppression and the
 * handle the popover is driven through.
 *
 * `resolve` turns a raycast hit into an `ObjectInfo`. It is held in a ref, so
 * the callback handed to the r3f meshes never changes identity and the scene
 * subtree is not re-rendered when the scene, the heroes or the parameters move.
 */
export function useObjectHover(
  resolve: (hit: HoverHit) => ObjectInfo | null,
  /** The viewport box the popover sits in, so a client coordinate becomes a coordinate inside it. */
  viewportRef: React.RefObject<HTMLElement | null>,
): {
  popoverRef: React.RefObject<ObjectPopoverHandle | null>;
  onHover: (hit: HoverHit | null, clientX: number, clientY: number) => void;
} {
  const popoverRef = useRef<ObjectPopoverHandle | null>(null);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const pending = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    lastAt: number;
    suppressed: boolean;
    hit: HoverHit | null;
    x: number;
    y: number;
  }>({ timer: null, lastAt: 0, suppressed: false, hit: null, x: 0, y: 0 });

  const apply = useCallback(() => {
    const store = pending.current;
    store.lastAt = performance.now();
    const popover = popoverRef.current;
    if (popover === null) return;
    if (store.suppressed || store.hit === null) {
      popover.hide();
      return;
    }
    const info = resolveRef.current(store.hit);
    if (info === null) {
      popover.hide();
      return;
    }
    popover.show(info, store.x, store.y);
  }, []);

  const onHover = useCallback(
    (hit: HoverHit | null, clientX: number, clientY: number) => {
      const store = pending.current;
      const box = viewportRef.current?.getBoundingClientRect();
      store.hit = hit;
      store.x = clientX - (box?.left ?? 0);
      store.y = clientY - (box?.top ?? 0);
      if (store.timer !== null) return;
      const wait = HOVER_THROTTLE_MS - (performance.now() - store.lastAt);
      if (wait <= 0) {
        apply();
        return;
      }
      // Trailing pass: the pointer usually STOPS on the thing the user wanted,
      // and a leading-only throttle throws that last move away.
      store.timer = setTimeout(() => {
        store.timer = null;
        apply();
      }, wait);
    },
    [apply, viewportRef],
  );

  useEffect(() => {
    const store = pending.current;
    const down = (): void => {
      store.suppressed = true;
      popoverRef.current?.hide();
    };
    const up = (): void => {
      store.suppressed = false;
    };
    const wheel = (): void => {
      popoverRef.current?.hide();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("wheel", wheel, true);
      if (store.timer !== null) clearTimeout(store.timer);
      store.timer = null;
    };
  }, []);

  return useMemo(() => ({ popoverRef, onHover }), [onHover]);
}

export default ObjectPopover;
