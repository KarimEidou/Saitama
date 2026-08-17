/**
 * PROGRESSION TUNING
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE DESIGN THESIS, IN NUMBERS
 *
 *  The protagonist wins every fight instantly. A progression system built on
 *  kills therefore has nothing to measure — it would hand out a promotion
 *  every four seconds and mean nothing.
 *
 *  So rank does not move on kills AT ALL. `POINTS_PER_KILL` is 0 and it is not
 *  a placeholder. Rank moves on two things:
 *
 *    WITNESSED SAVES     — somebody credible has to see you do it.
 *    REPORTED COLLATERAL — and the damage gets reported whether or not
 *                          anyone saw you, because the buildings are still
 *                          missing in the morning.
 *
 *  That asymmetry is the whole joke and the whole system. Credit needs an
 *  audience; blame does not. Meanwhile Genos, standing in the same fight,
 *  banks 2.4x the credit because he is an articulate cyborg with recording
 *  equipment and the player is a bald man in a yellow jumpsuit nobody
 *  believes. The player watches his own student climb past him. That gap IS
 *  the reward — the number the HUD should be showing.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { HeroClass, ThreatTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* The ladder                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Seats per class, canonical. Rank 1 is the top of each class, so C-class
 * rank 390 is the very bottom of the Hero Association and S-class rank 1 is
 * the strongest hero alive.
 */
export const CLASS_SIZES: Readonly<Record<HeroClass, number>> = {
  C: 390,
  B: 100,
  A: 39,
  S: 17,
};

/** Ascending order of the ladder. Never reorder. */
export const CLASS_ORDER: readonly HeroClass[] = ['C', 'B', 'A', 'S'];

/**
 * Hero points to climb ONE rank inside each class.
 *
 * Steeply super-linear across classes: the gap between C-200 and C-199 is
 * paperwork, the gap between S-3 and S-2 is a different order of being. It
 * also means a C-class hero can climb visibly in a session, which is what
 * makes the early game legible.
 */
export const CLASS_STEP_COST: Readonly<Record<HeroClass, number>> = {
  C: 10,
  B: 45,
  A: 190,
  S: 850,
};

/** Extra points demanded on top of the step to cross into the next class up. */
export const CLASS_PROMOTION_COST: Readonly<Record<HeroClass, number>> = {
  C: 260, // C-1 -> B-100: the Association actually has to notice you
  B: 900,
  A: 3400,
  S: 0, // nowhere further to go
};

/** Where the player starts. Canon, and non-negotiable. */
export const START_HERO_CLASS: HeroClass = 'C';
export const START_HERO_RANK = 388;
export const START_HERO_NAME = 'Caped Baldy';

/* -------------------------------------------------------------------------- */
/* Where points come from                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ZERO. Not a stub, not "to be tuned later".
 *
 * A monster kill contributes to rank only through an INCIDENT REPORT, which
 * needs either witnesses or an accepted Hero Association request. Punching a
 * thousand monsters to death in an empty alley moves the rank by nothing,
 * which is precisely the character's situation.
 */
export const POINTS_PER_KILL = 0;

/** Base points for a rescue somebody credible actually saw. */
export const POINTS_PER_WITNESSED_SAVE = 12;

/**
 * Points for a rescue nobody saw. Deliberately near-zero rather than zero:
 * the occasional saved civilian does tell someone, eventually, and a hard 0
 * makes the system feel broken rather than unfair.
 */
export const POINTS_PER_UNWITNESSED_SAVE = 0.4;

/** Penalty per civilian lost, and the multiplier when the player caused it. */
export const POINTS_PER_CIVILIAN_LOST = -35;
export const PLAYER_FAULT_MULTIPLIER = 2.5;

/** Points lost per unit of REPORTED collateral cost. */
export const POINTS_PER_COLLATERAL_UNIT = -0.0016;

/**
 * How much collateral gets reported with no witnesses at all, and how much
 * more with a full crowd.
 *
 * The base is high on purpose. This is the asymmetry: a save needs an audience
 * to count, a flattened block does not.
 */
export const COLLATERAL_REPORT_BASE = 0.55;
export const COLLATERAL_REPORT_WITNESSED = 0.45;

/** Points for resolving an incident, by the threat tier that was dispatched. */
export const INCIDENT_POINTS_BY_TIER: Readonly<Record<ThreatTier, number>> = {
  wolf: 8,
  tiger: 25,
  demon: 90,
  dragon: 420,
  god: 2600,
};

/**
 * Multiplier on incident points when the resolution was witnessed vs. not.
 *
 * An unwitnessed resolution still counts for something when it came from an
 * accepted request — the Association sent you, so the monster simply stopping
 * is evidence. Walking into an unreported fight and winning it alone is worth
 * almost nothing.
 */
export const INCIDENT_WITNESSED_MULTIPLIER = 1.0;
export const INCIDENT_DISPATCHED_MULTIPLIER = 0.75;
export const INCIDENT_UNWITNESSED_MULTIPLIER = 0.06;

