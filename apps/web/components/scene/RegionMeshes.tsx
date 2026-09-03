"use client";

import { useEffect, useMemo, useRef } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import PerfFrameMark from "@/components/scene/PerfFrameMark";
import type { RecessBand, RegionMesh } from "@/lib/engine/types";
import { perfSpan } from "@/lib/perf";

/**
 * The model, and since v3.1 the ONLY thing the viewport draws.
 *
 * Every `RegionMesh` here is a solid the pipeline finished and streamed as its
 * `finish-<region>` stage completed: the exact triangles the export writes, at
 * the export's own resolution, with the export's own per-region filament
 * colour. There is no approximate stack behind it any more, so a run in
 * flight no longer takes the model off the screen -- the previous meshes stay
 * up, dimmed, and each region is replaced on its own the moment a newer one
 * arrives (design rulings 1 and 3).
 *
 * Two things follow from that and are worth stating.
 *
 * **A region is rebuilt only when its own mesh changed.** The worker never
 * re-sends a region whose `finish-<region>` key matched the `known` map the
 * store passed it, so a new `RegionMesh` object IS a changed hash, and keying
 * the per-region cache on object identity is exactly "rebuild iff the hash
 * moved". A lettering edit therefore re-uploads the frame and nothing else.
 *
 * **Recess shading is presentation, not geometry.** `EngineResult.recessBands`
 * names the Z bands the lettering, ornament and underside cuts occupy per
 * region; a triangle whose centroid Z falls inside one of its own region's
 * bands is given a darker vertex colour, so an engraved line reads at viewing
 * distance instead of disappearing into the single flat colour of the region
 * it was cut into. Not one coordinate moves; the band list is a named
 * exception in `docs/handoff/v3-01-pipeline.md` section 5.
 *
 * `RegionMesh.positions` is double precision (`lib/engine/types.ts`: a
 * consumer that writes a FILE must keep that precision, but a GPU buffer
 * cannot hold one and has to make its own float32 copy) -- WebGL vertex
 * buffers do not support `Float64Array`, so this is that copy, made once here
 * and nowhere else in the render path.
 */

/** One region's own bands, in the order the engine emitted them. */
export function bandsForRegion(bands: readonly RecessBand[], region: string): RecessBand[] {
  return bands.filter((band) => band.region === region);
}

/** True when `z` lies inside any band, endpoints included. */
export function insideBands(z: number, bands: readonly RecessBand[]): boolean {
  for (const band of bands) {
    if (z >= band.zMm[0] && z <= band.zMm[1]) return true;
  }
  return false;
}

/**
 * One region's `BufferGeometry`.
 *
 * With no bands this is the indexed mesh the worker sent, vertex for vertex:
 * manifold3d shares vertices across faces (that is what makes it watertight)
 * and `flatShading` reads per-face normals in the fragment shader through
 * `fwidth`, so nothing has to be duplicated to keep a building's edges sharp.
 *
 * With bands the triangles are expanded, because a vertex colour is per VERTEX
 * and a shared vertex cannot be both shaded and not. The expansion costs three
 * vertices per triangle in the two regions that carry cuts (the base and the
 * frame) and nothing at all in the buildings, the roads, the water and the
 * parks, which carry none. The colour is a MULTIPLIER: 1 leaves the region's
 * own filament colour exactly as it was, `shade` darkens it.
 */
