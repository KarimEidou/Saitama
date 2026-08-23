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
import { resetLogState } from '@/util';
import type { BoneName, ClipName, IAnimator } from '@/types';
import { ProceduralAnimator, type AnimatorOptions } from '../animator';
import { createCharacterParts, buildCharacter } from '@/characters/mesh';
import { poseToModelMatrices } from '../pose';
import type { AnimEvent, Pose, RigLike } from '../types';
import { heroFixture, showcaseFixtures } from './support';

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

  it('keeps the base clip advancing when play() is called every single frame', () => {
    // The assertion above cannot see the failure it is named for: the solver
    // phase advances once per frame whatever the layers do. The guard has to
    // survive its OWN crossfade — every `play` resets the fade, so requiring
    // the fade to have finished first means a caller playing the same slot once
    // per frame rebuilds the base layer at time zero forever. The clip is then
    // pinned at t ~= 0: no breathing, no weight shift, and every marker in it
    // silently never fires.
    const { animator } = makeAnimator({ variants: { idle: 'bored' } });
    const events: AnimEvent[] = [];
    animator.onEvent((event) => events.push(event));
    // idle:bored is a ~9.4 s loop with its `voice` marker at 65.5 %.
    for (let i = 0; i < 60 * 12; i++) {
      animator.play('idle');
      animator.update(1 / 60);
    }
    expect(events.filter((e) => e.name === 'voice').length).toBeGreaterThanOrEqual(1);
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

  it('rebakes when the frame count or the params change', () => {
    // Both are baked INTO the result, so both belong in the cache key. Keying
    // on the slot alone hands a 16-frame preview back to an exporter that asked
    // for 240, and returns a bake taken at `boredom: 0` forever after the
    // Boredom system has driven it to 1 — silently, in both cases.
    const { animator } = makeAnimator();
    const keys = (clip: THREE.AnimationClip): number =>
      clip.tracks.find((t) => t.name.endsWith('.quaternion'))!.times.length;
    const coarse = animator.animationClip('walk', 8);
    const fine = animator.animationClip('walk', 64);
    expect(fine).not.toBe(coarse);
    expect(keys(fine)).toBeGreaterThan(keys(coarse));
    expect(animator.animationClip('walk', 8)).toBe(coarse);

    const engaged = animator.animationClip('idle', 16);
    animator.params.boredom = 1;
    expect(animator.animationClip('idle', 16)).not.toBe(engaged);
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

  it('feathers the flee style onto the spine, exactly as the baker does', () => {
    // `flee` is the only entry that is both locomotive and upper-region. The
    // runtime short-circuited the mask for anything locomotive while the baker
    // applied it on region alone, so the same clip meant two different things:
    // a fleeing civilian popped its torso the instant the VAT crowd promoted it
    // to a real skeleton — the exact artefact the promotion path exists to
    // avoid. 4 m/s resolves to `run`, so the gait retarget leaves both alone.
    const settled = (slot: ClipName): Float32Array => {
      const { animator } = makeAnimator({ seed: 3 });
      animator.play(slot, { fade: 0 });
      for (let i = 0; i < 200; i++) {
        animator.setLocomotion({ speed: 4 });
        animator.update(1 / 120);
      }
      const out = new Float32Array(animator.pose.rot);
      animator.dispose();
      return out;
    };
    const run = settled('run');
    const flee = settled('flee');
    const { animator } = makeAnimator({ seed: 3 });
    const rig = animator.rig;
    const delta = (name: 'Hips' | 'Spine' | 'Spine1' | 'Spine2' | 'Neck'): number => {
      const i = rig.index[name]!;
      return Math.hypot(
        flee[i * 4]! - run[i * 4]!,
        flee[i * 4 + 1]! - run[i * 4 + 1]!,
        flee[i * 4 + 2]! - run[i * 4 + 2]!
      );
    };
    // 35 % / 70 % / 100 % up the stack, and nothing at all below the waist.
    expect(delta('Hips')).toBeLessThan(1e-6);
    expect(delta('Spine')).toBeLessThan(delta('Spine1') * 0.6);
    expect(delta('Spine1')).toBeLessThan(delta('Spine2') * 0.8);
    expect(delta('Spine2')).toBeGreaterThan(0);
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

  it('omits the position when the marker names a bone the rig does not have', () => {
    // `resolveRig` is tolerant by design, and four library markers name
    // `RightHand` or `Hips`, so a hand-less or GLB-sourced rig reaches this.
    // The event used to carry a clone of the module scratch vector — in the
    // normal frame order, another bone's MODEL-space position, which looks
    // plausible and is in the wrong space entirely.
    const build = buildCharacter('saitama', 0);
    const parts = createCharacterParts(build, new THREE.MeshBasicMaterial());
    const kept = parts.skeleton.bones.filter((b) => !b.name.endsWith('RightHand'));
    const source: RigLike = {
      skeleton: new THREE.Skeleton(kept),
      profile: build.profile,
      getBone: (name: BoneName) => kept.find((b) => b.name.endsWith(name)),
    };
    const animator = new ProceduralAnimator(source, new THREE.Group());
    expect(animator.rig.index.RightHand).toBeUndefined();

    const events: AnimEvent[] = [];
    animator.onEvent((event) => events.push(event));
    animator.play('attack', { fade: 0 });
    step(animator, 1.5);

    const impact = events.find((e) => e.name === 'impact')!;
    expect(impact).toBeDefined();
    expect(impact.bone).toBe('RightHand');
    expect(impact.position).toBeUndefined();
    // ...while a marker naming a bone this rig DOES have still carries one, so
    // the guard is "no bone, no position" rather than "no position".
    events.length = 0;
    animator.play('jump', { fade: 0 });
    step(animator, 1);
    const launch = events.find((e) => e.name === 'launch')!;
    expect(launch.bone).toBe('Hips');
    expect(launch.position).toBeInstanceOf(THREE.Vector3);
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

describe('hostile input', () => {
  it('survives a non-finite frame from the game clock', () => {
    // The accumulator hazard from `locomotion.test.ts`'s "hostile input", seen
    // through the façade the game actually calls: a stalled clock or a
    // controller that produced one NaN speed must not erase the character for
    // the rest of the session.
    const { animator } = makeAnimator();
    step(animator, 1);
    animator.update(NaN);
    animator.setLocomotion({ speed: NaN });
    animator.update(1 / 60);
    animator.setLocomotion({ speed: 2 });
    step(animator, 0.5);

    const pose = animator.pose;
    for (let i = 0; i < pose.rot.length; i++) {
      expect(Number.isFinite(pose.rot[i]!), `rot ${i}`).toBe(true);
    }
    for (let i = 0; i < pose.pos.length; i++) {
      expect(Number.isFinite(pose.pos[i]!), `pos ${i}`).toBe(true);
    }
    expect(animator.gait.speed).toBe(2);
    animator.dispose();
  });

  it('ignores a non-finite timeScale rather than propagating it', () => {
    const { animator } = makeAnimator();
    step(animator, 0.5);
    animator.timeScale = NaN;
    animator.update(1 / 60);
    animator.timeScale = 1;
    step(animator, 0.5);
    expect(Number.isFinite(animator.solver.phase)).toBe(true);
    expect(Number.isFinite(animator.pose.rot[0]!)).toBe(true);
    animator.dispose();
  });

  it('sweeps non-finite clip params before they reach the pose functions', () => {
    // `params` is public and mutable, so a caller can put a NaN straight into
    // the angle every `poseArm` / `poseSpine` / `poseLeg` is about to compute —
    // no `dt` involved, and the `dt` guard above does not see it. The result is
    // not a wrong pose but NO character: NaN quaternions render as nothing.
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 2 });
    step(animator, 0.5);

    animator.params.boredom = NaN;
    animator.params.alertness = Number.POSITIVE_INFINITY;
    animator.params.phaseOffset = Number.NEGATIVE_INFINITY;
    animator.params.vigour = NaN;
    animator.update(1 / 60);

    // Repaired IN PLACE, because the caller is holding this exact object; a
    // replacement would leave them writing to something nothing reads.
    expect(Number.isFinite(animator.params.boredom)).toBe(true);
    expect(Number.isFinite(animator.params.alertness)).toBe(true);
    expect(Number.isFinite(animator.params.phaseOffset)).toBe(true);
    expect(Number.isFinite(animator.params.vigour)).toBe(true);

    step(animator, 0.5);
    const pose = animator.pose;
    for (let i = 0; i < pose.rot.length; i++) {
      expect(Number.isFinite(pose.rot[i]!), `rot ${i}`).toBe(true);
    }
    for (let i = 0; i < pose.pos.length; i++) {
      expect(Number.isFinite(pose.pos[i]!), `pos ${i}`).toBe(true);
    }
    animator.dispose();
  });

  it('repairs only the broken field, and leaves finite outliers alone', () => {
    // The sweep tests FINITENESS, not range. `vigour` is per-instance jitter
    // and `boredom` is legitimately driven to 1, so a guard that also clamped
    // to some tidy interval would quietly flatten a crowd's variation — a much
    // harder bug to see than the one it was added to fix.
    const { animator } = makeAnimator({ seed: 7 });
    const vigour = animator.params.vigour;
    const phase = animator.params.phaseOffset;
    animator.params.boredom = NaN;
    animator.params.alertness = 1;
    animator.update(1 / 60);
    expect(animator.params.boredom).toBe(0);
    expect(animator.params.alertness).toBe(1);
    expect(animator.params.vigour).toBe(vigour);
    expect(animator.params.phaseOffset).toBe(phase);
    animator.dispose();
  });

  it('says so out loud, once, instead of papering over it', () => {
    // Substituting a default for a visual parameter is defensible; doing it
    // silently is how a broken caller ships. And it must stay ONE line: this
    // runs per character per frame, so an unlatched warning from a crowd is
    // itself a worse bug than the pose it is reporting.
    resetLogState();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { animator } = makeAnimator();
      animator.params.boredom = NaN;
      step(animator, 0.5);
      animator.dispose();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]!.join(' '))).toContain('ClipParams');
    } finally {
      warn.mockRestore();
      resetLogState();
    }
  });

  it('never bakes a NaN track, even from params that were bad at bake time', () => {
    // `animationClip` is the other door into the same pose functions and it
    // does not go through `update`. A bake is CACHED, so a NaN written here
    // outlives the bad frame and keeps being handed back.
    const { animator } = makeAnimator();
    animator.params.boredom = NaN;
    animator.params.vigour = Number.POSITIVE_INFINITY;
    const clip = animator.animationClip('idle', 8);
    expect(clip.tracks.length).toBeGreaterThan(0);
    for (const track of clip.tracks) {
      for (let i = 0; i < track.values.length; i++) {
        expect(Number.isFinite(track.values[i]!), `${track.name}[${i}]`).toBe(true);
      }
    }
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
    // ...and bounded. A ragdoll seeded from a velocity the character never had
    // is fired off the map, which the lower bound alone cannot catch.
    expect(Math.max(...speeds)).toBeLessThan(20);
    animator.dispose();
  });

  it('reports no velocity at all when killed on its first animated frame', () => {
    // There is no previous frame to difference against: `output` still holds
    // the BIND pose, whose arms are in a shallow T, so charging the bind-to-idle
    // transition as one frame of motion reported ~36 m/s at the hands (and ~96
    // at the head when the reference was the unwritten all-zero buffer).
    const { animator } = makeAnimator();
    animator.update(1 / 60);
    const handoff = animator.handoffToRagdoll(0.12);
    const speeds = Array.from(handoff.velocities).map(Math.abs);
    // Float32 storage in the position snapshot leaves a few microns per second.
    expect(Math.max(...speeds)).toBeLessThan(1e-3);
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

  it('differences the last two poses exactly', () => {
    // Pins the semantics the velocity snapshot has to preserve: the handoff
    // reports (thisFrame - lastFrame) / dt per bone, in model space. The
    // snapshot is a POSE rather than resolved bone positions, so this is the
    // assertion that says the deferred forward-kinematics pass reproduces the
    // per-frame one exactly rather than approximately.
    const { animator } = makeAnimator();
    animator.setLocomotion({ speed: 4 });
    step(animator, 1);

    const prev: Pose = {
      boneCount: animator.pose.boneCount,
      rot: new Float32Array(animator.pose.rot),
      pos: new Float32Array(animator.pose.pos),
    };
    animator.update(1 / 60);
    const handoff = animator.handoffToRagdoll();

    const before = poseToModelMatrices(prev, animator.rig, []);
    const after = poseToModelMatrices(animator.pose, animator.rig, []);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    for (let i = 0; i < animator.rig.boneCount; i++) {
      a.setFromMatrixPosition(after[i]!);
      b.setFromMatrixPosition(before[i]!);
      expect(handoff.velocities[i * 3]!, `bone ${i} x`).toBeCloseTo((a.x - b.x) * 60, 6);
      expect(handoff.velocities[i * 3 + 1]!, `bone ${i} y`).toBeCloseTo((a.y - b.y) * 60, 6);
      expect(handoff.velocities[i * 3 + 2]!, `bone ${i} z`).toBeCloseTo((a.z - b.z) * 60, 6);
    }
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

  it('measures a real shoulder width rather than a multiple of the hips', () => {
    // The measurement is taken through shared scratch vectors, and the hip
    // reads reused them: `shoulderHalfWidth` silently collapsed to its own
    // `hipHalfWidth * 1.05` floor on EVERY body, so a 2.45 m monster with a
    // barrel chest and a 1.22 m child reported the same proportion.
    const ratios = showcaseFixtures().map((fixture) => {
      const m = fixture.rig.metrics;
      expect(m.shoulderHalfWidth, fixture.name).toBeGreaterThan(m.hipHalfWidth * 1.4);
      return m.shoulderHalfWidth / m.hipHalfWidth;
    });
    // ...and it is a MEASUREMENT, so it differs from body to body.
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.5);
  });
});
