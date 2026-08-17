/**
 * GROUND BVH — TRIANGLE-PRECISE RAYCASTS
 *
 * Verified against a plain `THREE.Raycaster` over the same mesh, which is the
 * un-accelerated reference for exactly this query. Both walk the same
 * triangles, so agreement to floating-point tolerance is the correct standard;
 * disagreement means the BVH is mis-traversing.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GroundBVH, createGroundHit, type IGroundHit } from '../mesh-bvh';
import { WORLD_SIZE, WORLD_MIN } from '../constants';
import { createRng } from '@/util';

/**
 * A merged ground/road mesh: a rolling grid over the whole world, which is the
 * shape the real merged terrain has — one big indexed mesh, many coplanar-ish
 * triangles, no hierarchy of its own.
 */
function buildGround(segments = 64): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.getAttribute('position');
  // Gentle relief so height sampling has something to find and the BVH has a
  // real split to make.
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, Math.sin(x * 0.01) * 6 + Math.cos(z * 0.013) * 4);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

const geometry = buildGround();
const bvh = new GroundBVH(geometry);

/** Un-accelerated reference: three's own raycaster over the same mesh. */
const referenceMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
referenceMesh.updateMatrixWorld(true);
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = false;

function reference(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  far: number
): THREE.Intersection | undefined {
  raycaster.set(origin, direction.clone().normalize());
  raycaster.near = 0;
  raycaster.far = far;
  const hits: THREE.Intersection[] = [];
  referenceMesh.raycast(raycaster, hits);
  hits.sort((a, b) => a.distance - b.distance);
  return hits[0];
}

describe('GroundBVH construction', () => {
  it('indexes every triangle of the merged mesh', () => {
    expect(bvh.triangleCount).toBe(64 * 64 * 2);
    expect(bvh.buildMs).toBeGreaterThanOrEqual(0);
    console.log(
      `[bvh] ${bvh.triangleCount} triangles built in ${bvh.buildMs.toFixed(1)} ms`
    );
  });

  it('reports the mesh bounds', () => {
    const box = new THREE.Box3();
    bvh.getBounds(box);
    expect(box.min.x).toBeCloseTo(WORLD_MIN, 2);
    expect(box.max.x).toBeCloseTo(-WORLD_MIN, 2);
    expect(box.max.y).toBeGreaterThan(0);
  });

  it('serialises for the asset cache', () => {
    const packed = bvh.serialize();
    expect(packed.roots.length).toBeGreaterThan(0);
  });
});

