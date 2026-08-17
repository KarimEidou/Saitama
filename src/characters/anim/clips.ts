/**
 * CLIP LIBRARY
 *
 * Twenty-one procedural clips covering all seventeen `ClipName` slots, plus
 * the OPM-specific idle variants the game's state machine needs.
 *
 * ── CLIPS ARE FUNCTIONS OF NORMALISED TIME ────────────────────────────────
 * Every clip is `(context, t, pose) => void` with `t` in 0..1. That signature
 * is the reason the VAT baker, the unit tests and the runtime all agree: there
 * is exactly one definition of what a clip looks like at a given moment, and
 * nothing in the chain can drift from it.
 *
 * ── WHY DURATIONS ARE SCALED, NOT THE POSES ───────────────────────────────
 * A clip's `duration` is stated for a 1.75 m reference adult and scaled per
 * character by `sqrt(legLength / referenceLeg)` — a pendulum period. A child
 * therefore punches faster and a monster slower, from the same function, which
 * is both physically right and the cheapest possible way to make a mixed-scale
 * cast stop looking like one actor at several zoom levels.
 *
 * ── SAITAMA'S BORED IDLE ──────────────────────────────────────────────────
 * `idle` / `bored` is the most load-bearing clip in the game, because Boredom
 * is a game system and not a mood: the renderer desaturates for it, the score
 * thins out, and this is the part the player actually sees. It is a nine
 * second loop of a collapsing posture — rounded thoracic spine, protracted
 * shoulders, posterior pelvic tilt, chin down and slightly forward — with a
 * yawn that arrives once per loop, stretches everything upward for a second
 * and a half, and then gives up. The `boredom` parameter scales the whole
 * collapse continuously, so the transition from engaged to catatonic can be
 * driven straight off the game's own 0..1 value rather than crossfaded.
 */

import type { ClipName } from '@/types';
import { clamp01, lerp, smoothstep, TAU } from '@/util';
import { poseArm, poseHead, poseLeg, posePelvis, poseSpine, springDecay, strikeCurve } from './posture';
import { solveGait } from './locomotion';
import { REFERENCE_LEG } from './rig';
import type { AnimRig, ClipDefinition, ClipParams, ClipVariant, Pose } from './types';

/** Everything a clip function is allowed to read. */
export interface ClipContext {
  readonly rig: AnimRig;
  readonly params: ClipParams;
}

/** A clip's pose function. `t` is normalised time in 0..1. */
export type ClipFn = (context: ClipContext, t: number, pose: Pose) => void;

/** A definition and its evaluator. */
export interface ClipEntry {
  readonly def: ClipDefinition;
  readonly evaluate: ClipFn;
}

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pelvis height for a symmetric squat that keeps both soles flat on the floor.
 *
 * With `hip = φ`, `knee = 2φ` and `ankle = φ` the shank leans back by exactly
 * as much as the thigh leans forward, so the foot stays level and the ankle
 * stays under the hip. The hip then sits `(thigh + shank)·cos φ` above the
 * ankle — exact, not fitted, which is what stops a crouch from sinking the
 * character through the floor at large angles.
 */
function squatPelvis(rig: AnimRig, phi: number): number {
  const m = rig.metrics;
  return m.ankleHeight + (m.thigh + m.shank) * Math.cos(phi);
}

/** Apply a symmetric squat to both legs and the pelvis. */
function squat(pose: Pose, rig: AnimRig, phi: number, spread = 0.04, pitch = 0): void {
  posePelvis(pose, rig, 0, squatPelvis(rig, phi), 0, pitch);
  for (const side of SIDES) {
    poseLeg(pose, rig, side, { flex: phi, knee: 2 * phi, ankle: phi, abduct: spread });
  }
}

const SIDES = [-1, 1] as const;

/* -------------------------------------------------------------------------- */
/* Idles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Neutral idle: breathing, a slow weight shift, and nothing else.
 *
 * Idle is the pose the player looks at longest, so the failure mode to avoid
 * is not "boring" but "frozen". Three oscillators at mutually irrational
 * periods (breath, sway, head) never line up, so the loop does not visibly
 * repeat even though it is a one-shot 5.4 s cycle.
 */
const idleDefault: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const p = t + params.phaseOffset;
  const v = params.vigour;
  const breath = Math.sin(TAU * p) * 0.5 + 0.5;
  const sway = Math.sin(TAU * (p * 0.63 + 0.2));
  const alert = params.alertness;

  posePelvis(
    pose,
    rig,
    sway * rig.metrics.legLength * 0.012 * v,
    rig.metrics.hipHeight - rig.metrics.legLength * (0.006 + 0.02 * alert),
    0,
    0.01 + 0.04 * alert,
    sway * 0.02,
    sway * 0.024
  );
  poseSpine(pose, rig, {
    bend: 0.035 - breath * 0.03 * v + 0.05 * alert,
    twist: -sway * 0.03,
    side: -sway * 0.02,
  });
  poseHead(pose, rig, -0.02 + breath * 0.02, Math.sin(TAU * (p * 0.41 + 0.7)) * 0.09, sway * 0.02);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 0.1 + breath * 0.012 + alert * 0.08,
      elbow: 0.18 + breath * 0.03 + alert * 0.45,
      flex: -0.05 + sway * 0.02 * side,
      twist: 0.14,
      shrug: breath * 0.02,
    });
  }
  for (const side of SIDES) {
    poseLeg(pose, rig, side, {
      flex: 0.03 + alert * 0.1,
      knee: 0.06 + alert * 0.2,
      abduct: 0.045,
      twist: 0.06,
      ankle: -0.02,
    });
  }
};

