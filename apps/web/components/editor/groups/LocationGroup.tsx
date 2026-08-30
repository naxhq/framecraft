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
 * `Controls.createCommitGate` (DECISIONS [P4-fix]). The Place name field's own
 * network call -- a debounced Nominatim reverse geocode -- is driven from
 * `EditorShell` on every pin move, never from a keystroke here (DECISIONS
 * [V3-P1]).
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
  const author = useEditorStore((state) => state.params.place?.author ?? "");
  const placeDetect = useEditorStore((state) => state.placeDetect);
  const setPlaceName = useEditorStore((state) => state.setPlaceName);
  const resetPlaceNameToDetected = useEditorStore((state) => state.resetPlaceNameToDetected);
  const setAuthor = useEditorStore((state) => state.setAuthor);
  const setRadius = useEditorStore((state) => state.setRadius);
  const setRotation = useEditorStore((state) => state.setRotation);
  const generate = useEditorStore((state) => state.generate);

  const canResetToDetected =
    placeDetect.detectedCity !== null && placeDetect.detectedCity !== cityLabel;
  const placeStatusHint =
    placeDetect.status === "resolving"
      ? "Looking up the place name..."
      : placeDetect.status === "error"
        ? "Could not look up a place name for this pin. Type one yourself, or use the coordinates."
        : "This is the {city} token. Type your own text and it wins from here on — a preset or a dragged pin no longer overwrites it.";

  return (
    <>
      <Note testId="location-coords">
        Pin at {format_coords({ lat, lon, scale_mm_per_m: 0, radius_m, date: "", buildings: 0 })}.
        Click the map or drag the pin to move it.
      </Note>

      <div className="space-y-1.5">
        <TextField
          id="city_label"
          label="Place name"
          value={cityLabel}
          maxLength={PARAM_LIMITS.city_label.max_length}
          placeholder={
            placeDetect.status === "resolving"
              ? "Detecting..."
              : format_coords({ lat, lon, scale_mm_per_m: 0, radius_m, date: "", buildings: 0 })
          }
          meta={`${cityLabel.length}/${PARAM_LIMITS.city_label.max_length}`}
          onChange={(value) => setPlaceName(value)}
          hint={placeStatusHint}
        />
        {canResetToDetected ? (
          <button
            type="button"
            data-testid="reset-place-name"
            onClick={resetPlaceNameToDetected}
            className="rounded-milled px-1.5 py-0.5 text-2xs text-ink-muted transition-colors hover:bg-plate-raised hover:text-ink"
          >
            Reset to detected ({placeDetect.detectedCity})
          </button>
        ) : null}
      </div>

      <TextField
        id="author"
        label="Author"
        value={author}
        maxLength={PARAM_LIMITS.place.author.max_length}
        placeholder="Your name"
        meta={`${author.length}/${PARAM_LIMITS.place.author.max_length}`}
        onChange={(value) => setAuthor(value)}
        hint="This is the {author} token, for a credit line in an engraving or the underside mark."
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
