/**
 * PROCEDURAL LOCOMOTION
 *
 * Walk, jog and run are generated from ground speed and measured body
 * dimensions. There are no keyframes, and there is no blend tree — the three
 * "gaits" are three tunings of one continuous model, so blending between them
 * is arithmetic on the parameters rather than a crossfade between clips, and
 * the result is phase-coherent by construction.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  1. THE GAIT MODEL IS DIMENSIONLESS
 *
 *  Speed is normalised as the Froude number's square root,
 *
 *      u = v / sqrt(g · L)          L = measured hip-to-ankle length
 *
 *  and every gait parameter is a function of u alone. This is not decoration:
 *  it is the only reason one implementation covers a 1.22 m child and a
 *  2.45 m monster. Legs are pendulums, so cadence goes as sqrt(g/L) and stride
 *  goes as L·sqrt(u). Scale a human walk cycle by height instead and the child
 *  minces while the monster wades — both take the same number of steps per
 *  second as the adult they were scaled from, which is the single most common
 *  tell in a game with mixed body sizes.
 *
 *      stride / L  = 2.20 · u^0.49       fitted to walk, run and sprint data
 *      duty factor = 0.42 · u^-0.51      stance fraction; < 0.5 implies flight
 *
 *  At u = 0.46 (an adult at 1.4 m/s) that gives a 1.40 m stride at 1.0 Hz —
 *  120 steps/min, 62 % stance. Those are the textbook numbers, and they fall
 *  out of the formula rather than being typed in.
 *
 *  2. FEET ARE PINNED IN WORLD SPACE, NOT ANIMATED IN MODEL SPACE
 *
 *  At touchdown the foot's contact point is written into WORLD space and the
 *  IK chases that world position for the whole of stance. Nothing about the
 *  foot is a function of the animation clock while it is planted, so changing
 *  speed, turning, or dropping frames cannot make it slide: model-space
 *  backward drift is whatever the root actually did, exactly.
 *
 *  The alternative — animating the foot backwards at the current speed —
 *  slides the instant the speed changes mid-stance, which is most of the time
 *  in a game with acceleration. That artefact is what this design exists to
 *  remove, and `analysis.ts` measures the residual rather than trusting it.
 *
 *  3. THE FOOT ROLLS OVER THREE PIVOTS
 *
 *  Heel strike → foot flat → toe off, pivoting on the heel, then nothing,
 *  then the ball. Each phase has an exactly stationary world pivot and the
 *  ankle is derived from it, so the roll is continuous at both handovers
 *  (the foot is flat at each, so the two pivots agree). The roll is what
 *  makes the geometry work: it lets the ankle stay inside the leg's reach at
 *  both extremes of a stride that is longer than the leg.
 *
 *  4. THE PELVIS HEIGHT IS DERIVED, NOT AUTHORED
 *
 *  Authored bounce is a wish. After it is applied, the pelvis is lowered by
 *  exactly as much as the stance leg's reach demands. A stride too long for
 *  the leg therefore produces a crouch instead of a snapped-straight leg and
 *  a sliding foot — which is what a person does too, and it is what keeps
 *  extreme body proportions from exploding.
 * ══════════════════════════════════════════════════════════════════════════
 */

import * as THREE from 'three';
import type { BoneName } from '@/types';
import { clamp, clamp01, lerp, mod, smootherstep, smoothstep, TAU } from '@/util';
import { makeChain, setModelRotation, solveChain, type IKChain } from './ik';
import { poseToModelMatrices, rotateBone, setRotation } from './pose';
import type {
  AnimRig,
  FootPhase,
  FootReport,
  GaitName,
  GaitSolution,
  LocomotionInput,
  LocomotionReport,
  Pose,
} from './types';

const GRAVITY = 9.81;

/* -------------------------------------------------------------------------- */
/* Gait model                                                                 */
/* -------------------------------------------------------------------------- */

/** Stride length as a multiple of leg length: `C · u^K`. */
const STRIDE_C = 2.2;
const STRIDE_K = 0.49;
/** Stance fraction of the cycle: `C · u^-K`, clamped. */
const DUTY_C = 0.42;
const DUTY_K = 0.51;
const DUTY_MIN = 0.22;
const DUTY_MAX = 0.7;

/** Normalised speeds bracketing the walk→run transition. */
const U_WALK = 0.62;
const U_RUN = 1.3;
/** Below this normalised speed the character is standing. */
const U_STAND = 0.06;

/** Cadence bounds in units of `sqrt(g / L)`, so they scale with the body. */
const CADENCE_MIN = 0.09;
const CADENCE_MAX = 1.35;

/**
 * Solve every gait parameter for a speed and a body.
 *
 * Pure — no state, no allocation beyond the returned record. The clip baker
 * and the VAT baker both call it directly.
 */
export function solveGait(speed: number, legLength: number): GaitSolution {
  const L = Math.max(legLength, 0.05);
  const pendulum = Math.sqrt(GRAVITY / L);
  const v = Math.max(speed, 0);
  const u = v / Math.sqrt(GRAVITY * L);

  const activity = smoothstep(U_STAND * 0.5, U_STAND * 4, u);
  const runBlend = smoothstep(U_WALK, U_RUN, u);

  let cycleFrequency: number;
  let strideLength: number;
  if (u <= 1e-4) {
    cycleFrequency = CADENCE_MIN * pendulum;
    strideLength = 0;
  } else {
    strideLength = STRIDE_C * Math.pow(u, STRIDE_K) * L;
    cycleFrequency = clamp(v / strideLength, CADENCE_MIN * pendulum, CADENCE_MAX * pendulum);
    // Re-derive the stride from the clamped cadence so `v = stride · freq`
    // stays exact. Foot planting depends on that identity holding.
    strideLength = v / cycleFrequency;
  }

  const duty = clamp(
    u <= 1e-4 ? DUTY_MAX : DUTY_C * Math.pow(u, -DUTY_K),
    DUTY_MIN,
    DUTY_MAX
  );
  const excursion = duty * strideLength;

  const gait: GaitName =
    u < U_STAND * 4 ? 'stand' : u < U_WALK * 1.1 ? 'walk' : u < U_RUN ? 'jog' : 'run';

  return {
    gait,
    speed: v,
    normalisedSpeed: u,
    cycleFrequency,
    strideLength,
    duty,
    excursion,
    swingLift: L * lerp(0.1, 0.3, runBlend) * activity,
    activity,
    runBlend,
  };
}

