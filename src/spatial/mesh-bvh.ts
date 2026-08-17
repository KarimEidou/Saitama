/**
 * TRIANGLE BVH FOR THE MERGED GROUND / ROAD MESH
 *
 * The quadtree indexes BOXES, which is the right granularity for deciding what
 * to draw but useless for "exactly how high is the pavement under Saitama's
 * left foot". Ground contact and projectile impacts need triangle precision, so
 * the merged ground/road mesh gets a real BVH — `three-mesh-bvh`, wrapped here
 * so callers never touch the library directly and the traversal stays behind
 * one narrow, allocation-controlled surface.
 *
 * Why a separate structure rather than putting triangles in the quadtree: the
 * ground is one mesh of tens of thousands of coplanar triangles spread over the
 * whole 1536 m world. A quadtree over it would be almost entirely leaf overlap;
 * a SAH BVH built over the triangles is the structure that actually fits the
 * data, and it costs one build at load and nothing per frame.
 *
 * ── ALLOCATION NOTE ────────────────────────────────────────────────────────
 * `THREE.Ray`, the scratch vectors and the hit records are all pooled or
 * owned by this object. The single allocation this wrapper cannot remove is the
 * `Intersection` object `three-mesh-bvh` returns from `raycastFirst`; its
 * fields are copied straight into a pooled `IGroundHit` and the temporary is
 * dropped immediately, so it dies in the nursery instead of surviving into a
 * major GC.
 */

import * as THREE from 'three';
import { MeshBVH, type MeshBVHOptions } from 'three-mesh-bvh';
import { ObjectPool } from '@/util';

/** One triangle-precise hit. Pooled; return it with `releaseHit`. */
export interface IGroundHit {
  /** Metres along the ray. */
  distance: number;
  /** World-space contact point. */
  readonly point: THREE.Vector3;
  /** World-space face normal, oriented as authored. */
  readonly normal: THREE.Vector3;
  /** Index of the triangle hit, for material / surface-type lookup. */
  faceIndex: number;
}

/** Construction options. */
export interface IGroundBvhOptions {
  /** Passed through to three-mesh-bvh. */
  readonly bvh?: MeshBVHOptions;
  /** Which side of a triangle counts as a hit. Default: double-sided. */
  readonly side?: THREE.Side;
  /**
   * World transform of the mesh. When supplied, rays are transformed into
   * local space and results back into world space. Omit for a merged mesh
   * already baked into world coordinates — the fast path.
   */
  readonly matrixWorld?: THREE.Matrix4;
  /** Pre-allocated hit records. */
  readonly hitPoolSize?: number;
}

/**
 * Wrapper around a `MeshBVH` for the merged ground/road mesh.
 * One instance per merged mesh; rebuild only when the mesh itself changes.
 */
export class GroundBVH {
  readonly geometry: THREE.BufferGeometry;
  readonly bvh: MeshBVH;
  readonly side: THREE.Side;
  /** Milliseconds spent building. */
  readonly buildMs: number;
  /** Triangles indexed. */
  readonly triangleCount: number;

  private readonly hasTransform: boolean;
  private readonly localMatrix = new THREE.Matrix4();
  private readonly worldMatrix = new THREE.Matrix4();
  private readonly normalMatrix = new THREE.Matrix3();

  private readonly ray = new THREE.Ray();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchBox = new THREE.Box3();
  private readonly hitPool: ObjectPool<IGroundHit>;
  /** Reused by `sampleHeight`, which is called every frame for the player. */
  private readonly heightHit: IGroundHit;

  constructor(geometry: THREE.BufferGeometry, options: IGroundBvhOptions = {}) {
    this.geometry = geometry;
    this.side = options.side ?? THREE.DoubleSide;

    const started = now();
    this.bvh = new MeshBVH(geometry, {
      // SAH costs more to build and pays it back on every raycast; the ground
      // mesh is built once at load, so the trade is free.
      strategy: 2 /* SAH */,
      maxDepth: 40,
      ...options.bvh,
    });
    this.buildMs = now() - started;

    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    this.triangleCount = index !== null ? index.count / 3 : (position?.count ?? 0) / 3;

    this.hasTransform = options.matrixWorld !== undefined;
    if (options.matrixWorld !== undefined) {
      this.worldMatrix.copy(options.matrixWorld);
      this.localMatrix.copy(options.matrixWorld).invert();
      this.normalMatrix.getNormalMatrix(this.worldMatrix);
    }

    this.hitPool = new ObjectPool<IGroundHit>({
      factory: createGroundHit,
      reset: (hit) => {
        hit.distance = 0;
        hit.faceIndex = -1;
      },
      initialSize: options.hitPoolSize ?? 8,
      maxSize: 64,
    });
    this.heightHit = createGroundHit();
  }

  /** Update the world transform after the mesh moves. Rare. */
  setMatrixWorld(matrix: THREE.Matrix4): void {
    this.worldMatrix.copy(matrix);
    this.localMatrix.copy(matrix).invert();
    this.normalMatrix.getNormalMatrix(this.worldMatrix);
  }

  /** World-space AABB of the whole mesh. */
  getBounds(target: THREE.Box3): THREE.Box3 {
    this.bvh.getBoundingBox(target);
    if (this.hasTransform) target.applyMatrix4(this.worldMatrix);
    return target;
  }

