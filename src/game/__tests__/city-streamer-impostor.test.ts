/**
 * THE FAR CITY AND THE NEAR CITY MUST BE THE SAME CITY
 *
 * `bakeSkyline` raises the whole 256-chunk skyline in the constructor, from the
 * plan alone, without generating a single chunk. It can only do that by
 * REPLAYING the rolls the real generator will make later: `readBuildRng` draws
 * from `rng.derive('buildings')` in exactly the order `makeRecipe`
 * (`src/world/city/block.ts`) draws from it, and a silhouette is only correct
 * for as long as those two orders agree.
 *
 * That coupling crosses a unit boundary and no type can express it. Add a roll
 * to `makeRecipe` and forget the mirror, and nothing fails: `tsc` is happy,
 * `eslint` is happy, every other test is happy — and the horizon quietly
 * becomes a different city, with silhouettes standing in the middle of avenues
 * and towers that shrink as you walk up to them.
 *
 * `checkImpostorDrift` counts it, because silent drift is the failure mode and
 * a counter is the fix. This is the test that reads the counter. It is the only
 * automated guard on that coupling — the number is otherwise visible on a debug
 * HUD and in a browser verification run, neither of which runs in CI.
 *
 * IF A CASE HERE FAILS, THE CITY IS WRONG, NOT THE ASSERTION: a non-zero
 * `impostorDrift` means `readBuildRng` has fallen out of step with `makeRecipe`.
 * Fix the mirror; do not weaken the expectation.
 *
 * No renderer, no GL and no Rapier: physics and the spatial index are both
 * optional on `ICityStreamerOptions`, and everything asserted here is a number
 * the streamer already keeps.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEventBus } from '@/util';
import { DestructionSystem } from '@/gameplay/destruction';
import { CityGenerator, type ICityPlan } from '@/world/city';
import { CHUNK_SIZE } from '@/spatial';
import rawPlan from '../../../assets/district/cityz.plan.json';
import { CityStreamer } from '../city-streamer';

function makeStreamer(): { streamer: CityStreamer; dispose: () => void } {
  const generator = new CityGenerator(rawPlan as unknown as ICityPlan, {
    defaultDetail: 'box',
    includeProps: true,
  });
  const bus = createEventBus();
  const destruction = new DestructionSystem({ bus });
  const streamer = new CityStreamer({
    generator,
    scene: new THREE.Scene(),
    resolve: () => new THREE.MeshBasicMaterial(),
    destruction,
    quality: 'high',
  });
  return {
    streamer,
    dispose: () => {
      streamer.dispose();
      destruction.dispose();
    },
  };
}

describe('the baked skyline matches the city that replaces it', () => {
  // Ten real chunks of real generation. Vitest's 5 s default is tight for that
  // on a loaded machine, and a timeout here would read as drift.
  it('bakes silhouettes for the buildings actually generated', { timeout: 20_000 }, () => {
    const { streamer, dispose } = makeStreamer();
    try {
      // The whole plan is baked in the constructor, resident or not.
      expect(streamer.impostorStats.buildings).toBeGreaterThan(0);
      expect(streamer.impostorDrift).toBe(0);

      // Downtown plus its ring: `full` and `reduced` detail, the densest blocks
      // in the plan and the ones in shot at boot.
      streamer.setFocus(9, 40);
      streamer.buildImmediate(1);
      expect(streamer.residentCount).toBeGreaterThan(1);
      expect(streamer.impostorDrift).toBe(0);

      // A second district, so a zone-params-specific divergence is caught too.
      streamer.setFocus(4.5 * CHUNK_SIZE, 4.5 * CHUNK_SIZE);
      streamer.buildImmediate(0);
      expect(streamer.impostorDrift).toBe(0);

      // The bake is a boot cost, not a frame cost, and it does not grow: no
      // chunk becoming resident may add a building to the ring.
      const buildings = streamer.impostorStats.buildings;
      streamer.setFocus(9, 40);
      expect(streamer.impostorStats.buildings).toBe(buildings);
    } finally {
      dispose();
    }
  });
});
