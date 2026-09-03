"use client";

import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";

import { perfEnabled, perfMark } from "@/lib/perf";

/**
 * Perf mode's "this is on screen now" mark: `perfMark(name)` on the first
 * frame react-three-fiber renders after this mounts.
 *
 * The subscription is the point. `useFrame` runs inside the render loop and
 * the `Canvas` has no `frameloop`, so it defaults to `always`: a callback
 * registered here is invoked about sixty times a second for the life of the
 * page. So the decision is taken BEFORE subscribing, not inside the callback:
 * with perf mode off nothing is rendered, `useFrame` is never called and the
 * render loop is exactly what it was; with perf mode on the probe unmounts
 * itself after its one mark, which is how r3f unsubscribes.
 *
 * Give it a `key` that changes to re-arm it, which is how `RegionMeshes` gets
 * one mark per fresh set of geometries rather than one for the whole session.
 */
export function PerfFrameMark({ name }: { name: string }) {
  const [armed, setArmed] = useState(() => perfEnabled());
  if (!armed) return null;
  return (
    <FrameProbe
      onFrame={() => {
        perfMark(name);
        setArmed(false);
      }}
    />
  );
}

/** Mounted only while perf mode is on and the mark has not been made yet. */
function FrameProbe({ onFrame }: { onFrame: () => void }) {
  const fired = useRef(false);
  useFrame(() => {
    if (fired.current) return;
    fired.current = true;
    onFrame();
  });
  return null;
}

export default PerfFrameMark;
