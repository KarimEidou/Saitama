/**
 * SHARED TEST / HARNESS SCAFFOLDING
 *
 * Ground planes and synthetic fracture chunks, used by the unit tests and the
 * `harness/physics.*` scene. Kept out of the test files themselves so the
 * harness (which is not a test file) can use exactly the same fixtures — a
 * scenario that passes in vitest and a scenario that renders in the browser
 * must be the same scenario, or neither proves anything about the other.
 *
 * Everything here is deterministic: fixture generation takes an `IRandom`, and
 * `Math.random()` appears nowhere.
 */

import * as THREE from 'three';
import type { FractureChunk } from '@/types';
import { type IRandom } from '@/util';
import type { PhysicsBody } from './body';
import type { PhysicsWorld } from './world';

/** Add a large static ground slab. Returns the body. */
export function makeGround(world: PhysicsWorld, halfSize = 60, y = 0): PhysicsBody {
  return world.createBody({
    type: 'fixed',
    shape: { kind: 'box', halfExtents: new THREE.Vector3(halfSize, 0.5, halfSize) },
    position: new THREE.Vector3(0, y - 0.5, 0),
    layer: 'world',
    collidesWith: ['player', 'monster', 'npc', 'debris', 'projectile', 'ragdoll'],
    friction: 0.9,
    restitution: 0.02,
  });
}

/** Four static walls forming an open-topped box, to keep debris in frame. */
export function makeArenaWalls(world: PhysicsWorld, halfSize = 9, height = 6): PhysicsBody[] {
  const t = 0.5;
  const specs: readonly [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(t, height, halfSize), new THREE.Vector3(halfSize + t, height, 0)],
    [new THREE.Vector3(t, height, halfSize), new THREE.Vector3(-halfSize - t, height, 0)],
    [new THREE.Vector3(halfSize, height, t), new THREE.Vector3(0, height, halfSize + t)],
    [new THREE.Vector3(halfSize, height, t), new THREE.Vector3(0, height, -halfSize - t)],
  ];
  return specs.map(([halfExtents, position]) =>
    world.createBody({
      type: 'fixed',
      shape: { kind: 'box', halfExtents },
      position,
      layer: 'world',
      collidesWith: ['player', 'monster', 'debris', 'ragdoll'],
      friction: 0.6,
      restitution: 0.02,
    })
  );
}

/** A synthetic fracture chunk: a box of the given half-extents. */
export function makeChunk(
  index: number,
  halfExtents: THREE.Vector3,
  geometry: THREE.BufferGeometry,
  density = 2400
): FractureChunk {
  const volume = 8 * halfExtents.x * halfExtents.y * halfExtents.z;
  return {
    index,
    geometry,
    centroid: new THREE.Vector3(0, 0, 0),
    volume,
    mass: volume * density,
    bounds: new THREE.Box3(
      new THREE.Vector3(-halfExtents.x, -halfExtents.y, -halfExtents.z),
      new THREE.Vector3(halfExtents.x, halfExtents.y, halfExtents.z)
    ),
    neighbours: [],
    isGrounded: false,
    detached: true,
  };
}

/** One generated debris drop: the chunk plus where and how hard it enters. */
export interface IDebrisSpawnSpec {
  readonly chunk: FractureChunk;
  readonly matrix: THREE.Matrix4;
  readonly impulse: THREE.Vector3;
  /** Kept so a caller can dispose the geometry it owns. */
  readonly geometry: THREE.BufferGeometry;
}

/**
 * Deterministically generate `count` debris drops in a column above the origin.
 *
 * Sizes straddle `DEBRIS_MIN_PHYSICS_SIZE` on purpose so a run exercises both
 * the simulated and the ballistic path.
 */
export function generateDebrisField(
  rng: IRandom,
  count: number,
  options: {
    readonly spread?: number;
    readonly minHeight?: number;
    readonly maxHeight?: number;
    readonly minSize?: number;
    readonly maxSize?: number;
    readonly impulse?: number;
    /**
     * Share of pieces generated small enough to skip the solver. Sampling all
     * three extents independently from one range makes gravel vanishingly
     * unlikely, so the ballistic path has to be asked for explicitly.
     */
    readonly gravelFraction?: number;
    /** Largest extent a gravel piece may have. */
    readonly gravelSize?: number;
  } = {}
): IDebrisSpawnSpec[] {
  const spread = options.spread ?? 5;
  const minHeight = options.minHeight ?? 3;
  const maxHeight = options.maxHeight ?? 22;
  const minSize = options.minSize ?? 0.12;
  const maxSize = options.maxSize ?? 0.5;
  const impulseScale = options.impulse ?? 0;
  const gravelFraction = options.gravelFraction ?? 0;
  const gravelSize = options.gravelSize ?? 0.14;

  const specs: IDebrisSpawnSpec[] = [];
  for (let i = 0; i < count; i++) {
    const gravel = gravelFraction > 0 && rng.next() < gravelFraction;
    const lo = gravel ? 0.05 : minSize;
    const hi = gravel ? gravelSize : maxSize;
    const hx = rng.range(lo, hi) * 0.5;
    const hy = rng.range(lo, hi) * 0.5;
    const hz = rng.range(lo, hi) * 0.5;
    const geometry = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    const chunk = makeChunk(i, new THREE.Vector3(hx, hy, hz), geometry);

    const [x, z] = rng.insideCircle(spread);
    const y = rng.range(minHeight, maxHeight);
    const rotation = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rng.range(0, Math.PI), rng.range(0, Math.PI), rng.range(0, Math.PI))
    );
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      rotation,
      new THREE.Vector3(1, 1, 1)
    );
    const impulse = new THREE.Vector3(
      rng.range(-1, 1) * impulseScale,
      rng.range(-0.2, 0.4) * impulseScale,
      rng.range(-1, 1) * impulseScale
    );
    specs.push({ chunk, matrix, impulse, geometry });
  }
  return specs;
}

/** Flatten body positions into a comparable buffer, for determinism checks. */
export function snapshotPositions(bodies: readonly PhysicsBody[]): Float64Array {
  const out = new Float64Array(bodies.length * 7);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  for (let i = 0; i < bodies.length; i++) {
    bodies[i]!.getTransform(position, rotation);
    out[i * 7] = position.x;
    out[i * 7 + 1] = position.y;
    out[i * 7 + 2] = position.z;
    out[i * 7 + 3] = rotation.x;
    out[i * 7 + 4] = rotation.y;
    out[i * 7 + 5] = rotation.z;
    out[i * 7 + 6] = rotation.w;
  }
  return out;
}

/** Largest absolute difference between two snapshots. */
export function maxAbsDifference(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!);
    if (d > max) max = d;
  }
  return max;
}
