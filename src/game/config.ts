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

/**
 * Facing, radians, in THREE.JS convention — forward is local -Z, so yaw 0
 * looks down the road towards decreasing z with the block on the left.
 *
 * The convention matters: `PlayerController` derives its own yaw as
 * `atan2(-dx, -dz)` and `MonsterBrain` uses `(+sin, +cos)`. Anything in
 * `src/game` that turns a yaw into a direction has to say which one it means.
 */
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
 * ── WHY THE IMPOSTOR RING DID NOT CHANGE IT ────────────────────────────────
 * This used to read "the number to raise when the city gains an impostor
 * ring". The impostor landed (`CityStreamer.impostor`) and the number stayed
 * at 1, deliberately, in BOTH directions:
 *
 *   • It cannot go UP. Raising it was only ever a way to push the empty
 *     horizon further away, and the horizon is no longer empty. Radius 2 buys
 *     16 more chunks of parallax at 600 000 extra vertices and 6.4 s of
 *     streaming (`STREAM_INTERVAL_SECONDS` x 16) for detail that the impostor
 *     already stands in for, at one draw call, from the first frame.
 *   • It cannot go DOWN. Radius 1 is the floor set by PHYSICS, not by looks:
 *     `COLLIDER_RADIUS` is 1, so radius 0 would leave the player able to walk
 *     off the collidable world about 50 m from spawn, and the impostor is a
 *     silhouette with no colliders and no destructible layout to replace it
 *     with. Buildings inside the resident ring are the ones a punch can take
 *     apart; that ring has to reach past arm's length.
 *
 * So the impostor did not buy a smaller ring. It bought a CITY behind the one
 * that is already there, which is a strictly better use of the same budget.
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
/* Distant skyline (the impostor ring)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fraction of true plan size a silhouette box keeps.
 *
 * Two independent mechanisms stop the impostor drawing over real geometry, and
 * this is the second one. The first — the residency test in the vertex shader,
 * `StreamingMaterials.installResidencyTest` — is exact and keeps the single
 * draw call. This one is the belt to that pair of braces: shrunk in plan and in
 * height, a silhouette sits strictly INSIDE the building it stands for, so even
 * with suppression disabled it cannot z-fight out through a façade. The numbers
 * are the streaming workstream's, kept identical so the two bakes are
 * comparable.
 */
export const IMPOSTOR_PLAN_SCALE = 0.94;

/** Fraction of true height a silhouette box keeps. See `IMPOSTOR_PLAN_SCALE`. */
export const IMPOSTOR_HEIGHT_SCALE = 0.97;

/**
 * Scalar the impostor material multiplies its vertex tints by.
 *
 * The resident city renders `facadeMap x vertexTint`; the impostor has no maps
 * at all, so without this it renders every distant building at the brightness
 * of bare plaster — a white city behind a grey one. 0.55 is the mean albedo of
 * the wall set in `CITY_MATERIALS` and was picked by matching a distant façade
 * against a near one in the same frame, not from the texture files.
 */
export const IMPOSTOR_ALBEDO = 0.55;

/**
 * ── WHY A DISTANT FAÇADE IS DARKER THAN THE PAINT ON IT ────────────────────
 *
 * A silhouette box is a lie of omission: it shows the wall and nothing else,
 * while the building it stands for is mostly wall but also windows, reveals and
 * a baked sky-occlusion gradient. Integrated over one pixel at 250 m, the real
 * building is measurably darker than its own tint — and the first build of this
 * ring proved it, with distant façades reading luminance 169 against a near
 * city whose walls sit in the 60-120 band. That is not atmospheric perspective,
 * it is a missing average.
 *
 * Both corrections below are means taken from what `building.ts` and
 * `facade.ts` actually bake, not numbers dialled until the frame looked right:
 *
 *   shade  `emitOnePanel` writes `0.7 + 0.3 * height fraction` into every
 *          panel's vertex tint — pavement-dark rising to parapet-bright. Its
 *          mean over a façade is 0.85.
 *   glass  a quarter of a façade is glazed, and `GLASS_DARK` in `building.ts`
 *          is what an unlit pane gets. Blending toward it also cools the
 *          distant city slightly, which is what glass at a distance does.
 *
 * Roofs get neither: they are neither glazed nor occluded by the street, and
 * `shadeTint(tint, 0.62)` — the city's own roof factor — is already applied.
 */
export const IMPOSTOR_FACADE_SHADE = 0.85;

/** Fraction of a façade the city glazes. See `IMPOSTOR_FACADE_SHADE`. */
export const IMPOSTOR_GLAZED_FRACTION = 0.25;

/** `GLASS_DARK` from `src/world/city/building.ts`: an unlit pane's baked tint. */
export const IMPOSTOR_GLASS_TINT: readonly [number, number, number] = [0.1, 0.13, 0.17];

/** Packed 0xRRGGBB of the world ground plane under the distant city. */
export const IMPOSTOR_GROUND_COLOUR = 0x39383a;

/**
 * Metres the impostor's ground plane sits BELOW y=0.
 *
 * Enough that a resident chunk's own road surface always wins the depth test,
 * small enough to stay invisible at grazing angles. 6 cm against ~2 mm of depth
 * resolution at 100 m and ~2 cm at 300 m — and past 300 m there is no resident
 * ground left to fight with.
 */
export const IMPOSTOR_GROUND_DEPTH = 0.06;

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