/**
 * Saitama, bored. A posture that has given up, plus one yawn per loop.
 *
 * The collapse is anatomically specific rather than "lean forward a bit":
 * posterior pelvic tilt flattens the lumbar curve, the thoracic spine rounds,
 * the scapulae protract so the shoulders roll in front of the ribcage, and the
 * head translates forward while the chin drops. Those four together are what
 * a slouch actually is; doing only the last one gives a character who is
 * looking at the floor while standing to attention.
 */
const idleBored: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const m = rig.metrics;
  const b = clamp01(0.45 + 0.55 * params.boredom);
  const p = t + params.phaseOffset * 0.31;
  const breath = Math.sin(TAU * p * 0.86) * 0.5 + 0.5;

  // The yawn: a slow inhale-and-stretch, a held peak, then the collapse back.
  const YAWN_IN = 0.6;
  const YAWN_PEAK = 0.68;
  const YAWN_OUT = 0.79;
  const yawn =
    t < YAWN_IN || t > YAWN_OUT
      ? 0
      : t < YAWN_PEAK
        ? smoothstep(YAWN_IN, YAWN_PEAK, t)
        : 1 - smoothstep(YAWN_PEAK, YAWN_OUT, t);
  // Kept near full strength regardless of boredom: the yawn is the beat that
  // sells the clip, and scaling it down to half at boredom 0 leaves the arms
  // stuck at shoulder height, which reads as a shrug.
  const y = yawn * params.vigour * (0.82 + 0.18 * params.boredom);

  // Weight parked on one leg, shifting over about eight seconds because
  // standing on one hip is only comfortable for so long.
  const shift = Math.sin(TAU * (p * 0.37 + 0.15));

  posePelvis(
    pose,
    rig,
    shift * m.legLength * 0.03 * b,
    m.hipHeight - m.legLength * (0.05 * b + 0.006 * breath) + y * m.legLength * 0.05,
    m.legLength * 0.02 * b,
    // Posterior tilt: the pelvis tucks under, which is what flattens the back.
    -0.22 * b + y * 0.14,
    shift * 0.05,
    shift * 0.06 * b
  );
  poseSpine(pose, rig, {
    bend: 0.48 * b - y * 0.86,
    twist: -shift * 0.05,
    side: -shift * 0.05 * b,
  });
  poseHead(pose, rig, 0.52 * b - y * 1.2, shift * 0.14, shift * 0.05 + 0.04 * b);

  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      // Hands drift forward and inward — the dead-arm hang, not a soldier's.
      // The yawn straightens the elbows as it lifts: a stretch is an EXTENSION,
      // and folding the arms while raising them reads as a shrug instead.
      abduct: 0.06 + 0.02 * b + y * 2.6,
      elbow: 0.3 + 0.35 * b - y * 0.42,
      flex: 0.12 * b + y * 0.34,
      twist: 0.42 * b - y * 0.6,
      // Protracted, depressed scapulae: shoulders rolled forward and dropped.
      shrug: -0.09 * b + y * 0.4,
    });
  }
  for (const side of SIDES) {
    poseLeg(pose, rig, side, {
      flex: 0.05 + 0.05 * b + (side < 0 ? shift : -shift) * 0.05,
      knee: 0.11 + 0.1 * b - y * 0.06,
      abduct: 0.05 + 0.03 * b,
      twist: 0.12 + 0.06 * b,
      ankle: -0.03,
    });
  }
};

/** Combat idle: guard up, weight forward, small continuous bob. */
const idleCombat: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const p = t + params.phaseOffset;
  const bob = Math.sin(TAU * p * 2);
  const phi = 0.3 + bob * 0.045;

  posePelvis(pose, rig, 0, squatPelvis(rig, phi), 0, 0.1, -0.22, 0);
  poseSpine(pose, rig, { bend: 0.13, twist: 0.26, side: 0.03 });
  poseHead(pose, rig, -0.06, -0.26, 0);
  // Orthodox stance: left foot leads, right foot back and turned out.
  poseLeg(pose, rig, -1, { flex: phi + 0.22, knee: 2 * phi, ankle: phi - 0.12, abduct: 0.1, twist: 0.16 });
  poseLeg(pose, rig, 1, { flex: phi - 0.24, knee: 2 * phi + 0.1, ankle: phi + 0.1, abduct: 0.16, twist: 0.42 });
  // Lead hand out, rear hand cocked at the jaw.
  poseArm(pose, rig, -1, { abduct: 0.34, elbow: 1.5, flex: 0.62, twist: -0.5, shrug: 0.07 });
  poseArm(pose, rig, 1, { abduct: 0.26, elbow: 2.05, flex: 0.3, twist: -0.66, shrug: 0.1 });
};