/* -------------------------------------------------------------------------- */
/* Style constants                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fraction of the foot's stance excursion that sits AHEAD of the hip.
 *
 * Deliberately below half. The leg's reach is the binding constraint at both
 * ends of stance, but not symmetrically: at heel strike the knee is nearly
 * straight and the ankle is low, while at toe-off the foot is plantar-flexed
 * and the ankle rides high on the ball, which buys back reach. Biasing the
 * stance window rearward equalises the two demands, and equalising them is
 * what keeps the pelvis drop small enough that the walk does not read as a
 * crouch. Real gait is asymmetric for exactly this reason.
 */
const FRONT_FRACTION = 0.33;
/** Foot-flat window inside stance, as fractions of stance progress. */
const ROLL_HEEL_END = 0.18;
const ROLL_TOE_START = 0.55;
/** Ankle pitch at heel strike (toes up) and at toe-off (toes down), radians. */
const HEEL_STRIKE_PITCH = 0.16;
const TOE_OFF_PITCH = -0.68;
/** Step width as a fraction of hip half-width, walking then running. */
const STANCE_WIDTH_WALK = 0.66;
const STANCE_WIDTH_RUN = 0.24;
/** Leg extension ceiling. Never fully straight; a locked knee reads as a stilt. */
const MAX_EXTENSION = 0.985;
/** Deepest the reach limiter may sink the pelvis, as a fraction of leg length. */
const MAX_CROUCH = 0.17;
/** How far a planted foot's heading may lag the body's before it lets go. */
const FOOT_YAW_LIMIT = 0.62;

/* -------------------------------------------------------------------------- */
/* Per-foot state                                                             */
/* -------------------------------------------------------------------------- */

interface FootState {
  readonly side: 'left' | 'right';
  readonly sign: number;
  phase: FootPhase;
  progress: number;
  /** World position of the HEEL contact, locked at touchdown. */
  readonly plantWorld: THREE.Vector3;
  /** Yaw the character had at touchdown, so the footprint keeps its heading. */
  plantYaw: number;
  /** World position the lift-off ankle occupied, so swing drift is exact. */
  readonly liftWorld: THREE.Vector3;
  pitch: number;
  slip: number;
  /** How far `clampTargets` had to pull this foot's target in, metres. */
  clamped: number;
  /** Bones. */
  chain: IKChain;
  footBone: number;
  toeBone: number;
}

/* -------------------------------------------------------------------------- */
/* Solver                                                                     */
/* -------------------------------------------------------------------------- */

/** Construction options. */
export interface LocomotionOptions {
  /** Starting cycle phase, 0..1. Give crowds different values. */
  readonly phase?: number;
  /** Multiplies every authored amplitude. Crowd variety without new code. */
  readonly vigour?: number;
}

/**
 * Stateful gait generator for one character.
 *
 * Owns the cycle phase and the two foot locks. Everything else is recomputed
 * from scratch each frame, so a reset plus an identical input sequence
 * reproduces an identical pose sequence — which is what the determinism test
 * asserts and what makes the VAT baker's output stable.
 */
export class LocomotionSolver {
  readonly rig: AnimRig;
  /** Cycle phase, 0..1. Phase 0 is right-foot touchdown. */
  phase: number;
  /** Virtual root, integrated when the caller does not supply one. */
  readonly rootPosition = new THREE.Vector3();
  rootYaw = 0;
  /** Multiplies authored amplitudes. */
  vigour: number;

  private readonly left: FootState;
  private readonly right: FootState;
  private readonly model: THREE.Matrix4[] = [];
  private readonly initialPhase: number;
  private solution: GaitSolution;
  private reachDrop = 0;
  private pelvisY = 0;
  /** Set when a foot touched down this frame; drained by the animator. */
  private touchdowns: Array<{ side: 'left' | 'right'; strength: number }> = [];

  constructor(rig: AnimRig, options: LocomotionOptions = {}) {
    this.rig = rig;
    this.initialPhase = options.phase ?? 0;
    this.phase = this.initialPhase;
    this.vigour = options.vigour ?? 1;
    this.left = this.makeFoot('left', -1);
    this.right = this.makeFoot('right', 1);
    this.solution = solveGait(0, rig.metrics.legLength);
    for (let i = 0; i < rig.boneCount; i++) this.model.push(new THREE.Matrix4());
  }

  private makeFoot(side: 'left' | 'right', sign: number): FootState {
    const rig = this.rig;
    const prefix = side === 'left' ? 'Left' : 'Right';
    const hip = rig.index[`${prefix}UpLeg` as BoneName] ?? 0;
    const knee = rig.index[`${prefix}Leg` as BoneName] ?? 0;
    const ankle = rig.index[`${prefix}Foot` as BoneName] ?? 0;
    const toe = rig.index[`${prefix}ToeBase` as BoneName] ?? ankle;
    return {
      side,
      sign,
      phase: 'swing',
      progress: 0,
      plantWorld: new THREE.Vector3(),
      plantYaw: 0,
      liftWorld: new THREE.Vector3(),
      pitch: 0,
      slip: 0,
      clamped: 0,
      // A knee folds BACKWARDS: negative rotation about the bone's local X.
      // The rig rests with identity rotations, so local X is the character's
      // medio-lateral axis and that sign holds for both legs (mirroring across
      // the YZ plane preserves rotations about X).
      chain: makeChain(rig, hip, knee, ankle, _X_AXIS, -1),
      footBone: ankle,
      toeBone: toe,
    };
  }

