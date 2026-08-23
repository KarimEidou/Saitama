/**
 * THE REFIT AFTER AN UNLOAD BELONGS TO STREAMING, NOT TO A FRAME
 *
 * `SpatialIndex.refit` says so itself: "Optional: queries do it lazily anyway.
 * Call it explicitly after a chunk unload so the cost lands in the streaming
 * budget rather than in the middle of a frame."
 *
 * `evict()` releases every one of a chunk's static handles — up to seven
 * buildings — and one `rescore()` after a boundary crossing can evict a whole
 * ring at once. Nothing called `refit()` afterwards, so the quadtree carried
 * the holes until the next query rebuilt its bounds lazily, and that query is
 * `spatial.cull(camera)` in the CAMERA phase of the very next frame. The
 * cheapest possible mistake: the work was going to be done either way, just in
 * the one place the design says it must not be.
 *
 * Once per RESCORE, not once per chunk. That distinction is the whole reason
 * this is a test and not a comment — a refit inside the eviction loop is
 * correct, passes any "did it refit?" assertion, and quietly does the work nine
 * times for one crossing.
 *
 * The index is a recording stub: `insertStatic`/`removeStatic`/`refit` are all
 * the streamer touches, and counting calls is the only way "once" stays
 * asserted.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEventBus } from '@/util';
import { DestructionSystem } from '@/gameplay/destruction';
import type { SpatialIndex } from '@/spatial';
import { CHUNK_SIZE } from '@/spatial';
import { CityGenerator, type ICityPlan } from '@/world/city';
import rawPlan from '../../../assets/district/cityz.plan.json';
import { CityStreamer } from '../city-streamer';

interface IIndexProbe {
  inserted: number;
  removed: number;
  refits: number;
}

function stubSpatial(): { spatial: SpatialIndex; probe: IIndexProbe } {
  const probe: IIndexProbe = { inserted: 0, removed: 0, refits: 0 };
  let handle = 1;
  return {
    probe,
    spatial: {
      insertStatic: () => {
        probe.inserted++;
        return handle++;
      },
      removeStatic: () => {
        probe.removed++;
        return true;
      },
      refit: () => {
        probe.refits++;
      },
    } as unknown as SpatialIndex,
  };
}

/** Tier `low`, so the resident radius is 1 and a short walk evicts. */
function makeStreamer(): { streamer: CityStreamer; probe: IIndexProbe; dispose: () => void } {
  const generator = new CityGenerator(rawPlan as unknown as ICityPlan, {
    defaultDetail: 'box',
    includeProps: true,
  });
  const bus = createEventBus();
  const destruction = new DestructionSystem({ bus });
  const { spatial, probe } = stubSpatial();
  const streamer = new CityStreamer({
    generator,
    scene: new THREE.Scene(),
    resolve: () => new THREE.MeshBasicMaterial(),
    destruction,
    spatial,
    quality: 'low',
  });
  return {
    streamer,
    probe,
    dispose: () => {
      streamer.dispose();
      destruction.dispose();
    },
  };
}

describe('CityStreamer refits the quadtree when it unloads chunks', () => {
  it('refits once per rescore that evicted, and not at all otherwise', { timeout: 20_000 }, () => {
    const { streamer, probe, dispose } = makeStreamer();
    try {
      streamer.setFocus(9, 40);
      streamer.buildImmediate(1);
      expect(probe.inserted).toBeGreaterThan(0);
      // Nothing has left the index yet. Inserting does not invalidate bounds.
      expect(probe.refits).toBe(0);
      const residents = streamer.residentCount;
      expect(residents).toBeGreaterThan(1);

      // Five chunks away: every original chunk is past `residentRadius + 1`, so
      // the whole ring goes in ONE rescore.
      streamer.setFocus(5.5 * CHUNK_SIZE, 5.5 * CHUNK_SIZE);
      expect(probe.removed).toBeGreaterThan(0);
      // One refit for many evictions — not one each.
      expect(probe.refits).toBe(1);

      // `setFocus` early-returns on an unchanged chunk, so a stationary player
      // never pays for this again.
      streamer.setFocus(5.5 * CHUNK_SIZE + 1, 5.5 * CHUNK_SIZE + 1);
      expect(probe.refits).toBe(1);
    } finally {
      dispose();
    }
  });
});