/** Civilian idle: hands loosely clasped, occasional glance. */
const idleCivilian: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const m = rig.metrics;
  const p = t + params.phaseOffset;
  const breath = Math.sin(TAU * p * 1.1) * 0.5 + 0.5;
  const shift = Math.sin(TAU * (p * 0.43 + 0.6));
  const glance = smoothstep(0.3, 0.42, t) - smoothstep(0.55, 0.7, t);

  posePelvis(
    pose,
    rig,
    shift * m.legLength * 0.022,
    m.hipHeight - m.legLength * 0.012,
    0,
    0.03,
    shift * 0.03,
    shift * 0.04
  );
  poseSpine(pose, rig, { bend: 0.1 - breath * 0.025, twist: -shift * 0.04, side: -shift * 0.03 });
  poseHead(pose, rig, 0.05, shift * 0.1 + glance * 0.5, 0);
  // Hands meeting low in front — the default human standing-about posture.
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 0.07,
      elbow: 0.66 + breath * 0.03,
      flex: 0.26,
      twist: 0.5,
      shrug: -0.03,
    });
  }
  for (const side of SIDES) {
    poseLeg(pose, rig, side, {
      flex: 0.04 + (side < 0 ? shift : -shift) * 0.04,
      knee: 0.1,
      abduct: 0.05,
      twist: 0.14,
    });
  }
};

/** Panicked idle: hands up, trembling, weight on the back foot. */
const idlePanicked: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const p = t + params.phaseOffset;
  const tremble = Math.sin(TAU * p * 7.3) * 0.5 + Math.sin(TAU * p * 11.1) * 0.5;
  const phi = 0.26;

  posePelvis(pose, rig, 0, squatPelvis(rig, phi), 0, -0.05, tremble * 0.03, 0);
  poseSpine(pose, rig, { bend: -0.06, twist: tremble * 0.05, side: 0 });
  poseHead(pose, rig, -0.24 + tremble * 0.03, tremble * 0.12, 0);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 1.05 + tremble * 0.05,
      elbow: 2.3,
      flex: 0.55,
      twist: -0.9,
      shrug: 0.22,
    });
    poseLeg(pose, rig, side, { flex: phi, knee: 2 * phi, ankle: phi, abduct: 0.1 });
  }
};

/* -------------------------------------------------------------------------- */
/* Locomotion styles                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Locomotive slots have no pose function of their own — the solver in
 * `locomotion.ts` produces the whole body. These entries exist so the slot
 * resolves, carries a duration, and can be baked like any other clip.
 */
const noop: ClipFn = () => {};

/** Fleeing: the solver runs the legs, this flails the arms above the head. */
const fleeStyle: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const p = t + params.phaseOffset;
  const flail = Math.sin(TAU * p * 2.4);
  poseSpine(pose, rig, { bend: 0.2, twist: flail * 0.12, side: 0 });
  poseHead(pose, rig, -0.16, flail * 0.3, 0);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 1.5 + flail * 0.25 * side,
      elbow: 1.9 + flail * 0.3,
      flex: 0.7,
      twist: -1.1,
      shrug: 0.3,
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Air                                                                        */
/* -------------------------------------------------------------------------- */

/** Jump launch: a crouch that unloads into full extension. */
const jumpClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  // Load in the first third, then extend violently. The knee leads the hip on
  // the way up, which is what makes a jump read as a push rather than a lift.
  const load = smoothstep(0, 0.32, t) * (1 - smoothstep(0.32, 0.55, t));
  const extend = smoothstep(0.3, 0.62, t);
  const phi = lerp(0.16, 0.86, load) * (1 - extend * 0.95);

  squat(pose, rig, phi, 0.06, 0.16 * load - 0.06 * extend);
  poseSpine(pose, rig, { bend: 0.34 * load - 0.16 * extend, twist: 0, side: 0 });
  poseHead(pose, rig, 0.12 * load - 0.2 * extend, 0, 0);
  for (const side of SIDES) {
    // Arms swing down and back on the load, then whip up through the launch.
    poseArm(pose, rig, side, {
      // Past 90 degrees of abduction the arm keeps going and ends up
      // overhead. Stopping at 90 and adding fore/aft `flex` does nothing at
      // all, because flexing an arm that points along the flexion axis is a
      // no-op — the arms simply spread into a T.
      abduct: 0.12 + extend * 2.35,
      elbow: 0.5 - extend * 0.32,
      flex: -0.5 * load + extend * 0.55,
      twist: 0.2,
      shrug: extend * 0.24,
    });
  }
  for (const side of SIDES) {
    poseLeg(pose, rig, side, {
      flex: phi + extend * 0.06,
      knee: 2 * phi,
      ankle: phi - extend * 0.55,
      abduct: 0.05,
      toe: extend * 0.45,
    });
  }
};

