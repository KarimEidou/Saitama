/**
 * PHYSICS TUNING CONSTANTS
 *
 * Every magic number the simulation depends on, in one place, in SI units
 * (metres, kilograms, seconds).
 *
 * The movement numbers are deliberately NOT realistic. Saitama's traversal is
 * the game's power fantasy: he crosses a city block in a couple of seconds and
 * leaps over the skyline. Gravity is roughly 2.2x Earth so the ascent is fast
 * and readable, and a fall multiplier makes the descent snappier still —
 * a "floaty apex, heavy landing" curve that platformers have used for decades
 * because a symmetric parabola feels sluggish at these speeds.
 */

import { DEG2RAD } from '@/util';

/* -------------------------------------------------------------------------- */
/* Solver                                                                     */
/* -------------------------------------------------------------------------- */

/** Fixed simulation step. 60 Hz regardless of render rate. */
export const FIXED_STEP = 1 / 60;

/**
 * Maximum fixed steps consumed per frame. Caps the spiral of death: after a
 * long stall (tab restore, GC pause) we drop simulation time rather than
 * spending 200 ms catching up and stalling again.
 */
export const MAX_SUB_STEPS = 4;

/** Solver iterations. Rapier's default is 4; 3 is measurably cheaper and holds
 *  up for debris piles, which are the dominant mobile workload. */
export const SOLVER_ITERATIONS = 3;

/** CPU budget for one whole simulation step on a mid-range phone. */
export const SIM_BUDGET_MS = 7;

/* -------------------------------------------------------------------------- */
/* Gravity                                                                    */
/* -------------------------------------------------------------------------- */

/** Base gravity on Y. Roughly 2.2x Earth — see the note at the top. */
export const GRAVITY_Y = -22;

/** Extra gravity applied while descending, for a snappier fall. */
export const FALL_GRAVITY_MULTIPLIER = 1.6;

/* -------------------------------------------------------------------------- */
/* Character movement                                                         */
/* -------------------------------------------------------------------------- */

/** Ground run speed. */
export const RUN_SPEED = 9;

/** Dash speed. */
export const DASH_SPEED = 22;

/** Target jump apex above the take-off point. */
export const JUMP_APEX_HEIGHT = 28;

/**
 * Take-off speed reaching `JUMP_APEX_HEIGHT` under `GRAVITY_Y`.
 * v = sqrt(2 * g * h) — about 35.1 m/s.
 */
export const JUMP_SPEED = Math.sqrt(2 * Math.abs(GRAVITY_Y) * JUMP_APEX_HEIGHT);

/** Terminal fall speed, so a fall from the skyline stays controllable. */
export const MAX_FALL_SPEED = 90;

/** Step height climbed without jumping. */
export const STEP_HEIGHT = 0.5;

/** Minimum free width required on top of a step before it can be climbed. */
export const STEP_MIN_WIDTH = 0.2;

/** Steepest walkable slope. */
export const MAX_SLOPE_ANGLE = 50 * DEG2RAD;

/** Slope beyond which the character slides back down. */
export const MIN_SLOPE_SLIDE_ANGLE = 55 * DEG2RAD;

/** Ground-snap search distance; keeps the character glued over crests. */
export const GROUND_SNAP_DISTANCE = 0.35;

/** Collision skin. Too small destabilises the controller, too large floats it. */
export const CHARACTER_SKIN = 0.02;

/** Default capsule for the player: total height and radius. */
export const PLAYER_HEIGHT = 1.75;
export const PLAYER_RADIUS = 0.3;

/**
 * Fall height that turns a landing into a ground slam. Above this the
 * controller emits `PlayerLanded` with `createsCrater`, which the destruction
 * system turns into detached fracture chunks.
 */
export const GROUND_SLAM_FALL_HEIGHT = 15;

/** Radius of the ground-slam shock, scaled by fall height beyond the threshold. */
export const GROUND_SLAM_BASE_RADIUS = 6;
export const GROUND_SLAM_RADIUS_PER_METRE = 0.25;
export const GROUND_SLAM_MAX_RADIUS = 26;

/** Coyote time: grace period after walking off a ledge during which jump works. */
export const COYOTE_TIME = 0.12;

