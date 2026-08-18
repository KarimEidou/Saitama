/**
 * COLLIDER RESIDENCY — THE RING GAP THAT DROPPED THE PLAYER OUT OF THE WORLD
 *
 * `RESIDENT_RADIUS_BY_TIER` is 2 at tier medium and high; `COLLIDER_RADIUS` is
 * 1, and deliberately so — the two rings are sized by different budgets and
 * closing the gap by widening the constant is the wrong fix.
 *
 * What that means in practice is that at those tiers MOST chunks are built
 * outside the collider ring. `build()` took its `distance` argument, saw ring
 * 2, and skipped both the per-building boxes and the chunk's ground slab; it
 * then returned early for the rest of that chunk's life, and no other code path
 * ever revisited the decision. So sixteen chunks of ring 2 stood there with
 * geometry, registered destructible structures, crowd obstacles and a visible
 * road, and nothing at all under them. Walk onto one and you fall forever.
 *
 * These tests pin the three transitions: the gap exists at build time (ring 2
 * has no physics and is not supposed to), walking onto a ring-2 chunk PROMOTES
 * it — ground slab included — and walking two rings away again gives the bodies
 * back to Rapier rather than leaking them.
 *
 * No renderer and no Rapier: the physics world is a stub that hands out
 * incrementing handles and records what it was asked to build, which is the
 * only way the ground slab's geometry stays asserted.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEventBus } from '@/util';
import { DestructionSystem } from '@/gameplay/destruction';
import type { IRigidBodyDesc } from '@/types';
import type { PhysicsWorld } from '@/physics';
import { CityGenerator, type ICityPlan } from '@/world/city';
import { CHUNK_SIZE } from '@/spatial';
import rawPlan from '../../../assets/district/cityz.plan.json';
import { COLLIDER_RADIUS } from '../config';
import { CityStreamer, type IResidentChunk } from '../city-streamer';

/** A physics world that only remembers what it was asked to do. */
function stubPhysics(): {
  physics: PhysicsWorld;
  created: IRigidBodyDesc[];
  removed: number[];
} {
  const created: IRigidBodyDesc[] = [];
  const removed: number[] = [];
  let nextHandle = 1;
  return {
    physics: {
      createBody: (desc: IRigidBodyDesc) => {
        created.push(desc);
        return { handle: nextHandle++ };
      },
      removeBody: (handle: number) => {
        removed.push(handle);
      },
    } as unknown as PhysicsWorld,
    created,
    removed,
  };
}

