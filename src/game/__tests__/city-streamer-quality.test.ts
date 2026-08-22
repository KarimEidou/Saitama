/**
 * A TIER CHANGE HAS TO REACH THE RING, NOT JUST THE NUMBER
 *
 * `RESIDENT_RADIUS_BY_TIER` is `{low: 1, medium: 2, high: 2}`, and `setQuality`
 * used to do nothing but assign it. `pending` is refilled by `rescore()` alone,
 * and the only other things that reach `rescore()` are a focus change that
 * crosses a chunk boundary and `buildImmediate()` — so a player standing still
 * on `low` who picked `high` in the settings screen got a wider radius and an
 * empty queue: sixteen chunks that the setting had just promised and that never
 * arrived until they happened to walk 96 m.
 *
 * The guard matters as much as the re-score. `medium` and `high` share a radius,
 * so switching between them must stay free rather than re-scoring — and
 * `onResidencyChanged` firing is the observable proof either way.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEventBus } from '@/util';
import { DestructionSystem } from '@/gameplay/destruction';
import { CityGenerator, type ICityPlan } from '@/world/city';
import { CHUNK_SIZE } from '@/spatial';
import rawPlan from '../../../assets/district/cityz.plan.json';
import { CityStreamer } from '../city-streamer';

/** The centre of a chunk in world metres — what the focus is actually set to. */
function chunkCentre(cx: number, cz: number): [number, number] {
  return [(cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE];
}

/** Tier `low`: resident radius 1, so raising the tier widens it to 2. */
function makeStreamer(): {
  streamer: CityStreamer;
  residencyChanges: () => number;
  dispose: () => void;
} {
  const generator = new CityGenerator(rawPlan as unknown as ICityPlan, {
    defaultDetail: 'box',
    includeProps: false,
  });
  const destruction = new DestructionSystem({ bus: createEventBus() });
  let changes = 0;
  const streamer = new CityStreamer({
    generator,
    scene: new THREE.Scene(),
    resolve: () => new THREE.MeshBasicMaterial(),
    destruction,
    quality: 'low',
    onResidencyChanged: () => {
      changes++;
    },
  });
  return {
    streamer,
    residencyChanges: () => changes,
    dispose: () => {
      streamer.dispose();
      destruction.dispose();
    },
  };
}

describe('CityStreamer.setQuality', () => {
  it('queues the ring the new tier just asked for, without waiting for a boundary', () => {
    const { streamer, residencyChanges, dispose } = makeStreamer();
    try {
      streamer.setFocus(...chunkCentre(0, 0));
      streamer.buildImmediate(1);

      // The whole `low` ring is standing and nothing is outstanding.
      expect(streamer.residentCount).toBe(9);
      expect(streamer.pendingCount).toBe(0);

      const before = residencyChanges();
      streamer.setQuality('high');

      // Ring 2 is 25 chunks minus the 9 already resident. The focus has not
      // moved, so `rescore` inside `setQuality` is the only thing that can have
      // queued them.
      expect(streamer.pendingCount).toBe(16);
      expect(residencyChanges()).toBe(before + 1);
    } finally {
      dispose();
    }
  });

  it('stays free when the tier changes but the radius does not', () => {
    const { streamer, residencyChanges, dispose } = makeStreamer();
    try {
      streamer.setFocus(...chunkCentre(0, 0));
      streamer.buildImmediate(1);
      streamer.setQuality('high');

      const changes = residencyChanges();
      const pending = streamer.pendingCount;
      // `medium` and `high` are both radius 2: nothing to do, so nothing done.
      streamer.setQuality('medium');
      expect(residencyChanges()).toBe(changes);
      expect(streamer.pendingCount).toBe(pending);
    } finally {
      dispose();
    }
  });
});