/** Falling: legs trail, arms out for balance, torso pitched forward. */
const fallClip: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const flutter = Math.sin(TAU * (t + params.phaseOffset) * 1.4);
  posePelvis(pose, rig, 0, rig.metrics.hipHeight, 0, -0.12, flutter * 0.05, flutter * 0.03);
  poseSpine(pose, rig, { bend: -0.14, twist: flutter * 0.06, side: 0 });
  poseHead(pose, rig, -0.2, flutter * 0.1, 0);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 1.2 + flutter * 0.12 * side,
      elbow: 0.8,
      flex: 0.25,
      twist: -0.4,
      shrug: 0.16,
    });
  }
  poseLeg(pose, rig, -1, { flex: 0.42, knee: 0.72, ankle: -0.3, abduct: 0.12 });
  poseLeg(pose, rig, 1, { flex: -0.12, knee: 0.3, ankle: -0.42, abduct: 0.1 });
};

/** Landing: absorb hard, then rise. Not a pose — a deceleration. */
const landClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  // Impact at t = 0.12: everything compresses in three frames and unwinds over
  // the rest of the clip. Symmetric ease here would read as a slow squat.
  const impact = t < 0.12 ? smoothstep(0, 0.12, t) : 1 - smoothstep(0.12, 0.9, t);
  const settle = t > 0.12 ? springDecay((t - 0.12) / 0.88, 1.4, 6) * 0.1 : 0;
  const phi = lerp(0.12, 1.02, impact) + settle;

  squat(pose, rig, phi, 0.1, 0.3 * impact);
  poseSpine(pose, rig, { bend: 0.42 * impact, twist: 0, side: 0 });
  poseHead(pose, rig, -0.24 * impact, 0, 0);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 0.24 + impact * 0.85,
      elbow: 0.5 + impact * 1.0,
      flex: -0.7 * impact,
      twist: 0.3,
      shrug: -0.1 * impact,
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Combat                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The normal punch: a right cross.
 *
 * The power in a real cross comes from the ground, not the arm, so the
 * ordering matters more than the arm angles: the pelvis rotates first, the
 * chest follows, the shoulder protracts, and only then does the elbow
 * straighten. Driving all four off the same curve with a small lag between
 * them is what produces a strike that looks connected to the body.
 */
const attackClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const drive = strikeCurve(t, 0.3, 0.46);
  const hips = strikeCurve(Math.min(1, t * 1.14), 0.3, 0.46);
  const chest = strikeCurve(Math.min(1, t * 1.06), 0.3, 0.46);
  const phi = 0.28 - drive * 0.06;

  posePelvis(pose, rig, 0, squatPelvis(rig, phi), 0, 0.06, -0.3 + hips * 0.75, 0);
  poseSpine(pose, rig, { bend: 0.06 + drive * 0.1, twist: 0.3 - chest * 0.95, side: 0.04 });
  poseHead(pose, rig, -0.04, 0.24 - drive * 0.5, 0);

  // Striking arm: drawn back on the wind-up, fully extended at the peak.
  poseArm(pose, rig, 1, {
    abduct: 0.28 + drive * 0.5,
    elbow: 2.1 - drive * 1.95,
    flex: 0.22 + drive * 1.28,
    twist: -0.7 + drive * 0.9,
    shrug: 0.08 + drive * 0.3,
  });
  // Guard hand retracts to the jaw as the other extends — the pull is what
  // accelerates the strike.
  poseArm(pose, rig, -1, {
    abduct: 0.34 - drive * 0.06,
    elbow: 1.5 + drive * 0.75,
    flex: 0.66 - drive * 0.55,
    twist: -0.45,
    shrug: 0.06,
  });
  poseLeg(pose, rig, -1, { flex: phi + 0.24, knee: 2 * phi, ankle: phi - 0.14, abduct: 0.1, twist: 0.16 });
  poseLeg(pose, rig, 1, {
    flex: phi - 0.26 + drive * 0.2,
    knee: 2 * phi,
    ankle: phi + 0.12 - drive * 0.24,
    abduct: 0.16,
    twist: 0.44 - drive * 0.22,
    toe: Math.max(0, drive) * 0.5,
  });
};

/**
 * The charged heavy punch: wind, hold, release.
 *
 * Structurally different from the cross rather than a bigger version of it.
 * There is a visible CHARGE plateau in the middle third — that plateau is what
 * the combat system's hold-to-charge input reads as feedback, and it is why
 * the markers are `windup`, `release`, `impact` rather than one `impact`.
 */
const heavyAttackClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const wind = smoothstep(0, 0.26, t);
  const hold = smoothstep(0.26, 0.44, t) * (1 - smoothstep(0.44, 0.52, t));
  const release = smoothstep(0.5, 0.62, t);
  const settle = 1 - smoothstep(0.66, 1, t);
  const tremor = hold * Math.sin(TAU * t * 26) * 0.02;

  const phi = 0.24 + wind * 0.34 - release * 0.3;
  posePelvis(
    pose,
    rig,
    0,
    squatPelvis(rig, phi),
    0,
    0.1 + wind * 0.2 - release * 0.24,
    -0.5 * wind + release * 1.15,
    tremor
  );
  poseSpine(pose, rig, {
    bend: 0.2 * wind - release * 0.22,
    twist: 0.6 * wind - release * 1.4,
    side: 0.08 * wind,
  });
  poseHead(pose, rig, 0.12 * wind - 0.16 * release, 0.4 * wind - 0.7 * release, 0);

  poseArm(pose, rig, 1, {
    abduct: 0.2 + wind * 0.42 + release * 0.3,
    elbow: 0.4 + wind * 2.15 - release * 2.4,
    flex: -0.55 * wind + release * 2.0 + tremor,
    twist: -0.9 * wind + release * 1.3,
    shrug: 0.06 + wind * 0.18 + release * 0.3,
  });
  poseArm(pose, rig, -1, {
    abduct: 0.26 + wind * 0.3,
    elbow: 1.1 + wind * 1.0 + release * 0.5,
    flex: 0.4 + wind * 0.5 - release * 0.9,
    twist: -0.4,
    shrug: 0.04 + wind * 0.12,
  });
  poseLeg(pose, rig, -1, {
    flex: phi + 0.3 + release * 0.12,
    knee: 2 * phi + 0.12,
    ankle: phi - 0.16,
    abduct: 0.12,
    twist: 0.18,
  });
  poseLeg(pose, rig, 1, {
    flex: phi - 0.42 + release * 0.3,
    knee: 2 * phi + wind * 0.2,
    ankle: phi + 0.2 - release * 0.4,
    abduct: 0.2,
    twist: 0.5,
    toe: release * 0.7 * settle,
  });
};

/** Guard: both forearms up, shoulders rolled in, weight back. */
const blockClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const set = smoothstep(0, 0.45, t);
  const phi = 0.24 + set * 0.14;
  squat(pose, rig, phi, 0.12, 0.16 * set);
  poseSpine(pose, rig, { bend: 0.2 * set, twist: 0.1 * set, side: 0 });
  poseHead(pose, rig, 0.22 * set, 0, 0);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 0.42 * set,
      elbow: 2.5 * set,
      flex: 1.15 * set,
      twist: -1.0 * set,
      shrug: 0.34 * set,
    });
  }
};

/** Dodge: a lateral push-off, a tuck, and a recovery. */
const dodgeClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const push = smoothstep(0, 0.2, t) * (1 - smoothstep(0.2, 0.55, t));
  const air = smoothstep(0.15, 0.45, t) * (1 - smoothstep(0.55, 0.85, t));
  const phi = 0.2 + push * 0.5 + air * 0.35;

  posePelvis(pose, rig, -rig.metrics.legLength * 0.12 * air, squatPelvis(rig, phi), 0, 0.1, 0.2 * air, -0.34 * air);
  poseSpine(pose, rig, { bend: 0.16 * push + 0.1 * air, twist: -0.24 * air, side: -0.38 * air });
  poseHead(pose, rig, -0.1, -0.3 * air, -0.26 * air);
  poseArm(pose, rig, -1, { abduct: 0.3 + air * 1.05, elbow: 0.7 + air * 0.5, flex: 0.2 - air * 0.4, twist: -0.2 });
  poseArm(pose, rig, 1, { abduct: 0.24 + air * 0.4, elbow: 1.0 + air * 1.3, flex: 0.4 + air * 0.6, twist: -0.5 });
  poseLeg(pose, rig, -1, { flex: phi - 0.2, knee: 2 * phi, ankle: phi + 0.1, abduct: 0.24 + air * 0.16 });
  poseLeg(pose, rig, 1, { flex: phi + 0.34 * air, knee: 2 * phi + air * 0.6, ankle: phi - 0.2, abduct: 0.08 });
};

/**
 * Hit reaction: a flinch that decays.
 *
 * Region is UPPER, so this plays over whatever the legs are doing — a civilian
 * struck while running keeps running. Layering is what makes reactions cheap
 * enough to fire on every hit rather than only on staggers.
 */
const hitClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const jolt = t < 0.14 ? smoothstep(0, 0.14, t) : Math.exp(-4.5 * (t - 0.14)) * (1 - t * 0.2);
  const ring = springDecay(t, 2.6, 5.5) * 0.35;

  poseSpine(pose, rig, { bend: -0.34 * jolt, twist: 0.42 * jolt + ring * 0.1, side: 0.2 * jolt });
  poseHead(pose, rig, -0.5 * jolt + ring * 0.14, 0.4 * jolt, 0.24 * jolt);
  poseArm(pose, rig, -1, {
    abduct: 0.24 + jolt * 0.55,
    elbow: 0.9 + jolt * 1.1,
    flex: -0.3 * jolt,
    twist: -0.2,
    shrug: 0.3 * jolt,
  });
  poseArm(pose, rig, 1, {
    abduct: 0.18 + jolt * 0.3,
    elbow: 0.7 + jolt * 1.5,
    flex: 0.2 + jolt * 0.3,
    twist: -0.4,
    shrug: 0.36 * jolt,
  });
};

