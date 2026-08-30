"""FrameCraft Bake service entrypoint.

Phase 1 (scaffolder) ships only /health and /files/{name}. Later phases add
routes here:
  - geo-ingest:  POST /scene, GET /presets   (app/ingest/**)
  - mesh-bake:   POST /bake, GET /bake/{id}  (app/geom/**, app/export/**, app/validate/**)

Do not add pipeline logic to this file; it wires routers and cross-cutting
concerns (CORS, static file serving) only.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from app import bake as bake_pipeline
from app.contracts import BakeResult, PrintParams, SceneGraph, SceneRequest
from app.ingest import normalize, overpass, presets

__version__ = "0.1.0"

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS_DIR = (REPO_ROOT / "artifacts").resolve()
SCENE_CACHE_DIR = ARTIFACTS_DIR / "cache" / "scene"
SCENE_CACHE_TTL_S = 24 * 60 * 60
SCENE_MEM_CACHE_MAX = 6  # the six presets stay warm; ~14 MB each

app = FastAPI(title="FrameCraft Bake", version=__version__)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "version": __version__}


# ---------------------------------------------------------------------------
# geo-ingest routes: GET /presets, POST /scene
# ---------------------------------------------------------------------------

_scene_mem_cache: "OrderedDict[str, SceneGraph]" = OrderedDict()


def _request_key(request: SceneRequest) -> str:
    """Stable hash of a SceneRequest, used for the /scene caches."""
    payload = json.dumps(request.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> SceneGraph | None:
    scene = _scene_mem_cache.get(key)
    if scene is not None:
        _scene_mem_cache.move_to_end(key)
        return scene
    path = SCENE_CACHE_DIR / f"{key}.json"
    if not path.is_file():
        return None
    if time.time() - path.stat().st_mtime > SCENE_CACHE_TTL_S:
        return None
    try:
        scene = SceneGraph(**json.loads(path.read_text(encoding="utf-8")))
    except (ValueError, OSError):
        return None
    _cache_put_mem(key, scene)
    return scene


def _cache_put_mem(key: str, scene: SceneGraph) -> None:
    _scene_mem_cache[key] = scene
    _scene_mem_cache.move_to_end(key)
    while len(_scene_mem_cache) > SCENE_MEM_CACHE_MAX:
        _scene_mem_cache.popitem(last=False)


def _cache_put(key: str, scene: SceneGraph) -> None:
    _cache_put_mem(key, scene)
    try:
        SCENE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        # allow_nan=False: NaN/Infinity are not JSON, and a cache file no other
        # parser can read is worse than no cache file at all.
        (SCENE_CACHE_DIR / f"{key}.json").write_text(
            json.dumps(scene.model_dump(mode="json"), separators=(",", ":"), allow_nan=False),
            encoding="utf-8",
            newline="\n",
        )
    except OSError:  # a read-only artifacts volume must not fail the request
        pass
    except ValueError:  # a non-finite number must never be persisted silently
        pass


def _resolve_request(request: SceneRequest) -> tuple[SceneRequest, bool]:
    """Return the request to serve and whether the network may be used.

    A request that names a preset *and* matches it is served from the committed
    fixture with the network disabled. A request that names a preset but has
    been edited (the user dragged the radius or the rotation) is no longer that
    preset, so it takes the normal cache-then-network path.
    """
    if not request.preset_id:
        return request, True
    preset = presets.get_preset(request.preset_id)
    if preset is None:
        raise HTTPException(status_code=400, detail=f"unknown preset_id {request.preset_id!r}")
    canonical = preset.request()
    if (request.lat, request.lon, request.radius_m, request.rotation_deg) == (
        canonical.lat,
        canonical.lon,
        canonical.radius_m,
        canonical.rotation_deg,
    ):
        return canonical, False
    return request, True


@app.get("/presets", response_model=list[SceneRequest])
def get_presets() -> list[SceneRequest]:
    """The six preset SceneRequest objects (01 "Preset cities for the MVP")."""
    return presets.preset_requests()


def build_scene(request: SceneRequest) -> SceneGraph:
    """The SceneGraph for a request, from cache, fixture or Overpass.

    Shared by ``POST /scene`` and the bake job so a bake and a preview can never
    be looking at different geometry for the same request.
    """
    served, allow_network = _resolve_request(request)
    key = _request_key(served)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        raw = overpass.load_raw(served, allow_network=allow_network)
    except overpass.OverpassOffline as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except overpass.OverpassError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    scene = normalize.build_scene(raw, served)
    _cache_put(key, scene)
    return scene


@app.post("/scene", response_model=SceneGraph)
def post_scene(request: SceneRequest) -> SceneGraph:
    """Location -> SceneGraph: Overpass (or fixture) -> normalize -> crop.

    Cached for 24 h on disk under artifacts/cache/scene/, keyed by a hash of
    the request, plus a small in-process cache so a warm preset answers in
    milliseconds.
    """
    return build_scene(request)


# ---------------------------------------------------------------------------
# mesh-bake routes: POST /bake, GET /bake/{job_id}
# ---------------------------------------------------------------------------

#: 02: "in-process asyncio task registry with a dict of job ids."
JOBS = bake_pipeline.JobRegistry()

#: At most two bakes run at once; the rest stay queued.  A bake is CPU bound and
#: runs in a worker thread, so more than two would just contend.
MAX_CONCURRENT_BAKES = 2
_bake_semaphore: asyncio.Semaphore | None = None
#: Strong references to the running tasks, so the event loop cannot collect one
#: mid-bake (asyncio only keeps weak references to tasks).
_bake_tasks: set[asyncio.Task] = set()


class BakeRequest(BaseModel):
    """Body of ``POST /bake`` (02: ``{ scene_request, print_params }``).

    Not a frozen contract schema - the two members are.  ``print_params``
    defaults to the contract defaults so a client may omit it.
    """

    model_config = ConfigDict(extra="forbid")
    scene_request: SceneRequest
    print_params: PrintParams = Field(default_factory=PrintParams)


class BakeJobHandle(BaseModel):
    """Response of ``POST /bake``: just the id to poll."""

    model_config = ConfigDict(extra="forbid")
    job_id: str


def _semaphore() -> asyncio.Semaphore:
    global _bake_semaphore
    if _bake_semaphore is None:
        _bake_semaphore = asyncio.Semaphore(MAX_CONCURRENT_BAKES)
    return _bake_semaphore


async def _run_bake(job_id: str, request: BakeRequest) -> None:
    """One job: wait for a slot, build the scene, then bake in a worker thread."""
    async with _semaphore():
        try:
            scene = await asyncio.to_thread(build_scene, request.scene_request)
        except HTTPException as exc:
            JOBS.fail(job_id, f"scene unavailable: {exc.detail}")
            return
        except Exception as exc:  # never a 500 on the poll endpoint
            JOBS.fail(job_id, f"{type(exc).__name__}: {exc}")
            return
        await asyncio.to_thread(
            bake_pipeline.bake_job,
            JOBS,
            job_id,
            scene,
            request.scene_request,
            request.print_params,
        )


@app.post("/bake", response_model=BakeJobHandle, status_code=202)
async def post_bake(request: BakeRequest) -> BakeJobHandle:
    """Start a bake and answer immediately with its job id."""
    job_id = JOBS.create()
    task = asyncio.create_task(_run_bake(job_id, request))
    _bake_tasks.add(task)
    task.add_done_callback(_bake_tasks.discard)
    return BakeJobHandle(job_id=job_id)


@app.get("/bake/{job_id}", response_model=BakeResult)
def get_bake(job_id: str) -> BakeResult:
    """Poll a bake.  404 for an unknown id; a failed bake is a 200 with
    ``status: "failed"`` and ``error`` naming the reason."""
    result = JOBS.get(job_id)
    if result is None:
        raise HTTPException(status_code=404, detail="unknown job id")
    return result


@app.get("/files/{name}")
def get_file(name: str) -> FileResponse:
    """Serve a bake artifact from the repo-root artifacts/ directory.

    Path-traversal safe: only the final path component of `name` is used
    (no directories), and the resolved path is verified to stay inside
    ARTIFACTS_DIR before it is ever opened.
    """
    safe_name = Path(name).name  # strips any directory components, "..", etc.
    if not safe_name or safe_name != name:
        raise HTTPException(status_code=400, detail="invalid file name")

    candidate = (ARTIFACTS_DIR / safe_name).resolve()
    if not candidate.is_relative_to(ARTIFACTS_DIR):
        raise HTTPException(status_code=400, detail="invalid file name")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="not found")

    return FileResponse(candidate)