describe('GroundBVH raycasts vs THREE.Raycaster', () => {
  const rng = createRng('bvh-rays');
  const hit: IGroundHit = createGroundHit();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();

  it('matches the reference on 300 downward rays', () => {
    let hits = 0;
    for (let i = 0; i < 300; i++) {
      const x = rng.range(WORLD_MIN + 10, -WORLD_MIN - 10);
      const z = rng.range(WORLD_MIN + 10, -WORLD_MIN - 10);
      origin.set(x, 400, z);
      direction.set(0, -1, 0);

      const found = bvh.raycastFirst(origin, direction, 1000, hit);
      const expected = reference(origin, direction, 1000);
      expect(found).toBe(expected !== undefined);
      if (expected !== undefined) {
        expect(hit.distance).toBeCloseTo(expected.distance, 4);
        expect(hit.point.y).toBeCloseTo(expected.point.y, 4);
        hits++;
      }
    }
    expect(hits).toBe(300);
  });

  it('matches the reference on 300 oblique rays', () => {
    let hits = 0;
    for (let i = 0; i < 300; i++) {
      origin.set(
        rng.range(WORLD_MIN, -WORLD_MIN),
        rng.range(20, 300),
        rng.range(WORLD_MIN, -WORLD_MIN)
      );
      const yaw = rng.range(0, Math.PI * 2);
      const pitch = rng.range(-1.4, 0.2);
      direction.set(
        Math.cos(pitch) * Math.sin(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.cos(yaw)
      );

      const found = bvh.raycastFirst(origin, direction, 2000, hit);
      const expected = reference(origin, direction, 2000);
      expect(found).toBe(expected !== undefined);
      if (expected !== undefined) {
        expect(hit.distance).toBeCloseTo(expected.distance, 3);
        hits++;
      }
    }
    // Most downward-ish rays should land; a few aimed at the sky will not.
    expect(hits).toBeGreaterThan(150);
  });

  it('misses cleanly when aimed away from the ground', () => {
    origin.set(0, 100, 0);
    direction.set(0, 1, 0);
    expect(bvh.raycastFirst(origin, direction, 500, hit)).toBe(false);
  });

  it('respects maxDistance', () => {
    origin.set(0, 400, 0);
    direction.set(0, -1, 0);
    expect(bvh.raycastFirst(origin, direction, 100, hit)).toBe(false);
    expect(bvh.raycastFirst(origin, direction, 1000, hit)).toBe(true);
  });
});

describe('GroundBVH gameplay queries', () => {
  const rng = createRng('bvh-height');

  it('samples ground height consistently with a raycast', () => {
    const hit = createGroundHit();
    const origin = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    for (let i = 0; i < 200; i++) {
      const x = rng.range(WORLD_MIN + 20, -WORLD_MIN - 20);
      const z = rng.range(WORLD_MIN + 20, -WORLD_MIN - 20);
      const height = bvh.sampleHeight(x, z);
      expect(height).toBeDefined();

      origin.set(x, 500, z);
      expect(bvh.raycastFirst(origin, down, 1000, hit)).toBe(true);
      expect(height!).toBeCloseTo(hit.point.y, 6);

      // The analytic surface the fixture was built from.
      const analytic = Math.sin(x * 0.01) * 6 + Math.cos(z * 0.013) * 4;
      expect(height!).toBeCloseTo(analytic, 0);
    }
  });

  it('returns undefined off the mesh', () => {
    expect(bvh.sampleHeight(WORLD_MIN - 500, 0)).toBeUndefined();
  });

  it('samples an upward-facing normal', () => {
    const normal = new THREE.Vector3();
    expect(bvh.sampleNormal(30, -40, normal)).toBe(true);
    expect(normal.y).toBeGreaterThan(0.5);
  });

  it('finds the closest surface point to an arbitrary position', () => {
    const target = new THREE.Vector3();
    const probe = new THREE.Vector3(12, 60, -34);
    const distance = bvh.closestPoint(probe, target);
    expect(distance).toBeLessThan(70);
    expect(distance).toBeGreaterThan(0);
    expect(target.distanceTo(probe)).toBeCloseTo(distance, 4);
  });

  it('answers box and sphere overlap', () => {
    const box = new THREE.Box3(new THREE.Vector3(-5, -20, -5), new THREE.Vector3(5, 20, 5));
    expect(bvh.intersectsBox(box)).toBe(true);
    const above = new THREE.Box3(
      new THREE.Vector3(-5, 500, -5),
      new THREE.Vector3(5, 520, 5)
    );
    expect(bvh.intersectsBox(above)).toBe(false);
    expect(bvh.intersectsSphere(new THREE.Sphere(new THREE.Vector3(0, 0, 0), 40))).toBe(true);
  });

  it('pools multi-hit records', () => {
    const hits: IGroundHit[] = [];
    const origin = new THREE.Vector3(0, 400, 0);
    const down = new THREE.Vector3(0, -1, 0);
    const count = bvh.raycastAll(origin, down, 1000, hits);
    expect(count).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.distance).toBeGreaterThanOrEqual(hits[i - 1]!.distance);
    }
    bvh.releaseHits(hits);
    expect(hits.length).toBe(0);

    // Reusing the pool must hand back the same objects, not fresh ones.
    const again: IGroundHit[] = [];
    bvh.raycastAll(origin, down, 1000, again);
    expect(again.length).toBe(count);
    bvh.releaseHits(again);
  });
});
