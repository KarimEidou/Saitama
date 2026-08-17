/**
 * MEASUREMENT
 *
 * Everything in this file exists so that claims about the animation can be
 * NUMBERS rather than opinions. Foot sliding in particular is the classic
 * procedural-locomotion failure and the classic procedural-locomotion lie: it
 * is perfectly possible to look at a walk cycle, decide the feet look planted,
 * and be wrong by several centimetres a step. So the planted foot's world
 * position is sampled through the FULL pipeline — solver, IK, forward
 * kinematics, root motion — and its wander is reported in metres.
 *
 * The same applies to the VAT. "Round-trips fine" means the maximum per-vertex
 * disagreement between GPU-path skinning and CPU-path skinning, in metres,
 * separated into the two error sources that behave differently:
 *
 *   QUANTISATION  half-float storage. Constant, tiny, scales with the model's
 *                 size. Fixed by baking float32 if it ever matters.
 *   TEMPORAL      32 baked frames and an element-wise matrix blend standing in
 *                 for a continuous pose. Scales with how fast the clip moves
 *                 and is the number that decides the frame count.
 *
 * Reporting one combined figure would hide which of the two you would have to
 * pay to fix.
 */

import * as THREE from 'three';
import { clamp01, TAU } from '@/util';
import { copyPose, createPose, poseToModelMatrices, skinningMatrices } from './pose';
import { LocomotionSolver } from './locomotion';
import { poseArm, poseLeg, posePelvis } from './posture';
import { sampleClip } from './bake';
import { sampleVatMatrix, type VatBake } from './vat';
import type { ClipEntry } from './clips';
import type { AnimRig, Pose } from './types';

/* -------------------------------------------------------------------------- */
/* Foot sliding                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One planted interval, measured.
 *
 * Split by PIVOT, which is the only decomposition that means anything. A
 * stance has three of them — heel, whole sole, ball — and each is a different
 * material point on the foot. Measuring "the contact point" as one series
 * would record the 22 cm from heel to ball as a slide, when in fact nothing
 * moved: the load simply changed feet, so to speak. Each pivot is therefore
 * tracked over its own window, and the headline figure is the worst of the
 * three.
 */
export interface StanceMeasurement {
  readonly side: 'left' | 'right';
  readonly samples: number;
  /** Horizontal wander of BOTH sole points while the foot is flat, metres.
   *  The strictest test: here the whole foot must be motionless. */
  readonly flatDrift: number;
  /** Horizontal wander of the heel while it is the pivot. */
  readonly heelDrift: number;
  /** Horizontal wander of the ball while it is the pivot. */
  readonly ballDrift: number;
  /** Worst of the three. This is what a viewer would perceive as sliding. */
  readonly contactDrift: number;
  /** Horizontal wander of the ankle across all of stance. Legitimately
   *  non-zero: the foot rolls heel-to-toe, so the ankle travels even though
   *  the contact does not. Reported for context, not as a failure. */
  readonly ankleDrift: number;
  /** Vertical wander of the loaded contact point, metres. */
  readonly verticalDrift: number;
}

/** Aggregate over a run. */
export interface FootSlideReport {
  readonly speed: number;
  readonly stances: readonly StanceMeasurement[];
  readonly maxFlatDrift: number;
  readonly meanFlatDrift: number;
  readonly maxContactDrift: number;
  readonly meanContactDrift: number;
  readonly maxHeelDrift: number;
  readonly maxBallDrift: number;
  readonly maxAnkleDrift: number;
  /** Largest distance the IK failed to cover while a foot was planted. */
  readonly maxStanceSlip: number;
  /** Largest pelvis drop the reach limiter had to apply, metres. */
  readonly maxReachDrop: number;
  /** Stride length the gait settled on, metres. */
  readonly strideLength: number;
  readonly cadence: number;
}

/** Options for `measureFootSlide`. */
export interface FootSlideOptions {
  /** Constant speed, m/s. Ignored when `speedAt` is given. */
  readonly speed?: number;
  /** Time-varying speed, for the acceleration case. */
  readonly speedAt?: (time: number) => number;
  readonly turnRate?: number;
  readonly dt?: number;
  readonly seconds?: number;
  /** Discard this long at the start, while the solver settles. */
  readonly warmup?: number;
}

/**
 * Walk a character and measure how far its planted feet move.
 *
 * The character's root is integrated by the solver at the commanded speed and
 * the pose is resolved to world space exactly as the renderer would, so this
 * measures the shipped path and not a simplified model of it.
 */
