/**
 * TEARDOWN IS TERMINAL
 *
 * `dispose()` used to evict everything and free the impostor, and leave the
 * object otherwise fully live. `focusValid` survives teardown, so a single late
 * call did real work against systems that no longer exist: `buildImmediate()`
 * regenerated chunks into a scene the game had torn down, created Rapier bodies
 * in a disposed `PhysicsWorld` and re-registered structures with a disposed
 * `DestructionSystem`; `update()` drained the pending queue the same way; a
 * second `dispose()` re-disposed the impostor ring and the residency texture.
 *
 * Nothing prevented that except luck about call order — and one of those
 * windows is real today: `Game.loadRemainingMaterials()` reaches
 * `cityStreamer.attachProps(...)` after an `await`, without re-checking whether
 * the game was disposed while it waited.
 *
 * The physics stub is what makes "did nothing" assertable: a body count that
 * does not move is the difference between a guard and a comment claiming one.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEventBus } from '@/util';
import { DestructionSystem } from '@/gameplay/destruction';
import type { IRigidBodyDesc } from '@/types';
import type { PhysicsWorld } from '@/physics';
import { CityGenerator, type ICityPlan } from '@/world/city';
import rawPlan from '../../../assets/district/cityz.plan.json';
import { CityStreamer } from '../city-streamer';

/** A physics world that only remembers what it was asked to do. */
function stubPhysics(): { physics: PhysicsWorld; created: IRigidBodyDesc[] } {
  const created: IRigidBodyDesc[] = [];
  let nextHandle = 1;
  return {
    physics: {
      createBody: (desc: IRigidBodyDesc) => {
        created.push(desc);
        return { handle: nextHandle++ };
      },
      removeBody: () => {},
    } as unknown as PhysicsWorld,
    created,
  };
}

describe('CityStreamer.dispose', () => {
  it('is idempotent, and every entry point is inert afterwards', () => {
    const generator = new CityGenerator(rawPlan as unknown as ICityPlan, {
      defaultDetail: 'box',
      includeProps: true,
    });
    const bus = createEventBus();
    const destruction = new DestructionSystem({ bus });
    const { physics, created } = stubPhysics();
    const streamer = new CityStreamer({
      generator,
      scene: new THREE.Scene(),
      resolve: () => new THREE.MeshBasicMaterial(),
      destruction,
      physics,
      quality: 'low',
    });

    try {
      streamer.setFocus(9, 40);
      streamer.buildImmediate(0);
      expect(streamer.residentCount).toBe(1);
      expect(created.length).toBeGreaterThan(0);

      streamer.dispose();
      expect(streamer.residentCount).toBe(0);
      const bodies = created.length;

      // A second dispose must not re-free the impostor ring or the residency
      // texture. Freeing a `THREE` resource twice is not always loud.
      streamer.dispose();

      // Everything below reached live code before the flag existed;
      // `buildImmediate` in particular rebuilt the chunk and its colliders.
      streamer.setFocus(500, 500);
      streamer.buildImmediate(1);
      expect(streamer.update(10)).toBe(false);
      expect(streamer.attachProps(() => undefined)).toBe(0);

      expect(created.length).toBe(bodies);
      expect(streamer.residentCount).toBe(0);
      expect(streamer.pendingCount).toBe(0);
    } finally {
      destruction.dispose();
    }
  });
});
