/**
 * STREAMING CONSTANTS — LOD RINGS AND THE HARD FRAME BUDGET
 *
 * Every number in this file is a budget, a ring radius, or an addressing
 * constant, and each one is here rather than inline because the streaming
 * system's whole job is to *not* be felt: a chunk arriving is supposed to be
 * invisible, and the only way that stays true is if the costs are declared in
 * one place and enforced mechanically.
 *
 * ── THE RINGS ──────────────────────────────────────────────────────────────
 * Rings are measured in CHUNK UNITS as the Chebyshev distance from the
 * streaming focus to the chunk CENTRE, divided by `CHUNK_SIZE`. A chunk whose
 * integer Chebyshev ring is `k` therefore has a continuous distance in
 * `[k - 0.5, k + 0.5]`, which is why the thresholds sit on the half:
 *
 *   R0  d <= 1.5   rings 0-1   (<= ~96 m)   LOD0, skinned NPCs, per-building colliders
 *   R1  d <= 4.5   rings 2-4   (<= ~384 m)  LOD1, instanced crowd, ONE merged block collider
 *   R2  d <= 8.5   rings 5-8   (<= ~768 m)  LOD2 merged block mesh, no NPCs, no colliders
 *   R3  beyond                              the pre-baked impostor ring, one draw call
 *
 * Using a continuous distance rather than the integer ring is deliberate:
 * hysteresis is impossible on an integer that flips the instant the camera
 * crosses a chunk boundary, which is exactly the case that thrashes.
 *
 * ── THE BUDGET ─────────────────────────────────────────────────────────────
 * `MAX_UPLOADS_PER_FRAME` and `UPLOAD_BUDGET_MS` are the point of this
 * workstream. Geometry is built on worker threads, so the only main-thread
 * cost left is turning transferred `ArrayBuffer`s into GPU buffers — and that
 * cost is unavoidable and synchronous. Capping it at two chunks and 4 ms is
 * what converts "the city pops in" from a visible hitch into a background
 * process. A frame that busts this budget is a bug, not a slow frame.
 *
 * ── QUALITY ────────────────────────────────────────────────────────────────
 * `IQualitySettings.streamingRadius` (120/200/320 m) is the RENDERER's hint and
 * is far tighter than the ring plan above — honouring it literally would delete
 * R2 entirely. Streaming instead treats it as a floor and scales its own
 * resident radius per tier via `RESIDENT_RADIUS_CHUNKS_BY_TIER`, keeping the
 * ring structure intact while still shrinking the working set on weak devices.
 */

import type { IQualityTier, ILODLevel } from '@/types';
import { CHUNK_SIZE } from '@/spatial/constants';

/* -------------------------------------------------------------------------- */
/* Worker pool                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Workers building chunk geometry. Two, not more: a mid-range Android phone has
 * 4-8 cores of which the main thread and the audio thread already claim two,
 * and every extra worker is a second copy of the module graph in memory.
 */
export const STREAMING_WORKER_COUNT = 2;

/**
 * Jobs allowed in flight across the whole pool. Held at 2x the worker count so
 * a worker never idles waiting for the next dispatch, while keeping the number
 * of results that can be orphaned by a sudden camera cut small.
 */
export const MAX_IN_FLIGHT_JOBS = STREAMING_WORKER_COUNT * 2;

/* -------------------------------------------------------------------------- */
/* The frame budget                                                           */
/* -------------------------------------------------------------------------- */

/** Hard cap on chunks uploaded to the GPU in one frame. */
export const MAX_UPLOADS_PER_FRAME = 2;

/** Hard cap on main-thread milliseconds spent uploading in one frame. */
export const UPLOAD_BUDGET_MS = 4;

/** Hard cap on chunks torn down in one frame. Dispose storms hitch too. */
export const MAX_UNLOADS_PER_FRAME = 4;