export function measureFootSlide(rig: AnimRig, options: FootSlideOptions = {}): FootSlideReport {
  const dt = options.dt ?? 1 / 120;
  const seconds = options.seconds ?? 8;
  const warmup = options.warmup ?? 2.5;
  const solver = new LocomotionSolver(rig);
  const pose = createPose(rig.boneCount);
  const model: THREE.Matrix4[] = [];

  const trackers: Record<'left' | 'right', Tracker> = {
    left: new Tracker('left'),
    right: new Tracker('right'),
  };
  const stances: StanceMeasurement[] = [];
  let maxStanceSlip = 0;
  let maxReachDrop = 0;
  let stride = 0;
  let cadence = 0;

  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    const time = i * dt;
    const speed = options.speedAt ? options.speedAt(time) : (options.speed ?? 1.4);
    copyPose(pose, rig.rest);
    const report = solver.update(dt, { speed, turnRate: options.turnRate }, pose);
    poseToModelMatrices(pose, rig, model);
    stride = report.solution.strideLength;
    cadence = report.solution.cycleFrequency;

    const settled = time >= warmup;
    if (settled) maxReachDrop = Math.max(maxReachDrop, report.reachDrop);

    for (const side of ['left', 'right'] as const) {
      const foot = side === 'left' ? report.left : report.right;
      const tracker = trackers[side];
      const bone = rig.index[side === 'left' ? 'LeftFoot' : 'RightFoot'];
      if (bone === undefined) continue;

      if (foot.phase !== 'stance') {
        const finished = tracker.close();
        if (finished !== undefined && settled) stances.push(finished);
        continue;
      }
      if (settled) maxStanceSlip = Math.max(maxStanceSlip, foot.slip);

      const matrix = model[bone]!;
      // Sole points in the foot bone's own frame. The bind rotation is
      // identity and the bone sits at the ankle, so these are literal offsets.
      _heelLocal.set(0, -rig.metrics.ankleHeight, rig.metrics.heelBack);
      _ballLocal.set(0, -rig.metrics.ankleHeight, -rig.metrics.footForward);
      _ankleModel.setFromMatrixPosition(matrix);
      _heelModel.copy(_heelLocal).applyMatrix4(matrix);
      _ballModel.copy(_ballLocal).applyMatrix4(matrix);

      solver.modelToWorld(_ankleModel, _ankleWorld);
      solver.modelToWorld(_heelModel, _heelWorld);
      solver.modelToWorld(_ballModel, _contactWorld);
      tracker.add(foot.pitch, _ankleWorld, _heelWorld, _contactWorld);
    }
  }
  for (const side of ['left', 'right'] as const) {
    const finished = trackers[side].close();
    if (finished !== undefined) stances.push(finished);
  }

  const flat = stances.map((s) => s.flatDrift);
  const contact = stances.map((s) => s.contactDrift);
  return {
    speed: options.speed ?? 0,
    stances,
    maxFlatDrift: max(flat),
    meanFlatDrift: mean(flat),
    maxContactDrift: max(contact),
    meanContactDrift: mean(contact),
    maxHeelDrift: max(stances.map((s) => s.heelDrift)),
    maxBallDrift: max(stances.map((s) => s.ballDrift)),
    maxAnkleDrift: max(stances.map((s) => s.ankleDrift)),
    maxStanceSlip,
    maxReachDrop,
    strideLength: stride,
    cadence,
  };
}

/**
 * Pitch band, in radians, inside which the foot counts as flat.
 *
 * The pivot is selected by the foot's ACTUAL pitch rather than by a fraction
 * of stance, because which point is loaded depends on the pitch and not on the
 * clock: a runner's forefoot strike never loads the heel at all, so charging
 * the airborne heel's motion to "slide" would be measuring the wrong point
 * entirely.
 */
const FLAT_BAND = 0.02;

/** Bounding-box diagonal of a set of points, per axis group. */
class Tracker {
  private readonly side: 'left' | 'right';
  private ankle: Bounds = new Bounds();
  private contact: Bounds = new Bounds();
  private flatHeel: Bounds = new Bounds();
  private flatBall: Bounds = new Bounds();
  private heel: Bounds = new Bounds();
  private ball: Bounds = new Bounds();
  private samples = 0;

  constructor(side: 'left' | 'right') {
    this.side = side;
  }

