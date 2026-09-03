"use client";

import { PARAM_RANGES } from "@/lib/contracts";
import { labelled } from "@/lib/controlCatalog";
import { useEditorStore } from "@/store/editor";
import { Note, Slider, Toggle } from "../Controls";

/**
 * Bridges: what happens where a road or a railway crosses above the ground.
 *
 * `bridges.enabled` has defaulted to TRUE since schema_version 3 with no way
 * to turn it off (`docs/handoff/v3-02-settings.md` section 5, the sharpest gap
 * on that list), so every model built bridge decks whether or not the user
 * wanted the extra unsupported geometry. All three fields move real solids in
 * `lib/engine/solid/bridges.ts`: a segment tagged as a bridge is lifted out of
 * its grade layer and rebuilt as a slab standing `clearance_mm` above the local
 * surface, with an abutment column at each end holding it there.
 */
const STEP_MM = 0.1;

export function BridgesGroup() {
  const params = useEditorStore((state) => state.params);
  const setParam = useEditorStore((state) => state.setParam);

  const bridges = params.bridges ?? {};
  // The contract's default is `true`, and a payload that omits the block gets
  // that behaviour, so the toggle has to read the same way round.
  const enabled = bridges.enabled ?? true;
  const clearance = bridges.clearance_mm ?? PARAM_RANGES.bridges.clearance_mm.default;
  const abutments = bridges.abutments ?? true;

  return (
    <>
      <Toggle
        {...labelled("bridges_enabled")}
        checked={enabled}
        onChange={(value) => setParam("bridges", { ...bridges, enabled: value })}
      />

      <Slider
        {...labelled("bridges_clearance_mm")}
        min={PARAM_RANGES.bridges.clearance_mm.min}
        max={PARAM_RANGES.bridges.clearance_mm.max}
        step={STEP_MM}
        value={clearance}
        display={`${clearance.toFixed(1)} mm`}
        disabled={!enabled}
        onChange={(value) =>
          setParam("bridges", { ...bridges, clearance_mm: Number(value.toFixed(2)) })
        }
      />

      <Toggle
        {...labelled("bridges_abutments")}
        checked={abutments}
        disabled={!enabled}
        onChange={(value) => setParam("bridges", { ...bridges, abutments: value })}
      />

      {!enabled ? (
        <Note testId="bridges-off-note">
          Every crossing is laid at ground level instead, which is how a v2 model
          was built. Nothing is left in the air, and a river under a road loses
          its own surface where the two meet.
        </Note>
      ) : null}
      {enabled && !abutments ? (
        <Note tone="warn" testId="bridges-abutments-off-note">
          With nothing under their ends the decks print as loose pieces floating{" "}
          {clearance.toFixed(1)} mm above the surface, and the build says so in
          its findings.
        </Note>
      ) : null}
    </>
  );
}

export default BridgesGroup;
