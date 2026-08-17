/**
 * SPATIAL CONSTANTS — CITY Z GEOMETRY
 *
 * Every structure in `src/spatial/` is dimensioned from these numbers, and they
 * are chosen so the hierarchy lines up exactly with no remainders:
 *
 *   world           1536 m x 1536 m
 *   chunk grid      16 x 16          -> 96 m chunks, 256 chunks
 *   quadtree        depth 6          -> 1536 / 2^6 = 24 m leaves, 4096 leaves
 *   entity grid     24 m cells       -> 64 x 64 = 4096 cells
 *   PVS mask        256 bits         -> 8 x uint32 per chunk, 8192 B total
 *
 * The alignment that matters most: **quadtree depth 4 cells are exactly the
 * 96 m chunks**. That is not a coincidence, it is the reason the PVS can be
 * applied *inside* the hierarchical frustum walk — when the walk reaches depth
 * 4 it can look up one bit and discard the entire 96 m subtree (up to 21 nodes
 * and every instance under them) before doing any further plane tests.
 *
 * COORDINATE CONVENTION (from `src/types/world.ts`): right-handed, Y-up,
 * 1 unit == 1 metre, +X east, +Z south. A chunk's world origin is
 * `(coord.x * CHUNK_SIZE, 0, coord.z * CHUNK_SIZE)`.
 *
 * The world is CENTRED on the origin, so chunk coordinates run -8..7 on both
 * axes and world coordinates run -768..768. `chunkIndex()` folds that signed
 * coord into the unsigned 0..255 slot used as the PVS bit index and as the
 * chunk-array index everywhere else.
 */

/* -------------------------------------------------------------------------- */
/* World extent                                                               */
/* -------------------------------------------------------------------------- */

/** Edge length of City Z in metres. */
export const WORLD_SIZE = 1536;

/** Edge length of one streaming chunk in metres. */
export const CHUNK_SIZE = 96;

/** Chunks per axis. `WORLD_SIZE / CHUNK_SIZE`. */
export const CHUNK_GRID = 16;

/** Total chunks in the world. Must stay <= `PVS_MASK_BITS`. */
export const CHUNK_COUNT = CHUNK_GRID * CHUNK_GRID;

/** Lowest chunk coordinate on either axis (inclusive). */
export const CHUNK_COORD_MIN = -(CHUNK_GRID >> 1);

/** Highest chunk coordinate on either axis (inclusive). */
export const CHUNK_COORD_MAX = (CHUNK_GRID >> 1) - 1;

/** World-space minimum on X and Z. */
export const WORLD_MIN = CHUNK_COORD_MIN * CHUNK_SIZE;

/** World-space maximum on X and Z. */
export const WORLD_MAX = WORLD_MIN + WORLD_SIZE;

/** Corner-to-corner distance across the world; the natural ray cap for PVS. */
export const WORLD_DIAGONAL = Math.SQRT2 * WORLD_SIZE;

/* -------------------------------------------------------------------------- */
/* Quadtree                                                                   */
/* -------------------------------------------------------------------------- */

/** Subdivision levels below the root. Depth 6 over 1536 m gives 24 m leaves. */
export const QUADTREE_DEPTH = 6;

/** Edge length of a deepest-level quadtree cell, in metres. */
export const QUADTREE_LEAF_SIZE = WORLD_SIZE / (1 << QUADTREE_DEPTH);

/**
 * Depth whose cells coincide with streaming chunks. `1536 / 2^4 == 96`.
 * The PVS is consulted at exactly this depth during the frustum walk.
 */
export const QUADTREE_CHUNK_DEPTH = 4;

/** Total nodes in a complete quadtree of `QUADTREE_DEPTH`: sum of 4^d. */
export const QUADTREE_NODE_COUNT = ((1 << (2 * (QUADTREE_DEPTH + 1))) - 1) / 3;

/**
 * Index of the first node at each level, for the level-major node layout.
 * `LEVEL_OFFSET[d] + cz * 2^d + cx` addresses cell (cx, cz) at depth d.
 *
 * A level-major layout is used instead of the usual `4i+1` implicit heap
 * because it makes (depth, cellX, cellZ) recoverable with a subtraction — which
 * is what lets depth-4 nodes map straight onto chunk indices.
 */
export const QUADTREE_LEVEL_OFFSET: readonly number[] = (() => {
  const offsets: number[] = [0];
  let total = 0;
  for (let d = 0; d <= QUADTREE_DEPTH; d++) {
    total += 1 << (2 * d);
    offsets.push(total);
  }
  return offsets;
})();

