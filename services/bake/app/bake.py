"""The bake pipeline and the in-process job registry.

``run_pipeline`` is the whole of ``04_PRINTABILITY_SPEC.md`` end to end:
Stage 1 (:mod:`app.geom.thicken`), Stage 2 (:mod:`app.geom.extrude` +
:mod:`app.geom.assemble`), Stage 3 (:mod:`app.export`) and Stage 4
(:mod:`app.validate`).  It is synchronous and CPU bound, so the API runs it in
a worker thread (``asyncio.to_thread``) from :class:`JobRegistry`; the CLI calls
it directly.

Nothing here talks to the network.  The caller supplies the ``SceneGraph``,
which is exactly how ``POST /scene`` builds it (fixtures for the presets).
"""
from __future__ import annotations

import secrets
import shutil
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np
import trimesh

from app import export
from app.contracts import BakeFiles, BakeResult, BakeStats, PrintParams, SceneGraph, SceneRequest
from app.export import mf3, stl
from app.geom import assemble, thicken, transform as T
from app.validate import checks as validators

__all__ = [
    "REPO_ROOT",
    "ARTIFACTS_DIR",
    "DEBUG_DIR",
    "STAGE_PROGRESS",
    "BakeError",
    "EmptySceneError",
    "ModelTooTallError",
    "predicted_top_mm",
    "BakeOutput",
    "JobRegistry",
    "new_job_id",
    "run_pipeline",
]

REPO_ROOT = Path(__file__).resolve().parents[3]
ARTIFACTS_DIR = (REPO_ROOT / "artifacts").resolve()
DEBUG_DIR = ARTIFACTS_DIR / "debug"

#: 04's filament estimate: grams = volume_mm3 / 1000 * 1.24 * infill_factor.
FILAMENT_DENSITY_G_PER_CM3 = 1.24
INFILL_FACTOR = 0.35

#: Progress reported through ``BakeResult.progress`` as each stage completes.
STAGE_PROGRESS: dict[str, float] = {
    "scene": 0.05,
    "repair": 0.25,
    "extrude": 0.45,
    "union": 0.8,
    "export": 0.9,
    "validate": 1.0,
}

ProgressFn = Callable[[str, float], None]


class BakeError(Exception):
    """A bake that cannot produce a model, with a message meant for the user."""


class EmptySceneError(BakeError):
    """The SceneGraph has no printable content."""


class ModelTooTallError(BakeError):
    """The parameters ask for a model over 04's 60 mm Z ceiling."""


def predicted_top_mm(scene: SceneGraph, params: PrintParams) -> float:
    """Highest Z the finished model can reach, in mm, without building it.

    Thin wrapper over :func:`app.geom.transform.predicted_top_mm`, which is the
    SHARED implementation the browser mirrors in ``apps/web/lib/transform.ts``:
    the Bake button is disabled from the same number this guard refuses on, so
    the editor can never offer a bake the server would reject (DECISIONS
    [P5-web]).  It is an upper bound on the baked height: Stage 1 can lower a
    tower (a merged block takes the area-weighted 80th percentile of the heights
    it swallowed) and can drop a footprint entirely, but nothing in the pipeline
    makes a solid taller.
    """
    return T.predicted_top_mm(scene, params, T.radius_m_from_bounds(scene.bounds))


@dataclass
class BakeOutput:
    result: BakeResult
    report: validators.ValidationReport | None = None
    timings_s: dict[str, float] = field(default_factory=dict)
    paths: dict[str, Path] = field(default_factory=dict)
    debug_dir: Path | None = None


def new_job_id() -> str:
    """8-12 hex characters, per the API contract."""
    return secrets.token_hex(5)


def est_grams(volume_mm3: float) -> float:
    """04 "Filament estimate".  Clearly an ESTIMATE: 15% infill, 3 walls."""
    return volume_mm3 / 1000.0 * FILAMENT_DENSITY_G_PER_CM3 * INFILL_FACTOR


# --------------------------------------------------------------------------
# manifold3d -> trimesh (export boundary only)
# --------------------------------------------------------------------------


def manifold_to_trimesh(solid) -> trimesh.Trimesh:
    """Convert at the export boundary, in float64 (``to_mesh64``).

    float32 would put ~1e-5 mm of noise on a 180 mm plate, which the
    ``sits_at_zero`` validator measures at 1e-3 mm.
    """
    mesh = solid.to_mesh64()
    vertices = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
    faces = np.asarray(mesh.tri_verts).astype(np.int64)
    return stl.to_trimesh(vertices, faces)


