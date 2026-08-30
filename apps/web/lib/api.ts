/**
 * Typed client for the FrameCraft bake API (services/bake).
 *
 * Every network call the editor makes goes through this module, so there is
 * exactly one place that knows the base URL, the error shape, and which
 * endpoints exist. The types come from the FROZEN contracts.
 */

import type {
  BakeResult,
  PrintParams,
  SceneGraph,
  SceneRequest,
} from "./contracts";

/**
 * Base URL of the FrameCraft bake API (services/bake), used by every fetch
 * call the editor makes (POST /scene, POST /bake, GET /bake/{id}, GET
 * /presets, GET /files/{name}). Override via NEXT_PUBLIC_BAKE_API_URL.
 */
export const BAKE_API_URL: string =
  process.env.NEXT_PUBLIC_BAKE_API_URL ?? "http://localhost:8000";

/** `POST /bake` answers with just a job id; it is not a contract schema. */
export interface BakeJobHandle {
  job_id: string;
}

/** An HTTP-level failure from the bake API, carrying the status code. */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
  }
}

/**
 * Turn a FastAPI error body into a human-readable message.
 *
 * The status and path are always included: a bare FastAPI `{"detail": "Not
 * Found"}` on a route that does not exist yet is useless on its own, and this
 * text is what the user sees in the bake status row.
 */
function describeError(status: number, path: string, body: string): string {
  const context = `${path} failed (HTTP ${status})`;
  const trimmed = body.trim();
  if (!trimmed) return context;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && "detail" in parsed) {
      const detail = (parsed as { detail: unknown }).detail;
      return `${context}: ${
        typeof detail === "string" ? detail : JSON.stringify(detail)
      }`;
    }
  } catch {
    // not JSON; fall through to the raw body
  }
  return `${context}: ${trimmed.slice(0, 300)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BAKE_API_URL}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ApiError(
      `Cannot reach the bake API at ${BAKE_API_URL}. Is it running? ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
      0,
      path,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(describeError(response.status, path, body), response.status, path);
  }
  return (await response.json()) as T;
}

/** `GET /presets` -> the six preset SceneRequest objects. */
export function fetchPresets(signal?: AbortSignal): Promise<SceneRequest[]> {
  return request<SceneRequest[]>("/presets", { method: "GET", signal });
}

/** `POST /scene` -> the SceneGraph for a location (server-side crop + rotate). */
export function fetchScene(
  sceneRequest: SceneRequest,
  signal?: AbortSignal,
): Promise<SceneGraph> {
  return request<SceneGraph>("/scene", {
    method: "POST",
    body: JSON.stringify(sceneRequest),
    signal,
  });
}

/** `POST /bake` -> a job id; the mesh is produced asynchronously. */
export function startBake(
  sceneRequest: SceneRequest,
  printParams: PrintParams,
  signal?: AbortSignal,
): Promise<BakeJobHandle> {
  return request<BakeJobHandle>("/bake", {
    method: "POST",
    body: JSON.stringify({
      scene_request: sceneRequest,
      print_params: printParams,
    }),
    signal,
  });
}

/** `GET /bake/{job_id}` -> the current BakeResult for a job. */
export function fetchBakeResult(
  jobId: string,
  signal?: AbortSignal,
): Promise<BakeResult> {
  return request<BakeResult>(`/bake/${encodeURIComponent(jobId)}`, {
    method: "GET",
    signal,
  });
}

/**
 * Absolute URL for a `BakeResult.files` entry.
 *
 * The contract carries server-relative paths such as `/files/ab12.3mf`; the
 * browser is on :3000 and the API on :8000, so they need the base URL glued
 * on. Absolute URLs are passed through untouched.
 */
export function fileUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${BAKE_API_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}
