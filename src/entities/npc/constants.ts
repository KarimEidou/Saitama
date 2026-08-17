/**
 * CROWD TUNING — every magic number in one place
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS SYSTEM IS THE POINT OF THE GAME
 *
 *  Saitama is never in danger. Nothing threatens him, nothing ever will, and
 *  a game built around a protagonist who cannot lose has to find its stakes
 *  somewhere else. It finds them here. The city is fragile, the people in it
 *  are fragile, and the only thing a punch can actually cost is THEM.
 *
 *  So this is not set dressing. The crowd is the health bar.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THREE TIERS, PICKED BY DISTANCE ───────────────────────────────────────
 *   NEAR  < 40 m,  <= 16 agents   real skeletons, real brains, real deaths
 *   MID   40-150 m, <= 250 agents VAT instances on a flow field
 *   FAR   > 150 m                 a scalar density feeding the audio bed
 *
 * The cliff between NEAR and MID is deliberate and load-bearing: an agent is
 * either something the player can save individually or a texture of motion,
 * and pretending otherwise costs the whole frame budget for people who are
 * three pixels tall.
 */

import { CHUNK_SIZE, WORLD_MIN, WORLD_SIZE } from '@/spatial/constants';

/* -------------------------------------------------------------------------- */
/* Tiers                                                                      */
/* -------------------------------------------------------------------------- */

/** Metres. Inside this, civilians are individually simulated and skinned. */
export const NEAR_RADIUS = 40;

/** Metres. Outside this, nothing is simulated; only a density number survives. */
export const MID_RADIUS = 150;

/**
 * Hysteresis band, metres. A civilian must be this far past a tier boundary
 * before it changes tier.
 *
 * Without it, an agent loitering at exactly 40 m gets promoted and demoted
 * every frame, and promotion costs a skeleton bind plus an animator. The band
 * is 4 m — a second of walking, so a real crossing still happens promptly.
 */
export const TIER_HYSTERESIS = 4;

/** Hard cap on individually-simulated civilians. */
export const NEAR_CAP = 16;

/** Hard cap on VAT-instanced civilians. */
export const MID_CAP = 250;

/** Distinct body archetypes in the instanced crowd — one draw call each. */
export const CROWD_ARCHETYPES = 6;

/** Wardrobe palettes selectable per instance. Two colours each (cloth, trim). */
export const CROWD_PALETTES = 16;

/* -------------------------------------------------------------------------- */
/* Field grid                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Cell size of the alarm and flow fields, metres.
 *
 * The chunk grid is 96 m, which is far too coarse to steer a pedestrian round
 * a building — a whole city block fits inside one chunk. 12 m divides 96
 * exactly (8x8 field cells per chunk), so a field cell never straddles a chunk
 * boundary and `chunkIndex` maps onto field coordinates by an integer shift.
 * It is also roughly a street width, which is the resolution at which "go
 * round that corner" is a meaningful instruction.
 */
export const FIELD_CELL = 12;

/** Field cells per side. 1536 / 12. */
export const FIELD_DIM = WORLD_SIZE / FIELD_CELL;

/** Total field cells. */
export const FIELD_COUNT = FIELD_DIM * FIELD_DIM;

/** World-space X/Z of field cell (0, 0)'s minimum corner. */
export const FIELD_ORIGIN = WORLD_MIN;

/** Field cells spanning one streaming chunk. */
export const FIELD_CELLS_PER_CHUNK = CHUNK_SIZE / FIELD_CELL;

/* -------------------------------------------------------------------------- */
/* Alarm propagation                                                          */
/* -------------------------------------------------------------------------- */

/** Alarm field ticks per second. */
export const ALARM_HZ = 10;

/** Seconds between alarm ticks. */
export const ALARM_DT = 1 / ALARM_HZ;

/**
 * How much alarm survives one cell of travel.
 *
 * Sets the field's RANGE rather than its speed: a seed of intensity 1 decays
 * to the flee threshold after `ln(threshold) / ln(transfer)` cells. At 0.86
 * per 12 m that is about 260 m for the gawk threshold and 140 m for the flee
 * threshold — a dragon-level monster empties the district, a wolf-level one
 * clears a street.
 */
export const ALARM_TRANSFER = 0.86;

/**
 * Ceiling on how fast a cell's alarm may rise, per second.
 *
 * This — not the diffusion coefficient — is what sets the FRONT SPEED, and
 * front speed is the thing the player actually perceives. A pure diffusion
 * step spreads as sqrt(t), so the wave visibly decelerates and the far side of
 * the street reacts minutes after the near side; a rate limit gives a front
 * that advances at a near-constant metres per second, which is what a
 * spreading scream looks like.
 *
 * 0.55/s over a 12 m cell works out around 25-35 m/s: deliberately faster than
 * a real crowd's panic wave (1-5 m/s), because the threats here are ten metres
 * tall and audible across a district. Slower and the player outruns the panic,
 * which makes the city read as oblivious.
 */
export const ALARM_RISE = 0.55;

/** How fast alarm bleeds away once the threat stops feeding it, per second. */
export const ALARM_DECAY = 0.42;

/** Alarm at or above which a civilian stops to look. */
export const ALARM_GAWK = 0.1;

/** Alarm at or above which an average civilian runs. */
export const ALARM_FLEE = 0.38;

/** Alarm at or above which a cornered civilian gives up and cowers. */
export const ALARM_COWER = 0.82;