/* -------------------------------------------------------------------------- */
/* Witnesses                                                                  */
/* -------------------------------------------------------------------------- */

/** Metres within which a witness can testify to an incident. */
export const WITNESS_RADIUS = 45;

/**
 * Credibility weight by witness kind. This is the Association's word, not
 * ours: a registered hero's report is taken at face value, a civilian's is
 * taken with a shrug, and the player's own account of what he did is worth
 * nothing whatsoever, which is canon.
 */
export const WITNESS_CREDIBILITY = {
  civilian: 1,
  hero: 4.5,
  press: 7,
  camera: 3,
  self: 0,
} as const;

export type WitnessKind = keyof typeof WITNESS_CREDIBILITY;

/**
 * Total credibility at which an incident is fully corroborated. Roughly seven
 * bystanders, or two heroes, or one news crew.
 */
export const WITNESS_SATURATION = 7;

/* -------------------------------------------------------------------------- */
/* Rivals                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Credit multiplier for a rival present at the same incident.
 *
 * Genos above 1 is the entire dramatic irony. He gives statements, he has
 * recordings, he looks like what people expect a hero to look like. The
 * player, standing next to him, having done the actual work, is credited at
 * 1.0 — and only when someone saw him.
 */
export const RIVAL_CREDIT_MULTIPLIER = {
  genos: 2.4,
  mumen: 0.9,
  tank: 1.6,
} as const;

/**
 * Points a rival banks per in-game day from work the player never sees.
 *
 * Without this the world stops existing when the player goes shopping, and
 * the rank table becomes a mirror rather than a league. Genos is out there.
 */
export const RIVAL_OFFSCREEN_POINTS_PER_DAY = {
  genos: 34,
  mumen: 6,
  tank: 14,
} as const;

export type RivalId = keyof typeof RIVAL_CREDIT_MULTIPLIER;

/* -------------------------------------------------------------------------- */
/* Boredom                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Rank gain multiplier at maximum boredom.
 *
 * Not zero: a hard lock is a wall the player cannot see or plan around. 0.15
 * is a throttle they can feel — the numbers still move, just visibly badly —
 * which pushes them towards the heroism that drains it instead of towards the
 * wiki.
 */
export const BOREDOM_RANK_FLOOR = 0.15;

/** Exponent on the throttle. Above 1 keeps mild boredom nearly harmless. */
export const BOREDOM_RANK_EXPONENT = 1.35;

/** Above this, "genuinely fun fight" encounters stop appearing at all. */
export const BOREDOM_FUN_FIGHT_LOCK = 0.72;

/**
 * Boredom deltas for heroism. Every one is NEGATIVE — boredom drains through
 * being a hero and through nothing else. There is no "wait it out" path,
 * because waiting it out is exactly the character's problem.
 */
export const HEROISM_BOREDOM_RELIEF = {
  /** Reached a civilian before the timer ran out. */
  arrivedInTime: -0.06,
  /** Took a hit meant for someone who could not survive it. */
  bodyBlock: -0.14,
  /** Caught falling debris instead of letting it land. */
  caughtDebris: -0.045,
  /** Finished an incident with zero collateral cost. */
  zeroCollateral: -0.09,
  /** Every ally still standing at the end. */
  alliesStanding: -0.07,
  /** Rescued someone with nobody watching — done purely because it mattered. */
  unwitnessedRescue: -0.05,
} as const;

export type HeroicDeed = keyof typeof HEROISM_BOREDOM_RELIEF;

/** Boredom the player gains from outcomes only progression can see. */
export const BOREDOM_ON_QUEST_FAILED = 0.04;
/**
 * Missing the bargain sale.
 *
 * Larger than a failed subjugation, and that is the correct relative weight.
 * The monster was never going to be interesting. The sale was the one thing
 * that day with an outcome he could not guarantee.
 */
export const BOREDOM_ON_MISSED_SALE = 0.12;
/** Relief from completing an errand that had nothing to do with heroism. */
export const BOREDOM_ON_ERRAND_COMPLETE = -0.08;

/* -------------------------------------------------------------------------- */
/* Reputation                                                                 */
/* -------------------------------------------------------------------------- */

export const START_REPUTATION = 50;
export const REPUTATION_MIN = 0;
export const REPUTATION_MAX = 100;

/** Reputation per witnessed save, and per unit of reported collateral. */
export const REPUTATION_PER_WITNESSED_SAVE = 1.2;
export const REPUTATION_PER_COLLATERAL_UNIT = -0.00035;

/* -------------------------------------------------------------------------- */
/* Saves                                                                      */
/* -------------------------------------------------------------------------- */

/** Bump on any breaking change to `ISaveGame`. Migrations key off it. */
export const SAVE_VERSION = 1;

/** Preferences/localStorage key. */
export const SAVE_KEY = 'saitama.save.slot0';
