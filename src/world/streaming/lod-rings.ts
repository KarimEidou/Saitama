/**
 * LOD RING ASSIGNMENT WITH HYSTERESIS
 *
 * Which of the four rings a chunk belongs to, and — much more importantly —
 * when it is allowed to change.
 *
 * ── THE FAILURE THIS PREVENTS ──────────────────────────────────────────────
 * Ring membership is a function of distance, and distance is continuous, so a
 * camera parked exactly on a ring boundary flips a chunk between two rings on
 * the noise in its own position. Each flip is a full worker rebuild, a GPU
 * upload and a teardown, at 60 Hz, forever, for a player who is standing still
 * reading a sign. It is the single most expensive thing a streaming system can
 * do and the easiest state to enter, because players stop moving constantly.
 *
 * The fix is a dead band. A chunk must travel `RING_HYSTERESIS_CHUNKS` PAST a
 * boundary before it demotes, and the same distance INSIDE the finer band
 * before it promotes. The two thresholds do not coincide, so there is no
 * distance at which a small oscillation crosses both — which is exactly the
 * property "hysteresis" names.
 *
 * The band is 0.35 chunks (33.6 m). Wide enough to swallow a sprint's worth of
 * jitter at a boundary; narrow enough that the wrong LOD is never visible for
 * more than a third of a chunk.
 *
 * ── LOAD/UNLOAD USES THE SAME TRICK ────────────────────────────────────────
 * `shouldEvict` applies `EVICT_MARGIN_CHUNKS` on top of the resident radius,
 * which is what `IWorldConfig.evictionRadiusChunks > streamingRadiusChunks`
 * exists to express: the radius at which a chunk is dropped is deliberately
 * larger than the radius at which it is loaded.
 */

import type { IQualityTier } from '@/types';
import { CHUNK_COUNT } from '@/spatial/constants';
import {
  EVICT_MARGIN_CHUNKS,
  RESIDENT_RADIUS_CHUNKS_BY_TIER,
  RING_COUNT,
  RING_HYSTERESIS_CHUNKS,
  RING_OUTER_CHUNKS,
  RING_R3,
} from './constants';

/** Ring a distance falls in with no hysteresis applied. */
export function ringForDistance(distanceChunks: number): number {
  for (let ring = 0; ring < RING_OUTER_CHUNKS.length; ring++) {
    if (distanceChunks <= RING_OUTER_CHUNKS[ring]!) return ring;
  }
  return RING_R3;
}

/**
 * Ring a chunk should move to, given the ring it is already in.
 *
 * @param distanceChunks Chebyshev distance to the chunk centre, in chunk units.
 * @param currentRing    Ring the chunk is in now, or -1 when it has none yet.
 */
export function ringWithHysteresis(distanceChunks: number, currentRing: number): number {
  const target = ringForDistance(distanceChunks);
  if (currentRing < 0 || target === currentRing) return target;

  if (target > currentRing) {
    // Demoting to a coarser ring: require the chunk to be clearly PAST the
    // outer edge of the ring it currently occupies.
    const boundary = RING_OUTER_CHUNKS[currentRing];
    if (boundary === undefined) return target;
    return distanceChunks > boundary + RING_HYSTERESIS_CHUNKS ? target : currentRing;
  }

  // Promoting to a finer ring: require the chunk to be clearly INSIDE the
  // finer band, not merely touching its outer edge.
  const boundary = RING_OUTER_CHUNKS[target];
  if (boundary === undefined) return target;
  return distanceChunks < boundary - RING_HYSTERESIS_CHUNKS ? target : currentRing;
}

/** Resident radius in chunk units for a render tier. */
export function residentRadiusFor(tier: IQualityTier): number {
  return RESIDENT_RADIUS_CHUNKS_BY_TIER[tier];
}

/** True when a chunk this far away should be built and kept resident. */
export function shouldLoad(distanceChunks: number, residentRadius: number): boolean {
  return distanceChunks <= residentRadius;
}

/** True when a resident chunk this far away should be torn down. */
export function shouldEvict(distanceChunks: number, residentRadius: number): boolean {
  return distanceChunks > residentRadius + EVICT_MARGIN_CHUNKS;
}

/**
 * Per-chunk ring memory plus transition counters.
 *
 * Dense `Int8Array` over all 256 chunks rather than a `Map`: the array is 256
 * bytes, it is walked in full every frame, and a `Map` lookup per chunk per
 * frame would cost more than the entire assignment pass.
 */
export class RingAssigner {
  /** Current ring per chunk; -1 for chunks that have never been assigned. */
  private readonly rings = new Int8Array(CHUNK_COUNT).fill(-1);
  /** Ring transitions since construction, for thrash detection. */
  private transitions = 0;
  /** Transitions that the hysteresis band suppressed. */
  private suppressed = 0;
  /** Chunks currently in each ring, refreshed by `beginPass`/`assign`. */
  private readonly counts = new Int32Array(RING_COUNT + 1);

  /** Ring a chunk is currently assigned to, or -1. */
  ringOf(chunk: number): number {
    return this.rings[chunk]!;
  }

  /** Reset the per-ring population counters before a pass. */
  beginPass(): void {
    this.counts.fill(0);
  }

  /**
   * Assign a chunk from its distance, applying hysteresis. Returns the ring the
   * chunk should now be in, and records whether that was a change.
   */
  assign(chunk: number, distanceChunks: number): number {
    const current = this.rings[chunk]!;
    const next = ringWithHysteresis(distanceChunks, current);
    const naive = ringForDistance(distanceChunks);
    if (next !== current) {
      if (current >= 0) this.transitions++;
      this.rings[chunk] = next;
    } else if (naive !== current) {
      this.suppressed++;
    }
    this.counts[next]!++;
    return next;
  }

  /** Forget a chunk's ring, e.g. when it is evicted. */
  forget(chunk: number): void {
    this.rings[chunk] = -1;
  }

  /** Chunks assigned to a ring during the last pass. */
  countFor(ring: number): number {
    return this.counts[ring] ?? 0;
  }

  /** Ring changes since construction. */
  get transitionCount(): number {
    return this.transitions;
  }

  /** Ring changes the hysteresis band prevented. */
  get suppressedCount(): number {
    return this.suppressed;
  }

  /** Zero the counters without forgetting assignments. */
  resetCounters(): void {
    this.transitions = 0;
    this.suppressed = 0;
  }

  /** Forget everything. */
  clear(): void {
    this.rings.fill(-1);
    this.counts.fill(0);
    this.resetCounters();
  }
}
