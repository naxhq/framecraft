/**
 * Where the preview camera is looking, as something a link and a project file
 * can carry ([V3.1-U6]).
 *
 * A sibling of `lib/layout.ts` and deliberately built the same way, because it
 * answers the same question that `[V3.1-O6]` answered for the columns: a
 * shared design should open the way its author framed it. The columns were
 * half of that framing and the camera is the other half.
 *
 * It is NOT part of the layout payload, for three reasons that are all about
 * where the value comes from. The layout lives in a store the shell owns and
 * changes a few times a session; the camera lives inside the `<Canvas>` and
 * moves continuously under a drag. The layout writes `localStorage` on every
 * mutation, which is right for a value that moves rarely and wrong for one
 * sampled off an orbit. And the layout is a set of pixel widths that clamp to
 * the recipient's screen, while a pose is millimetres in the model's own
 * space, which every screen shares.
 *
 * Presentation, like the layout: a payload this build cannot read restores
 * nothing and refuses nothing. A camera must never be the reason a shared
 * design fails to open.
 */

/** A camera position and the point it is looking at, engine millimetres, three-space (y up). */
export interface CameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

/**
 * The furthest a coordinate may sit from the origin, millimetres.
 *
 * The plate tops out at 300 mm and `FitView` puts the camera at 1.15 plate
 * widths, so a real pose is inside a few hundred; four orders of magnitude
 * above that is room for any zoom a user can reach and still refuses a payload
 * carrying `1e30`, which would push the near/far planes somewhere the depth
 * buffer cannot follow and paint an empty viewport.
 */
export const CAMERA_LIMIT_MM = 1e6;

/**
 * How close the camera may sit to its own target before the pose is refused,
 * millimetres. A zero-length view vector gives `OrbitControls` no orientation
 * to work from and leaves the camera pointing at nothing.
 */
const MIN_VIEW_DISTANCE_MM = 0.001;

/** Two decimals: 10 micrometres of camera position, and about 40 fewer characters in a link. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function readTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    if (Math.abs(entry) > CAMERA_LIMIT_MM) return null;
    out.push(entry);
  }
  return [out[0], out[1], out[2]];
}

/**
 * The pose as it travels: `{p, t}`, two triples, rounded.
 *
 * Short keys for the same reason the share payload uses `r`, `p` and `l`: this
 * rides in a URL with a length limit, and six numbers with two-character names
 * costs about 60 characters where six spelled-out ones cost over a hundred.
 */
export interface CameraPayload {
  readonly p: readonly [number, number, number];
  readonly t: readonly [number, number, number];
}

/** A pose as a payload, or null when there is nothing worth sending. */
export function cameraPayload(pose: CameraPose | null): CameraPayload | null {
  if (pose === null) return null;
  const p = readTriple([...pose.position]);
  const t = readTriple([...pose.target]);
  if (p === null || t === null) return null;
  if (distance(p, t) < MIN_VIEW_DISTANCE_MM) return null;
  return { p: [round(p[0]), round(p[1]), round(p[2])], t: [round(t[0]), round(t[1]), round(t[2])] };
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * A payload back into a pose, or null when there is nothing usable in it.
 *
 * Never throws. Every rejection is a whole-pose rejection rather than a
 * partial one: half a camera (a position with no target) is a camera pointing
 * somewhere neither the sender nor the recipient chose, which is worse than
 * leaving this device's own view alone.
 */
export function cameraFromPayload(value: unknown): CameraPose | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const position = readTriple(record.p);
  const target = readTriple(record.t);
  if (position === null || target === null) return null;
  if (distance(position, target) < MIN_VIEW_DISTANCE_MM) return null;
  return { position, target };
}