export function buildGeometry(
  region: RegionMesh,
  bands: readonly RecessBand[],
  shade: number,
): BufferGeometry {
  const geometry = new BufferGeometry();
  if (bands.length === 0) {
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(region.positions), 3));
    geometry.setIndex(new BufferAttribute(region.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  const triangles = Math.floor(region.indices.length / 3);
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t += 1) {
    const out = t * 9;
    let zSum = 0;
    for (let k = 0; k < 3; k += 1) {
      const source = region.indices[t * 3 + k] * 3;
      positions[out + k * 3] = region.positions[source];
      positions[out + k * 3 + 1] = region.positions[source + 1];
      positions[out + k * 3 + 2] = region.positions[source + 2];
      zSum += region.positions[source + 2];
    }
    const tint = insideBands(zSum / 3, bands) ? shade : 1;
    for (let k = 0; k < 9; k += 1) colors[out + k] = tint;
  }
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A region with too few vertices to be a surface is not drawn (and is not an error: an empty region is a real outcome). */
function drawable(mesh: RegionMesh): boolean {
  return mesh.indices.length >= 3 && mesh.positions.length >= 9;
}

export interface BuiltRegion {
  region: string;
  mesh: RegionMesh;
  bands: RecessBand[];
  geometry: BufferGeometry;
}

interface CacheEntry extends BuiltRegion {
  /** The band list this geometry was shaded with, by value: bands move without the mesh moving. */
  bandsKey: string;
  shade: number;
}

function bandsKeyOf(bands: readonly RecessBand[]): string {
  return bands.map((band) => `${band.kind}:${band.zMm[0]}:${band.zMm[1]}`).join("|");
}

export interface ReconcileResult {
  /** Counts up once per pass that built or dropped something: what re-arms the on-screen mark. */
  id: number;
  regions: BuiltRegion[];
}

/**
 * The per-region geometry cache, as a plain object so it can be driven twice
 * in a test without a React renderer.
 *
 * `reconcile` is the whole rule: a region whose `RegionMesh` object, band list
 * and shade are all unchanged keeps the exact `BufferGeometry` it already had,
 * every other region is rebuilt, and a region the worker removed is disposed.
 * Because the worker only re-sends a region whose `finish-<region>` key moved,
 * "same object" IS "same hash", so this rebuilds a region if and only if its
 * hash changed.
 */
export class RegionGeometryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private generation = 0;

  reconcile(
    regions: ReadonlyMap<string, RegionMesh>,
    recessBands: readonly RecessBand[],
    recessShade: number,
  ): ReconcileResult {
    const out: BuiltRegion[] = [];
    const live = new Set<string>();
    let moved = false;
    for (const [name, mesh] of regions) {
      if (!drawable(mesh)) continue;
      live.add(name);
      const bands = bandsForRegion(recessBands, name);
      const bandsKey = bandsKeyOf(bands);
      const hit = this.entries.get(name);
      if (hit !== undefined && hit.mesh === mesh && hit.bandsKey === bandsKey && hit.shade === recessShade) {
        out.push(hit);
        continue;
      }
      hit?.geometry.dispose();
      // `preview.region.<name>` is CPU time and only CPU time: the float64 ->
      // float32 copy, the recess pass, the vertex normals and the bounding
      // sphere for THIS region. Nothing here touches the GPU; three.js uploads
      // a buffer lazily, on the first render that binds it.
      const geometry = perfSpan(`preview.region.${name}`, () =>
        buildGeometry(mesh, bands, recessShade),
      );
      const entry: CacheEntry = { region: name, mesh, bands, bandsKey, shade: recessShade, geometry };
      this.entries.set(name, entry);
      out.push(entry);
      moved = true;
    }
    for (const [name, entry] of this.entries) {
      if (live.has(name)) continue;
      entry.geometry.dispose();
      this.entries.delete(name);
      moved = true;
    }
    if (moved) this.generation += 1;
    return { id: this.generation, regions: out };
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.geometry.dispose();
    this.entries.clear();
  }
}

export function RegionMeshes({
  regions,
  recessBands,
  dimmed,
  dimOpacity,
  recessShade,
}: {
  regions: ReadonlyMap<string, RegionMesh>;
  recessBands: readonly RecessBand[];
  /** True while the meshes describe older parameters than the controls do. */
  dimmed: boolean;
  dimOpacity: number;
  recessShade: number;
}) {
  // A ref rather than a memo because the unit of work is ONE region: a memo
  // over the whole map would rebuild every region's buffers whenever any
  // single one arrived, which is the cost progressive streaming exists to
  // avoid.
  const cache = useRef<RegionGeometryCache | null>(null);
  cache.current ??= new RegionGeometryCache();
  const store = cache.current;

  const built = useMemo(
    () => store.reconcile(regions, recessBands, recessShade),
    [store, regions, recessBands, recessShade],
  );

  // Every geometry still in the cache is this component's own to dispose when
  // it unmounts; the reconciliation above owns the rest.
  useEffect(() => () => store.dispose(), [store]);

  // `data-testid` on a react-three-fiber primitive is NOT a DOM attribute --
  // `<group>`/`<mesh>` become real `THREE.Object3D` instances inside the
  // WebGL canvas, not HTML elements, so a Playwright DOM locator can never
  // find these. They are still named for anyone reading the render tree with
  // r3f devtools or the `useThree` state directly; an e2e that needs to prove
  // a region is on screen reads `window.__framecraft` (`CityPreview.tsx`),
  // not a DOM query.
  return (
    <group data-testid="region-meshes">
      {/* Perf mode only: the first frame that actually renders these meshes,
          which is where three.js uploads the buffers this component built. */}
      <PerfFrameMark key={built.id} name="preview.geometryOnScreen" />
      {built.regions.map(({ region, mesh, bands, geometry }) => (
        <mesh
          key={region}
          data-testid={`region-mesh-${region}`}
          geometry={geometry}
          castShadow={!dimmed}
          receiveShadow={!dimmed}
        >
          <meshStandardMaterial
            color={mesh.colorHex}
            vertexColors={bands.length > 0}
            roughness={0.85}
            flatShading
            transparent={dimmed}
            opacity={dimmed ? dimOpacity : 1}
            depthWrite={!dimmed}
          />
        </mesh>
      ))}
    </group>
  );
}

export default RegionMeshes;
