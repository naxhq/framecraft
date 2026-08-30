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

import datetime as _datetime
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
from app.geom import assemble, lettering, thicken, tokens, transform as T
from app.validate import checks as validators
from app.validate import container

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


class UndersideTooThinError(BakeError):
    """The hanger or the underside mark would break through the base plate."""


def token_context(
    scene: SceneGraph,
    params: PrintParams,
    date: str | None = None,
) -> tokens.TokenContext:
    """The context every ``{token}`` in an engraving expands against.

    Everything comes from the SCENE and the params: the centre and the radius
    are the ones the scene was actually built with, which is what a legend on
    the finished object has to describe.  (It used to take the ``SceneRequest``
    too and never read it - v2-03 audit, finding 13.)

    ``date`` defaults to TODAY'S UTC date in ISO form, which is what a frame
    legend means by "the date"; it is an argument so a test - and a reproducible
    re-bake from a sidecar - can pin it instead of depending on the day the
    command runs.
    """
    radius_m = T.radius_m_from_bounds(scene.bounds)
    return tokens.TokenContext(
        lat=float(scene.center.lat),
        lon=float(scene.center.lon),
        scale_mm_per_m=T.scale_mm_per_m(params, radius_m),
        radius_m=radius_m,
        date=date or _datetime.datetime.now(_datetime.timezone.utc).date().isoformat(),
        buildings=int(scene.stats.building_count),
        city=str(getattr(params, "city_label", "") or ""),
    )


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


def _wants_lettering(params: PrintParams) -> bool:
    """True when this parameter set asks for any text or ornament at all.

    A v1 parameter set asks for none, so the whole lettering path - including
    loading a font - is skipped and the model is bit-identical to v1's.
    """
    if getattr(params, "engravings", None):
        return True
    if bool(getattr(getattr(params, "north_arrow", None), "enabled", False)):
        return True
    if bool(getattr(getattr(params, "scale_bar", None), "enabled", False)):
        return True
    if bool(getattr(getattr(params, "underside_mark", None), "enabled", False)):
        return True
    return str(getattr(params, "hanger", None) or "none") != "none"


def _detail_advice(scene: SceneGraph, params: PrintParams) -> str | None:
    """The detail advisor's sentence, but only when the band is ``poor``.

    04's Stage 1 does the right thing with a crop that is too wide for the plate
    - it widens and merges - and the model still prints; what it cannot do is
    tell the user that the city they are looking at has lost its small
    buildings.  That is this line's job, and it is the same sentence, from the
    same shared function, that the editor's HUD shows.
    """
    radius_m = T.radius_m_from_bounds(scene.bounds)
    report = T.detail_report(scene, params, radius_m)
    if report.band != "poor":
        return None
    return T.detail_recommendation(scene, params, radius_m)


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
    date: str | None = None,
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

    # The underside pockets are refused on arithmetic alone, before anything is
    # built: a keyhole 2 mm deep in a 3 mm plate that also carries a 0.6 mm road
    # engraving leaves 0.4 mm of picture over the screw, and printing a hole
    # through the plate is not something to warn about and ship.
    letters = None
    if _wants_lettering(print_params):
        ctx = token_context(scene, print_params, date=date)
        try:
            letters = lettering.build(
                print_params, ctx, rotation_deg=float(scene_request.rotation_deg)
            )
        except lettering.BaseTooThinError as exc:
            raise UndersideTooThinError(str(exc)) from exc
        warnings.extend(letters.warnings)

    tick("scene")

    # ---- Stage 1 --------------------------------------------------------
    t0 = time.perf_counter()
    repaired = thicken.repair_scene(scene, print_params)
    timings["repair"] = time.perf_counter() - t0
    warnings.extend(repaired.warnings)
    tick("repair")

    # The detail advisor's one-liner, when this radius and plate are losing the
    # city (04 stage 1 is doing its job; the user should still be told).
    advice = _detail_advice(scene, print_params)
    if advice:
        warnings.append(advice)

    # ---- Stage 2 --------------------------------------------------------
    t0 = time.perf_counter()
    assembly = assemble.assemble(
        repaired, print_params, progress=lambda s, _v: tick(s), lettering=letters
    )
    timings["assemble"] = time.perf_counter() - t0

    # ---- to trimesh -----------------------------------------------------
    t0 = time.perf_counter()
    mesh = manifold_to_trimesh(assembly.solid)
    #: What the colour parts partition, before any decimation: the parts are cut
    #: from these exact solids, so this is what ``parts_union`` compares against.
    assembled = mesh
    mesh, decimation = validators.enforce_triangle_budget(mesh)
    if decimation:
        warnings.append(decimation)
        if assembly.color_parts:
            warnings.append(
                "the .3mf parts are NOT decimated: decimating them independently "
                "would break the partition, so only the .stl is reduced"
            )
    part_meshes = [(p.name, manifold_to_trimesh(p.solid)) for p in assembly.color_parts]
    parts_union_mesh = (
        manifold_to_trimesh(assembly.parts_union)
        if assembly.parts_union is not None
        else None
    )
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
        # Glyph outlines in the model are third-party work under the OFL, and
        # the package has to say so.  Only when text was actually cut: a plate
        # with no lettering carries no letterforms (v2-03 audit, finding 5).
        extra_license=(
            export.FONT_LICENSE_LINE
            if letters is not None and letters.measures
            else None
        ),
    )
    if assembly.color_parts:
        # One 3MF object per colour, assembled into a single build item.  The
        # STL is the single welded body in both modes (it has no notion of
        # parts), so it is always written from the assembled solid.
        by_name = dict(part_meshes)
        mf3_path = mf3.write_3mf_parts(
            out_dir / f"{stem}.3mf",
            [
                mf3.PartMesh(
                    part.name,
                    part.color,
                    by_name[part.name].vertices,
                    by_name[part.name].faces,
                )
                for part in assembly.color_parts
            ],
            metadata,
        )
    else:
        mf3_path = mf3.write_3mf(out_dir / f"{stem}.3mf", mesh.vertices, mesh.faces, metadata)
    stl_path = stl.write_stl(out_dir / f"{stem}.stl", mesh)
    timings["export"] = time.perf_counter() - t0
    tick("export")

    # ---- Stage 4 --------------------------------------------------------
    t0 = time.perf_counter()
    report = validators.validate(mesh, print_params, manifold=assembly.solid)
    # 04 stage 3 is as much a part of the gate as stage 4 is, and the job that
    # WROTE the package is the only one that can refuse to ship it: `POST /bake`
    # marks a download done on `report.passed` alone, so a container row that
    # only ever ran under `make validate` was a row the product path never saw
    # (v2-02 audit, finding 5).  The rows are the same functions the CLI calls,
    # on the file that was just written.
    if assembly.color_parts:
        container_rows, components = container.parts_checks(mf3_path, part_meshes)
        report.checks.extend(
            validators.validate_parts(
                part_meshes,
                union=parts_union_mesh,
                reference=assembled,
                # The component count comes from the FILE, not from the assembly:
                # that is what makes `bodies` a statement about what shipped.
                components=components,
                # The solids themselves, not their meshes: the symmetric
                # difference is a boolean, and the bake still holds both.
                union_solid=assembly.parts_union,
                reference_solid=assembly.solid,
            )
        )
        report.checks.append(
            container.color_mode_check("parts", str(print_params.color_mode))
        )
        report.checks.extend(container_rows)
    else:
        # One connected solid: the parts path has its own `bodies` row and the
        # single path had none inside the bake at all.
        report.checks.append(validators.single_body_check(mesh, assembly.solid))
        report.checks.extend(container.structure_checks(mf3_path, mesh))
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