  add(pitch: number, ankle: THREE.Vector3, heel: THREE.Vector3, ball: THREE.Vector3): void {
    this.samples++;
    this.ankle.add(ankle);
    this.contact.add(heel.y <= ball.y ? heel : ball);
    // Only the LOADED point is graded. Toes up, the heel carries the weight
    // and the ball is in the air; toes down, the reverse; flat, both are down
    // and both must hold still.
    if (pitch > FLAT_BAND) {
      this.heel.add(heel);
    } else if (pitch < -FLAT_BAND) {
      this.ball.add(ball);
    } else {
      // Two separate bounds, not one: pooling the heel and the ball would
      // record the fixed 22 cm between them as motion.
      this.flatHeel.add(heel);
      this.flatBall.add(ball);
    }
  }

  close(): StanceMeasurement | undefined {
    if (this.samples < 8) {
      this.reset();
      return undefined;
    }
    const flatDrift = Math.max(this.flatHeel.horizontalSpan(), this.flatBall.horizontalSpan());
    const heelDrift = this.heel.horizontalSpan();
    const ballDrift = this.ball.horizontalSpan();
    const result: StanceMeasurement = {
      side: this.side,
      samples: this.samples,
      flatDrift,
      heelDrift,
      ballDrift,
      contactDrift: Math.max(flatDrift, heelDrift, ballDrift),
      ankleDrift: this.ankle.horizontalSpan(),
      verticalDrift: this.contact.verticalSpan(),
    };
    this.reset();
    return result;
  }

  private reset(): void {
    this.ankle = new Bounds();
    this.contact = new Bounds();
    this.flatHeel = new Bounds();
    this.flatBall = new Bounds();
    this.heel = new Bounds();
    this.ball = new Bounds();
    this.samples = 0;
  }
}

class Bounds {
  private minX = Infinity;
  private maxX = -Infinity;
  private minY = Infinity;
  private maxY = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;

  add(v: THREE.Vector3): void {
    if (v.x < this.minX) this.minX = v.x;
    if (v.x > this.maxX) this.maxX = v.x;
    if (v.y < this.minY) this.minY = v.y;
    if (v.y > this.maxY) this.maxY = v.y;
    if (v.z < this.minZ) this.minZ = v.z;
    if (v.z > this.maxZ) this.maxZ = v.z;
  }

  horizontalSpan(): number {
    if (this.minX === Infinity) return 0;
    return Math.hypot(this.maxX - this.minX, this.maxZ - this.minZ);
  }

  verticalSpan(): number {
    return this.minY === Infinity ? 0 : this.maxY - this.minY;
  }
}

/* -------------------------------------------------------------------------- */
/* The control: what a naive procedural walk does                             */
/* -------------------------------------------------------------------------- */

/**
 * The textbook bad walk, measured the same way.
 *
 * Sinusoidal hip and knee angles at a hand-picked amplitude, no IK, no foot
 * lock — the version that appears in every "procedural walk in 50 lines"
 * article. It is here as a CONTROL: a foot-slide number is only meaningful
 * next to what the problem looks like unsolved, and the ratio between the two
 * is the actual result this workstream is claiming.
 */
