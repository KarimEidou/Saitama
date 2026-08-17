/**
 * CIVILIAN CLIPS — the two poses a crowd needs that a hero library does not
 *
 * The animation library covers everything a fighter does. It does not cover
 * the two things a bystander does, because no hero ever does them:
 *
 *   GAWK   stand in the open, phone up, filming the thing that is about to
 *          kill you. This is the single most One-Punch-Man behaviour in the
 *          game. The joke of the setting is that City Z has normalised
 *          kaiju to the point of content, and it is also what makes the
 *          collateral damage land: the people in the blast radius chose to
 *          be there.
 *   COWER  give up, fold up, and wait. What is left when there is nowhere to
 *          run to.
 *
 * ── THEY RIDE ON EXISTING SLOTS, BECAUSE `ClipName` IS A CONTRACT ─────────
 * `ClipName` is a closed union in `src/types/character.ts` that no single
 * workstream may extend, and it has no `gawk`. Variants exist precisely for
 * this: one slot, several performances. Gawk is `taunt:civilian` — `taunt` is
 * already the slot for a non-combat full-body expressive action, and a
 * bystander filming you is exactly that. Cower is `block:panicked` — `block`
 * already means "protect yourself", and this is what that looks like without
 * training.
 *
 * ── WRITTEN AGAINST THE POSTURE VOCABULARY, NOT QUATERNIONS ───────────────
 * `poseArm`/`poseLeg`/`poseSpine`/`posePelvis` are exported by the animation
 * system for exactly this. Building these clips out of raw quaternions would
 * duplicate the hinge-axis reasoning documented in `posture.ts` and get it
 * subtly wrong on the mirrored side, which is the standard way a procedural
 * character ends up with one elbow bending the wrong way.
 *
 * ── BOTH LOOP SEAMLESSLY, WHICH IS NOT OPTIONAL HERE ──────────────────────
 * The VAT shader wraps every clip with `mod(t, frames)` — it does not read the
 * `loop` flag. A clip whose last frame does not meet its first therefore POPS
 * once per cycle on all 250 instances at once, which is extremely visible. So
 * every oscillator below is a whole number of cycles over the clip's duration.
 */

import { TAU } from '@/util';
import {
  poseArm,
  poseHead,
  poseLeg,
  posePelvis,
  poseSpine,
  type ClipEntry,
  type ClipFn,
  type ClipParams,
} from '@/characters/anim';
import type { AnimRig, Pose } from '@/characters/anim';

/** Left is -1, right is +1. */
const SIDES = [-1, 1] as const;

/**
 * Pelvis height for a symmetric squat that keeps both soles flat.
 *
 * With `hip = phi`, `knee = 2·phi`, `ankle = phi` the shank leans back by
 * exactly as much as the thigh leans forward, so the ankle stays under the hip
 * and the foot stays level. The hip then sits `(thigh + shank)·cos(phi)` above
 * the sole — exact, not fitted, which is what stops a deep crouch from sinking
 * the character through the pavement.
 */
function squatHipHeight(rig: AnimRig, phi: number): number {
  const m = rig.metrics;
  return m.ankleHeight + (m.thigh + m.shank) * Math.cos(phi);
}

/* -------------------------------------------------------------------------- */
/* Gawk                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Standing, both hands up at eye level holding a phone, tracking the action.
 *
 * Three things carry the read at 40-150 m, which is the only distance this is
 * ever seen from:
 *
 *   1. the ELBOWS — arms folded up in front of the face is a silhouette no
 *      other clip in the game produces, and silhouette is all that survives at
 *      a hundred metres;
 *   2. the head TILTED BACK — everyone is looking up, because the thing they
 *      are filming is four storeys tall;
 *   3. the slow yaw drift — a crowd of people all panning to follow something
 *      reads as attention, and attention reads as a threat off-screen.
 */
