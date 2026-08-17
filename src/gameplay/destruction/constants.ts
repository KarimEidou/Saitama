/**
 * DESTRUCTION TUNING
 *
 * Every number that decides what a punch does to the city. Kept in one file
 * because the difference between "a building collapsed" and "some triangles
 * disappeared" is entirely in these values, and they have to be readable
 * together to be judged.
 */

/**
 * Byte written into the per-vertex `aDestroyed` attribute to remove a vertex.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  MUST BE 255. NOT 1.
 *
 *  The attribute is uploaded NORMALISED, so the vertex shader sees
 *  `byte / 255`. Writing 1 gives it 0.00392, the `aDestroyed > 0.5` test
 *  fails, and NOTHING DISAPPEARS. The failure mode is indistinguishable from
 *  "destruction was never wired up", which is why this has bitten this
 *  codebase before and why `__tests__/attribute.test.ts` asserts the
 *  arithmetic explicitly rather than trusting the constant.
 * ══════════════════════════════════════════════════════════════════════════
 */
export const DESTROYED_FLAG = 255;

/** The comparison the city's vertex shader performs on the normalised value. */
export const DESTROYED_SHADER_THRESHOLD = 0.5;

/** Normalised byte range denominator, i.e. what the GPU divides by. */
export const UNORM8_SCALE = 255;

/* -------------------------------------------------------------------------- */
/* Collapse                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fraction of a floor's support that must SURVIVE for it to stay standing.
 * 0.4 means "collapse once more than 60% of the supports are gone" — the
 * threshold the city generator bakes its `supportShare` values against.
 */
export const COLLAPSE_SUPPORT_RATIO = 0.4;

/**
 * Frames a collapse is spread over.
 *
 * Not a performance dodge — it is the whole difference between a collapse and
 * a pop. Detaching 40 chunks in one frame gives every piece the same birth
 * time and the same velocity phase, and the eye reads that as the building
 * being switched off. Three frames (50 ms at 60 Hz) is enough separation for
 * the lower storeys to be visibly ahead of the upper ones while still being
 * far too fast to read as a stutter.
 */
export const COLLAPSE_STAGGER_FRAMES = 3;

/** Ceiling on chunks detached per frame by collapses, across all structures. */
export const COLLAPSE_MAX_DETACH_PER_FRAME = 64;

/* -------------------------------------------------------------------------- */
/* Impulses                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Impulses are expressed as a target Δv and multiplied by the piece's mass at
 * the last moment, so a 400 kg parapet and a 9000 kg slab leave the wall at
 * the same speed. Doing it the other way — a fixed impulse — makes light
 * pieces rocket and heavy pieces sit still, which reads as a physics bug.
 */

/** Δv (m/s) along the blast axis for a chunk at the shockwave origin. */
export const BLAST_DELTA_V_NEAR = 26;

/** Δv (m/s) along the blast axis for a chunk at the far end of the cone. */
export const BLAST_DELTA_V_FAR = 7;

/** Upward fraction of the blast Δv, so debris arcs instead of skidding. */
export const BLAST_LIFT_FRACTION = 0.42;

/** Outward-from-axis fraction, so the tunnel walls spall sideways. */
export const BLAST_SPREAD_FRACTION = 0.3;

/** Δv (m/s) a collapsing chunk starts with: gravity does the rest. */
export const COLLAPSE_DELTA_V = 1.6;

/** Sideways Δv (m/s) as a floor pancakes and pushes its facade outward. */
export const COLLAPSE_OUTWARD_DELTA_V = 2.4;

/** Random Δv jitter (m/s), from a seeded stream. Never `Math.random()`. */
export const DETACH_JITTER_DELTA_V = 1.1;

/** Intent multiplier on blast Δv. Restraint is a gameplay resource. */
export const INTENT_BLAST_SCALE: Readonly<Record<string, number>> = {
  restrained: 0.25,
  normal: 0.55,
  serious: 1,
  full: 1.35,
};

/**
 * Intent below which a shockwave does not damage structures at all.
 * `restrained` punches leave the city alone — that is the entire point of
 * being able to pull one.
 */
export const MINIMUM_DESTRUCTIVE_INTENT_RANK = 1;

/** Rank per intent, for the threshold above. */
export const INTENT_RANK: Readonly<Record<string, number>> = {
  restrained: 0,
  normal: 1,
  serious: 2,
  full: 3,
};

/* -------------------------------------------------------------------------- */
/* Budgets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Debris ceiling MIRRORED from `src/physics/constants.ts` (`DEBRIS_HARD_CAP`).
 *
 * Mirrored, not imported, because of the architectural rule. The live value
 * always comes from the injected sink's `capacity` — this is only the default
 * used when nothing is injected, so a divergence cannot cause an overrun.
 */
export const DEBRIS_HARD_CAP = 300;

/** Ragdoll ceiling, mirrored from `MAX_ACTIVE_RAGDOLLS`. Same caveat. */
export const MAX_ACTIVE_RAGDOLLS = 8;

/** Metres from a recent impact within which a death launches a ragdoll. */
export const RAGDOLL_IMPACT_RADIUS = 42;

/** Seconds an impact stays "recent" for the purposes of the rule above. */
export const RAGDOLL_IMPACT_WINDOW_SECONDS = 0.75;

/** Δv (m/s) imparted to a ragdoll at the centre of the impact. */
export const RAGDOLL_DELTA_V_NEAR = 34;

/** Nominal ragdoll mass (kg) used to convert Δv into an impulse. */
export const RAGDOLL_MASS_KG = 72;

/** Impacts remembered for the ragdoll proximity test. */
export const IMPACT_HISTORY = 8;

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Vertical bands and plan quarters in the persistent damage bitmask.
 *
 * The streaming bitmask stores 16 bits per building: 4 vertical bands x 4 plan
 * quarters. A 12-storey building has 48 fracture chunks, so the mask is a
 * COARSER tier than the live geometry — see `damage-address.ts` for exactly
 * what that costs and what it does not.
 */
export const DAMAGE_BANDS = 4;
export const DAMAGE_PLAN_QUARTERS = 4;
export const DAMAGE_PIECES_PER_BUILDING = DAMAGE_BANDS * DAMAGE_PLAN_QUARTERS;

/* -------------------------------------------------------------------------- */
/* Collateral                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Default collateral units per kilogram carried on `ChunkDetached`.
 *
 * One unit per kilogram: the destruction system reports MASS and lets combat
 * price it, because the yen rate is zoning — combat's business, not
 * destruction's. `IStructureSpec.collateralPerKg` exists so a landmark can be
 * made to hurt more without destruction learning what a district is.
 */
export const DEFAULT_COLLATERAL_PER_KG = 1;

/* -------------------------------------------------------------------------- */
/* Seeds                                                                      */
/* -------------------------------------------------------------------------- */

/** Root label for the destruction RNG stream. */
export const DESTRUCTION_RNG_LABEL = 'destruction';
