/**
 * THE POOLED NEAR BODY
 *
 * Near bodies are recycled: `CrowdSystem.releaseAgent -> detachBody` pushes a
 * `NearCivilian` onto the free list and `acquireBody` pops it and calls
 * `rebind`. A corpse takes exactly that path once `CORPSE_SECONDS` is up — and
 * by then the animator is parked on the CLAMPED final frame of the death clip
 * and the locomotion solver still holds that civilian's world-space foot
 * plants, from wherever they died.
 *
 * If `reset` does not snap both, the next occupant of that body fades up out of
 * a face-down corpse pose with a foot nailed to the old pavement — inside forty
 * metres, which is the only place the near tier exists at all.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  buildHumanoid,
  civilianOptions,
  civilianProfile,
  createCharacterParts,
} from '@/characters/mesh';
import { ProceduralAnimator } from '@/characters/anim';
import type { EntityId } from '@/types';
import { NearCivilian, type ICivilianHost } from '../near-civilian';
import { CrowdAgents, MOOD_DOWN, TIER_NEAR } from '../crowd-agents';

/** A body built headlessly, the way `animator.test.ts` builds one. */
function makeBody(agents: CrowdAgents, index: number): NearCivilian {
  const profile = civilianProfile(7);
  const build = buildHumanoid(profile, civilianOptions(profile, 2));
  const parts = createCharacterParts(build, new THREE.MeshBasicMaterial());
  const animator = new ProceduralAnimator(parts, parts.root, { seed: 7 });
  const host: ICivilianHost = {
    agents,
    now: () => 0,
    playerPosition: () => undefined,
    damageAgent: (i: number, amount: number): number => {
      const dealt = Math.min(agents.health[i]!, amount);
      agents.health[i] = agents.health[i]! - dealt;
      return dealt;
    },
  };
  return new NearCivilian(agents.idOf(index) as EntityId, parts, animator, host, index);
}

describe('NearCivilian recycling', () => {
  it('does not carry the last occupant’s corpse pose onto the next one', () => {
    const agents = new CrowdAgents();
    const a = agents.spawn(1, 0, 0, 0, TIER_NEAR);
    const b = agents.spawn(2, 30, 0, 0, TIER_NEAR);
    const body = makeBody(agents, a);
    const animator = body.character.animator as ProceduralAnimator;

    agents.health[a] = 0;
    body.think(1 / 60);
    body.present(1 / 60);
    // The corpse pose is real: `death` is played once and clamped, so the
    // animator sits on its final frame for as long as the body is pooled.
    expect(animator.current).toBe('death');
    expect(agents.mood[a]).toBe(MOOD_DOWN);

    body.detach();
    body.rebind(agents.idOf(b), b);

    expect(animator.current).toBe('idle');
    expect(body.index).toBe(b);
    expect(body.id).toBe(agents.idOf(b));
    expect(body.isDead).toBe(false);
    expect(body.stateMachine.current).toBe('idle');

    // And the very first frame of the new occupant does not re-issue a clip
    // change on top of the snap.
    body.think(1 / 60);
    body.present(1 / 60);
    expect(animator.current).toBe('idle');
    expect(body.root.position.x).toBeCloseTo(30, 5);

    body.dispose();
  });

  it('still switches clip for a new occupant who is doing something else', () => {
    const agents = new CrowdAgents();
    const a = agents.spawn(1, 0, 0, 0, TIER_NEAR);
    const b = agents.spawn(2, 30, 0, 0, TIER_NEAR);
    const body = makeBody(agents, a);
    const animator = body.character.animator as ProceduralAnimator;

    agents.health[a] = 0;
    body.think(1 / 60);
    body.present(1 / 60);
    body.detach();
    body.rebind(agents.idOf(b), b);

    // `lastClip` is pinned to the clip that was actually snapped to, not left
    // undefined — but it must not stop a genuine change.
    agents.velX[b] = 1.2;
    body.think(1 / 60);
    body.present(1 / 60);
    expect(animator.current).toBe('walk');

    body.dispose();
  });
});