  /** Return to the constructed state. Determinism starts here. */
  reset(phase = this.initialPhase): void {
    this.phase = phase;
    this.rootPosition.set(0, 0, 0);
    this.rootYaw = 0;
    this.reachDrop = 0;
    for (const foot of [this.left, this.right]) {
      foot.phase = 'swing';
      foot.progress = 0;
      foot.plantWorld.set(0, 0, 0);
      foot.plantYaw = 0;
      foot.liftWorld.set(0, 0, 0);
      foot.pitch = 0;
      foot.slip = 0;
      foot.clamped = 0;
    }
    this.touchdowns = [];
  }

  /** Place the virtual root explicitly, e.g. from an entity transform. */
  setRoot(position: THREE.Vector3, yaw: number): void {
    this.rootPosition.copy(position);
    this.rootYaw = yaw;
  }

  /** Touchdowns since the last call. Drained. */
  drainTouchdowns(): Array<{ side: 'left' | 'right'; strength: number }> {
    const events = this.touchdowns;
    this.touchdowns = [];
    return events;
  }

  /**
   * Advance one frame and write the locomotion pose.
   *
   * `pose` must already hold the rest pose; the solver overwrites the bones it
   * owns and leaves the rest for the clip layer.
   */
  update(dt: number, input: LocomotionInput, pose: Pose, integrateRoot = true): LocomotionReport {
    const rig = this.rig;
    const m = rig.metrics;
    const solution = solveGait(input.speed, m.legLength);
    this.solution = solution;
    const grounded = input.grounded ?? true;
    const groundY = input.groundY ?? 0;
    const turnRate = input.turnRate ?? 0;

    if (integrateRoot) {
      this.rootYaw += turnRate * dt;
      // Forward is -Z, so the world step follows the yawed forward axis.
      const forwardX = -Math.sin(this.rootYaw);
      const forwardZ = -Math.cos(this.rootYaw);
      this.rootPosition.x += forwardX * input.speed * dt;
      this.rootPosition.z += forwardZ * input.speed * dt;
    }

    if (grounded) this.phase = mod(this.phase + solution.cycleFrequency * dt, 1);

    this.authorPelvisAndSpine(pose, solution, input);
    poseToModelMatrices(pose, rig, this.model);

    // Ankle targets first, THEN the pelvis reach correction, THEN the IK:
    // the correction needs to know where the feet are going before it can
    // decide how far the pelvis has to drop to keep them reachable.
    this.resolveFoot(this.left, solution, input, groundY, grounded);
    this.resolveFoot(this.right, solution, input, groundY, grounded);
    this.applyReachLimit(pose);
    this.clampTargets();

    this.solveLeg(pose, this.left);
    this.solveLeg(pose, this.right);

    return {
      solution,
      phase: this.phase,
      left: this.report(this.left),
      right: this.report(this.right),
      reachDrop: this.reachDrop,
      pelvisY: this.pelvisY,
    };
  }

  /** Current gait solution, for callers that need it without re-solving. */
  get gait(): GaitSolution {
    return this.solution;
  }

