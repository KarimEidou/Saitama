/**
 * DAMAGE ADDRESSES ARE A PROPERTY OF THE PLAN, NOT OF WHERE THE PLAYER WALKED
 *
 * `build()` hands each building a slot in the persistent 8 KB damage bitmask —
 * 256 chunks x 16 buildings — from a per-chunk cursor, and the comment at the
 * assignment promises that "a damage slot addresses the same building on every
 * run and a save restored tomorrow puts the hole back in the same wall".
 *
 * The cursor used to survive eviction. A chunk streamed out and back in
 * therefore re-addressed the SAME buildings from wherever the cursor had got
 * to: slots 0..6 on the first residency, 7..13 on the second, and on the third
 * the sixteen-slot budget ran out and every remaining building was registered
 * with no address at all (`damageChunk = -1`), which no `restoreFromBitmask`
 * can ever put back. Four chunks of travel is about eighteen seconds at dash
 * speed, so this is the ordinary case rather than a corner.
 *
 * Nothing here needs a renderer, Rapier or a spatial index: the address is
 * whatever `DestructionSystem` was handed at registration, which is exactly
 * what a save reads back.
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

/**
 * Tier `low`, so the resident radius is 1 and a focus three chunks away is past
 * the one ring of eviction hysteresis.
 */
function makeStreamer(): {
  streamer: CityStreamer;
  destruction: DestructionSystem;
  dispose: () => void;
} {
  const generator = new CityGenerator(rawPlan as unknown as ICityPlan, {
    defaultDetail: 'box',
    includeProps: false,
  });
  const destruction = new DestructionSystem({ bus: createEventBus() });
  const streamer = new CityStreamer({
    generator,
    scene: new THREE.Scene(),
    resolve: () => new THREE.MeshBasicMaterial(),
    destruction,
    quality: 'low',
  });
  return {
    streamer,
    destruction,
    dispose: () => {
      streamer.dispose();
      destruction.dispose();
    },
  };
}

/** `id -> "chunk:building"` for every structure the origin chunk registered. */
function addressesAt(
  streamer: CityStreamer,
  destruction: DestructionSystem,
  cx: number,
  cz: number
): Map<string, string> {
  const chunk = streamer.chunks.find((c) => c.cx === cx && c.cz === cz);
  expect(chunk, `chunk (${cx},${cz}) should be resident`).toBeDefined();
  const out = new Map<string, string>();
  for (const id of chunk!.structureIds) {
    const structure = destruction.structures.get(id);
    expect(structure, `structure ${id} should be registered`).toBeDefined();
    out.set(id, `${structure!.damageChunk}:${structure!.damageBuilding}`);
  }
  return out;
}

describe('city damage slots survive streaming out and back', () => {
  it('re-addresses a re-streamed chunk exactly as it was addressed the first time', () => {
    const { streamer, destruction, dispose } = makeStreamer();
    try {
      streamer.setFocus(...chunkCentre(0, 0));
      streamer.buildImmediate(0);

      const first = addressesAt(streamer, destruction, 0, 0);
      expect(first.size).toBeGreaterThan(0);
      // Every building addressed, and none of them aliasing another.
      expect([...first.values()]).not.toContain('-1:0');
      expect(new Set(first.values()).size).toBe(first.size);
      const unaddressable = streamer.unaddressableBuildings;

      // Two full round trips. The third residency is where a cursor that was
      // never reset runs the chunk out of slots entirely.
      for (let visit = 0; visit < 2; visit++) {
        streamer.setFocus(...chunkCentre(4, 0));
        expect(streamer.chunks.find((c) => c.cx === 0 && c.cz === 0)).toBeUndefined();

        streamer.setFocus(...chunkCentre(0, 0));
        streamer.buildImmediate(0);
        expect(addressesAt(streamer, destruction, 0, 0)).toEqual(first);
      }

      // The counter means what its comment says: a plan-budget overflow, not a
      // tally of how many times the player walked away and came back.
      expect(streamer.unaddressableBuildings).toBe(unaddressable);
    } finally {
      dispose();
    }
  });
});