/** Seeded alarm falls off to zero over this radius around a threat, metres. */
export const THREAT_SEED_RADIUS = 26;

/** Seconds an impulse seed (explosion, shockwave) keeps feeding the field. */
export const IMPULSE_SEED_SECONDS = 1.4;

/* -------------------------------------------------------------------------- */
/* Flow field                                                                 */
/* -------------------------------------------------------------------------- */

/** Flow field rebuilds per second. */
export const FLOW_HZ = 4;

/** Seconds between flow rebuilds. */
export const FLOW_DT = 1 / FLOW_HZ;

/** Dial's-algorithm edge cost for an orthogonal step. */
export const STEP_ORTHO = 10;

/** Dial's-algorithm edge cost for a diagonal step. `round(10 * sqrt(2))`. */
export const STEP_DIAG = 14;

/** Sentinel for "no path" / unreachable in an integer cost field. */
export const COST_UNREACHABLE = 0x7fffffff;

/**
 * Extra cost per cell for hugging a wall.
 *
 * Without it, the shortest path round a building runs flush against its
 * façade, so the whole crowd files along the wall in a single-file line and
 * the middle of the street stays empty. A small penalty on cells adjacent to
 * geometry pushes the flow to the street centre, where pedestrians actually
 * walk, at the cost of a metre or two of path length.
 */
export const WALL_HUG_PENALTY = 26;

/* -------------------------------------------------------------------------- */
/* Locomotion                                                                 */
/* -------------------------------------------------------------------------- */

/** Metres per second, commuting. */
export const SPEED_WALK = 1.35;

/** Metres per second, fleeing. */
export const SPEED_FLEE = 4.4;

/** Metres per second squared. Civilians are not sports cars. */
export const ACCELERATION = 7.5;

/** Radians per second a civilian may turn while moving. */
export const TURN_RATE = 6.5;

/** Collision radius of a civilian, metres. Shoulder half-width plus slack. */
export const AGENT_RADIUS = 0.26;

/** Twice `AGENT_RADIUS`; the separation two civilians must maintain. */
export const MIN_SEPARATION = AGENT_RADIUS * 2;

/** Neighbour search radius for avoidance, metres. */
export const AVOID_RADIUS = 3.2;

/** Maximum neighbours considered per agent per frame. */
export const AVOID_NEIGHBOURS = 8;

/** Candidate velocities sampled per near-tier agent per RVO solve. */
export const RVO_SAMPLES = 12;

/** Seconds ahead the RVO solver looks for a collision. */
export const RVO_HORIZON = 2.4;

/** Positional relaxation passes that guarantee non-overlap after integration. */
export const SEPARATION_PASSES = 2;

/* -------------------------------------------------------------------------- */
/* Health and stakes                                                          */
/* -------------------------------------------------------------------------- */

/** A civilian's hit points. Deliberately tiny: they are not combatants. */
export const CIVILIAN_HEALTH = 12;

/** Seconds of sprinting before a civilian's legs give out and they cower. */
export const STAMINA_SECONDS = 9;

/** Seconds of standing still before exhausted legs recover. */
export const STAMINA_RECOVERY = 6;

/**
 * Alarm at or below which a civilian who was previously in danger counts as
 * SAVED. Higher than zero so escaping a district still resolves promptly.
 */
export const SAFE_ALARM = 0.06;

/** Alarm a civilian must have experienced before a save can be credited. */
export const ENDANGERED_ALARM = 0.45;

/** Metres from the player at which a rescue counts as "by the player". */
export const RESCUE_RADIUS = 6;

/** Reputation for a civilian who escaped on their own. */
export const REP_SAVED_SELF = 1;

/** Reputation for a civilian the player personally pulled out. */
export const REP_SAVED_BY_PLAYER = 4;

/** Reputation lost when a civilian dies to a monster. */
export const REP_LOST = -6;

/** Reputation lost when the player's own collateral kills a civilian. */
export const REP_LOST_BY_PLAYER = -18;

/**
 * Multiplier applied to a save/loss the PLAYER had line of sight to.
 *
 * `CivilianSavedEvent` is a frozen contract with no line-of-sight field, so
 * witnessing rides on the magnitude of `reputationDelta` — the ranking system
 * already scores on that number, and an unwitnessed rescue moving the meter
 * less is exactly the behaviour it wants. `CrowdLedger` keeps the explicit
 * flags for anything that needs them structurally.
 */
export const WITNESS_MULTIPLIER = 1.5;

/** Multiplier when other civilians saw it happen but the player did not. */
export const BYSTANDER_MULTIPLIER = 1.15;

/** Metres a civilian can see. Beyond this, nothing is witnessed. */
export const SIGHT_RANGE = 55;

/* -------------------------------------------------------------------------- */
/* Hero allies                                                                */
/* -------------------------------------------------------------------------- */

/** Genos: hit points. High enough to matter, low enough to lose. */
export const GENOS_HEALTH = 420;

/** Mumen Rider: hit points. He is a C-class on a bicycle. */
export const MUMEN_HEALTH = 95;

/** Tatsumaki: hit points. She is not the one who gets hurt. */
export const TATSUMAKI_HEALTH = 780;

/** Seconds Mumen Rider spends on the ground before getting back up. */
export const MUMEN_DOWN_SECONDS = 1.6;

/** Fraction of max health below which Genos starts calling for Saitama. */
export const GENOS_CALLOUT_HEALTH = 0.45;