def _dump_debug(directory: Path, parts: dict[str, Any], mesh: trimesh.Trimesh | None) -> Path:
    """04 stage 4: log the intermediate solids so a failure can be inspected."""
    directory.mkdir(parents=True, exist_ok=True)
    for name, solid in parts.items():
        try:
            stl.write_stl(directory / f"{name}.stl", manifold_to_trimesh(solid))
        except Exception:  # a broken intermediate must not hide the real failure
            continue
    if mesh is not None:
        try:
            stl.write_stl(directory / "final.stl", mesh)
        except Exception:
            pass
    return directory


# --------------------------------------------------------------------------
# The pipeline
# --------------------------------------------------------------------------


def run_pipeline(
    scene: SceneGraph,
    scene_request: SceneRequest,
    print_params: PrintParams,
    *,
    job_id: str,
    out_dir: Path | str = ARTIFACTS_DIR,
    stem: str | None = None,
    progress: ProgressFn | None = None,
    file_url_prefix: str = "/files",
    debug_root: Path | str = DEBUG_DIR,
    height_guard: bool = True,
) -> BakeOutput:
    """Run 04 end to end and write the artifacts.  Never raises for a *bad*
    model - a failing validator comes back as ``status='failed'`` with the
    check named - but does raise :class:`BakeError` for an unusable input."""
    stem = stem or job_id
    out_dir = Path(out_dir)
    timings: dict[str, float] = {}
    warnings: list[str] = []

    def tick(stage: str) -> None:
        if progress is not None:
            progress(stage, STAGE_PROGRESS[stage])

    if scene.stats.coverage == "empty":
        raise EmptySceneError(
            "no OpenStreetMap buildings in this area: try a larger radius or a "
            "different location"
        )

    # 04 stage 4 caps the model at 60 mm and the pipeline used to discover that
    # only after the whole bake (2-7 s of shapely and booleans, then a quarantine
    # dump).  Below ~500 m of radius a dense downtown blows the ceiling at the
    # DEFAULT parameters, which makes "zoom into the Loop and bake" a normal user
    # path that ends in status=failed.  The same predicate the preview draws with
    # answers it in well under a millisecond.  The Stage 4 validator still runs
    # and is still the gate; ``height_guard=False`` skips only this shortcut.
    if height_guard:
        predicted = predicted_top_mm(scene, print_params)
        if predicted >= validators.MAX_HEIGHT_MM:
            raise ModelTooTallError(
                f"this model would print {predicted:.1f} mm tall, over the "
                f"{validators.MAX_HEIGHT_MM:.0f} mm limit: lower the building height "
                f"multipliers (large {float(print_params.large_scale):g}x, small "
                f"{float(print_params.small_scale):g}x), or widen the radius, or "
                f"choose a smaller plate"
            )

    tick("scene")

    # ---- Stage 1 --------------------------------------------------------
    t0 = time.perf_counter()
    repaired = thicken.repair_scene(scene, print_params)
    timings["repair"] = time.perf_counter() - t0
    warnings.extend(repaired.warnings)
    tick("repair")

    # ---- Stage 2 --------------------------------------------------------
    t0 = time.perf_counter()
    assembly = assemble.assemble(repaired, print_params, progress=lambda s, _v: tick(s))
    timings["assemble"] = time.perf_counter() - t0

    # ---- to trimesh -----------------------------------------------------
    t0 = time.perf_counter()
    mesh = manifold_to_trimesh(assembly.solid)
    mesh, decimation = validators.enforce_triangle_budget(mesh)
    if decimation:
        warnings.append(decimation)
    timings["convert"] = time.perf_counter() - t0

    # ---- Stage 3 --------------------------------------------------------
    t0 = time.perf_counter()
    out_dir.mkdir(parents=True, exist_ok=True)
    request_json = scene_request.model_dump(mode="json")
    params_json = print_params.model_dump(mode="json")
    metadata = mf3.build_metadata(
        title=f"FrameCraft {stem}",
        scene_request=request_json,
        print_params=params_json,
    )
    mf3_path = mf3.write_3mf(out_dir / f"{stem}.3mf", mesh.vertices, mesh.faces, metadata)
    stl_path = stl.write_stl(out_dir / f"{stem}.stl", mesh)
    timings["export"] = time.perf_counter() - t0
    tick("export")

    # ---- Stage 4 --------------------------------------------------------
    t0 = time.perf_counter()
    report = validators.validate(mesh, print_params, manifold=assembly.solid)
    timings["validate"] = time.perf_counter() - t0
    tick("validate")

    extents = mesh.extents.astype(float)
    volume = float(mesh.volume)
    stats = BakeStats(
        triangles=int(len(mesh.faces)),
        volume_mm3=max(0.0, volume),
        bbox_mm=(float(extents[0]), float(extents[1]), float(extents[2])),
        est_grams=max(0.0, est_grams(volume)),
        is_manifold=bool(report.get("manifold") and report.get("manifold").passed),
        min_wall_mm=max(0.0, float(report.value_of("min_wall", 0.0))),
    )

    debug_dir: Path | None = None
    if report.passed:
        files = BakeFiles(
            **{
                "3mf": f"{file_url_prefix}/{mf3_path.name}",
                "stl": f"{file_url_prefix}/{stl_path.name}",
            }
        )
        result = BakeResult(
            job_id=job_id,
            status="done",
            files=files,
            stats=stats,
            warnings=warnings,
            progress=1.0,
            error=None,
        )
        sidecar_path = out_dir / f"{stem}.json"
        credits_path = export.write_credits(out_dir)
    else:
        # 04: do not silently ship.  The model and every intermediate go to
        # artifacts/debug/<job_id>/ instead of the download directory.
        debug_dir = Path(debug_root) / job_id
        _dump_debug(debug_dir, assembly.parts, mesh)
        for path in (mf3_path, stl_path):
            try:
                shutil.move(str(path), str(debug_dir / path.name))
            except OSError:
                pass
        result = BakeResult(
            job_id=job_id,
            status="failed",
            files=None,
            stats=stats,
            warnings=warnings,
            progress=1.0,
            error=report.error_text(),
        )
        sidecar_path = debug_dir / f"{stem}.json"
        credits_path = export.write_credits(debug_dir)

    export.write_sidecar(
        sidecar_path,
        export.sidecar_payload(
            bake_result=result.model_dump(mode="json"),
            scene_request=request_json,
            print_params=params_json,
            validation=report.to_dict(),
            scene_stats=scene.stats.model_dump(mode="json"),
            timings_s={k: round(v, 3) for k, v in timings.items()},
        ),
    )

    return BakeOutput(
        result=result,
        report=report,
        timings_s=timings,
        paths={
            "3mf": mf3_path if report.passed else debug_dir / mf3_path.name,
            "stl": stl_path if report.passed else debug_dir / stl_path.name,
            "json": sidecar_path,
            "credits": credits_path,
        },
        debug_dir=debug_dir,
    )


