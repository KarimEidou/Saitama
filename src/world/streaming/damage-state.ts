/**
 * PERSISTENT PER-CHUNK DAMAGE STATE
 *
 * The thing that makes an open world feel like the player's rather than a
 * backdrop is that it remembers. Punch the corner off a tower block, walk a
 * kilometre away so the chunk unloads, come back — the corner is still gone.
 *
 * That requirement collides head-on with streaming, because streaming's whole
 * premise is that a chunk can be thrown away and rebuilt from its seed. The
 * resolution is to keep the ONE piece of state that is not derivable from the
 * seed, and keep it tiny:
 *
 *   256 chunks x 16 buildings x 16 fracture pieces = 1 bit each = 8 KB total.
 *
 * A bitmask, not a list of objects, for three reasons:
 *  1. It is a fixed 8 KB for the entire city — it can live in memory forever
 *     and be written to a save file without a serialisation format.
 *  2. It is transferable. The mask for a chunk is handed to the geometry
 *     worker in the job message, so the rebuilt chunk simply never emits the
 *     destroyed pieces. Damage costs nothing at rebuild time.
 *  3. Order independence survives. Nothing about the mask depends on when or
 *     how often the chunk was loaded, so determinism is preserved.
 *
 * Masks are allocated LAZILY: an undamaged city holds zero mask arrays, which
 * matters because the overwhelmingly common case is a chunk the player has
 * never touched.
 *
 * ── SLOT ADDRESSING ────────────────────────────────────────────────────────
 * `slot = buildingIndex * FRACTURE_PIECES_PER_BUILDING + pieceIndex`, both
 * indices assigned by the deterministic chunk layout, so a slot means the same
 * physical piece of masonry on every device and in every session.
 */

import {
  DAMAGE_BITS_PER_CHUNK,
  DAMAGE_WORDS_PER_CHUNK,
  FRACTURE_PIECES_PER_BUILDING,
  MAX_BUILDINGS_PER_CHUNK,
} from './constants';
import { CHUNK_COUNT } from '@/spatial/constants';

/** Bytes a fully dense serialisation occupies, excluding the header. */
export const DAMAGE_TOTAL_BYTES = CHUNK_COUNT * DAMAGE_WORDS_PER_CHUNK * 4;

const DAMAGE_MAGIC = 0x44414d31; /* "DAM1" */
const DAMAGE_VERSION = 1;
const DAMAGE_HEADER_BYTES = 16;

/** Zero mask handed out for undamaged chunks so callers never branch on null. */
const EMPTY_MASK = new Uint32Array(DAMAGE_WORDS_PER_CHUNK);

/** Snapshot counters for the debug HUD and tests. */
export interface IDamageStats {
  /** Chunks holding at least one destroyed piece. */
  readonly damagedChunks: number;
  /** Total destroyed fracture pieces across the world. */
  readonly destroyedPieces: number;
  /** Bytes currently allocated for masks (lazy, so usually far below 8 KB). */
  readonly residentBytes: number;
}

/**
 * Stable slot index for a fracture piece.
 *
 * @param buildingIndex 0..15 within the chunk.
 * @param pieceIndex    0..15 within the building.
 */
export function damageSlot(buildingIndex: number, pieceIndex: number): number {
  return buildingIndex * FRACTURE_PIECES_PER_BUILDING + pieceIndex;
}

/** The world's persistent destruction record. One instance per save. */
export class ChunkDamageState {
  /** Lazily allocated masks, keyed by dense chunk index. */
  private readonly masks = new Map<number, Uint32Array>();
  /** Chunks whose mask changed since `clearDirty()`. */
  private readonly dirty = new Set<number>();
  /** Running total so `stats()` stays O(1) on the hot path. */
  private destroyed = 0;

  /* ------------------------------------------------------------------ */
  /* Queries                                                            */
  /* ------------------------------------------------------------------ */

  /** True when this fracture piece has already been destroyed. */
  isDestroyed(chunk: number, slot: number): boolean {
    const mask = this.masks.get(chunk);
    if (mask === undefined) return false;
    if (slot < 0 || slot >= DAMAGE_BITS_PER_CHUNK) return false;
    return (mask[slot >>> 5]! & (1 << (slot & 31))) !== 0;
  }

  /** True when the chunk carries any damage at all. */
  isChunkDamaged(chunk: number): boolean {
    return this.masks.has(chunk);
  }

  /**
   * The chunk's mask, or a shared all-zero mask when undamaged. The returned
   * array is LIVE — copy it before handing it to a worker.
   */
  maskFor(chunk: number): Uint32Array {
    return this.masks.get(chunk) ?? EMPTY_MASK;
  }

  /**
   * A detached copy of the mask, suitable for `postMessage` transfer. Returns
   * `undefined` for an undamaged chunk so the common case sends nothing.
   */
  cloneMask(chunk: number): Uint32Array | undefined {
    const mask = this.masks.get(chunk);
    return mask === undefined ? undefined : mask.slice();
  }

  /** Destroyed pieces in one chunk. */
  destroyedCount(chunk: number): number {
    const mask = this.masks.get(chunk);
    if (mask === undefined) return 0;
    let total = 0;
    for (let w = 0; w < DAMAGE_WORDS_PER_CHUNK; w++) total += popcount32(mask[w]!);
    return total;
  }

  /* ------------------------------------------------------------------ */
  /* Mutation                                                           */
  /* ------------------------------------------------------------------ */

