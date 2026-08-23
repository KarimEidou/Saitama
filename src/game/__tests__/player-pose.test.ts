/**
 * THE PROTAGONIST IS NEVER LEFT IN HIS BIND POSE
 *
 * `src/game/__tests__/` had fourteen files and not one of them touched
 * animation, which is how the assembled game shipped a Saitama standing in a
 * flat symmetric T — arms horizontal, elbows locked, knees straight, cape an
 * undeformed cone — while every clip in the table was fine and every animation
 * unit test passed. Nothing was broken downstream. Nothing had written the
 * bones.
 *
 * `Game.tickAnimators` is the only thing that writes them for the player, and
 * it used to open with `if (dt <= 0) return;`. That made "the world is paused"
 * and "this character has no pose" the same condition, and any stuck flag
 * upstream — a modal that never closed, a `timeScale` left at zero — turned the
 * protagonist into a mannequin for the rest of the session with nothing logged
 * and nothing thrown.
 *
 * Two halves are asserted here, because the bug needs both to come back:
 *
 *   1. THE BEHAVIOUR. An animator built the way `buildSaitama` builds the
 *      player's poses him off the rig's rest pose within one tick — and does so
 *      even when every tick it has ever had was a ZERO delta, which is the
 *      property the guard destroyed. `update(0)` integrates nothing (phases do not move, no
 *      footfall is emitted) and still ends in `applyPose`, so a paused frame
 *      re-asserts a pose instead of abandoning the skeleton.
 *
 *   2. THE WIRING. There is no DOM and no GL here, so an assembled `Game`
 *      cannot be constructed to prove it calls the thing — the composition is
 *      asserted against its source instead, the way
 *      `settings-and-safe-area.test.ts` asserts the HUD's stick-hand write.
 *
 * `poseAngleDelta` returns the largest per-bone angular difference in radians.
 * 0.05 rad is ~3 degrees: far below the >=17 degrees of elbow flexion `idleBored`
 * authors, and far above anything floating-point noise produces.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { ProceduralAnimator, poseAngleDelta } from '@/characters/anim';
import { buildCharacter, createCharacterParts } from '@/characters/mesh';

/** Exactly what `buildSaitama` builds, minus the roster's baked atlas. */
function playerAnimator(): ProceduralAnimator {
  const parts = createCharacterParts(buildCharacter('saitama', 0), new THREE.MeshBasicMaterial());
  return new ProceduralAnimator(parts, parts.root, {
    variants: { idle: 'bored' },
    initial: 'idle',
  });
}

/** Largest angle any bone has moved off the rig's bind pose, radians. */
function offRest(animator: ProceduralAnimator): number {
  return poseAngleDelta(animator.pose, animator.rig.rest);
}

const GAME_SOURCE = readFileSync(path.resolve(import.meta.dirname, '..', 'game.ts'), 'utf8');

describe('the player is posed, not left in the bind pose', () => {
  it('poses him off the bind pose on an ordinary frame', () => {
    const animator = playerAnimator();
    animator.update(1 / 60);
    expect(offRest(animator)).toBeGreaterThan(0.05);
  });

  it('still poses him when every frame so far has had a zero delta', () => {
    const animator = playerAnimator();
    // A paused or hit-stopped frame. The guard this replaces returned before
    // `update` was reached at all, which is what left the bind pose on screen.
    for (let i = 0; i < 5; i++) animator.update(0);
    expect(offRest(animator)).toBeGreaterThan(0.05);
  });

  it('keeps animating once time resumes', () => {
    const animator = playerAnimator();
    animator.update(1 / 60);
    const first = Float32Array.from(animator.pose.rot);
    for (let i = 0; i < 30; i++) animator.update(1 / 60);
    const moved = animator.pose.rot.some((value, index) => Math.abs(value - first[index]!) > 1e-4);
    expect(moved).toBe(true);
  });
});

describe('the composition root ticks the animators unconditionally', () => {
  it('has no delta gate in front of the pose write', () => {
    const body = GAME_SOURCE.slice(GAME_SOURCE.indexOf('private tickAnimators('));
    const method = body.slice(0, body.indexOf('\n  }'));
    expect(method).not.toMatch(/if\s*\(\s*dt\s*<=\s*0\s*\)\s*return/);
    expect(method).toMatch(/this\.playerAnimator\.update\(dt\)/);
  });

  it('calls it every frame, with the scaled delta the hit-stop owns', () => {
    // SCALED, not raw: `ImpactFreeze` drops `timeScale` to 0.04 for 90 ms and
    // the whole beat is that the character stops with the world.
    expect(GAME_SOURCE).toMatch(/this\.tickAnimators\(dt\);/);
  });
});