/** Stagger: the whole body loses the argument, then catches itself. */
const staggerClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const blow = smoothstep(0, 0.1, t);
  const recover = smoothstep(0.45, 1, t);
  const w = blow * (1 - recover);
  const wobble = springDecay(t, 1.6, 3.2);
  const phi = 0.16 + w * 0.55;

  posePelvis(
    pose,
    rig,
    rig.metrics.legLength * 0.1 * w,
    squatPelvis(rig, phi),
    rig.metrics.legLength * 0.12 * w,
    -0.3 * w,
    0.35 * w + wobble * 0.08,
    0.26 * w
  );
  poseSpine(pose, rig, { bend: -0.4 * w, twist: 0.5 * w, side: 0.3 * w + wobble * 0.06 });
  poseHead(pose, rig, -0.55 * w, 0.4 * w, 0.3 * w);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 0.3 + w * (1.1 + side * 0.3),
      elbow: 0.7 + w * 0.9,
      flex: -0.5 * w,
      twist: -0.5 * w,
      shrug: 0.3 * w,
    });
  }
  // Back foot shoots out to catch the fall — the reason a stagger reads as
  // recoverable rather than as a death.
  poseLeg(pose, rig, -1, { flex: phi - 0.5 * w, knee: 2 * phi, ankle: phi + 0.2 * w, abduct: 0.14 });
  poseLeg(pose, rig, 1, { flex: phi + 0.3 * w, knee: 2 * phi + 0.5 * w, ankle: phi - 0.2, abduct: 0.3 * w + 0.1 });
};

/**
 * Death, ending in a pose the physics system can take over cleanly.
 *
 * The last third barely moves: the ragdoll blend needs the animated pose to be
 * near rest and near still at the handover, or the solver inherits a velocity
 * the character never had and the body kicks. The `ragdoll` marker fires at
 * 0.55 — deliberately BEFORE the clip ends — so physics has the full ~120 ms
 * blend window inside the animation rather than starting after it.
 */
const deathClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const m = rig.metrics;
  const buckle = smoothstep(0, 0.35, t);
  const collapse = smoothstep(0.25, 0.8, t);
  const still = 1 - smoothstep(0.8, 1, t) * 0.15;
  const phi = lerp(0.12, 1.35, buckle);

  posePelvis(
    pose,
    rig,
    -m.legLength * 0.06 * collapse,
    lerp(squatPelvis(rig, phi), m.ankleHeight + m.legLength * 0.16, collapse),
    m.legLength * 0.1 * collapse,
    -0.4 * collapse * still,
    0.3 * collapse,
    -0.5 * collapse
  );
  poseSpine(pose, rig, { bend: 0.5 * buckle - 0.2 * collapse, twist: 0.3 * collapse, side: -0.4 * collapse });
  poseHead(pose, rig, 0.55 * buckle - 0.1 * collapse, 0.3 * collapse, -0.35 * collapse);
  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      abduct: 0.1 + collapse * (0.9 + side * 0.25),
      elbow: 0.3 + collapse * 0.8,
      flex: 0.3 * buckle - 0.7 * collapse,
      twist: 0.3 - collapse * 0.6,
      shrug: -0.2 * collapse,
    });
  }
  poseLeg(pose, rig, -1, { flex: phi * 0.7 + collapse * 0.7, knee: 2 * phi, ankle: 0.1, abduct: 0.3 * collapse });
  poseLeg(pose, rig, 1, { flex: phi * 0.4, knee: 2 * phi + collapse * 0.5, ankle: -0.2, abduct: 0.5 * collapse });
};

/** Taunt: a beckon. Saitama does not do this; Garou very much does. */
const tauntClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const raise = smoothstep(0, 0.28, t) * (1 - smoothstep(0.78, 1, t));
  const beckon = Math.sin(TAU * clamp01((t - 0.28) / 0.5) * 2) * raise;
  const phi = 0.2;

  squat(pose, rig, phi, 0.1, 0.02);
  poseSpine(pose, rig, { bend: -0.1 * raise, twist: -0.18 * raise, side: 0.05 });
  poseHead(pose, rig, -0.16 * raise, 0.1, 0.1 * raise);
  poseArm(pose, rig, -1, {
    abduct: 0.18 + raise * 0.7,
    elbow: 0.4 + raise * (1.5 + beckon * 0.55),
    flex: raise * 0.9,
    twist: -0.9 * raise,
    shrug: 0.1 * raise,
  });
  poseArm(pose, rig, 1, { abduct: 0.14, elbow: 0.35, flex: -0.1, twist: 0.2 });
};

