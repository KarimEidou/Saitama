/**
 * A CHUNK IT CANNOT COMPLETE MUST COST LOOKUPS AND NOTHING ELSE
 *
 * `attachProps` is all-or-nothing per chunk, and that rule is right: a
 * half-populated street that fills in over the next few seconds is more
 * distracting than one that arrives at once. What it must NOT do is pay for the
 * meshes before applying the rule.
 *
 * A `THREE.InstancedMesh` allocates a `count × 16` Float32Array and this method
 * writes every matrix into it. Building all of a chunk's batches and only then
 * discovering that one model has not landed means that whole cost is thrown
 * away — and `attachProps` is re-run over every propless resident chunk at the
 * end of EVERY chunk build (every 0.4 s while the world streams) and once per
 * background material wave. Worst case is permanent, not transient: the game's
 * prop resolver memoises a failed lookup as `null`, so a chunk that references
 * one model which never loads rebuilds and discards its entire prop set on
 * every subsequent chunk build for the rest of the session.
 *
 * The resolve-first pass also makes strictly FEWER resolver calls than the
 * old one — it stops at the first gap instead of resolving every remaining
 * batch after it — which is the cheapest observable proof that no mesh was
 * built, and is what `stops at the first unresolvable batch` asserts.
 *
 * No renderer and no GL: `InstancedMesh` construction is CPU-side, and nothing
 * here is ever drawn.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createEventBus } from '@/util';
import { DestructionSystem } from '@/gameplay/destruction';
import { CityGenerator, type ICityPlan } from '@/world/city';
import rawPlan from '../../../assets/district/cityz.plan.json';
import { CityStreamer, type IResidentChunk } from '../city-streamer';

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

/** The resident chunk carrying the most prop batches. */
function busiestChunk(streamer: CityStreamer): IResidentChunk {
  let best: IResidentChunk | undefined;
  for (const chunk of streamer.chunks) {
    if (best === undefined || chunk.build.instances.length > best.build.instances.length) {
      best = chunk;
    }
  }
  expect(best, 'at least one chunk should be resident').toBeDefined();
  return best!;
}

describe('CityStreamer.attachProps', () => {
  it('stops at the first unresolvable batch and builds nothing', { timeout: 20_000 }, () => {
    const { streamer, dispose } = makeStreamer();
    try {
      // BEFORE the first `attachProps`: `build()` auto-attaches once a resolver
      // has been handed over, and the point of the count below is that this
      // call is the first one the chunk sees.
      streamer.setFocus(9, 40);
      streamer.buildImmediate(1);

      const chunk = busiestChunk(streamer);
      // Otherwise "stops at the first" is not a claim about anything.
      expect(chunk.build.instances.length).toBeGreaterThan(1);
      const propless = streamer.chunks.filter((c) => c.build.instances.length > 0).length;
      expect(propless).toBeGreaterThan(0);

      let calls = 0;
      const added = streamer.attachProps(() => {
        calls++;
        return undefined;
      });

      expect(added).toBe(0);
      // One lookup per chunk with batches, and no more: the first gap ends that
      // chunk. The old implementation resolved every batch of every chunk.
      expect(calls).toBe(propless);
      for (const c of streamer.chunks) expect(c.props.length).toBe(0);
    } finally {
      dispose();
    }
  });

  it('attaches the whole chunk once every model resolves, then stays idempotent', () => {
    const { streamer, dispose } = makeStreamer();
    try {
      streamer.setFocus(9, 40);
      streamer.buildImmediate(0);

      const chunk = busiestChunk(streamer);
      const batches = chunk.build.instances.length;
      expect(batches).toBeGreaterThan(1);

      const geometry = new THREE.BufferGeometry();
      const material = new THREE.MeshBasicMaterial();
      const added = streamer.attachProps(() => ({ geometry, material }));

      expect(added).toBe(batches);
      expect(chunk.props.length).toBe(batches);
      expect(chunk.props[0]!.count).toBe(chunk.build.instances[0]!.count);
      // A chunk is skipped once its props exist, so the 0.4 s re-run is free.
      expect(streamer.attachProps(() => ({ geometry, material }))).toBe(0);
      expect(chunk.props.length).toBe(batches);

      geometry.dispose();
      material.dispose();
    } finally {
      dispose();
    }
  });
});