# --------------------------------------------------------------------------
# Job registry (02: "in-process asyncio task registry with a dict of job ids")
# --------------------------------------------------------------------------


class JobRegistry:
    """A bounded dict of ``BakeResult`` keyed by job id.

    Assignment into a dict is atomic under the GIL, which is all the worker
    thread needs to publish progress; no lock is taken on the read path so
    ``GET /bake/{job_id}`` stays responsive while a bake is running.
    """

    def __init__(self, max_jobs: int = 64) -> None:
        self._jobs: OrderedDict[str, BakeResult] = OrderedDict()
        self._max = max_jobs

    def create(self, job_id: str | None = None) -> str:
        job_id = job_id or new_job_id()
        self._jobs[job_id] = BakeResult(
            job_id=job_id, status="queued", warnings=[], progress=0.0
        )
        self._jobs.move_to_end(job_id)
        while len(self._jobs) > self._max:
            self._jobs.popitem(last=False)
        return job_id

    def get(self, job_id: str) -> BakeResult | None:
        return self._jobs.get(job_id)

    def put(self, result: BakeResult) -> None:
        self._jobs[result.job_id] = result

    def update(self, job_id: str, **fields: Any) -> None:
        current = self._jobs.get(job_id)
        if current is None:
            return
        self._jobs[job_id] = current.model_copy(update=fields)

    def progress_fn(self, job_id: str) -> ProgressFn:
        def _progress(stage: str, value: float) -> None:
            self.update(job_id, status="running", progress=float(value))

        return _progress

    def fail(self, job_id: str, message: str) -> None:
        current = self._jobs.get(job_id) or BakeResult(job_id=job_id, status="failed")
        self._jobs[job_id] = current.model_copy(
            update={"status": "failed", "error": message, "progress": 1.0}
        )

    def __len__(self) -> int:  # pragma: no cover - diagnostics
        return len(self._jobs)


def bake_job(
    registry: JobRegistry,
    job_id: str,
    scene: SceneGraph,
    scene_request: SceneRequest,
    print_params: PrintParams,
    *,
    out_dir: Path = ARTIFACTS_DIR,
) -> BakeResult:
    """Run one job to completion and publish the result.  Never raises."""
    registry.update(job_id, status="running", progress=STAGE_PROGRESS["scene"])
    try:
        output = run_pipeline(
            scene,
            scene_request,
            print_params,
            job_id=job_id,
            out_dir=out_dir,
            progress=registry.progress_fn(job_id),
        )
        registry.put(output.result)
        return output.result
    except BakeError as exc:
        registry.fail(job_id, str(exc))
    except Exception as exc:  # never a 500 on the poll endpoint
        registry.fail(job_id, f"{type(exc).__name__}: {exc}")
    return registry.get(job_id) or BakeResult(job_id=job_id, status="failed")