/**
 * The Serious Punch.
 *
 * A held pose, not a flurry: the whole gag is that Saitama's finisher looks
 * like an ordinary punch thrown with slightly more attention. So the clip is
 * mostly stillness — a long, quiet gather, one frame of contact, and a long
 * hold on the follow-through with the arm still out.
 */
const specialClip: ClipFn = (ctx, t, pose) => {
  const { rig } = ctx;
  const gather = smoothstep(0, 0.42, t);
  const strike = smoothstep(0.46, 0.53, t);
  const hold = smoothstep(0.53, 0.62, t);
  const phi = 0.18 + gather * 0.3 - strike * 0.34;

  posePelvis(
    pose,
    rig,
    0,
    squatPelvis(rig, phi),
    0,
    0.08 + gather * 0.16 - strike * 0.2,
    -0.62 * gather + strike * 1.35,
    0
  );
  poseSpine(pose, rig, { bend: 0.24 * gather - 0.3 * strike, twist: 0.72 * gather - 1.6 * strike, side: 0.06 });
  poseHead(pose, rig, 0.1 * gather - 0.14 * strike, 0.5 * gather - 0.85 * strike, 0);
  poseArm(pose, rig, 1, {
    abduct: 0.16 + gather * 0.34 + strike * 0.34,
    elbow: 0.3 + gather * 2.3 - strike * 2.55,
    flex: -0.7 * gather + strike * 2.25,
    twist: -1.0 * gather + strike * 1.5,
    shrug: gather * 0.2 + strike * 0.34,
  });
  poseArm(pose, rig, -1, {
    abduct: 0.2 + gather * 0.24,
    elbow: 0.9 + gather * 1.3 + strike * 0.6,
    flex: 0.3 + gather * 0.6 - strike * 1.05,
    twist: -0.3,
    shrug: gather * 0.1,
  });
  poseLeg(pose, rig, -1, { flex: phi + 0.34, knee: 2 * phi + 0.1, ankle: phi - 0.18, abduct: 0.12, twist: 0.2 });
  poseLeg(pose, rig, 1, {
    flex: phi - 0.5 + strike * 0.4,
    knee: 2 * phi + gather * 0.24,
    ankle: phi + 0.24 - strike * 0.45,
    abduct: 0.22,
    twist: 0.52,
    toe: (strike - hold * 0.3) * 0.8,
  });
};

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

function def(
  slot: ClipName,
  variant: ClipVariant,
  duration: number,
  loop: boolean,
  region: 'full' | 'upper' | 'lower',
  markers: ClipDefinition['markers'] = [],
  locomotive = false,
  referenceSpeed?: number
): ClipDefinition {
  return { slot, variant, duration, loop, region, markers, locomotive, referenceSpeed };
}

/**
 * Reference speeds are FROUDE-NORMALISED: `u = v / sqrt(g · L)`.
 *
 * Not m/s, and — less obviously — not leg-lengths per second either. Dynamic
 * similarity says two bodies are doing the same gait when their Froude numbers
 * match, and Froude goes as v²/(gL), so equal leg-lengths-per-second still
 * leaves a small body strolling while a large one strides. `play('run')` has
 * to mean "run" for a 1.22 m child and a 2.45 m monster alike, so u is the
 * only unit that works.
 *
 *   u = 0.47  comfortable walk   (1.36 m/s for an adult)
 *   u = 1.15  running            (3.33 m/s)
 *   u = 2.10  sprint             (6.08 m/s)
 */
const WALK_SPEED = 0.47;
const RUN_SPEED = 1.15;
const SPRINT_SPEED = 2.1;
const GRAVITY = 9.81;

