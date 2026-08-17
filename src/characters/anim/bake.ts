/**
 * CLIP BAKING
 *
 * Samples a procedural clip into a fixed array of poses, and from there into
 * either a `THREE.AnimationClip` (for interop) or a VAT texture (for crowds).
 *
 * ── ONE EVALUATOR, THREE CONSUMERS ────────────────────────────────────────
 * The runtime animator, the VAT baker and the unit tests all go through
 * `sampleClip`, so there is exactly one answer to "what does `walk` look like
 * at 40 % of its cycle". Baking through a second, parallel code path is how
 * GPU crowds end up subtly out of step with the hero standing next to them.
 *
 * ── LOCOMOTIVE CLIPS ARE SAMPLED, NOT EVALUATED ───────────────────────────
 * Gaits come out of a stateful solver — the foot locks are world-space, which
 * is the whole point — so a locomotive clip cannot be evaluated at an
 * arbitrary `t`. It is instead simulated forward from a reset at the clip's
 * own reference speed and sampled at fixed intervals. The model-space result
 * is exactly periodic, because everything in it is a function of the cycle
 * phase; the world-space drift lives in the root, which the crowd renderer
 * supplies per instance anyway.
 */

import * as THREE from 'three';
import { blendPoseMasked, copyPose, createPose, upperBodyMask } from './pose';
import { LocomotionSolver } from './locomotion';
import { clipDuration, clipSpeed, defaultClipParams, type ClipEntry } from './clips';
import type { AnimRig, BoneMask, ClipParams, Pose } from './types';

/** How the solver is warmed before sampling a locomotive clip. */
const WARMUP_CYCLES = 4;

/** Options for `sampleClip`. */
export interface SampleOptions {
  readonly params?: ClipParams;
  /** Frames to emit. More frames cost texture memory, not runtime. */
  readonly frames?: number;
  /** Sub-steps per emitted frame while simulating a locomotive clip. */
  readonly substeps?: number;
}

/**
 * Sample one clip into `frames` poses covering exactly one period.
 *
 * The returned poses are freshly allocated; this runs at load time, not per
 * frame.
 */
export function sampleClip(rig: AnimRig, entry: ClipEntry, options: SampleOptions = {}): Pose[] {
  const frames = Math.max(2, options.frames ?? 32);
  const params = options.params ?? defaultClipParams();
  const out: Pose[] = [];
  for (let i = 0; i < frames; i++) out.push(createPose(rig.boneCount));

  if (entry.def.locomotive) {
    sampleLocomotive(rig, entry, params, out, options.substeps ?? 4);
  } else {
    sampleStatic(rig, entry, params, out);
  }
  return out;
}

function sampleStatic(rig: AnimRig, entry: ClipEntry, params: ClipParams, out: Pose[]): void {
  // Non-locomotive clips are authored over a STANDING base so that a clip
  // masked to the upper body still has legs under it when played on its own.
  const solver = new LocomotionSolver(rig);
  const base = createPose(rig.boneCount);
  copyPose(base, rig.rest);
  for (let i = 0; i < 40; i++) {
    copyPose(base, rig.rest);
    solver.update(1 / 60, { speed: 0 }, base);
  }

  const mask = entry.def.region === 'upper' ? upperBodyMask(rig) : undefined;
  const scratch = createPose(rig.boneCount);
  const frames = out.length;
  for (let i = 0; i < frames; i++) {
    const t = entry.def.loop ? i / frames : frames === 1 ? 0 : i / (frames - 1);
    const pose = out[i]!;
    copyPose(pose, base);
    if (mask === undefined) {
      entry.evaluate({ rig, params }, t, pose);
    } else {
      copyPose(scratch, base);
      entry.evaluate({ rig, params }, t, scratch);
      blendPoseMasked(pose, scratch, 1, mask);
    }
  }
}