const gawkClip: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const m = rig.metrics;
  const p = t + params.phaseOffset;
  const v = params.vigour;

  // Two full cycles of breath, one of sway, over the clip. Whole numbers, so
  // the wrap is continuous.
  const breath = Math.sin(TAU * 2 * p);
  const sway = Math.sin(TAU * p);
  // Tracking the monster: a slow pan with a faster jitter riding on it, so it
  // reads as following something moving rather than as an idle head turn.
  const track = Math.sin(TAU * p + 0.9) * 0.36 + Math.sin(TAU * 3 * p) * 0.06;
  // Leaning back a little. Nobody films a monster leaning towards it.
  const lean = 0.06 + 0.03 * sway;

  posePelvis(
    pose,
    rig,
    sway * m.legLength * 0.018 * v,
    m.hipHeight - m.legLength * 0.012,
    -m.legLength * 0.02,
    -lean,
    track * 0.35,
    sway * 0.03
  );
  poseSpine(pose, rig, {
    bend: -0.06 - breath * 0.02 * v,
    twist: track * 0.4,
    side: -sway * 0.035,
  });
  // Chin up: the subject of the shot is above the horizon.
  poseHead(pose, rig, -0.34 + breath * 0.02, track * 0.5, sway * 0.03);

  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      // Both arms forward and up. `abduct` is measured from hanging, so 1.28
      // rad puts the upper arm a little above horizontal.
      abduct: 1.28 + breath * 0.02 * v,
      flex: 0.5 + breath * 0.015,
      // Elbows folded hard, hands meeting in front of the face.
      elbow: 1.62 + sway * side * 0.05,
      twist: side * -0.55,
      wrist: -0.28,
      shrug: 0.16,
    });
    // Weight on one leg, the other relaxed — the shift is what stops a row of
    // gawkers from looking like a row of bollards.
    poseLeg(pose, rig, side, {
      flex: 0.02 + sway * side * 0.05,
      knee: 0.1 + Math.max(0, sway * side) * 0.14,
      abduct: 0.045,
      twist: side * 0.09,
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Cower                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Deep crouch, spine curled, forearms over the head.
 *
 * The tremble is a 6 Hz oscillation at a couple of millimetres. It is far too
 * small to see on one civilian and it is the entire read on twenty of them:
 * a static crouch looks like a prop, and a crouch that is very slightly
 * vibrating looks like a person.
 */
const cowerClip: ClipFn = (ctx, t, pose) => {
  const { rig, params } = ctx;
  const m = rig.metrics;
  const p = t + params.phaseOffset;
  const v = params.vigour;

  // Whole cycles again: 1 for the rock, 12 for the shiver over the clip.
  const rock = Math.sin(TAU * p);
  const shiver = Math.sin(TAU * 12 * p) * 0.5 + Math.sin(TAU * 7 * p) * 0.5;
  const phi = 1.02 + rock * 0.045 * v;

  posePelvis(
    pose,
    rig,
    shiver * m.legLength * 0.004,
    squatHipHeight(rig, phi),
    -m.legLength * 0.06,
    0.34 + rock * 0.03,
    shiver * 0.012,
    shiver * 0.01
  );
  // Curled forward over the knees, which is what "protect the soft parts"
  // resolves to without any training.
  poseSpine(pose, rig, { bend: 0.62 + rock * 0.04, twist: shiver * 0.02, side: 0 });
  // Head tucked hard down. The chin-to-chest angle is most of the silhouette.
  poseHead(pose, rig, 0.55 + rock * 0.03, shiver * 0.03, 0);

  for (const side of SIDES) {
    poseArm(pose, rig, side, {
      // Forearms over the crown, elbows out — hands clasped behind the head.
      abduct: 1.5,
      flex: 0.95,
      elbow: 2.35 + rock * 0.05,
      twist: side * -0.9,
      wrist: -0.2,
      shrug: 0.34,
    });
    poseLeg(pose, rig, side, {
      flex: phi,
      knee: 2 * phi,
      ankle: phi,
      abduct: 0.16,
      twist: side * 0.22,
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Entries                                                                    */
/* -------------------------------------------------------------------------- */

/** `taunt:civilian` — filming the monster. */
export const GAWK_CLIP: ClipEntry = {
  def: {
    slot: 'taunt',
    variant: 'civilian',
    duration: 4.6,
    loop: true,
    markers: [],
    locomotive: false,
    region: 'full',
  },
  evaluate: gawkClip,
};

/** `block:panicked` — curled up, waiting for it to be over. */
export const COWER_CLIP: ClipEntry = {
  def: {
    slot: 'block',
    variant: 'panicked',
    duration: 2.4,
    loop: true,
    markers: [],
    locomotive: false,
    region: 'full',
  },
  evaluate: cowerClip,
};

/** Bake key for gawk, as `bakeVat` indexes it. */
export const GAWK_KEY = 'taunt:civilian';

/** Bake key for cower. */
export const COWER_KEY = 'block:panicked';

/**
 * Evaluate one of the civilian clips straight into a pose.
 *
 * The near tier drives these through `ProceduralAnimator.playAdditive`, which
 * resolves clips out of the shared library and so cannot see entries defined
 * here. Exposing the raw evaluator lets the near tier apply the same pose the
 * VAT crowd is displaying, so a civilian promoted from mid to near does not
 * visibly change what they are doing at the moment they gain a skeleton.
 */
export function evaluateCrowdClip(
  entry: ClipEntry,
  rig: AnimRig,
  params: ClipParams,
  t: number,
  pose: Pose
): void {
  entry.evaluate({ rig, params }, t - Math.floor(t), pose);
}