/** Every clip in the library, in a stable order. */
export const CLIP_LIBRARY: readonly ClipEntry[] = [
  { def: def('idle', 'default', 5.4, true, 'full'), evaluate: idleDefault },
  {
    def: def('idle', 'bored', 9.2, true, 'full', [
      { name: 'voice', at: 0.655, strength: 0.4 },
    ]),
    evaluate: idleBored,
  },
  { def: def('idle', 'combat', 2.1, true, 'full'), evaluate: idleCombat },
  { def: def('idle', 'civilian', 6.3, true, 'full'), evaluate: idleCivilian },
  { def: def('idle', 'panicked', 1.7, true, 'full'), evaluate: idlePanicked },

  { def: def('walk', 'default', 1, true, 'full', [], true, WALK_SPEED), evaluate: noop },
  { def: def('run', 'default', 1, true, 'full', [], true, RUN_SPEED), evaluate: noop },
  { def: def('sprint', 'default', 1, true, 'full', [], true, SPRINT_SPEED), evaluate: noop },
  {
    def: def('flee', 'default', 1, true, 'upper', [], true, RUN_SPEED * 0.92),
    evaluate: fleeStyle,
  },

  {
    def: def('jump', 'default', 0.62, false, 'full', [
      { name: 'launch', at: 0.44, strength: 1, bone: 'Hips' },
      { name: 'whoosh', at: 0.5, strength: 0.5 },
    ]),
    evaluate: jumpClip,
  },
  { def: def('fall', 'default', 1.4, true, 'full'), evaluate: fallClip },
  {
    def: def('land', 'default', 0.78, false, 'full', [
      { name: 'landImpact', at: 0.11, strength: 1, bone: 'Hips' },
    ]),
    evaluate: landClip,
  },

  {
    def: def('attack', 'default', 0.66, false, 'upper', [
      { name: 'windup', at: 0.22, strength: 0.4 },
      { name: 'whoosh', at: 0.4, strength: 0.6 },
      { name: 'impact', at: 0.47, strength: 1, bone: 'RightHand' },
      { name: 'release', at: 0.56, strength: 0.5 },
    ]),
    evaluate: attackClip,
  },
  {
    def: def('heavyAttack', 'default', 1.15, false, 'full', [
      { name: 'windup', at: 0.2, strength: 0.6 },
      { name: 'whoosh', at: 0.55, strength: 0.9 },
      { name: 'release', at: 0.56, strength: 1 },
      { name: 'impact', at: 0.6, strength: 1, bone: 'RightHand' },
    ]),
    evaluate: heavyAttackClip,
  },
  { def: def('block', 'default', 0.45, false, 'upper'), evaluate: blockClip },
  {
    def: def('dodge', 'default', 0.52, false, 'full', [
      { name: 'whoosh', at: 0.2, strength: 0.5 },
      { name: 'footfall', at: 0.78, strength: 0.5 },
    ]),
    evaluate: dodgeClip,
  },
  {
    def: def('hit', 'default', 0.42, false, 'upper', [{ name: 'voice', at: 0.05, strength: 0.7 }]),
    evaluate: hitClip,
  },
  {
    def: def('stagger', 'default', 0.95, false, 'full', [
      { name: 'voice', at: 0.06, strength: 0.9 },
      { name: 'footfall', at: 0.42, strength: 0.7 },
    ]),
    evaluate: staggerClip,
  },
  {
    def: def('death', 'default', 1.5, false, 'full', [
      { name: 'voice', at: 0.02, strength: 1 },
      { name: 'ragdoll', at: 0.55, strength: 1, bone: 'Hips' },
    ]),
    evaluate: deathClip,
  },
  { def: def('taunt', 'default', 1.6, false, 'upper'), evaluate: tauntClip },
  {
    def: def('special', 'default', 2.4, false, 'full', [
      { name: 'windup', at: 0.3, strength: 1 },
      { name: 'release', at: 0.5, strength: 1 },
      { name: 'impact', at: 0.52, strength: 1, bone: 'RightHand' },
    ]),
    evaluate: specialClip,
  },
];

const BY_KEY = new Map<string, ClipEntry>();
for (const entry of CLIP_LIBRARY) BY_KEY.set(`${entry.def.slot}:${entry.def.variant}`, entry);

/**
 * Resolve a slot and variant to a clip.
 *
 * Falls back variant-first, then to `idle` — never throws and never returns
 * undefined. `IAnimator`'s contract says a missing slot must degrade to idle
 * rather than break the frame, and every character in this game is generated,
 * so "missing" here means "this variant was never written", not "the asset
 * failed to load".
 */
export function findClip(slot: ClipName, variant: ClipVariant = 'default'): ClipEntry {
  return (
    BY_KEY.get(`${slot}:${variant}`) ??
    BY_KEY.get(`${slot}:default`) ??
    BY_KEY.get('idle:default')!
  );
}

/** True when the library has a real entry for this slot and variant. */
export function hasClip(slot: ClipName, variant: ClipVariant = 'default'): boolean {
  return BY_KEY.has(`${slot}:${variant}`) || BY_KEY.has(`${slot}:default`);
}

/**
 * Clip duration for a specific body, in seconds.
 *
 * For a locomotive slot this is the GAIT CYCLE PERIOD, taken from the same
 * solver the runtime uses, so a style overlay keyed to normalised clip time
 * stays locked to the stride instead of drifting against it.
 */
export function clipDuration(entry: ClipEntry, rig: AnimRig): number {
  if (entry.def.locomotive) {
    const gait = solveGait(clipSpeed(entry, rig), rig.metrics.legLength);
    return 1 / Math.max(1e-3, gait.cycleFrequency);
  }
  return entry.def.duration * Math.sqrt(Math.max(rig.metrics.legLength, 0.05) / REFERENCE_LEG);
}

/** Ground speed a locomotive slot means for this body, in m/s. */
export function clipSpeed(entry: ClipEntry, rig: AnimRig): number {
  if (!entry.def.locomotive) return 0;
  const L = Math.max(rig.metrics.legLength, 0.05);
  return (entry.def.referenceSpeed ?? 0) * Math.sqrt(GRAVITY * L);
}

/** Default clip parameters. */
export function defaultClipParams(): ClipParams {
  return { boredom: 0, alertness: 0, phaseOffset: 0, vigour: 1 };
}