/** Main-thread millisecond cap for teardown in one frame. */
export const UNLOAD_BUDGET_MS = 2;

/**
 * Smoothing factor for the exponential moving average of upload cost. The EMA
 * drives ADMISSION CONTROL: the second upload of a frame is only started when
 * the predicted cost still fits in the remaining budget, which is what keeps
 * the cap a cap rather than an aspiration.
 */
export const UPLOAD_COST_EMA_ALPHA = 0.25;

/* -------------------------------------------------------------------------- */
/* LOD rings                                                                  */
/* -------------------------------------------------------------------------- */

/** Number of rings, including the impostor ring R3. */
export const RING_COUNT = 4;

/** Ring indices, named. Also the index into `STREAMING_LOD_LEVELS`. */
export const RING_R0 = 0;
export const RING_R1 = 1;
export const RING_R2 = 2;
export const RING_R3 = 3;

/**
 * Outer edge of rings R0, R1 and R2 in chunk units. A chunk past the last entry
 * belongs to R3 and is represented only by the impostor ring.
 */
export const RING_OUTER_CHUNKS: readonly number[] = [1.5, 4.5, 8.5];

/**
 * Hysteresis band in chunk units (0.35 * 96 m = 33.6 m).
 *
 * A chunk must travel this far PAST a ring boundary before it is demoted, and
 * this far INSIDE the finer band before it is promoted. Without it a camera
 * parked on a boundary rebuilds the same chunk at alternating LODs forever,
 * which is both the most expensive thing the streamer can do and the easiest
 * to trigger — players stand still.
 */
export const RING_HYSTERESIS_CHUNKS = 0.35;

/** Resident radius in chunk units per render tier. See the file header. */
export const RESIDENT_RADIUS_CHUNKS_BY_TIER: Readonly<Record<IQualityTier, number>> = {
  low: 4.5,
  medium: 6.5,
  high: 8.5,
};

/**
 * Extra distance a resident chunk must drift before eviction, in chunk units.
 * This is the load/unload counterpart of `RING_HYSTERESIS_CHUNKS`; it is what
 * `IWorldConfig.evictionRadiusChunks > streamingRadiusChunks` means in practice.
 */
export const EVICT_MARGIN_CHUNKS = 0.5;

/* -------------------------------------------------------------------------- */
/* Priority                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ring separation in the priority score. Larger than any achievable in-ring
 * score, so ring order is absolute: no R1 chunk ever loads before an R0 chunk.
 */
export const RING_PRIORITY_STRIDE = 1e5;

/**
 * How hard the view direction bends the effective distance. A chunk directly
 * behind the camera (`1 - dot == 2`) is treated as `1 + 1.5 * 2 == 4x` further
 * away than one dead ahead at the same true distance. That single multiplier is
 * what makes the city assemble in front of the player instead of around them.
 */
export const ANGLE_PRIORITY_WEIGHT = 1.5;

/**
 * Effective-distance multiplier for a chunk the cached PVS says cannot be seen
 * from the chunk the camera stands in. A penalty rather than an exclusion: the
 * player may turn a corner next frame, so those chunks must still load, just
 * last.
 */
export const PVS_PRIORITY_PENALTY = 2;

/* -------------------------------------------------------------------------- */
/* Damage bitmask addressing                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Destructible slots per chunk, and the reason the number is exactly 256:
 * 16 buildings x 16 fracture pieces, which is 8 uint32 words — the same shape
 * as one PVS row. The whole city's persistent damage is therefore 256 chunks x
 * 32 B = 8 KB, small enough to keep resident forever and to write into a save
 * file without thinking about it.
 */
export const MAX_BUILDINGS_PER_CHUNK = 16;

/** Fracture pieces a building is split into: 2x2 in plan, 4 vertical bands. */
export const FRACTURE_PIECES_PER_BUILDING = 16;

/** Fracture piece grid: 2 x 2 columns in plan. */
export const FRACTURE_PLAN_DIVISIONS = 2;