  /** Record one destroyed fracture piece. Returns true when it was new. */
  setDestroyed(chunk: number, slot: number): boolean {
    if (chunk < 0 || chunk >= CHUNK_COUNT) return false;
    if (slot < 0 || slot >= DAMAGE_BITS_PER_CHUNK) return false;
    const mask = this.ensureMask(chunk);
    const word = slot >>> 5;
    const bit = 1 << (slot & 31);
    if ((mask[word]! & bit) !== 0) return false;
    mask[word] = (mask[word]! | bit) >>> 0;
    this.destroyed++;
    this.dirty.add(chunk);
    return true;
  }

  /** Level an entire building. Returns the number of pieces newly destroyed. */
  destroyBuilding(chunk: number, buildingIndex: number): number {
    if (buildingIndex < 0 || buildingIndex >= MAX_BUILDINGS_PER_CHUNK) return 0;
    let added = 0;
    for (let p = 0; p < FRACTURE_PIECES_PER_BUILDING; p++) {
      if (this.setDestroyed(chunk, damageSlot(buildingIndex, p))) added++;
    }
    return added;
  }

  /** Restore one piece. Used by repair/cheat paths and by tests. */
  clearDestroyed(chunk: number, slot: number): boolean {
    const mask = this.masks.get(chunk);
    if (mask === undefined) return false;
    const word = slot >>> 5;
    const bit = 1 << (slot & 31);
    if ((mask[word]! & bit) === 0) return false;
    mask[word] = (mask[word]! & ~bit) >>> 0;
    this.destroyed--;
    this.dirty.add(chunk);
    // Drop the allocation once the chunk is pristine again.
    let any = 0;
    for (let w = 0; w < DAMAGE_WORDS_PER_CHUNK; w++) any |= mask[w]!;
    if (any === 0) this.masks.delete(chunk);
    return true;
  }

  /** Wipe everything. New game. */
  clear(): void {
    for (const chunk of this.masks.keys()) this.dirty.add(chunk);
    this.masks.clear();
    this.destroyed = 0;
  }

  private ensureMask(chunk: number): Uint32Array {
    let mask = this.masks.get(chunk);
    if (mask === undefined) {
      mask = new Uint32Array(DAMAGE_WORDS_PER_CHUNK);
      this.masks.set(chunk, mask);
    }
    return mask;
  }

  /* ------------------------------------------------------------------ */
  /* Dirty tracking — drives chunk rebuilds                             */
  /* ------------------------------------------------------------------ */

  /** Chunks changed since the last `clearDirty()`. */
  takeDirty(): number[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  /** Chunks changed since the last `takeDirty()`, without consuming them. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Dense 8 KB snapshot with a 16-byte header, matching the shape
   * `PvsTable.serialize` uses so both can share a save-file container.
   */
  serialize(): Uint8Array {
    const bytes = new Uint8Array(DAMAGE_HEADER_BYTES + DAMAGE_TOTAL_BYTES);
    const view = new DataView(bytes.buffer);
    const words = new Uint32Array(bytes.buffer, DAMAGE_HEADER_BYTES, CHUNK_COUNT * DAMAGE_WORDS_PER_CHUNK);
    for (const [chunk, mask] of this.masks) {
      words.set(mask, chunk * DAMAGE_WORDS_PER_CHUNK);
    }
    view.setUint32(0, DAMAGE_MAGIC, true);
    view.setUint32(4, DAMAGE_VERSION, true);
    view.setUint32(8, CHUNK_COUNT, true);
    view.setUint32(12, checksum(words), true);
    return bytes;
  }

  /** Restore a snapshot produced by `serialize`. Throws on a bad container. */
  static deserialize(bytes: Uint8Array): ChunkDamageState {
    if (bytes.byteLength !== DAMAGE_HEADER_BYTES + DAMAGE_TOTAL_BYTES) {
      throw new Error(`damage snapshot is ${bytes.byteLength} B, expected ${DAMAGE_HEADER_BYTES + DAMAGE_TOTAL_BYTES}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) !== DAMAGE_MAGIC) throw new Error('damage snapshot: bad magic');
    if (view.getUint32(4, true) !== DAMAGE_VERSION) throw new Error('damage snapshot: bad version');
    if (view.getUint32(8, true) !== CHUNK_COUNT) throw new Error('damage snapshot: chunk count mismatch');

    // Copy rather than alias: the caller's buffer may be a view into a larger
    // save blob with an offset the Uint32Array constructor would reject.
    const words = new Uint32Array(CHUNK_COUNT * DAMAGE_WORDS_PER_CHUNK);
    for (let i = 0; i < words.length; i++) {
      words[i] = view.getUint32(DAMAGE_HEADER_BYTES + i * 4, true);
    }
    if (view.getUint32(12, true) !== checksum(words)) throw new Error('damage snapshot: checksum mismatch');

    const state = new ChunkDamageState();
    for (let chunk = 0; chunk < CHUNK_COUNT; chunk++) {
      const base = chunk * DAMAGE_WORDS_PER_CHUNK;
      let any = 0;
      for (let w = 0; w < DAMAGE_WORDS_PER_CHUNK; w++) any |= words[base + w]!;
      if (any === 0) continue;
      const mask = words.slice(base, base + DAMAGE_WORDS_PER_CHUNK);
      state.masks.set(chunk, mask);
      for (let w = 0; w < DAMAGE_WORDS_PER_CHUNK; w++) state.destroyed += popcount32(mask[w]!);
    }
    return state;
  }

  /** Snapshot for the debug HUD. */
  stats(): IDamageStats {
    return {
      damagedChunks: this.masks.size,
      destroyedPieces: this.destroyed,
      residentBytes: this.masks.size * DAMAGE_WORDS_PER_CHUNK * 4,
    };
  }
}

/** Hamming weight of a uint32. */
function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0x3f;
}

/** FNV-style rolling checksum, matching the spirit of the PVS container. */
function checksum(words: Uint32Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    h = Math.imul(h ^ words[i]!, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