/** The centre of a chunk in world metres — what the focus is actually set to. */
function chunkCentre(cx: number, cz: number): [number, number] {
  return [(cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE];
}

function ring(chunk: IResidentChunk, cx: number, cz: number): number {
  return Math.max(Math.abs(chunk.cx - cx), Math.abs(chunk.cz - cz));
}

function chunkAt(streamer: CityStreamer, cx: number, cz: number): IResidentChunk {
  const chunk = streamer.chunks.find((c) => c.cx === cx && c.cz === cz);
  expect(chunk, `chunk (${cx},${cz}) should still be resident`).toBeDefined();
  return chunk!;
}

/** Tier `high`, so the resident ring is 2 and the collider ring is 1. */
function makeStreamer(): {
  streamer: CityStreamer;
  created: IRigidBodyDesc[];
  removed: number[];
  dispose: () => void;
} {
  const generator = new CityGenerator(rawPlan as unknown as ICityPlan, {
    defaultDetail: 'box',
    includeProps: true,
  });
  const bus = createEventBus();
  const destruction = new DestructionSystem({ bus });
  const { physics, created, removed } = stubPhysics();
  const streamer = new CityStreamer({
    generator,
    scene: new THREE.Scene(),
    resolve: () => new THREE.MeshBasicMaterial(),
    destruction,
    physics,
    quality: 'high',
  });
  return {
    streamer,
    created,
    removed,
    dispose: () => {
      streamer.dispose();
      destruction.dispose();
    },
  };
}

describe('city collider residency follows the current ring', () => {
  it('promotes a ring-2 chunk, ground slab included, when the focus walks onto it', () => {
    const { streamer, created, removed, dispose } = makeStreamer();
    try {
      streamer.setFocus(0, 0);
      streamer.buildImmediate(2);

      // ── Boot: the collider ring is exactly one chunk wide ────────────────
      // Ring 2 legitimately has no physics yet. It also has buildings, which is
      // the whole problem: this is a populated, destructible, walkable chunk.
      let ringTwo = 0;
      for (const chunk of streamer.chunks) {
        const distance = ring(chunk, 0, 0);
        if (distance <= COLLIDER_RADIUS) {
          expect(chunk.bodyHandles.length, `chunk (${chunk.cx},${chunk.cz})`).toBeGreaterThan(0);
        } else {
          expect(chunk.bodyHandles.length, `chunk (${chunk.cx},${chunk.cz})`).toBe(0);
          ringTwo++;
        }
      }
      expect(ringTwo).toBe(16);
      expect(chunkAt(streamer, 2, 0).structureIds.length).toBeGreaterThan(0);

      // ── Walk onto (2,0) ─────────────────────────────────────────────────
      const before = created.length;
      const [focusX, focusZ] = chunkCentre(2, 0);
      streamer.setFocus(focusX, focusZ);

      const promoted = chunkAt(streamer, 2, 0);
      expect(promoted.bodyHandles.length).toBeGreaterThan(0);
      // One body per building it recorded at build time, plus the ground slab.
      expect(promoted.bodyHandles.length).toBe(promoted.colliderBoxes.length + 1);

      // The ground slab specifically, because falling through the road is the
      // failure this exists to prevent: half a metre thick, top face at y = 0,
      // spanning the whole 96 m chunk.
      const [centreX, centreZ] = chunkCentre(2, 0);
      const slabs = created
        .slice(before)
        .filter((desc) => desc.position.x === centreX && desc.position.z === centreZ);
      expect(slabs.length).toBe(1);
      const slab = slabs[0]!;
      expect(slab.position.y).toBe(-0.5);
      expect(slab.shape.kind).toBe('box');
      const halfExtents = (slab.shape as { halfExtents: THREE.Vector3 }).halfExtents;
      expect(halfExtents.y).toBe(0.5);
      expect(halfExtents.x).toBe(CHUNK_SIZE * 0.5);
      expect(halfExtents.z).toBe(CHUNK_SIZE * 0.5);
      expect(slab.type).toBe('fixed');

      // Promotion is idempotent. `rescore` runs on every focus change and on
      // every `buildImmediate`, and a second pass that added the slab again
      // would stack a duplicate world body per crossing.
      const afterPromotion = created.length;
      const handles = [...promoted.bodyHandles];
      streamer.buildImmediate(0);
      expect(created.length).toBe(afterPromotion);
      expect(chunkAt(streamer, 2, 0).bodyHandles).toEqual(handles);
      expect(removed).not.toContain(handles[0]);
    } finally {
      dispose();
    }
  });

  it('gives the bodies back once the chunk is two rings out and still resident', () => {
    const { streamer, removed, dispose } = makeStreamer();
    try {
      streamer.setFocus(0, 0);
      streamer.buildImmediate(2);
      streamer.setFocus(...chunkCentre(2, 0));

      const handles = [...chunkAt(streamer, 2, 0).bodyHandles];
      expect(handles.length).toBeGreaterThan(0);

      // (-1,0) puts (2,0) at Chebyshev distance 3: past the collider ring and
      // its one chunk of hysteresis, but inside `residentRadius + 1`, so the
      // chunk itself stays loaded and only its physics goes.
      streamer.setFocus(...chunkCentre(-1, 0));
      const demoted = chunkAt(streamer, 2, 0);
      expect(ring(demoted, -1, 0)).toBe(3);
      expect(demoted.bodyHandles.length).toBe(0);
      for (const handle of handles) {
        expect(removed.filter((h) => h === handle).length).toBe(1);
      }
    } finally {
      dispose();
    }
  });

  it('holds physics steady across the hysteresis ring rather than thrashing Rapier', () => {
    const { streamer, created, removed, dispose } = makeStreamer();
    try {
      streamer.setFocus(0, 0);
      streamer.buildImmediate(2);

      // (0,0) was built inside the collider ring. Step to (1,0) and back: it is
      // at distance 1 then 0, never past COLLIDER_RADIUS + 1, so nothing about
      // its physics may change. A boundary paced at dash speed is one crossing
      // every four seconds and rebuilding a dozen fixed bodies each time is a
      // cost paid for nothing.
      const origin = chunkAt(streamer, 0, 0);
      const handles = [...origin.bodyHandles];
      const before = created.length;

      streamer.setFocus(...chunkCentre(1, 0));
      streamer.setFocus(...chunkCentre(0, 0));

      expect(chunkAt(streamer, 0, 0).bodyHandles).toEqual(handles);
      expect(removed).toHaveLength(0);
      expect(created.length).toBeGreaterThan(before); // ring 2 promoted into place
    } finally {
      dispose();
    }
  });
});