/** Fracture piece grid: 4 vertical bands. */
export const FRACTURE_HEIGHT_BANDS = 4;

/** Damage bits per chunk. `MAX_BUILDINGS_PER_CHUNK * FRACTURE_PIECES_PER_BUILDING`. */
export const DAMAGE_BITS_PER_CHUNK = MAX_BUILDINGS_PER_CHUNK * FRACTURE_PIECES_PER_BUILDING;

/** uint32 words per chunk damage mask. `256 / 32`. */
export const DAMAGE_WORDS_PER_CHUNK = DAMAGE_BITS_PER_CHUNK >> 5;

/* -------------------------------------------------------------------------- */
/* City block geometry                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Total street width along a chunk boundary, in metres. Streets run ON the
 * boundaries so every chunk edge is a clean sightline corridor — the geometry
 * the PVS in `src/spatial/` was measured against.
 */
export const STREET_WIDTH = 16;

/** Gap between building lots inside a block, in metres. */
export const ALLEY_WIDTH = 4;

/** Metres per storey. */
export const FLOOR_HEIGHT = 3.6;

/** Edge length of the buildable block inside one chunk, in metres. */
export const BLOCK_SIZE = CHUNK_SIZE - STREET_WIDTH;

/* -------------------------------------------------------------------------- */
/* LOD bands                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four bands, in the shape `IWorldConfig.lodLevels` expects. Distances are
 * the ring radii converted to metres so the renderer and any debug overlay read
 * the same numbers streaming acts on.
 */
export const STREAMING_LOD_LEVELS: readonly ILODLevel[] = [
  {
    index: RING_R0,
    minDistance: 0,
    maxDistance: RING_OUTER_CHUNKS[0]! * CHUNK_SIZE,
    meshDetail: 1,
    includeProps: true,
    includeInteriors: true,
    castShadows: true,
    textureBias: 0,
    useImpostors: false,
  },
  {
    index: RING_R1,
    minDistance: RING_OUTER_CHUNKS[0]! * CHUNK_SIZE,
    maxDistance: RING_OUTER_CHUNKS[1]! * CHUNK_SIZE,
    meshDetail: 0.35,
    includeProps: false,
    includeInteriors: false,
    castShadows: true,
    textureBias: 0.5,
    useImpostors: false,
  },
  {
    index: RING_R2,
    minDistance: RING_OUTER_CHUNKS[1]! * CHUNK_SIZE,
    maxDistance: RING_OUTER_CHUNKS[2]! * CHUNK_SIZE,
    meshDetail: 0.08,
    includeProps: false,
    includeInteriors: false,
    castShadows: false,
    textureBias: 1.5,
    useImpostors: false,
  },
  {
    index: RING_R3,
    minDistance: RING_OUTER_CHUNKS[2]! * CHUNK_SIZE,
    maxDistance: Infinity,
    meshDetail: 0.01,
    includeProps: false,
    includeInteriors: false,
    castShadows: false,
    textureBias: 3,
    useImpostors: true,
  },
];

/* -------------------------------------------------------------------------- */
/* Crowd and collider policy per ring                                         */
/* -------------------------------------------------------------------------- */

/** How NPCs are represented in a ring. */
export type CrowdMode = 'skinned' | 'instanced' | 'none';

/** How static collision is represented in a ring. */
export type ColliderMode = 'per-building' | 'merged-block' | 'none';

/** Crowd representation per ring index. */
export const RING_CROWD_MODE: readonly CrowdMode[] = ['skinned', 'instanced', 'none', 'none'];

/** Collider representation per ring index. */
export const RING_COLLIDER_MODE: readonly ColliderMode[] = [
  'per-building',
  'merged-block',
  'none',
  'none',
];

/** True when destructible buildings are simulated at this ring. */
export const RING_DESTRUCTIBLE: readonly boolean[] = [true, false, false, false];
