"use client";

import { useShallow } from "zustand/react/shallow";

import { PARAM_LIMITS } from "@/lib/contracts";
import { RADIUS_MAX_M, RADIUS_MIN_M, RADIUS_STEP_M } from "@/lib/geo";
import { format_coords } from "@/lib/tokens";
import { useEditorStore } from "@/store/editor";
import { Note, Slider, TextField } from "../Controls";

/**
 * Location: where the model is cut from, which way round, and what the place
 * is called.
 *
 * The radius and rotation sliders are the only two controls in the whole panel
 * that can reach the network, and they only do so on release, through
 * `Controls.createCommitGate` (DECISIONS [P4-fix]).
 */
export function LocationGroup() {
  const { lat, lon, radius_m, rotation_deg } = useEditorStore(
    useShallow((state) => ({
      lat: state.location.lat,
      lon: state.location.lon,
      radius_m: state.location.radius_m,
      rotation_deg: state.location.rotation_deg,
    })),
  );
  const cityLabel = useEditorStore((state) => state.params.city_label ?? "");
  const setParam = useEditorStore((state) => state.setParam);
  const setRadius = useEditorStore((state) => state.setRadius);
  const setRotation = useEditorStore((state) => state.setRotation);
  const generate = useEditorStore((state) => state.generate);

  return (
    <>
      <Note testId="location-coords">
        Pin at {format_coords({ lat, lon, scale_mm_per_m: 0, radius_m, date: "", buildings: 0 })}.
        Click the map or drag the pin to move it.
      </Note>

      <TextField
        id="city_label"
        label="City label"
        value={cityLabel}
        maxLength={PARAM_LIMITS.city_label.max_length}
        placeholder="Chicago"
        meta={`${cityLabel.length}/${PARAM_LIMITS.city_label.max_length}`}
        onChange={(value) => setParam("city_label", value)}
        hint="This is the {city} token. Type it here and any engraving or underside mark that uses {city} picks it up — FrameCraft never guesses a place name from the coordinates."
      />

      <Slider
        id="radius_m"
        label="Radius"
        min={RADIUS_MIN_M}
        max={RADIUS_MAX_M}
        step={RADIUS_STEP_M}
        value={radius_m}
        display={`${radius_m} m`}
        onChange={setRadius}
        onCommit={() => void generate()}
        hint="Half the ground span. Changing it refetches the scene."
      />

      <Slider
        id="rotation_deg"
        label="Rotation"
        min={0}
        max={360}
        step={1}
        value={rotation_deg}
        display={`${rotation_deg}°`}
        onChange={setRotation}
        onCommit={() => void generate()}
        hint="Turns the crop before it is squared. The dashed square on the map is what prints. Server-side, so it refetches on release."
      />
    </>
  );
}

export default LocationGroup;
