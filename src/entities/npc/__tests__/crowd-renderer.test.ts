/**
 * THE INSTANCED CROWD PLAYS THE RIGHT CLIP AT THE RIGHT SPEED
 *
 * The VAT material has ONE `vatFps` uniform for all six baked clips, and the
 * bake gives every clip the same frame count — so `vatParams.y` carries no
 * duration information and cannot recover the differences between a
 * one-second walk cycle, a 4.6-second phone-filming performance and a
 * 2.4-second cower. The per-clip rate therefore has to ride in the per-instance
 * `vatParams.w`, and this is the assertion that it does.
 *
 * The symptom when it does not is not subtle: gawkers at 4.6x, cowering
 * civilians trembling at 12 Hz, and every fleeing civilian's feet advancing at
 * two thirds of the speed their body is moving — foot sliding, on the most
 * populated mood in a panic.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { CrowdRenderer } from '../crowd-renderer';
import {
  CrowdAgents,
  MOOD_COMMUTE,
  MOOD_COWER,
  MOOD_DOWN,
  MOOD_FLEE,
  MOOD_GAWK,
  TIER_MID,
} from '../crowd-agents';

// Building six humanoids and baking six VAT atlases is a second or two of CPU
// on an idle machine and rather more on a loaded one.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NO_SKIP: ReadonlySet<number> = new Set<number>();

/**
 * Playback rate written for a single agent in the given mood.
 *
 * Reads the instance attribute off the archetype's mesh rather than reaching
 * into `CrowdRenderer` — the buffer is what the GPU sees, so it is what the
 * claim is about.
 */
function rateFor(renderer: CrowdRenderer, mood: number, speed: number): number {
  const agents = new CrowdAgents();
  const index = agents.spawn(9001, 0, 0, 0, TIER_MID);
  agents.setMood(index, mood);
  agents.velX[index] = speed;
  agents.velZ[index] = 0;
  agents.rate[index] = 1;
  renderer.update(agents, 1 / 60, NO_SKIP);

  const mesh = renderer.group.children[agents.archetype[index]!] as THREE.InstancedMesh;
  const params = mesh.geometry.getAttribute('vatParams');
  return params.getW(0);
}

describe('CrowdRenderer clip rates', () => {
  it('gives every clip its own playback rate, not the walk clip’s', () => {
    const renderer = new CrowdRenderer(0x5a17a);
    try {
      // Walk is the reference the material's single `vatFps` holds, so an
      // instance walking at its nominal rate advances at exactly that rate.
      const walk = rateFor(renderer, MOOD_COMMUTE, 1.5);
      expect(walk).toBeCloseTo(1, 5);

      // Gawk is a 4.6-second clip against a roughly one-second walk cycle, so
      // it has to advance several times slower. Playing it at the walk rate is
      // a 3 Hz head shake instead of a slow pan.
      expect(rateFor(renderer, MOOD_GAWK, 0)).toBeLessThan(walk * 0.4);

      // Cower is 2.4 seconds: its 5 Hz and 2.9 Hz trembles become 12 Hz and
      // 7 Hz at the walk rate.
      expect(rateFor(renderer, MOOD_COWER, 0)).toBeLessThan(walk * 0.6);

      // Flee is the short one and runs FASTER than a walk, which is what stops
      // its feet from sliding under a body moving at `SPEED_FLEE`.
      expect(rateFor(renderer, MOOD_FLEE, 4)).toBeGreaterThan(walk * 1.2);

      // A body on the pavement is still frozen on the clip's first frame.
      expect(rateFor(renderer, MOOD_DOWN, 0)).toBe(0);
    } finally {
      renderer.dispose();
    }
  });
});
