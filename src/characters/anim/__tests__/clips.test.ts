/**
 * THE CLIP LIBRARY
 *
 * Coverage, continuity and character. The interesting assertions are the last
 * two: a clip that jumps between adjacent frames pops on screen, and a bored
 * idle that does not measurably differ from a neutral one is not doing the job
 * the Boredom system needs it to do.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoneName, ClipName } from '@/types';
import {
  CLIP_LIBRARY,
  clipDuration,
  clipSpeed,
  defaultClipParams,
  findClip,
  hasClip,
} from '../clips';
import { bakeAnimationClips, maskFor, sampleClip, toAnimationClip } from '../bake';
import { poseHead, posePelvis, poseSpine } from '../posture';
import { copyPose, createPose, poseAngleDelta, poseToModelMatrices } from '../pose';
import { REFERENCE_LEG } from '../rig';
import type { Pose } from '../types';
import { heroFixture, showcaseFixtures } from './support';

const ALL_SLOTS: readonly ClipName[] = [
  'idle',
  'walk',
  'run',
  'sprint',
  'jump',
  'fall',
  'land',
  'attack',
  'heavyAttack',
  'block',
  'dodge',
  'hit',
  'stagger',
  'death',
  'flee',
  'taunt',
  'special',
];

describe('coverage', () => {
  it('covers every ClipName slot', () => {
    for (const slot of ALL_SLOTS) {
      expect(hasClip(slot), slot).toBe(true);
      expect(findClip(slot).def.slot, slot).toBe(slot);
    }
  });

  it('ships at least twelve clips', () => {
    expect(CLIP_LIBRARY.length).toBeGreaterThanOrEqual(12);
  });

  it('carries the OPM-specific idle variants', () => {
    for (const variant of ['bored', 'combat', 'civilian', 'panicked'] as const) {
      const entry = findClip('idle', variant);
      expect(entry.def.variant, variant).toBe(variant);
    }
  });

  it('falls back to the default variant rather than throwing', () => {
    // Asset coverage lands incrementally; a missing variant must degrade.
    const entry = findClip('attack', 'panicked');
    expect(entry.def.slot).toBe('attack');
    expect(entry.def.variant).toBe('default');
  });

  it('gives every clip a plausible duration for the body', () => {
    const { rig } = heroFixture('saitama');
    for (const entry of CLIP_LIBRARY) {
      const duration = clipDuration(entry, rig);
      expect(duration, `${entry.def.slot}:${entry.def.variant}`).toBeGreaterThan(0.05);
      expect(duration, `${entry.def.slot}:${entry.def.variant}`).toBeLessThan(20);
    }
  });

  it('scales clip durations with the square root of leg length', () => {
    // A pendulum period. A short-legged child snaps; a monster is ponderous.
    const bodies = showcaseFixtures();
    const child = bodies.find((b) => b.name === 'Child')!;
    const monster = bodies.find((b) => b.name === 'Monster humanoid')!;
    const attack = findClip('attack');
    const ratio = clipDuration(attack, monster.rig) / clipDuration(attack, child.rig);
    const expected = Math.sqrt(monster.rig.metrics.legLength / child.rig.metrics.legLength);
    expect(ratio).toBeCloseTo(expected, 5);
    // ...and the reference adult lands on the authored number.
    const { rig } = heroFixture('saitama');
    expect(clipDuration(attack, rig)).toBeCloseTo(
      attack.def.duration * Math.sqrt(rig.metrics.legLength / REFERENCE_LEG),
      6
    );
  });

  it('states locomotive reference speeds in Froude units', () => {
    const bodies = showcaseFixtures();
    const child = bodies.find((b) => b.name === 'Child')!;
    const monster = bodies.find((b) => b.name === 'Monster humanoid')!;
    const run = findClip('run');
    // The monster's run is faster in m/s, but both are the SAME gait.
    expect(clipSpeed(run, monster.rig)).toBeGreaterThan(clipSpeed(run, child.rig));
    const u = (speed: number, L: number): number => speed / Math.sqrt(9.81 * L);
    expect(u(clipSpeed(run, monster.rig), monster.rig.metrics.legLength)).toBeCloseTo(
      u(clipSpeed(run, child.rig), child.rig.metrics.legLength),
      6
    );
  });
});

describe('continuity', () => {
  const { rig } = heroFixture('saitama');

  it('keeps every joint under a physically plausible angular velocity', () => {
    // Measured in rad/s, not degrees per sampled frame, so the assertion is
    // about the ANIMATION rather than about how densely it was sampled.
    // Elite human strikes peak near 40 rad/s at the elbow; 50 leaves room for
    // a stylised hero without allowing a joint to skip most of its arc between
    // two 60 Hz frames, which is what a "pop" actually is.
    for (const entry of CLIP_LIBRARY) {
      const frames = 128;
      const poses = sampleClip(rig, entry, { frames });
      const dt = clipDuration(entry, rig) / (entry.def.loop ? frames : frames - 1);
      let worst = 0;
      for (let i = 1; i < poses.length; i++) {
        worst = Math.max(worst, poseAngleDelta(poses[i - 1]!, poses[i]!) / dt);
      }
      expect(worst, `${entry.def.slot}:${entry.def.variant}`).toBeLessThan(50);
    }
  });

  it('closes the loop on every looping clip', () => {
    for (const entry of CLIP_LIBRARY) {
      if (!entry.def.loop) continue;
      const poses = sampleClip(rig, entry, { frames: 64 });
      const wrap = poseAngleDelta(poses[poses.length - 1]!, poses[0]!);
      const dt = clipDuration(entry, rig) / 64;
      expect(wrap / dt, `${entry.def.slot}:${entry.def.variant}`).toBeLessThan(50);
    }
  });

  it('keeps every clip above the ground plane', () => {
    // The clips author legs directly rather than through the foot IK, so this
    // is the check that a squat or a collapse does not put a shin through the
    // floor. Death and dodge are exempt: both deliberately leave the ground.
    const model: THREE.Matrix4[] = [];
    const position = new THREE.Vector3();
    for (const entry of CLIP_LIBRARY) {
      if (entry.def.slot === 'death' || entry.def.slot === 'dodge') continue;
      if (entry.def.slot === 'jump' || entry.def.slot === 'fall') continue;
      const poses = sampleClip(rig, entry, { frames: 32 });
      let lowest = Infinity;
      for (const pose of poses) {
        poseToModelMatrices(pose, rig, model);
        for (let b = 0; b < rig.boneCount; b++) {
          position.setFromMatrixPosition(model[b]!);
          lowest = Math.min(lowest, position.y);
        }
      }
      // The lowest bone is a toe, which sits a little above the sole.
      expect(lowest, `${entry.def.slot}:${entry.def.variant}`).toBeGreaterThan(-0.02);
    }
  });
});

describe('the sagittal sign convention', () => {
  // The one thing a height measurement cannot tell you. A backward arch drops
  // the head exactly as much as a forward fold does, so every assertion here is
  // about a model-space DIRECTION: the character faces -Z, so forward is -Z.
  const { rig } = heroFixture('saitama');
  const model: THREE.Matrix4[] = [];

  const posed = (build: (pose: Pose) => void): ((bone: BoneName) => THREE.Vector3) => {
    const pose = createPose(rig.boneCount);
    copyPose(pose, rig.rest);
    build(pose);
    // Its own matrix array: two of these are alive at once in every assertion.
    const matrices = poseToModelMatrices(pose, rig, []);
    return (bone) => new THREE.Vector3().setFromMatrixPosition(matrices[rig.index[bone]!]!);
  };

  const rest = posed(() => {});

  it('folds the chest FORWARD for a positive spine bend', () => {
    const at = posed((pose) => poseSpine(pose, rig, { bend: 0.6 }));
    expect(at('Neck').z).toBeLessThan(rest('Neck').z - 0.05);
  });

  it('drops the chin for a positive head pitch', () => {
    const at = posed((pose) => poseHead(pose, rig, 0.6));
    expect(at('HeadTop_End').z).toBeLessThan(rest('HeadTop_End').z - 0.02);
    expect(at('HeadTop_End').y).toBeLessThan(rest('HeadTop_End').y);
  });

  it('tips the whole body forward for a positive pelvis pitch', () => {
    const m = rig.metrics;
    const at = posed((pose) => posePelvis(pose, rig, 0, m.hipHeight, 0, 0.4));
    expect(at('Neck').z).toBeLessThan(rest('Neck').z - 0.1);
  });

  it('leaves Saitama slouched FORWARD at full boredom, not arched back', () => {
    // The flagship consequence: `idle:bored` promises "rounded thoracic spine,
    // chin down and slightly forward". Under an inverted sagittal sign it
    // produces the exact opposite — a 15 degree backward arch with the face
    // tilted up — and every head-height assertion in this file still passes.
    const bored = findClip('idle', 'bored');
    const sample = (boredom: number): { head: THREE.Vector3; hips: THREE.Vector3 } => {
      const params = { ...defaultClipParams(), boredom };
      // Frame 1 of 8 is away from the yawn, which reverses the posture.
      const pose = sampleClip(rig, bored, { frames: 8, params })[1]!;
      poseToModelMatrices(pose, rig, model);
      return {
        head: new THREE.Vector3().setFromMatrixPosition(model[rig.index.Head!]!),
        hips: new THREE.Vector3().setFromMatrixPosition(model[rig.index.Hips!]!),
      };
    };
    const slouched = sample(1);
    const engaged = sample(0);
    // Head carried ahead of the hips, and further ahead the more bored he is.
    expect(slouched.head.z).toBeLessThan(slouched.hips.z - 0.05);
    expect(slouched.head.z - slouched.hips.z).toBeLessThan(engaged.head.z - engaged.hips.z);
  });

  it('keeps the neutral idle upright', () => {
    // The control: without it every assertion above would pass on any pose that
    // happened to lean forward for unrelated reasons.
    const pose = sampleClip(rig, findClip('idle', 'default'), { frames: 8 })[1]!;
    poseToModelMatrices(pose, rig, model);
    const head = new THREE.Vector3().setFromMatrixPosition(model[rig.index.Head!]!);
    const hips = new THREE.Vector3().setFromMatrixPosition(model[rig.index.Hips!]!);
    expect(Math.abs(head.z - hips.z)).toBeLessThan(0.05);
  });
});

describe('three.js interop', () => {
  const { rig } = heroFixture('saitama');

  it('closes the loop seam on a looping bake', () => {
    // Without a key at `duration` the mixer holds the last frame for one whole
    // frame interval and then jumps to frame 0 — a visible hitch once per loop.
    const entry = findClip('idle');
    const poses = sampleClip(rig, entry, { frames: 16 });
    const duration = clipDuration(entry, rig);
    const clip = toAnimationClip(rig, 'idle', poses, duration, { loop: true });
    const track = clip.tracks.find((t) => t.name.endsWith('.quaternion'))!;
    expect(track.times.length).toBe(17);
    expect(track.times[16]!).toBeCloseTo(duration, 5);
    // ...and the wrap key repeats frame 0 exactly.
    for (let i = 0; i < 4; i++) {
      expect(track.values[16 * 4 + i]!).toBeCloseTo(track.values[i]!, 6);
    }
  });

  it('lays a one-shot bake on the closed grid it was sampled on', () => {
    // `sampleClip` puts pose i of an n-frame one-shot at i/(n-1), so the keys
    // belong there too; the looping grid i/n compresses the whole performance
    // into (n-1)/n of the stated duration and slides every marker early.
    const entry = findClip('attack');
    const poses = sampleClip(rig, entry, { frames: 24 });
    const duration = clipDuration(entry, rig);
    const clip = toAnimationClip(rig, 'attack', poses, duration, { loop: false });
    const track = clip.tracks.find((t) => t.name.endsWith('.quaternion'))!;
    expect(track.times.length).toBe(24);
    expect(track.times[23]!).toBeCloseTo(duration, 5);
  });

  it('picks the grid from each clip when baking the library', () => {
    const clips = bakeAnimationClips(rig, [findClip('idle'), findClip('attack')], 12);
    const keys = (name: string): number => {
      const clip = clips.get(name)!;
      return clip.tracks.find((t) => t.name.endsWith('.quaternion'))!.times.length;
    };
    expect(keys('idle:default')).toBe(13); // looping: wrap key appended
    expect(keys('attack:default')).toBe(12); // one-shot: closed grid
  });

  it('caches the region masks per rig instead of rebuilding them', () => {
    // The docstring promised a cache and there was none, so a per-frame overlay
    // blend over a crowd allocated a fresh 27-float array per member per frame.
    expect(maskFor(rig, 'upper')).toBe(maskFor(rig, 'upper'));
    expect(maskFor(rig, 'lower')).toBe(maskFor(rig, 'lower'));
    expect(maskFor(rig, 'upper')).not.toBe(maskFor(rig, 'lower'));
    expect(maskFor(rig, 'full')).toBeUndefined();
  });
});

describe("Saitama's bored idle", () => {
  const { rig } = heroFixture('saitama');
  const bored = findClip('idle', 'bored');
  const neutral = findClip('idle', 'default');

  it('is a measurably different posture from the neutral idle', () => {
    const a = sampleClip(rig, neutral, { frames: 16 })[0]!;
    const b = sampleClip(rig, bored, { frames: 16 })[0]!;
    // Not a subtle variation: a slouch has to read at gameplay distance.
    expect((poseAngleDelta(a, b) * 180) / Math.PI).toBeGreaterThan(12);
  });

  it('drops the head and rounds the spine, and does both harder when bored', () => {
    const model: THREE.Matrix4[] = [];
    const head = new THREE.Vector3();
    const hips = new THREE.Vector3();

    const headDrop = (boredom: number): number => {
      const params = { ...defaultClipParams(), boredom };
      const poses = sampleClip(rig, bored, { frames: 8, params });
      // Sample away from the yawn, which reverses the posture.
      poseToModelMatrices(poses[1]!, rig, model);
      head.setFromMatrixPosition(model[rig.index.Head!]!);
      hips.setFromMatrixPosition(model[rig.index.Hips!]!);
      return head.y - hips.y;
    };

    const upright = sampleClip(rig, neutral, { frames: 8 })[1]!;
    poseToModelMatrices(upright, rig, model);
    head.setFromMatrixPosition(model[rig.index.Head!]!);
    hips.setFromMatrixPosition(model[rig.index.Hips!]!);
    const uprightRise = head.y - hips.y;

    expect(headDrop(0)).toBeLessThan(uprightRise);
    // More boredom, more collapse — the parameter must be continuous, because
    // the game drives it straight off its own 0..1 Boredom value.
    expect(headDrop(1)).toBeLessThan(headDrop(0));
    expect(uprightRise - headDrop(1)).toBeGreaterThan(0.02);
  });

  it('yawns exactly once per loop, reaching up and then giving up', () => {
    const model: THREE.Matrix4[] = [];
    const hand = new THREE.Vector3();
    const poses = sampleClip(rig, bored, { frames: 48 });
    const heights = poses.map((pose) => {
      poseToModelMatrices(pose, rig, model);
      hand.setFromMatrixPosition(model[rig.index.LeftHand!]!);
      return hand.y;
    });
    const lowest = Math.min(...heights);
    const highest = Math.max(...heights);
    // The hands have to travel: a yawn that does not raise the arms is a nod.
    expect(highest - lowest).toBeGreaterThan(rig.metrics.legLength * 0.35);

    // One peak, not several: count the frames above the midpoint and check
    // they form a single contiguous run.
    const threshold = (highest + lowest) * 0.5;
    let runs = 0;
    let inRun = false;
    for (const h of [...heights, lowest]) {
      if (h > threshold && !inRun) runs++;
      inRun = h > threshold;
    }
    expect(runs).toBe(1);
  });

  it('fires a voice marker inside the yawn', () => {
    const voice = bored.def.markers.find((m) => m.name === 'voice');
    expect(voice).toBeDefined();
    expect(voice!.at).toBeGreaterThan(0.6);
    expect(voice!.at).toBeLessThan(0.79);
  });
});

describe('combat clips', () => {
  const { rig } = heroFixture('saitama');

  it('extends the striking arm furthest at the impact marker', () => {
    const model: THREE.Matrix4[] = [];
    const shoulder = new THREE.Vector3();
    const fist = new THREE.Vector3();
    for (const slot of ['attack', 'heavyAttack', 'special'] as const) {
      const entry = findClip(slot);
      const impact = entry.def.markers.find((m) => m.name === 'impact');
      expect(impact, slot).toBeDefined();
      const frames = 64;
      const poses = sampleClip(rig, entry, { frames });
      const reachAt = (i: number): number => {
        poseToModelMatrices(poses[i]!, rig, model);
        shoulder.setFromMatrixPosition(model[rig.index.RightArm!]!);
        fist.setFromMatrixPosition(model[rig.index.RightHand!]!);
        return shoulder.distanceTo(fist);
      };
      const reaches = poses.map((_, i) => reachAt(i));
      const peak = reaches.indexOf(Math.max(...reaches));
      const expected = Math.round(impact!.at * (frames - 1));
      // The fist must be near full extension when the hit lands, or the combat
      // system's damage window fires while the arm is still cocked.
      expect(Math.abs(peak - expected), slot).toBeLessThanOrEqual(6);
    }
  });

  it('winds up before it strikes', () => {
    const model: THREE.Matrix4[] = [];
    const shoulder = new THREE.Vector3();
    const fist = new THREE.Vector3();
    const entry = findClip('attack');
    const poses = sampleClip(rig, entry, { frames: 64 });
    const reach = poses.map((pose) => {
      poseToModelMatrices(pose, rig, model);
      shoulder.setFromMatrixPosition(model[rig.index.RightArm!]!);
      fist.setFromMatrixPosition(model[rig.index.RightHand!]!);
      return shoulder.distanceTo(fist);
    });
    const windupIndex = Math.round(0.22 * 63);
    // Anticipation: the fist is CLOSER to the shoulder at the wind-up than at
    // the start. Without it a punch has no weight.
    expect(reach[windupIndex]!).toBeLessThan(reach[0]!);
  });

  it('ends the death clip nearly still, for the ragdoll handover', () => {
    const entry = findClip('death');
    const poses = sampleClip(rig, entry, { frames: 64 });
    const lastDelta = poseAngleDelta(poses[62]!, poses[63]!);
    const midDelta = poseAngleDelta(poses[20]!, poses[21]!);
    // A ragdoll started from a pose that is still moving inherits a velocity
    // the character never had, and kicks.
    expect(lastDelta).toBeLessThan(midDelta * 0.5);
    const ragdoll = entry.def.markers.find((m) => m.name === 'ragdoll');
    expect(ragdoll).toBeDefined();
    // Fired BEFORE the clip ends, so physics gets its blend window inside the
    // animation rather than after it.
    expect(ragdoll!.at).toBeLessThan(0.8);
  });
});

describe('pose buffers', () => {
  it('starts every clip from a distinct pose object', () => {
    const { rig } = heroFixture('saitama');
    const poses = sampleClip(rig, findClip('walk'), { frames: 8 });
    expect(new Set(poses.map((p) => p.rot)).size).toBe(8);
    expect(poses[0]!.boneCount).toBe(rig.boneCount);
    expect(createPose(rig.boneCount).rot.length).toBe(rig.boneCount * 4);
  });
});