export function measureNaiveFootSlide(rig: AnimRig, speed = 1.4, seconds = 8): FootSlideReport {
  const dt = 1 / 120;
  const m = rig.metrics;
  const pose = createPose(rig.boneCount);
  const model: THREE.Matrix4[] = [];
  const solver = new LocomotionSolver(rig);
  const gait = solver.update(1e-6, { speed }, pose).solution;
  const frequency = gait.cycleFrequency;
  const swing = 0.45;

  const trackers: Record<'left' | 'right', Tracker> = {
    left: new Tracker('left'),
    right: new Tracker('right'),
  };
  const stances: StanceMeasurement[] = [];
  const root = new THREE.Vector3();
  const steps = Math.round(seconds / dt);

  for (let i = 0; i < steps; i++) {
    const time = i * dt;
    const phase = (time * frequency) % 1;
    root.z -= speed * dt;
    copyPose(pose, rig.rest);
    posePelvis(pose, rig, 0, m.hipHeight - m.legLength * 0.02, 0, 0.05);
    for (const side of [-1, 1] as const) {
      const p = side > 0 ? phase : (phase + 0.5) % 1;
      const hip = Math.cos(TAU * p) * swing;
      const knee = Math.max(0, Math.sin(TAU * p + 1.1)) * 0.9;
      poseLeg(pose, rig, side, { flex: hip, knee, ankle: -hip * 0.3, abduct: 0.04 });
      poseArm(pose, rig, side, { abduct: 0.12, elbow: 0.3, flex: -Math.cos(TAU * p) * 0.3 });
    }
    poseToModelMatrices(pose, rig, model);

    for (const side of ['left', 'right'] as const) {
      const bone = rig.index[side === 'left' ? 'LeftFoot' : 'RightFoot'];
      if (bone === undefined) continue;
      const p = side === 'right' ? phase : (phase + 0.5) % 1;
      // "Stance" for the naive walk is simply the half-cycle when the foot is
      // behind the hip. There is no plant to detect, which is the point.
      const inStance = p < 0.5;
      if (!inStance) {
        const finished = trackers[side].close();
        if (finished !== undefined && time > 1.5) stances.push(finished);
        continue;
      }
      const matrix = model[bone]!;
      _heelLocal.set(0, -m.ankleHeight, m.heelBack);
      _ballLocal.set(0, -m.ankleHeight, -m.footForward);
      _ankleModel.setFromMatrixPosition(matrix);
      _heelModel.copy(_heelLocal).applyMatrix4(matrix);
      _ballModel.copy(_ballLocal).applyMatrix4(matrix);
      _ankleWorld.copy(_ankleModel).add(root);
      _heelWorld.copy(_heelModel).add(root);
      _contactWorld.copy(_ballModel).add(root);
      // Same pitch the naive pose function applied, so the control is graded
      // by exactly the same pivot rule as the real solver.
      trackers[side].add(-Math.cos(TAU * p) * swing * 0.3, _ankleWorld, _heelWorld, _contactWorld);
    }
  }

  const flat = stances.map((s) => s.flatDrift);
  const contact = stances.map((s) => s.contactDrift);
  return {
    speed,
    stances,
    maxFlatDrift: max(flat),
    meanFlatDrift: mean(flat),
    maxContactDrift: max(contact),
    meanContactDrift: mean(contact),
    maxHeelDrift: max(stances.map((s) => s.heelDrift)),
    maxBallDrift: max(stances.map((s) => s.ballDrift)),
    maxAnkleDrift: max(stances.map((s) => s.ankleDrift)),
    maxStanceSlip: 0,
    maxReachDrop: 0,
    strideLength: gait.strideLength,
    cadence: frequency,
  };
}

/* -------------------------------------------------------------------------- */
/* Limb sanity                                                                */
/* -------------------------------------------------------------------------- */

/** Bone-length and joint-limit check over a whole run. */
export interface LimbReport {
  /** Largest relative change in any bone's length. Rotation-only animation
   *  must keep this at floating-point zero. */
  readonly maxLengthError: number;
  /** Largest knee flexion seen, radians. Over PI means the knee inverted. */
  readonly maxKneeFlexion: number;
  /** Lowest point of either sole below the ground plane, metres. */
  readonly maxGroundPenetration: number;
  /** Highest the pelvis rose above its bind height, metres. */
  readonly maxPelvisRise: number;
  readonly frames: number;
}

/**
 * Prove nothing explodes.
 *
 * The failure this catches on extreme proportions is not subtle — a leg that
 * cannot reach produces either a stretched bone or an inverted knee — but both
 * are easy to miss at a glance and impossible to miss in a number.
 */