/* -------------------------------------------------------------------------- */
/* Dynamic entity grid                                                        */
/* -------------------------------------------------------------------------- */

/** Cell edge length for the per-frame dynamic entity grid, in metres. */
export const ENTITY_CELL_SIZE = 24;

/** Cells per axis in the dynamic entity grid. */
export const ENTITY_GRID_DIM = WORLD_SIZE / ENTITY_CELL_SIZE;

/* -------------------------------------------------------------------------- */
/* Potentially visible set                                                    */
/* -------------------------------------------------------------------------- */

/** Bits in one chunk's visibility mask. One bit per chunk in the world. */
export const PVS_MASK_BITS = 256;

/** uint32 words per mask. `256 / 32`. */
export const PVS_MASK_WORDS = PVS_MASK_BITS >> 5;

/** Total bytes for the whole table: 256 chunks x 8 words x 4 bytes. */
export const PVS_TOTAL_BYTES = CHUNK_COUNT * PVS_MASK_WORDS * 4;

/** Horizontal rays cast per sampling origin during PVS generation. */
export const PVS_DEFAULT_RAY_COUNT = 128;

/** Default seed for the PVS builder's angular jitter. */
export const PVS_DEFAULT_SEED = 0x5a17a3a;

/* -------------------------------------------------------------------------- */
/* Chunk addressing                                                           */
/* -------------------------------------------------------------------------- */

/** True when `(cx, cz)` names a chunk inside the world. */
export function isChunkInWorld(cx: number, cz: number): boolean {
  return (
    cx >= CHUNK_COORD_MIN && cx <= CHUNK_COORD_MAX && cz >= CHUNK_COORD_MIN && cz <= CHUNK_COORD_MAX
  );
}

/**
 * Signed chunk coordinate -> dense 0..255 index, or -1 when outside the world.
 * This index is the PVS bit position and the canonical chunk slot.
 */
export function chunkIndex(cx: number, cz: number): number {
  if (!isChunkInWorld(cx, cz)) return -1;
  return (cz - CHUNK_COORD_MIN) * CHUNK_GRID + (cx - CHUNK_COORD_MIN);
}

/** Dense index -> signed chunk X. Undefined behaviour outside 0..255. */
export function chunkIndexToX(index: number): number {
  return (index % CHUNK_GRID) + CHUNK_COORD_MIN;
}

/** Dense index -> signed chunk Z. */
export function chunkIndexToZ(index: number): number {
  return Math.floor(index / CHUNK_GRID) + CHUNK_COORD_MIN;
}

/** World X -> signed chunk X. Not clamped; may fall outside the world. */
export function worldToChunkX(x: number): number {
  return Math.floor(x / CHUNK_SIZE);
}

/** World Z -> signed chunk Z. Not clamped. */
export function worldToChunkZ(z: number): number {
  return Math.floor(z / CHUNK_SIZE);
}

/** World position -> dense chunk index, or -1 when outside the world. */
export function chunkIndexAt(x: number, z: number): number {
  return chunkIndex(worldToChunkX(x), worldToChunkZ(z));
}

/** World X of the western edge of a chunk index. */
export function chunkMinX(index: number): number {
  return chunkIndexToX(index) * CHUNK_SIZE;
}

/** World Z of the northern edge of a chunk index. */
export function chunkMinZ(index: number): number {
  return chunkIndexToZ(index) * CHUNK_SIZE;
}

/** World X of a chunk centre. */
export function chunkCentreX(index: number): number {
  return chunkMinX(index) + CHUNK_SIZE * 0.5;
}

/** World Z of a chunk centre. */
export function chunkCentreZ(index: number): number {
  return chunkMinZ(index) + CHUNK_SIZE * 0.5;
}

/** Chebyshev chunk distance between two dense indices. */
export function chunkChebyshev(a: number, b: number): number {
  const dx = Math.abs(chunkIndexToX(a) - chunkIndexToX(b));
  const dz = Math.abs(chunkIndexToZ(a) - chunkIndexToZ(b));
  return dx > dz ? dx : dz;
}

/** `"x,z"` key matching `IChunkCoord` conventions in `src/types/world.ts`. */
export function chunkKeyFromIndex(index: number): string {
  return `${chunkIndexToX(index)},${chunkIndexToZ(index)}`;
}
