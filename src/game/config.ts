/**
 * COMPOSITION TUNABLES
 *
 * Numbers that belong to the WIRING rather than to any one system. Every
 * system's own tuning lives with that system; what is here is the shape of the
 * assembled game — how much city is resident, how much of a frame the
 * composition root may spend building it, where the player starts.
 *
 * Nothing in this file is a gameplay constant. If a number describes how the
 * game FEELS it is in the wrong place and belongs in the owning system.
 */

import type { IQualityTier } from '@/types';

/* -------------------------------------------------------------------------- */
/* World                                                                      */
/* -------------------------------------------------------------------------- */

/** Master seed. One number decides the entire world, every run. */
export const WORLD_SEED = 0x0_5a17a_1;

/** Seed as a string, for the systems that key their RNG by name. */
export const WORLD_SEED_KEY = 'city-z';

/**
 * Where Saitama spawns.
 *
 * Chunk (0,0) is downtown — the densest block in the plan, seven buildings and
 * a through street. It is also the most expensive chunk to generate (478 ms at
 * full detail, measured), which is deliberate: the boot budget must be proven
 * against the worst chunk in the world, not a convenient one.
 */
/*
 * Chunk (0,0) is downtown and spans world 0..96 on both axes; its block runs
 * 18.2..86.8, so the road is the 18 m strip along the chunk's west and north
 * edges. x = 9 puts Saitama in the middle of that road with the block's full
 * facade to his right, which is both a walkable street and a punchable wall.
 */
export const SPAWN_POSITION = { x: 9, y: 1.4, z: 40 } as const;

/** Facing, radians. 0 is +Z: straight up the road, buildings to the right. */
export const SPAWN_YAW = 0;

/** Time of day at a fresh start. 0.34 is mid-morning: long shadows, full sun. */
export const START_TIME_OF_DAY = 0.34;

/* -------------------------------------------------------------------------- */
/* City residency                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Chebyshev chunk radius kept resident, per render tier.
 *
 * ── WHY THIS IS SO SMALL ───────────────────────────────────────────────────
 * The city generator emits 425 000 VERTICES for one downtown chunk at full
 * detail and about 100 000 at reduced — measured, not estimated. A radius of 1
 * is nine chunks and roughly 1.2 M vertices; a radius of 2 adds sixteen more
 * and takes it past 1.8 M. That is a VERTEX budget, not a draw-distance
 * choice, and at street level in a downtown grid it costs nothing visible: a
 * 96 m ring reaches the far side of the next block, and the block itself
 * occludes everything behind it.
 *
 * This is the number to raise when the city gains an impostor ring.
 */
export const RESIDENT_RADIUS_BY_TIER: Readonly<Record<IQualityTier, number>> = {
  low: 1,
  medium: 1,
  high: 1,
};

/** Chunks generated at `full` detail: Chebyshev distance <= this. */
export const FULL_DETAIL_RADIUS = 0;

/** Chunks generated at `reduced` detail: Chebyshev distance <= this. */
export const REDUCED_DETAIL_RADIUS = 1;

/**
 * Chunks built synchronously before the first frame presents.
 *
 * Only the ring that is unavoidably in shot. Everything further out arrives
 * during play, one chunk per frame, which is invisible at these distances and
 * keeps the boot budget honest.
 */
export const BOOT_RADIUS = 0;

/**
 * Seconds between city-chunk builds after boot.
 *
 * A TIME budget rather than a frame-time budget, and that is deliberate: one
 * chunk costs between 30 ms and 1.5 s depending on the district and there is no
 * way to check a millisecond budget before paying it. A per-frame budget check
 * also silently starves on a slow renderer — if the frame is already over
 * budget the queue never drains at all, and the world stops arriving.
 */
export const STREAM_INTERVAL_SECONDS = 0.4;

/** Physics colliders are built for chunks within this Chebyshev radius. */
export const COLLIDER_RADIUS = 1;

/* -------------------------------------------------------------------------- */
/* Population                                                                 */
/* -------------------------------------------------------------------------- */

/** Civilians registered with progression as witnesses, nearest first. */
export const MAX_TRACKED_WITNESSES = 96;

/** Metres a civilian may drift before its witness record is re-published. */
export const WITNESS_RESYNC_DISTANCE = 4;

/** Seconds between witness-register sweeps. Incidents are rarer than frames. */
export const WITNESS_SYNC_INTERVAL = 0.25;

/* -------------------------------------------------------------------------- */
/* Frame                                                                      */
/* -------------------------------------------------------------------------- */

/** Fixed simulation step. 60 Hz, matching physics and the animation bake. */
export const FIXED_STEP = 1 / 60;

/** Longest frame the clock will charge, in seconds. Below 15 fps we slow down. */
export const MAX_DELTA = 1 / 15;

/** Autosave period, in seconds of unscaled time. */
export const AUTOSAVE_INTERVAL = 60;