export function measureLimbSanity(
  rig: AnimRig,
  speeds: readonly number[],
  seconds = 4
): LimbReport {
  const dt = 1 / 120;
  const pose = createPose(rig.boneCount);
  const model: THREE.Matrix4[] = [];
  let maxLengthError = 0;
  let maxKneeFlexion = 0;
  let maxGroundPenetration = 0;
  let maxPelvisRise = 0;
  let frames = 0;

  for (const speed of speeds) {
    const solver = new LocomotionSolver(rig);
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) {
      copyPose(pose, rig.rest);
      const report = solver.update(dt, { speed }, pose);
      poseToModelMatrices(pose, rig, model);
      frames++;

      for (let b = 0; b < rig.boneCount; b++) {
        const parent = rig.parent[b]!;
        if (parent < 0) continue;
        _a.setFromMatrixPosition(model[b]!);
        _b.setFromMatrixPosition(model[parent]!);
        const rest = Math.hypot(
          rig.rest.pos[b * 3]!,
          rig.rest.pos[b * 3 + 1]!,
          rig.rest.pos[b * 3 + 2]!
        );
        if (rest < 1e-6) continue;
        maxLengthError = Math.max(maxLengthError, Math.abs(_a.distanceTo(_b) - rest) / rest);
      }

      for (const side of ['Left', 'Right'] as const) {
        const knee = rig.index[`${side}Leg`];
        if (knee !== undefined) {
          _q.setFromRotationMatrix(_m.identity());
          const o = knee * 4;
          _q.set(pose.rot[o]!, pose.rot[o + 1]!, pose.rot[o + 2]!, pose.rot[o + 3]!);
          maxKneeFlexion = Math.max(maxKneeFlexion, 2 * Math.acos(Math.min(1, Math.abs(_q.w))));
        }
        const foot = rig.index[`${side}Foot`];
        if (foot !== undefined) {
          _heelLocal.set(0, -rig.metrics.ankleHeight, rig.metrics.heelBack);
          _ballLocal.set(0, -rig.metrics.ankleHeight, -rig.metrics.footForward);
          _heelModel.copy(_heelLocal).applyMatrix4(model[foot]!);
          _ballModel.copy(_ballLocal).applyMatrix4(model[foot]!);
          const lowest = Math.min(_heelModel.y, _ballModel.y);
          if (lowest < 0) maxGroundPenetration = Math.max(maxGroundPenetration, -lowest);
        }
      }
      maxPelvisRise = Math.max(maxPelvisRise, report.pelvisY - rig.rest.pos[rig.index.Hips! * 3 + 1]!);
    }
  }

  return { maxLengthError, maxKneeFlexion, maxGroundPenetration, maxPelvisRise, frames };
}

/* -------------------------------------------------------------------------- */
/* VAT fidelity                                                               */
/* -------------------------------------------------------------------------- */

/** Skinned-vertex agreement between the CPU and the texture path. */
export interface VatErrorReport {
  /** Per-vertex error from texture STORAGE alone, at exact frame times. */
  readonly quantisationMax: number;
  readonly quantisationRms: number;
  /** Per-vertex error from frame-rate discretisation plus the element-wise
   *  matrix blend, sampled between frames. The number that decides how many
   *  frames a clip needs. */
  readonly temporalMax: number;
  readonly temporalRms: number;
  readonly vertices: number;
  readonly samples: number;
}

/** Geometry the round-trip needs, as plain arrays. */
export interface SkinnedGeometryData {
  readonly position: Float32Array;
  readonly skinIndex: ArrayLike<number>;
  readonly skinWeight: ArrayLike<number>;
}

/**
 * Compare skinning through the VAT with skinning from the exact pose.
 *
 * Both halves use the same vertex data and the same weights, so the only
 * differences are the two the test is trying to isolate.
 */
