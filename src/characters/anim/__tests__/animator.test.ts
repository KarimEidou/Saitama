/**
 * THE ANIMATOR
 *
 * `IAnimator` conformance, layering, events, the ragdoll handoff, and
 * determinism.
 *
 * Determinism gets its own section because the entire city generates from
 * seeds and has to be byte-identical across runs and devices. An animator that
 * reached for `Math.random` to jitter a crowd's breathing would break replay
 * for every system downstream of it, silently.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ClipName, IAnimator } from '@/types';
import { ProceduralAnimator, type AnimatorOptions } from '../animator';
import { createCharacterParts, buildCharacter } from '@/characters/mesh';
import type { AnimEvent } from '../types';
import { heroFixture } from './support';

function makeAnimator(options: AnimatorOptions = {}): {
  animator: ProceduralAnimator;
  root: THREE.Object3D;
} {
  const parts = createCharacterParts(buildCharacter('saitama', 0), new THREE.MeshBasicMaterial());
  const animator = new ProceduralAnimator(parts, parts.root, options);
  return { animator, root: parts.root };
}

function step(animator: ProceduralAnimator, seconds: number, dt = 1 / 60): void {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) animator.update(dt);
}

describe('IAnimator conformance', () => {
  it('satisfies the interface structurally', () => {
    const { animator } = makeAnimator();
    const asInterface: IAnimator = animator;
    expect(asInterface.mixer).toBeInstanceOf(THREE.AnimationMixer);
    expect(asInterface.available.length).toBe(17);
    expect(typeof asInterface.play).toBe('function');
    expect(typeof asInterface.playAdditive).toBe('function');
    expect(typeof asInterface.stopAdditive).toBe('function');
    expect(typeof asInterface.has).toBe('function');
    expect(typeof asInterface.update).toBe('function');
    expect(typeof asInterface.onFinished).toBe('function');
    expect(typeof asInterface.dispose).toBe('function');
    expect(asInterface.timeScale).toBe(1);
    animator.dispose();
  });

  it('reports every slot as available and never falls back silently', () => {
    const { animator } = makeAnimator();
    for (const slot of animator.available) expect(animator.has(slot), slot).toBe(true);
    animator.dispose();
  });

  it('ignores a repeated play of the same looping slot', () => {
    // A state machine calling play('walk') every frame must not reset the
    // cycle; otherwise the feet never leave the first frame of stance.
    const { animator } = makeAnimator();
    animator.play('walk');
    step(animator, 0.4);
    const phaseBefore = animator.solver.phase;
    animator.play('walk');
    animator.update(1 / 60);
    expect(animator.solver.phase).toBeGreaterThan(phaseBefore);
    animator.dispose();
  });

  it('fires onFinished exactly once for a one-shot', () => {
    const { animator } = makeAnimator();
    const seen: ClipName[] = [];
    animator.onFinished((clip) => seen.push(clip));
    animator.play('attack', { fade: 0 });
    step(animator, 2);
    expect(seen.filter((c) => c === 'attack')).toHaveLength(1);
    animator.dispose();
  });

  it('unsubscribes cleanly', () => {
    const { animator } = makeAnimator();
    const spy = vi.fn();
    const off = animator.onFinished(spy);
    off();
    animator.play('attack', { fade: 0 });
    step(animator, 2);
    expect(spy).not.toHaveBeenCalled();
    animator.dispose();
  });

  it('survives a handler that throws', () => {
    const { animator } = makeAnimator();
    animator.onEvent(() => {
      throw new Error('bad handler');
    });
    const good = vi.fn();
    animator.onEvent(good);
    animator.setLocomotion({ speed: 1.4 });
    expect(() => step(animator, 2)).not.toThrow();
    expect(good).toHaveBeenCalled();
    animator.dispose();
  });

  it('bakes a real THREE.AnimationClip on demand', () => {
    const { animator } = makeAnimator();
    const clip = animator.animationClip('walk', 16);
    expect(clip).toBeInstanceOf(THREE.AnimationClip);
    expect(clip.tracks.length).toBeGreaterThan(10);
    expect(clip.duration).toBeGreaterThan(0.1);
    // Cached: baking a locomotive clip simulates several gait cycles.
    expect(animator.animationClip('walk', 16)).toBe(clip);
    // And it is usable on the mixer the interface exposes.
    const action = animator.mixer.clipAction(clip);
    expect(action).toBeDefined();
    animator.dispose();
  });
});

describe('speed-driven gait selection', () => {
  it('walks, runs and sprints as the commanded speed rises', () => {
    const { animator } = makeAnimator();
    animator.play('walk');
    const seen = new Set<ClipName>();
    for (let i = 0; i < 900; i++) {
      animator.setLocomotion({ speed: (i / 900) * 8 });
      animator.update(1 / 60);
      seen.add(animator.current!);
    }
    expect(seen.has('idle')).toBe(true);
    expect(seen.has('walk')).toBe(true);
    expect(seen.has('run')).toBe(true);
    expect(seen.has('sprint')).toBe(true);
    animator.dispose();
  });

  it('does not let movement override a non-locomotive slot', () => {
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 5 });
    animator.play('death', { fade: 0 });
    step(animator, 0.5);
    expect(animator.current).toBe('death');
    animator.dispose();
  });

  it('uses the slot as a style when no speed is supplied', () => {
    const { animator } = makeAnimator();
    animator.play('run', { fade: 0 });
    step(animator, 1);
    expect(animator.gait.speed).toBeGreaterThan(2);
    expect(animator.gait.gait).not.toBe('stand');
    animator.dispose();
  });
});

describe('layering', () => {
  it('punches with the arms while the legs keep running', () => {
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 5 });
    animator.play('run');
    step(animator, 1);

    const legsBefore = new Float32Array(animator.pose.rot);
    animator.playAdditive('attack', { fade: 0 });
    animator.update(1 / 60);

    const rig = animator.rig;
    const hip = rig.index.RightUpLeg!;
    const shoulder = rig.index.RightArm!;
    const rot = animator.pose.rot;
    // The leg is unchanged by the overlay beyond one frame of gait advance...
    const legDelta = Math.hypot(
      rot[hip * 4]! - legsBefore[hip * 4]!,
      rot[hip * 4 + 1]! - legsBefore[hip * 4 + 1]!,
      rot[hip * 4 + 2]! - legsBefore[hip * 4 + 2]!
    );
    const armDelta = Math.hypot(
      rot[shoulder * 4]! - legsBefore[shoulder * 4]!,
      rot[shoulder * 4 + 1]! - legsBefore[shoulder * 4 + 1]!,
      rot[shoulder * 4 + 2]! - legsBefore[shoulder * 4 + 2]!
    );
    expect(armDelta).toBeGreaterThan(legDelta * 3);
    expect(animator.current).toBe('run');
    animator.dispose();
  });

  it('feathers the spine so the two halves do not shear at the waist', () => {
    const { animator } = makeAnimator();
    animator.play('idle', { fade: 0 });
    step(animator, 0.5);
    const before = new Float32Array(animator.pose.rot);
    animator.playAdditive('block', { fade: 0 });
    step(animator, 0.5);

    const rig = animator.rig;
    const delta = (name: 'Spine' | 'Spine1' | 'Spine2'): number => {
      const i = rig.index[name]!;
      return Math.hypot(
        animator.pose.rot[i * 4]! - before[i * 4]!,
        animator.pose.rot[i * 4 + 1]! - before[i * 4 + 1]!,
        animator.pose.rot[i * 4 + 2]! - before[i * 4 + 2]!
      );
    };
    // Increasing up the stack: 35 %, 70 %, 100 % of the layer's authority.
    expect(delta('Spine')).toBeLessThan(delta('Spine1'));
    expect(delta('Spine1')).toBeLessThan(delta('Spine2'));
    animator.dispose();
  });

  it('releases a one-shot overlay by itself', () => {
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 4 });
    animator.playAdditive('attack');
    step(animator, 3);
    // Gameplay should never have to remember to stop a punch.
    animator.playAdditive('attack');
    expect(() => step(animator, 3)).not.toThrow();
    animator.dispose();
  });
});

describe('events', () => {
  it('fires a footfall for every touchdown while moving', () => {
    const { animator } = makeAnimator();
    const events: AnimEvent[] = [];
    animator.onEvent((event) => events.push(event));
    animator.setLocomotion({ speed: 1.4 });
    animator.play('walk');
    step(animator, 6);

    const footfalls = events.filter((event) => event.name === 'footfall');
    const cadence = animator.gait.cycleFrequency;
    // Two steps per cycle. Allow one at each end for the warm-up transient.
    expect(footfalls.length).toBeGreaterThan(cadence * 6 * 2 - 3);
    expect(footfalls.length).toBeLessThan(cadence * 6 * 2 + 3);
    expect(new Set(footfalls.map((f) => f.foot))).toEqual(new Set(['left', 'right']));
    // Footfalls carry the WORLD plant position, which is what the audio
    // system needs to place the sound.
    expect(footfalls[0]!.position).toBeInstanceOf(THREE.Vector3);
    animator.dispose();
  });

  it('does not fire footfalls while standing still', () => {
    const { animator } = makeAnimator();
    const events: AnimEvent[] = [];
    animator.onEvent((event) => events.push(event));
    animator.setLocomotion({ speed: 0 });
    step(animator, 5);
    expect(events.filter((e) => e.name === 'footfall')).toHaveLength(0);
    animator.dispose();
  });

  it('fires punch markers in order, once each', () => {
    const { animator } = makeAnimator();
    const events: AnimEvent[] = [];
    animator.onEvent((event) => events.push(event));
    animator.play('attack', { fade: 0 });
    step(animator, 1.5);

    const names = events.filter((e) => e.clip === 'attack').map((e) => e.name);
    expect(names).toEqual(['windup', 'whoosh', 'impact', 'release']);
    const impact = events.find((e) => e.name === 'impact')!;
    expect(impact.bone).toBe('RightHand');
    expect(impact.position).toBeInstanceOf(THREE.Vector3);
    expect(impact.strength).toBe(1);
    animator.dispose();
  });

  it('does not swallow markers on a hitched frame', () => {
    // A 300 ms frame at a 4 Hz gait crosses several markers at once. Dropping
    // them is the sort of bug that only appears on the slowest device shipped.
    const { animator } = makeAnimator();
    const events: AnimEvent[] = [];
    animator.onEvent((event) => events.push(event));
    animator.play('attack', { fade: 0 });
    animator.update(0.3);
    animator.update(0.3);
    animator.update(0.3);
    const names = events.filter((e) => e.clip === 'attack').map((e) => e.name);
    expect(new Set(names)).toEqual(new Set(['windup', 'whoosh', 'impact', 'release']));
    animator.dispose();
  });

  it('fires the ragdoll cue before the death clip ends', () => {
    const { animator } = makeAnimator();
    const events: AnimEvent[] = [];
    animator.onEvent((event) => events.push(event));
    animator.play('death', { fade: 0 });
    step(animator, 2.5);
    const cue = events.find((e) => e.name === 'ragdoll');
    expect(cue).toBeDefined();
    expect(cue!.phase).toBeLessThan(0.8);
    animator.dispose();
  });
});

describe('ragdoll handoff', () => {
  it('exposes the pose, model matrices and velocities at the handoff instant', () => {
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 5 });
    step(animator, 1.5);

    const handoff = animator.handoffToRagdoll(0.12);
    expect(handoff.modelMatrices).toHaveLength(animator.rig.boneCount);
    expect(handoff.pose.boneCount).toBe(animator.rig.boneCount);
    expect(handoff.duration).toBeCloseTo(0.12, 9);
    expect(handoff.blend).toBe(0);
    // A running character's limbs are moving; a ragdoll handed zero velocity
    // stalls in mid-air before it starts to fall.
    const speeds = Array.from(handoff.velocities).map(Math.abs);
    expect(Math.max(...speeds)).toBeGreaterThan(0.5);
    animator.dispose();
  });

  it('blends over the stated duration and then lets go of the skeleton', () => {
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 3 });
    step(animator, 1);
    animator.handoffToRagdoll(0.12);

    animator.update(0.06);
    expect(animator.ragdollHandoff!.blend).toBeCloseTo(0.5, 2);
    expect(animator.ragdollComplete).toBe(false);

    animator.update(0.06);
    expect(animator.ragdollHandoff!.blend).toBe(1);
    expect(animator.ragdollComplete).toBe(true);

    // Once physics owns the bones the animator must stop writing them, or the
    // two writers fight and the body jitters.
    const bone = animator.rig.bones[animator.rig.index.Hips!]!;
    bone.position.set(99, 99, 99);
    animator.update(1 / 60);
    expect(bone.position.x).toBe(99);
    animator.dispose();
  });

  it('can take the skeleton back for a get-up', () => {
    const { animator } = makeAnimator();
    step(animator, 0.5);
    animator.handoffToRagdoll(0.05);
    step(animator, 0.2);
    expect(animator.ragdollComplete).toBe(true);
    animator.clearRagdoll();
    const bone = animator.rig.bones[animator.rig.index.Hips!]!;
    bone.position.set(99, 99, 99);
    animator.update(1 / 60);
    expect(bone.position.x).not.toBe(99);
    animator.dispose();
  });

  it('freezes the captured pose rather than letting it drift', () => {
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 4 });
    step(animator, 1);
    const handoff = animator.handoffToRagdoll(0.2);
    const snapshot = new Float32Array(handoff.pose.rot);
    step(animator, 0.15);
    // Physics is interpolating toward this pose; if it moved under them the
    // blend would never land.
    expect(Array.from(handoff.pose.rot)).toEqual(Array.from(snapshot));
    animator.dispose();
  });
});

describe('determinism', () => {
  function trace(seed: number, speeds: (i: number) => number): number[] {
    const parts = createCharacterParts(buildCharacter('saitama', 0), new THREE.MeshBasicMaterial());
    const animator = new ProceduralAnimator(parts, parts.root, { seed });
    for (let i = 0; i < 300; i++) {
      animator.setLocomotion({ speed: speeds(i) });
      animator.update(1 / 60);
    }
    const out = [...Array.from(animator.pose.rot), ...Array.from(animator.pose.pos)];
    animator.dispose();
    return out;
  }

  it('produces a bit-identical pose sequence from the same seed', () => {
    const speeds = (i: number): number => 1 + Math.sin(i * 0.031) * 0.9;
    expect(trace(11, speeds)).toEqual(trace(11, speeds));
  });

  it('produces different animation from a different seed', () => {
    const speeds = (i: number): number => 1 + Math.sin(i * 0.031) * 0.9;
    expect(trace(11, speeds)).not.toEqual(trace(12, speeds));
  });

  it('never calls Math.random while evaluating', () => {
    // The whole city generates from seeds and must replay identically. One
    // unseeded call in the evaluation path would break that for every system
    // downstream, and would do it silently.
    //
    // The spy is installed AFTER construction on purpose: three.js seeds every
    // object's uuid from `Math.random`, so counting calls during construction
    // would measure three.js rather than this system. A uuid cannot influence
    // a pose; a call inside `update` could.
    const { animator } = makeAnimator({ seed: 5 });
    animator.setLocomotion({ speed: 2 });
    animator.play('walk');
    step(animator, 1);

    const spy = vi.spyOn(Math, 'random');
    step(animator, 3);
    animator.playAdditive('attack');
    step(animator, 1);
    animator.setLocomotion({ speed: 0.2 });
    step(animator, 1);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    animator.dispose();
  });

  it('gives crowd members different phases from different seeds', () => {
    const a = makeAnimator({ seed: 1 }).animator;
    const b = makeAnimator({ seed: 2 }).animator;
    expect(a.solver.phase).not.toBe(b.solver.phase);
    expect(a.params.phaseOffset).not.toBe(b.params.phaseOffset);
    a.dispose();
    b.dispose();
  });
});

describe('attachment to the mesh system', () => {
  it('completes an ICharacterInstance from CharacterParts', () => {
    // The seam the mesh workstream handed over: parts plus an animator is a
    // complete character, with neither module importing the other.
    const parts = createCharacterParts(buildCharacter('genos', 0), new THREE.MeshBasicMaterial());
    const animator = new ProceduralAnimator(parts, parts.root);
    const instance = { ...parts, animator };
    expect(instance.animator.mixer).toBeInstanceOf(THREE.AnimationMixer);
    expect(instance.getBone('Hips')).toBeDefined();
    animator.setLocomotion({ speed: 2 });
    animator.update(1 / 60);
    parts.root.updateMatrixWorld(true);
    const socket = new THREE.Vector3();
    instance.getSocketWorldPosition('RightHand', socket);
    expect(socket.length()).toBeGreaterThan(0.1);
    animator.dispose();
  });

  it('measures the body off the skeleton rather than the profile', () => {
    const fixture = heroFixture('tatsumaki');
    // Tatsumaki is 1.44 m; the metrics must reflect what was BUILT.
    expect(fixture.rig.metrics.height).toBeCloseTo(1.44, 1);
    expect(fixture.rig.metrics.legLength).toBeGreaterThan(0.5);
    expect(fixture.rig.metrics.legLength).toBeLessThan(0.85);
    expect(fixture.rig.identityRest).toBe(true);
    expect(fixture.rig.boneCount).toBe(27);
  });
});