  private report(foot: FootState): FootReport {
    return {
      side: foot.side,
      phase: foot.phase,
      progress: foot.progress,
      plantWorld: foot.plantWorld,
      slip: foot.slip,
      pitch: foot.pitch,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Pelvis, spine, arms                                                */
  /* ------------------------------------------------------------------ */

  private authorPelvisAndSpine(pose: Pose, g: GaitSolution, input: LocomotionInput): void {
    const rig = this.rig;
    const m = rig.metrics;
    const p = this.phase;
    const a = g.activity * this.vigour;
    const run = g.runBlend;
    const slouch = clamp01(input.slouch ?? 0);
    const turn = input.turnRate ?? 0;

    // --- Pelvis height -----------------------------------------------------
    // Walking is an inverted pendulum: highest at mid-stance. Running is a
    // spring: LOWEST at mid-stance, highest at mid-flight. The phase inverts
    // across the transition, which is why the two terms carry opposite signs
    // and why the vertical travel passes through a minimum near the walk→run
    // boundary — a real and slightly odd-looking property of real gait.
    const bounceWalk = -Math.cos(4 * Math.PI * (p - 0.09)) * (1 - run);
    const bounceRun = Math.cos(4 * Math.PI * p) * run;
    // Modest authored amplitude: most of a walk's pelvis dip is not styling,
    // it is the geometric consequence of the legs splaying at double support,
    // and `applyReachLimit` produces that part for free. Authoring the full
    // travel here and then adding the geometric drop on top gives a bouncing
    // walk — a common and very visible procedural-animation smell.
    const bounceAmplitude = m.legLength * lerp(0.028, 0.075, run) * a;
    const crouch = m.legLength * (lerp(0.012, 0.05, run) * a + 0.03 * slouch);
    const authoredY = m.hipHeight - crouch + (bounceWalk + bounceRun) * bounceAmplitude;

    // --- Pelvis lateral sway, toward the stance foot ----------------------
    const sway = Math.sin(TAU * p) * m.legLength * lerp(0.042, 0.012, run) * a;
    // Banking into a turn: lean the whole body toward the inside of the arc.
    const bank = clamp(turn * lerp(0.1, 0.26, run), -0.35, 0.35);

    const hips = rig.index.Hips;
    if (hips !== undefined) {
      const o = hips * 3;
      pose.pos[o] = rig.rest.pos[o]! + sway;
      pose.pos[o + 1] = authoredY - (m.hipHeight - rig.rest.pos[o + 1]!);
      pose.pos[o + 2] = rig.rest.pos[o + 2]! + m.legLength * 0.01 * run * a;

      // Transverse rotation: the swing-side hip travels forward.
      const pelvisYaw = Math.cos(TAU * p) * lerp(0.07, 0.16, run) * a;
      // Frontal list: the swing-side hip drops (Trendelenburg).
      const pelvisRoll = Math.sin(TAU * p) * lerp(0.05, 0.02, run) * a + bank * 0.35;
      const pelvisPitch = lerp(0.02, 0.1, run) * a + slouch * 0.05;
      setEulerZYX(pose, hips, pelvisPitch, pelvisYaw, pelvisRoll);
      this.pelvisY = pose.pos[o + 1]!;
    }

    // --- Spine: the thorax counter-rotates against the pelvis -------------
    // Without this the character reads as one rigid block pivoting at the
    // waist. Counter-rotation is the single clearest cue that a walk is
    // human, and it is why the arm swing looks driven rather than pasted on.
    // Sized against the PELVIS rotation, not against zero. The thorax has to
    // end up counter-rotating in WORLD space by about five degrees at walking
    // speed, and the pelvis is already carrying four the other way — so a
    // spine term that merely cancels the pelvis leaves the shoulders visually
    // static, which is what makes a procedural walk read as a torso being
    // carried along rather than a body driving itself.
    const counter = -Math.cos(TAU * p) * lerp(0.17, 0.34, run) * a;
    const lean = lerp(0.03, 0.22, run) * a;
    const lateral = -Math.sin(TAU * p) * lerp(0.03, 0.05, run) * a;
    const spineStack: Array<[BoneName, number]> = [
      ['Spine', 0.3],
      ['Spine1', 0.35],
      ['Spine2', 0.35],
    ];
    for (const [name, share] of spineStack) {
      const i = rig.index[name];
      if (i === undefined) continue;
      setEulerZYX(
        pose,
        i,
        lean * share + slouch * 0.16 * share,
        counter * share,
        lateral * share - bank * 0.2 * share
      );
    }

    // --- Head: stabilise the gaze against the thorax ----------------------
    const neck = rig.index.Neck;
    if (neck !== undefined) {
      setEulerZYX(pose, neck, -lean * 0.55 + slouch * 0.2, -counter * 0.45, -lateral * 0.5);
    }
    const head = rig.index.Head;
    if (head !== undefined) {
      // Vertical gaze stabilisation: the head cancels most of the pelvis bob,
      // which is why a real walk cycle's head travels far less than its hips.
      const bob = -(bounceWalk + bounceRun) * 0.35 * a;
      setEulerZYX(pose, head, -lean * 0.3 + bob * 0.15 + slouch * 0.28, -counter * 0.3, 0);
    }

    this.authorArms(pose, g, input);
  }

  /**
   * Arm swing, opposite the ipsilateral leg.
   *
   * The arms are the second-most-diagnostic part of a walk after the feet.
   * Three things have to be right: the phase (right leg forward means LEFT arm
   * forward), the asymmetry (a human arm extends further behind than it swings
   * in front), and the elbow, which is nearly straight at a stroll and folded
   * to 80–90° at a sprint. Getting the phase wrong produces the unmistakable
   * "marching soldier" read.
   */
  private authorArms(pose: Pose, g: GaitSolution, input: LocomotionInput): void {
    const rig = this.rig;
    const p = this.phase;
    const a = g.activity * this.vigour;
    const run = g.runBlend;
    const slouch = clamp01(input.slouch ?? 0);

    // Bring the arms from the bind pose's near-horizontal droop down to the
    // sides. The droop angle is measured, so this works on any rig.
    const droop = Math.atan2(-rig.metrics.armRestDir.y, Math.abs(rig.metrics.armRestDir.x));
    const outward = lerp(0.13, 0.2, run) + 0.09 * (1 - a) + slouch * 0.05;
    const adduct = Math.PI / 2 - droop - outward;

    const swing = lerp(0.34, 0.95, run) * a;
    const backBias = lerp(0.1, 0.02, run) * a;
    const elbow = lerp(0.22, 1.5, run) + 0.12 * a + slouch * 0.35;

    for (const side of _SIDES) {
      const sign = side === 'Left' ? 1 : -1;
      const shoulder = rig.index[`${side}Arm` as BoneName];
      const fore = rig.index[`${side}ForeArm` as BoneName];
      const clavicle = rig.index[`${side}Shoulder` as BoneName];
      if (shoulder === undefined) continue;

      // Left arm forward when the RIGHT leg is forward (phase 0).
      const forward = Math.cos(TAU * p + (sign > 0 ? 0 : Math.PI)) * swing - backBias;
      // Compose adduction first, then the fore/aft swing: once the arm hangs
      // down, fore/aft IS a rotation about the model X axis, identically for
      // both sides. Doing it in the other order would try to swing an arm
      // about its own length, which does nothing.
      _q0.setFromAxisAngle(_Z_AXIS, sign * adduct);
      _q1.setFromAxisAngle(_X_AXIS, forward);
      _q2.copy(_q1).multiply(_q0);
      setRotation(pose, shoulder, _q2);

      if (fore !== undefined) {
        // Elbow hinge is the bind-frame Y axis: the arm points sideways at
        // bind, so folding it forward is a yaw, and the sign mirrors.
        const flex = elbow + Math.max(0, forward) * lerp(0.5, 0.35, run);
        _q0.setFromAxisAngle(_Y_AXIS, -sign * flex);
        setRotation(pose, fore, _q0);
      }
      if (clavicle !== undefined) {
        setEulerZYX(pose, clavicle, 0, forward * 0.12, sign * (0.03 + slouch * 0.06));
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feet                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Decide where one ankle must be this frame, in MODEL space.
   *
   * Stance reads the world lock; swing interpolates between the lock the foot
   * just left and the one it is heading for, both of which are world-anchored,
   * so the swing arrives with exactly the stance drift velocity and there is
   * no velocity discontinuity at touchdown.
   */
  private resolveFoot(
    foot: FootState,
    g: GaitSolution,
    input: LocomotionInput,
    groundY: number,
    grounded: boolean
  ): void {
    const m = this.rig.metrics;
    const offset = foot.side === 'right' ? 0 : 0.5;
    const local = mod(this.phase - offset, 1);
    const duty = g.duty;

    const halfWidth =
      m.hipHalfWidth * lerp(STANCE_WIDTH_WALK, STANCE_WIDTH_RUN, g.runBlend) +
      m.hipHalfWidth * 0.34 * (1 - g.activity);
    const excursion = g.excursion;
    const zTouchdown = -excursion * FRONT_FRACTION;

    const wasStance = foot.phase === 'stance';
    const isStance = grounded && (local < duty || g.activity < 0.02);
    foot.phase = isStance ? 'stance' : 'swing';
    foot.progress = isStance
      ? duty > 1e-6
        ? clamp01(local / duty)
        : 0
      : clamp01((local - duty) / Math.max(1e-6, 1 - duty));

    if (isStance && !wasStance) {
      // Touchdown. Pin the BALL of the foot — the metatarsal head — into world
      // space. Anchoring on the ball rather than the heel is what lets one
      // model cover both a walking heel strike and a running forefoot strike:
      // the ball is the pivot that both gaits actually load, and the heel is
      // derived from it.
      //
      // The crossing is resolved to SUB-FRAME accuracy. Touchdown happens at
      // local phase zero, and this frame has already overshot it by `local`;
      // the root has therefore already travelled past the true footprint. Not
      // correcting for that plants the foot up to `speed × dt` too far back,
      // which is invisible at a fixed time step and turns into a frame-rate
      // dependent gait the moment anything runs at a different one — including
      // the offline baker.
      const overshoot = local / Math.max(1e-6, g.cycleFrequency);
      this.touchdownAnkle(g, groundY, halfWidth, foot.sign, zTouchdown, _v0);
      _v0.z += g.speed * overshoot;
      this.ankleToBall(_v0, this.strikePitch(g), _v1);
      this.modelToWorld(_v1, foot.plantWorld);
      foot.plantYaw = this.rootYaw;
      this.touchdowns.push({
        side: foot.side,
        strength: clamp01(0.25 + g.normalisedSpeed * 0.55),
      });
    }

    if (!isStance && wasStance) {
      // Toe-off. Anchor the swing's origin in WORLD space, computed from the
      // plant at exactly full stance progress rather than snapshotted from
      // last frame's ankle. Snapshotting works, but it quantises the swing's
      // starting point to the time step; deriving it keeps the whole gait a
      // function of phase alone.
      this.worldToModel(foot.plantWorld, _ballModel);
      _ballModel.y = groundY;
      const yaw = clamp(wrapPi(foot.plantYaw - this.rootYaw), -FOOT_YAW_LIMIT, FOOT_YAW_LIMIT);
      this.ballToAnkle(_ballModel, this.toeOffPitch(g), _v0, yaw);
      this.modelToWorld(_v0, foot.liftWorld);
    }

    if (isStance) {
      this.stanceAnkle(foot, g, groundY, _ankleTarget);
    } else {
      this.swingAnkle(foot, g, groundY, halfWidth, zTouchdown, _ankleTarget);
    }
    _footTargets[foot.side].copy(_ankleTarget);
  }

  /**
   * Ankle position during stance, derived from the locked world pivot.
   *
   * Three sub-phases, each with a stationary pivot: heel, flat sole, ball.
   * The foot is flat at both handovers, so the ankle path is continuous
   * across them without any blending.
   */
  private stanceAnkle(
    foot: FootState,
    g: GaitSolution,
    groundY: number,
    out: THREE.Vector3
  ): void {
    const r = foot.progress;
    const strikePitch = this.strikePitch(g);
    const offPitch = this.toeOffPitch(g);

    let pitch: number;
    if (r < ROLL_HEEL_END) {
      pitch = lerp(strikePitch, 0, smootherstep(0, ROLL_HEEL_END, r));
    } else if (r < ROLL_TOE_START) {
      pitch = 0;
    } else {
      pitch = lerp(0, offPitch, smootherstep(ROLL_TOE_START, 1, r));
    }
    foot.pitch = pitch;

    // The ball footprint in model space. The world lock makes this drift
    // backwards at exactly the root's speed, whatever that speed is doing —
    // including while it is changing, which is where speed-driven procedural
    // locomotion normally starts to skate.
    this.worldToModel(foot.plantWorld, _ballModel);
    _ballModel.y = groundY;
    this.ballToAnkle(_ballModel, pitch, out, this.retainedYaw(foot));
  }

  /**
   * Ankle pitch at the instant of toe-off, for this gait.
   *
   * A function of the GAIT, never of the last frame sampled. Carrying the
   * pitch across the stance/swing boundary as state instead makes the whole
   * pose depend on where the time step happened to fall — the same walk run at
   * 60 Hz and at 240 Hz then differs by up to twenty degrees at the ankle,
   * which is exactly what the offline baker and the runtime must not do.
   */
  private toeOffPitch(g: GaitSolution): number {
    return TOE_OFF_PITCH * lerp(1, 0.92, g.runBlend) * g.activity;
  }

  /** Ankle pitch at the instant of touchdown, for this gait. */
  private strikePitch(g: GaitSolution): number {
    // Walkers strike heel-first; runners land nearer the forefoot, and by
    // sprint speed the heel never touches at all.
    return lerp(HEEL_STRIKE_PITCH, -0.09, g.runBlend) * g.activity;
  }

  /**
   * Ankle position from a ball footprint and a foot pitch.
   *
   * With the toes up the foot pivots on the HEEL, which sits a foot-length
   * behind the ball; with the toes down it pivots on the ball itself. The two
   * agree exactly at pitch zero — the foot is flat there — so the handover is
   * continuous without any blending.
   */
  private ballToAnkle(
    ball: THREE.Vector3,
    pitch: number,
    out: THREE.Vector3,
    yaw = 0
  ): void {
    const m = this.rig.metrics;
    if (pitch > 0) {
      _pivotLocal.set(0, -m.ankleHeight, m.heelBack);
      rotateAboutX(_pivotLocal, pitch, _rotated);
      _heelOffset.set(0, 0, m.heelBack + m.footForward);
      rotateAboutY(_heelOffset, yaw, _heelOffset);
      rotateAboutY(_rotated, yaw, _rotated);
      out.copy(ball).add(_heelOffset).sub(_rotated);
    } else {
      _pivotLocal.set(0, -m.ankleHeight, -m.footForward);
      rotateAboutX(_pivotLocal, pitch, _rotated);
      rotateAboutY(_rotated, yaw, _rotated);
      out.copy(ball).sub(_rotated);
    }
  }

  /** Inverse of `ballToAnkle`, at zero retained yaw (touchdown only). */
  private ankleToBall(ankle: THREE.Vector3, pitch: number, out: THREE.Vector3): void {
    const m = this.rig.metrics;
    if (pitch > 0) {
      _pivotLocal.set(0, -m.ankleHeight, m.heelBack);
      rotateAboutX(_pivotLocal, pitch, _rotated);
      out.copy(ankle).add(_rotated);
      out.z -= m.heelBack + m.footForward;
    } else {
      _pivotLocal.set(0, -m.ankleHeight, -m.footForward);
      rotateAboutX(_pivotLocal, pitch, _rotated);
      out.copy(ankle).add(_rotated);
    }
  }

  /**
   * How much the planted foot's heading lags the body's, in model space.
   *
   * A planted foot keeps its WORLD heading while the body turns over it — you
   * pivot on the foot, you do not sweep it round. Retaining the yaw is what
   * makes that true; without it the whole foot rotates about its ball every
   * frame and a character walking a curve leaves a smeared footprint. The lag
   * is capped, because past about 35° the ankle has run out of range and the
   * foot has to give up and re-place, which is also what a person does.
   */
  private retainedYaw(foot: FootState): number {
    if (foot.phase !== 'stance') return 0;
    const lag = wrapPi(foot.plantYaw - this.rootYaw);
    return clamp(lag, -FOOT_YAW_LIMIT, FOOT_YAW_LIMIT);
  }

  /**
   * Where the ankle must be at the instant of touchdown.
   *
   * Shared by the swing trajectory and by the plant, so the two agree to the
   * last decimal and the handover produces no pop. The height comes from the
   * ground: whichever end of the sole is lowest under the strike pitch has to
   * be exactly on the ground, and the ankle follows from that.
   */
  private touchdownAnkle(
    g: GaitSolution,
    groundY: number,
    halfWidth: number,
    sign: number,
    zTouchdown: number,
    out: THREE.Vector3
  ): void {
    const m = this.rig.metrics;
    const pitch = this.strikePitch(g);
    _pivotLocal.set(0, -m.ankleHeight, m.heelBack);
    rotateAboutX(_pivotLocal, pitch, _rotated);
    const heelY = _rotated.y;
    _pivotLocal.set(0, -m.ankleHeight, -m.footForward);
    rotateAboutX(_pivotLocal, pitch, _rotated);
    const ballY = _rotated.y;
    out.set(sign * halfWidth, groundY - Math.min(heelY, ballY), zTouchdown);
  }

  /** Ankle position during swing. */
  private swingAnkle(
    foot: FootState,
    g: GaitSolution,
    groundY: number,
    halfWidth: number,
    zTouchdown: number,
    out: THREE.Vector3
  ): void {
    const m = this.rig.metrics;
    const s = foot.progress;

    // Where the ankle left the ground, drifted into the current model frame.
    this.worldToModel(foot.liftWorld, _from);
    // Where it is going: the future footprint, expressed in the CURRENT model
    // frame, i.e. still ahead of the character by the distance left to cover.
    const swingDuration = Math.max(1e-4, (1 - g.duty) / Math.max(1e-4, g.cycleFrequency));
    const remaining = (1 - s) * swingDuration;
    const strikePitch = this.strikePitch(g);
    this.touchdownAnkle(g, groundY, halfWidth, foot.sign, zTouchdown, _to);
    _to.z -= g.speed * remaining;

    // Smootherstep has zero derivative at both ends, so the ankle inherits
    // exactly the drift velocity of whichever world anchor it is nearest —
    // which is the no-pop, no-slide condition at touchdown.
    const h = smootherstep(0, 1, s);
    out.lerpVectors(_from, _to, h);

    // Lift, peaking a little before mid-swing so the foot clears early and
    // then reaches out. A symmetric arc reads as a hop.
    const bump = Math.pow(Math.sin(Math.PI * Math.pow(s, 0.86)), 1.5);
    out.y += g.swingLift * bump;

    // Toe pitch through the swing: plantar-flexed leaving the ground, toes up
    // in mid-swing for clearance, neutral-to-heel-first arriving. Both ends
    // come from the gait, so the trajectory is a pure function of phase.
    const pitch =
      s < 0.35
        ? lerp(this.toeOffPitch(g), 0.2 * g.activity, smootherstep(0, 0.35, s))
        : lerp(0.2 * g.activity, strikePitch, smootherstep(0.35, 1, s));
    foot.pitch = pitch;

    // Hard guarantee: no part of the sole may go below the ground.
    _pivotLocal.set(0, -m.ankleHeight, m.heelBack);
    rotateAboutX(_pivotLocal, pitch, _rotated);
    const heelY = out.y + _rotated.y;
    _pivotLocal.set(0, -m.ankleHeight, -m.footForward);
    rotateAboutX(_pivotLocal, pitch, _rotated);
    const ballY = out.y + _rotated.y;
    const lowest = Math.min(heelY, ballY);
    if (lowest < groundY) out.y += groundY - lowest;
  }

  /**
   * Lower the pelvis until both stance legs can reach their targets.
   *
   * Closed form: the hip joint translates rigidly with the pelvis, so the
   * admissible drop for one foot is one square root. Take the deepest demand
   * of the two feet. This is what turns "the stride is longer than the leg"
   * from an exploding-limb bug into a crouch.
   */
  private applyReachLimit(pose: Pose): void {
    const rig = this.rig;
    const hips = rig.index.Hips;
    if (hips === undefined) return;
    const reach = (rig.metrics.thigh + rig.metrics.shank) * MAX_EXTENSION;

    // Collected per foot rather than folded straight into a running minimum:
    // the two demands are combined with a SOFT minimum below.
    let demandLeft = Infinity;
    let demandRight = Infinity;
    for (const foot of [this.left, this.right]) {
      // BOTH feet constrain, planted or swinging.
      //
      // Releasing the swing leg is the obvious design and it is wrong twice
      // over. It makes the pelvis spring up the instant a foot leaves the
      // ground and sink again as the next one reaches for its landing — six
      // extra inflections per cycle and a visible hitch — and it leaves the
      // trailing leg unable to reach its own toe-off position, so the leg
      // quietly fails to extend behind the body.
      //
      // Constraining both is smoother AND more correct: 41 mm of pelvis travel
      // at walking speed against a textbook 45 mm, four inflections, and no
      // leg ever short of its target. The one failure mode it introduces —
      // a foot thrown forward and lifted at sprinting speed briefly demanding
      // an absurd crouch — is handled by the cap below rather than by
      // weakening the constraint everywhere.
      _v0.setFromMatrixPosition(this.model[foot.chain.root]!);
      const target = _footTargets[foot.side];
      const dx = target.x - _v0.x;
      const dz = target.z - _v0.z;
      const dy = target.y - _v0.y;
      const horizontal = dx * dx + dz * dz;
      const span = horizontal >= reach * reach ? 0 : Math.sqrt(reach * reach - horizontal);
      const allowed = dy + span;
      if (foot.side === 'left') demandLeft = allowed;
      else demandRight = allowed;
    }

    // A SOFT minimum, not a hard one.
    //
    // The leading leg's demand falls through early stance while the trailing
    // leg's rises toward toe-off, so the two cross over during double support.
    // A hard `min` puts a corner exactly at the crossing, and the pelvis
    // develops a small double dip per step — half the total vertical travel,
    // arriving as a shudder. Rounding the corner over a centimetre removes it
    // for at most 7 mm of extra crouch, and extra crouch is always safe: it
    // can only make a leg more able to reach, never less.
    let drop = Math.min(0, softMin(demandLeft, demandRight, rig.metrics.legLength * 0.014));

    // The crouch has a floor. Past about a sixth of a leg length the character
    // stops reading as "reaching" and starts reading as "squatting", and the
    // only thing that ever asks for more is an airborne foot at hero speed —
    // which `clampTargets` can absorb invisibly.
    drop = Math.max(drop, -rig.metrics.legLength * MAX_CROUCH);
    this.reachDrop = -drop;
    if (drop < 0) {
      pose.pos[hips * 3 + 1] = pose.pos[hips * 3 + 1]! + drop;
      this.pelvisY = pose.pos[hips * 3 + 1]!;
      // Only the pelvis moved; the IK recomputes each leg chain from it, and
      // the upper body's stale matrices are never read again this frame.
      _local.compose(
        _v1.set(pose.pos[hips * 3]!, pose.pos[hips * 3 + 1]!, pose.pos[hips * 3 + 2]!),
        _q0.set(
          pose.rot[hips * 4]!,
          pose.rot[hips * 4 + 1]!,
          pose.rot[hips * 4 + 2]!,
          pose.rot[hips * 4 + 3]!
        ),
        _ONE
      );
      this.model[hips]!.copy(_local);
      // Refresh the two hip joints so `clampTargets` measures from where the
      // legs actually hang, not from where they hung before the pelvis moved.
      for (const foot of [this.left, this.right]) {
        const root = foot.chain.root;
        _local.compose(
          _v1.set(pose.pos[root * 3]!, pose.pos[root * 3 + 1]!, pose.pos[root * 3 + 2]!),
          _q0.set(
            pose.rot[root * 4]!,
            pose.rot[root * 4 + 1]!,
            pose.rot[root * 4 + 2]!,
            pose.rot[root * 4 + 3]!
          ),
          _ONE
        );
        this.model[root]!.multiplyMatrices(this.model[hips]!, _local);
      }
    }
  }

  /**
   * Pull any still-unreachable target onto the leg's reach sphere.
   *
   * Runs AFTER the pelvis has settled, so it only ever touches targets the
   * pelvis was not obliged to accommodate — in practice a swing foot at
   * sprinting speed. The distance it moves is recorded as that foot's `slip`,
   * so "the leg could not do what the gait asked" stays a measured number
   * rather than a silent snap to full extension.
   */
  private clampTargets(): void {
    const rig = this.rig;
    const reach = (rig.metrics.thigh + rig.metrics.shank) * MAX_EXTENSION;
    for (const foot of [this.left, this.right]) {
      _v0.setFromMatrixPosition(this.model[foot.chain.root]!);
      const target = _footTargets[foot.side];
      const distance = _to.subVectors(target, _v0).length();
      if (distance <= reach) {
        foot.clamped = 0;
        continue;
      }
      foot.clamped = distance - reach;
      target.copy(_v0).addScaledVector(_to.multiplyScalar(1 / distance), reach);
    }
  }

  /** Run the IK for one leg and orient the foot and toe. */
  private solveLeg(pose: Pose, foot: FootState): void {
    const rig = this.rig;
    const target = _footTargets[foot.side];

    // Knee pole, as a MODEL-space direction: forward and slightly outward, so
    // the knee can neither invert nor cross the midline. Forward is -Z.
    _pole.set(foot.sign * 0.28, 0.12, -1).normalize();

    const result = solveChain(pose, rig, this.model, foot.chain, target, {
      maxExtension: MAX_EXTENSION,
      pole: _pole,
      poleWeight: 0.85,
    });
    // Report BOTH failure modes as one number: what the IK could not cover,
    // plus what the target had to give up before the IK saw it.
    foot.slip = result.slip + foot.clamped;

    // Foot orientation in MODEL space, so the sole stays parallel to the
    // ground whatever the leg had to do to get there: retained yaw first (a
    // planted foot keeps its world heading), then ankle pitch.
    _q0.setFromAxisAngle(_Y_AXIS, this.retainedYaw(foot));
    _q1.setFromAxisAngle(_X_AXIS, foot.pitch);
    _q0.multiply(_q1);
    setModelRotation(pose, foot.footBone, _q0, this.model[foot.chain.mid]!);

    // The toe joint extends as the heel lifts — the metatarsal break. Without
    // it the foot leaves the ground as a rigid plank.
    //
    // The fade matters more than it looks. Snapping the extension to zero the
    // frame a foot leaves the ground puts a ~29 degree step change on the toe,
    // which pops on screen and, worse, makes the whole pose frame-rate
    // dependent: two runs at different time steps classify the transition on
    // different frames and disagree by that entire step.
    if (foot.toeBone !== foot.footBone) {
      const release = foot.phase === 'stance' ? 1 : 1 - smoothstep(0, 0.25, foot.progress);
      const extend = Math.max(0, -foot.pitch) * 0.75 * release;
      _q0.identity();
      setRotation(pose, foot.toeBone, _q0);
      rotateBone(pose, foot.toeBone, 'x', extend);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Frame conversion                                                   */
  /* ------------------------------------------------------------------ */

  /** Model space (character-local) to world. */
  modelToWorld(model: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.rootYaw);
    const s = Math.sin(this.rootYaw);
    return out.set(
      this.rootPosition.x + model.x * c + model.z * s,
      this.rootPosition.y + model.y,
      this.rootPosition.z - model.x * s + model.z * c
    );
  }

  /** World to model space. */
  worldToModel(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const c = Math.cos(this.rootYaw);
    const s = Math.sin(this.rootYaw);
    const dx = world.x - this.rootPosition.x;
    const dy = world.y - this.rootPosition.y;
    const dz = world.z - this.rootPosition.z;
    return out.set(dx * c - dz * s, dy, dx * s + dz * c);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Smooth minimum. Approaches `Math.min` as `k` goes to zero and rounds the
 * corner over a band of width ~`k` around the crossing.
 */
function softMin(a: number, b: number, k: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  if (k <= 0) return Math.min(a, b);
  const h = clamp01(0.5 + (b - a) / (2 * k));
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Rotate a vector about the X axis into `out`. */
function rotateAboutX(v: THREE.Vector3, angle: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return out.set(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

/** Rotate a vector about the Y axis into `out`. */
function rotateAboutY(v: THREE.Vector3, angle: number, out: THREE.Vector3): THREE.Vector3 {
  if (angle === 0) return out.copy(v);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return out.set(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

/** Wrap to (-PI, PI]. */
function wrapPi(angle: number): number {
  return mod(angle + Math.PI, TAU) - Math.PI;
}

/**
 * Set a bone's rotation from pitch/yaw/roll applied in that order.
 *
 * ZYX rather than three.js's default XYZ: for a body, roll about the forward
 * axis should be the innermost rotation, so a leaning character's yaw stays
 * about the world vertical instead of tipping with the lean.
 */
function setEulerZYX(pose: Pose, bone: number, pitch: number, yaw: number, roll: number): void {
  _q0.setFromAxisAngle(_Y_AXIS, yaw);
  _q1.setFromAxisAngle(_X_AXIS, pitch);
  _q2.setFromAxisAngle(_Z_AXIS, roll);
  _q0.multiply(_q1).multiply(_q2);
  setRotation(pose, bone, _q0);
}

const _SIDES = ['Left', 'Right'] as const;
const _X_AXIS = new THREE.Vector3(1, 0, 0);
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _Z_AXIS = new THREE.Vector3(0, 0, 1);
const _ONE = new THREE.Vector3(1, 1, 1);
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _local = new THREE.Matrix4();
const _ankleTarget = new THREE.Vector3();
const _heelModel = new THREE.Vector3();
const _ballModel = new THREE.Vector3();
const _pivotLocal = new THREE.Vector3();
const _rotated = new THREE.Vector3();
const _heelOffset = new THREE.Vector3();
const _footTargets: Record<'left' | 'right', THREE.Vector3> = {
  left: new THREE.Vector3(),
  right: new THREE.Vector3(),
};