export function measureVatRoundTrip(
  rig: AnimRig,
  bake: VatBake,
  entry: ClipEntry,
  clipIndex: number,
  geometry: SkinnedGeometryData,
  options: { readonly stride?: number; readonly subSamples?: number } = {}
): VatErrorReport {
  const stride = Math.max(1, options.stride ?? 7);
  const subSamples = Math.max(1, options.subSamples ?? 4);
  const clip = bake.clips[clipIndex]!;
  const vertexCount = geometry.position.length / 3;

  const exact = sampleClip(rig, entry, { frames: clip.frames });
  const dense = sampleClip(rig, entry, { frames: clip.frames * subSamples });

  const model: THREE.Matrix4[] = [];
  const skin: THREE.Matrix4[] = [];

  let quantMax = 0;
  let quantSum = 0;
  let temporalMax = 0;
  let temporalSum = 0;
  let quantCount = 0;
  let temporalCount = 0;

  const measure = (
    pose: Pose,
    frameTime: number,
    onError: (error: number) => void
  ): void => {
    poseToModelMatrices(pose, rig, model);
    skinningMatrices(model, rig.boneInverses, skin);
    for (let v = 0; v < vertexCount; v += stride) {
      _truth.set(0, 0, 0);
      _test.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const weight = geometry.skinWeight[v * 4 + k]!;
        if (weight === 0) continue;
        const bone = geometry.skinIndex[v * 4 + k]!;
        _p.set(
          geometry.position[v * 3]!,
          geometry.position[v * 3 + 1]!,
          geometry.position[v * 3 + 2]!
        );
        _q0.copy(_p).applyMatrix4(skin[bone]!);
        _truth.addScaledVector(_q0, weight);
        sampleVatMatrix(bake, clipIndex, frameTime, bone, _m);
        _q0.copy(_p).applyMatrix4(_m);
        _test.addScaledVector(_q0, weight);
      }
      onError(_truth.distanceTo(_test));
    }
  };

  for (let f = 0; f < clip.frames; f++) {
    measure(exact[f]!, f, (error) => {
      quantMax = Math.max(quantMax, error);
      quantSum += error * error;
      quantCount++;
    });
  }

  for (let i = 0; i < dense.length; i++) {
    const frameTime = i / subSamples;
    measure(dense[i]!, frameTime, (error) => {
      temporalMax = Math.max(temporalMax, error);
      temporalSum += error * error;
      temporalCount++;
    });
  }

  return {
    quantisationMax: quantMax,
    quantisationRms: Math.sqrt(quantSum / Math.max(1, quantCount)),
    temporalMax,
    temporalRms: Math.sqrt(temporalSum / Math.max(1, temporalCount)),
    vertices: Math.ceil(vertexCount / stride),
    samples: temporalCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Gait profiling                                                             */
/* -------------------------------------------------------------------------- */

/** One row of the cadence/stride table. */
export interface GaitRow {
  readonly speed: number;
  readonly normalisedSpeed: number;
  readonly gait: string;
  readonly cadence: number;
  readonly stepsPerMinute: number;
  readonly strideLength: number;
  readonly strideRatio: number;
  readonly duty: number;
}

/** Tabulate the gait model across a speed sweep. Used by tests and the harness. */
export function gaitProfile(rig: AnimRig, speeds: readonly number[]): GaitRow[] {
  const solver = new LocomotionSolver(rig);
  const pose = createPose(rig.boneCount);
  return speeds.map((speed) => {
    copyPose(pose, rig.rest);
    const g = solver.update(1e-6, { speed }, pose).solution;
    return {
      speed,
      normalisedSpeed: g.normalisedSpeed,
      gait: g.gait,
      cadence: g.cycleFrequency,
      stepsPerMinute: g.cycleFrequency * 120,
      strideLength: g.strideLength,
      strideRatio: g.strideLength / rig.metrics.legLength,
      duty: g.duty,
    };
  });
}

/**
 * Poses at N evenly spaced phases of one gait cycle.
 *
 * Feeds the walk-cycle contact sheet — the picture a human actually judges the
 * gait from, and the one place where a number cannot substitute.
 */
export function sampleGaitPhases(
  rig: AnimRig,
  speed: number,
  phases: number,
  solverOut?: { solver?: LocomotionSolver }
): { poses: Pose[]; rootZ: number[] } {
  const solver = new LocomotionSolver(rig);
  const pose = createPose(rig.boneCount);
  const probe = solver.update(1e-6, { speed }, pose).solution;
  const period = 1 / Math.max(1e-4, probe.cycleFrequency);
  const substeps = 8;
  const dt = period / (phases * substeps);

  solver.reset(0);
  for (let i = 0; i < phases * substeps * 4; i++) {
    copyPose(pose, rig.rest);
    solver.update(dt, { speed }, pose);
  }

  // Capture before advancing, so phase i is exactly i / phases.
  const poses: Pose[] = [];
  const rootZ: number[] = [];
  for (let i = 0; i < phases; i++) {
    poses.push(copyPose(createPose(rig.boneCount), pose));
    rootZ.push(solver.rootPosition.z);
    for (let s = 0; s < substeps; s++) {
      copyPose(pose, rig.rest);
      solver.update(dt, { speed }, pose);
    }
  }
  if (solverOut) solverOut.solver = solver;
  return { poses, rootZ };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function max(values: readonly number[]): number {
  let out = 0;
  for (const value of values) if (value > out) out = value;
  return out;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** 0..1 progress through a stance, clamped. Exported for harness overlays. */
export function stanceProgress(progress: number): number {
  return clamp01(progress);
}

const _heelLocal = new THREE.Vector3();
const _ballLocal = new THREE.Vector3();
const _heelModel = new THREE.Vector3();
const _ballModel = new THREE.Vector3();
const _ankleModel = new THREE.Vector3();
const _ankleWorld = new THREE.Vector3();
const _heelWorld = new THREE.Vector3();
const _contactWorld = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _truth = new THREE.Vector3();
const _test = new THREE.Vector3();
const _q0 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