  /**
   * Nearest triangle along a ray.
   *
   * @param direction Need not be normalised; it is normalised internally so
   *   `distance` is always in metres.
   * @param target Caller-owned record, so a per-frame cast allocates nothing.
   * @returns true when something was hit.
   */
  raycastFirst(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    target: IGroundHit
  ): boolean {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction).normalize();
    if (this.hasTransform) this.ray.applyMatrix4(this.localMatrix);

    const hit = this.bvh.raycastFirst(this.ray, this.side, 0, maxDistance);
    if (hit === null) return false;

    target.distance = hit.distance;
    target.point.copy(hit.point);
    if (hit.normal !== undefined) target.normal.copy(hit.normal);
    else target.normal.set(0, 1, 0);
    target.faceIndex = hit.faceIndex ?? -1;

    if (this.hasTransform) {
      target.point.applyMatrix4(this.worldMatrix);
      target.normal.applyMatrix3(this.normalMatrix).normalize();
      target.distance = target.point.distanceTo(origin);
    }
    return true;
  }

  /**
   * Every triangle along a ray, nearest first.
   *
   * Hits come from the pool; hand them back with `releaseHits` once consumed.
   * Used by penetrating projectiles and by the destruction system deciding how
   * many surfaces a punch passes through.
   */
  raycastAll(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    out: IGroundHit[]
  ): number {
    out.length = 0;
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction).normalize();
    if (this.hasTransform) this.ray.applyMatrix4(this.localMatrix);

    const raw = this.bvh.raycast(this.ray, this.side, 0, maxDistance);
    raw.sort((a, b) => a.distance - b.distance);

    for (let i = 0; i < raw.length; i++) {
      const hit = raw[i]!;
      const record = this.hitPool.acquire();
      record.distance = hit.distance;
      record.point.copy(hit.point);
      if (hit.normal !== undefined && hit.normal !== null) record.normal.copy(hit.normal);
      else record.normal.set(0, 1, 0);
      record.faceIndex = hit.faceIndex ?? -1;
      if (this.hasTransform) {
        record.point.applyMatrix4(this.worldMatrix);
        record.normal.applyMatrix3(this.normalMatrix).normalize();
        record.distance = record.point.distanceTo(origin);
      }
      out.push(record);
    }
    return out.length;
  }

  /** Return pooled hits from `raycastAll`. */
  releaseHits(hits: IGroundHit[]): void {
    for (let i = 0; i < hits.length; i++) this.hitPool.release(hits[i]!);
    hits.length = 0;
  }

  /** Take a single hit record from the pool. */
  acquireHit(): IGroundHit {
    return this.hitPool.acquire();
  }

  /** Return a single hit record. */
  releaseHit(hit: IGroundHit): void {
    this.hitPool.release(hit);
  }

  /**
   * Ground height under a world position, or `undefined` when there is no
   * surface. THE per-frame query for the character controller: one downward
   * ray from `fromY`, reusing an internal hit record so nothing is allocated.
   */
  sampleHeight(x: number, z: number, fromY = 500, maxDistance = 1000): number | undefined {
    this.scratchDir.set(0, -1, 0);
    HEIGHT_ORIGIN.set(x, fromY, z);
    if (!this.raycastFirst(HEIGHT_ORIGIN, this.scratchDir, maxDistance, this.heightHit)) {
      return undefined;
    }
    return this.heightHit.point.y;
  }

  /** Surface normal under a world position, written into `target`. */
  sampleNormal(x: number, z: number, target: THREE.Vector3, fromY = 500): boolean {
    this.scratchDir.set(0, -1, 0);
    HEIGHT_ORIGIN.set(x, fromY, z);
    if (!this.raycastFirst(HEIGHT_ORIGIN, this.scratchDir, fromY * 2, this.heightHit)) return false;
    target.copy(this.heightHit.normal);
    return true;
  }

  /** True when any triangle intersects the world-space box. */
  intersectsBox(box: THREE.Box3): boolean {
    if (!this.hasTransform) return this.bvh.intersectsBox(box, IDENTITY);
    this.scratchBox.copy(box);
    return this.bvh.intersectsBox(this.scratchBox, this.localMatrix);
  }

  /** True when any triangle intersects the world-space sphere. */
  intersectsSphere(sphere: THREE.Sphere): boolean {
    return this.bvh.intersectsSphere(sphere);
  }

  /**
   * Nearest surface point to a world position. Used to push a character out of
   * a wall it has been shoved into and to snap debris onto the ground.
   */
  closestPoint(point: THREE.Vector3, target: THREE.Vector3, maxDistance = Infinity): number {
    const info = this.bvh.closestPointToPoint(point, CLOSEST_INFO, 0, maxDistance);
    if (info === null) return Infinity;
    target.copy(info.point);
    return info.distance;
  }

  /** Serialised BVH for the asset cache, avoiding a rebuild at load. */
  serialize(): ReturnType<typeof MeshBVH.serialize> {
    return MeshBVH.serialize(this.bvh);
  }

  /** Drop references. The BVH holds no GPU resources of its own. */
  dispose(): void {
    this.hitPool.clear();
  }
}

/** Fresh hit record; the pool factory. */
export function createGroundHit(): IGroundHit {
  return {
    distance: 0,
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(0, 1, 0),
    faceIndex: -1,
  };
}

const IDENTITY = /* @__PURE__ */ new THREE.Matrix4();
const HEIGHT_ORIGIN = /* @__PURE__ */ new THREE.Vector3();
const CLOSEST_INFO = {
  point: /* @__PURE__ */ new THREE.Vector3(),
  distance: 0,
  faceIndex: -1,
};

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