/* -------------------------------------------------------------------------- */
/* Ragdolls                                                                   */
/* -------------------------------------------------------------------------- */

/** Rigid bodies per ragdoll. Pelvis, chest, head, 2x(arm, forearm, thigh, shin, foot). */
export const RAGDOLL_BODY_COUNT = 13;

/** Blend time from the animated pose into full physics. */
export const RAGDOLL_BLEND_SECONDS = 0.12;

/** Hard cap on simultaneously simulated ragdolls. */
export const MAX_ACTIVE_RAGDOLLS = 8;

/** Fade applied to a ragdoll frozen because the cap was exceeded. */
export const RAGDOLL_FADE_SECONDS = 1.5;

/** Linear/angular damping on ragdoll limbs. Kills the jitter that spherical
 *  joint chains develop when limbs interpenetrate. */
export const RAGDOLL_LINEAR_DAMPING = 0.15;
export const RAGDOLL_ANGULAR_DAMPING = 1.2;

/** Human tissue is close to water; 985 kg/m^3 puts a 1.75 m adult near 70 kg. */
export const RAGDOLL_DENSITY = 985;

/**
 * Ceiling on the speed an activation impulse may impart to a single limb.
 *
 * Punch power in this game is unbounded, and handing a 5 kg forearm a literal
 * 3000 N·s produces 400 m/s — six metres of travel per solver step, which no
 * joint constraint can hold and which reads on screen as the ragdoll shattering
 * rather than being hit hard. Clamping to a fast-but-solvable speed keeps the
 * hit looking brutal and the skeleton intact.
 */
export const RAGDOLL_MAX_IMPULSE_SPEED = 45;

/** Extra solver iterations for ragdoll limbs. Joint chains need them; nothing
 *  else in the game does, and there are at most 8 ragdolls. */
export const RAGDOLL_SOLVER_ITERATIONS = 8;

/* -------------------------------------------------------------------------- */
/* Debris                                                                     */
/* -------------------------------------------------------------------------- */

/** Absolute ceiling on simultaneously live debris pieces. */
export const DEBRIS_HARD_CAP = 300;

/** Seconds a settled piece fades out over before being recycled. */
export const DEBRIS_FADE_SECONDS = 12;

/** Seconds a piece lives at full opacity before its fade starts. */
export const DEBRIS_REST_SECONDS = 8;

/**
 * Largest AABB extent that still skips the solver. Below this a piece is
 * gravel: nobody can tell it is not simulated, and 200 gravel bodies cost more
 * than the entire rest of the frame.
 */
export const DEBRIS_MIN_PHYSICS_SIZE = 0.18;

/** Bounce retained by a ballistic (non-simulated) piece on its single bounce. */
export const BALLISTIC_RESTITUTION = 0.35;

/** Horizontal speed retained by a ballistic piece after its bounce. */
export const BALLISTIC_GROUND_FRICTION = 0.45;

/** Debris material densities in kg/m^3, by structure material. */
export const MATERIAL_DENSITY: Readonly<Record<string, number>> = {
  concrete: 2400,
  brick: 1900,
  asphalt: 2300,
  glass: 2500,
  metal: 7800,
  wood: 700,
};

/** Fallback density when a chunk's material is unknown. */
export const DEFAULT_DEBRIS_DENSITY = 2400;

/* -------------------------------------------------------------------------- */
/* Impulse propagation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Velocity change applied to a body at the very centre of a maximum-power
 * shockwave. Impulses scale with mass so heavy and light debris accelerate
 * alike — physically wrong, visually right, and it stops a pebble reaching
 * escape velocity next to a girder that barely twitches.
 */
export const SHOCKWAVE_MAX_DELTA_V = 45;

/** Punch `power` that maps to half of `SHOCKWAVE_MAX_DELTA_V`. */
export const SHOCKWAVE_POWER_HALF = 5000;

/** Spin imparted by a shockwave, as a fraction of the linear delta-v. */
export const SHOCKWAVE_SPIN_FACTOR = 0.35;

/** Upward bias so debris lifts off the ground instead of grinding along it. */
export const SHOCKWAVE_LIFT = 0.35;