function sampleLocomotive(
  rig: AnimRig,
  entry: ClipEntry,
  params: ClipParams,
  out: Pose[],
  substeps: number
): void {
  const speed = clipSpeed(entry, rig);
  const solver = new LocomotionSolver(rig);
  const probe = createPose(rig.boneCount);
  copyPose(probe, rig.rest);
  const period = 1 / Math.max(1e-4, solver.update(1e-6, { speed }, probe).solution.cycleFrequency);

  solver.reset(0);
  const frames = out.length;
  const dt = period / (frames * substeps);
  const mask = entry.def.region === 'upper' ? upperBodyMask(rig) : undefined;
  const scratch = createPose(rig.boneCount);

  // Warm up: the first cycle starts from an artificial "both feet just landed"
  // state. Four cycles is well past the point where the locks and the pelvis
  // settle into their steady loop.
  for (let i = 0; i < frames * substeps * WARMUP_CYCLES; i++) {
    copyPose(probe, rig.rest);
    solver.update(dt, { speed }, probe);
  }

  for (let i = 0; i < frames; i++) {
    for (let s = 0; s < substeps; s++) {
      copyPose(probe, rig.rest);
      solver.update(dt, { speed }, probe);
    }
    const pose = out[i]!;
    copyPose(pose, probe);
    if (mask !== undefined) {
      copyPose(scratch, probe);
      entry.evaluate({ rig, params }, i / frames, scratch);
      blendPoseMasked(pose, scratch, 1, mask);
    } else {
      entry.evaluate({ rig, params }, i / frames, pose);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* three.js interop                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Convert sampled poses into a real `THREE.AnimationClip`.
 *
 * `IAnimator` exposes a `THREE.AnimationMixer`, and a mixer with no clips on
 * it would make that field a lie. Baking every slot into a genuine
 * `AnimationClip` means external tooling — an editor, a retargeter, a GLB
 * exporter — sees ordinary three.js animation data and can work with it, even
 * though the runtime evaluates the procedural source directly.
 */
export function toAnimationClip(
  rig: AnimRig,
  name: string,
  poses: readonly Pose[],
  duration: number
): THREE.AnimationClip {
  const frames = poses.length;
  const times = new Float32Array(frames);
  for (let i = 0; i < frames; i++) times[i] = (i / frames) * duration;

  const tracks: THREE.KeyframeTrack[] = [];
  for (let b = 0; b < rig.boneCount; b++) {
    const boneName = rig.bones[b]!.name;
    const quats = new Float32Array(frames * 4);
    let moves = false;
    for (let i = 0; i < frames; i++) {
      const pose = poses[i]!;
      quats[i * 4] = pose.rot[b * 4]!;
      quats[i * 4 + 1] = pose.rot[b * 4 + 1]!;
      quats[i * 4 + 2] = pose.rot[b * 4 + 2]!;
      quats[i * 4 + 3] = pose.rot[b * 4 + 3]!;
      if (
        i > 0 &&
        (quats[i * 4] !== quats[0] ||
          quats[i * 4 + 1] !== quats[1] ||
          quats[i * 4 + 2] !== quats[2] ||
          quats[i * 4 + 3] !== quats[3])
      ) {
        moves = true;
      }
    }
    if (moves || frames === 1) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, quats));
    }

    // Only the root translates in a humanoid clip; emitting 27 constant
    // position tracks would triple the clip size for nothing.
    let translates = false;
    const positions = new Float32Array(frames * 3);
    for (let i = 0; i < frames; i++) {
      const pose = poses[i]!;
      positions[i * 3] = pose.pos[b * 3]!;
      positions[i * 3 + 1] = pose.pos[b * 3 + 1]!;
      positions[i * 3 + 2] = pose.pos[b * 3 + 2]!;
      if (
        i > 0 &&
        (positions[i * 3] !== positions[0] ||
          positions[i * 3 + 1] !== positions[1] ||
          positions[i * 3 + 2] !== positions[2])
      ) {
        translates = true;
      }
    }
    if (translates) {
      tracks.push(new THREE.VectorKeyframeTrack(`${boneName}.position`, times, positions));
    }
  }

  return new THREE.AnimationClip(name, duration, tracks);
}

/** Bake every clip in a list into `AnimationClip`s, keyed by slot:variant. */
export function bakeAnimationClips(
  rig: AnimRig,
  entries: readonly ClipEntry[],
  frames = 24
): Map<string, THREE.AnimationClip> {
  const out = new Map<string, THREE.AnimationClip>();
  for (const entry of entries) {
    const poses = sampleClip(rig, entry, { frames });
    const key = `${entry.def.slot}:${entry.def.variant}`;
    out.set(key, toAnimationClip(rig, key, poses, clipDuration(entry, rig)));
  }
  return out;
}

/** Upper-body mask, cached per rig so callers do not rebuild it per frame. */
export function maskFor(rig: AnimRig, region: 'full' | 'upper' | 'lower'): BoneMask | undefined {
  if (region === 'upper') return upperBodyMask(rig);
  if (region === 'lower') {
    const upper = upperBodyMask(rig);
    const mask = new Float32Array(rig.boneCount);
    for (let i = 0; i < rig.boneCount; i++) mask[i] = 1 - upper[i]!;
    return mask;
  }
  return undefined;
}
