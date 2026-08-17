/**
 * ADDRESSING THE PERSISTENT DAMAGE BITMASK
 *
 * The world's destruction record is 8 KB for the whole city — 256 chunks x 16
 * buildings x 16 pieces, one bit each. That budget is what lets damage live in
 * memory forever and go into a save file with no serialisation format, and it
 * is not negotiable.
 *
 * ── THE GRANULARITY GAP, STATED HONESTLY ───────────────────────────────────
 * The bitmask's 16 pieces per building are 4 vertical bands x 4 plan quarters.
 * A live pre-fractured building is 4 chunks per STOREY — 48 for a 12-storey
 * tower. The mask is therefore a strictly coarser tier, and a round trip
 * through it alone cannot reproduce "floor 7's east wall, and only that".
 *
 * So destruction keeps TWO records, and is explicit about which does what:
 *
 *   LEDGER (`structure-ledger.ts`)  exact, one byte per fracture chunk, held
 *                                   for as long as the process lives. This is
 *                                   what a stream-out / stream-in round trip
 *                                   restores from, so within a session the
 *                                   city comes back damaged EXACTLY as it was.
 *
 *   BITMASK (this addressing)       coarse, 1 bit per band x quarter, owned by
 *                                   the streaming system, transferable to the
 *                                   geometry worker, and the thing that
 *                                   survives a save. A far-LOD rebuild reads
 *                                   it and omits the boxes; that rebuild is
 *                                   already a box-per-piece approximation of
 *                                   the building, so band granularity is the
 *                                   right granularity for it.
 *
 * ── THE FACE-TO-CORNER MAP ─────────────────────────────────────────────────
 * A fracture chunk is one FACE of one floor (+X, +Z, -X, -Z). A mask piece is
 * one CORNER of one band ((-X,-Z), (+X,-Z), (-X,+Z), (+X,+Z)). Four faces into
 * four corners has no direction-preserving bijection, so the map below picks,
 * for each face, a corner that TOUCHES it, walking the compass so the four
 * faces land on four distinct corners. Destroying a whole storey therefore
 * clears the whole band, and destroying the east wall marks the east side —
 * which is as much as a coarse tier can promise.
 */

import { DAMAGE_BANDS, DAMAGE_PIECES_PER_BUILDING, DAMAGE_PLAN_QUARTERS } from './constants';

/**
 * Facade quadrant (0 = +X, 1 = +Z, 2 = -X, 3 = -Z) to plan quarter
 * (`pz * 2 + px`, px/pz 0 = negative side, 1 = positive side).
 *
 *   +X -> (px 1, pz 0) = 1
 *   +Z -> (px 1, pz 1) = 3
 *   -X -> (px 0, pz 1) = 2
 *   -Z -> (px 0, pz 0) = 0
 */
const QUADRANT_TO_PLAN_QUARTER = [1, 3, 2, 0] as const;

/** Inverse of the map above, for restoring from a mask. */
const PLAN_QUARTER_TO_QUADRANT = [3, 0, 2, 1] as const;

/** Vertical band 0..3 a storey belongs to. */
export function bandForFloor(floor: number, floorCount: number): number {
  if (floorCount <= 1) return 0;
  const band = Math.floor((floor * DAMAGE_BANDS) / floorCount);
  return band < 0 ? 0 : band > DAMAGE_BANDS - 1 ? DAMAGE_BANDS - 1 : band;
}

/**
 * Piece index 0..15 inside a building for one fracture chunk.
 *
 * Matches the streaming layout's own ordering:
 * `band * 4 + (pz * 2 + px)`.
 */
export function pieceForChunk(floor: number, quadrant: number, floorCount: number): number {
  const band = bandForFloor(floor, floorCount);
  const quarter = QUADRANT_TO_PLAN_QUARTER[quadrant & 3]!;
  return band * DAMAGE_PLAN_QUARTERS + quarter;
}

/**
 * Slot index inside a chunk's mask.
 * `buildingIndex * 16 + pieceIndex`, matching `damageSlot()` in
 * `src/world/streaming/damage-state.ts` bit for bit.
 */
export function damageSlot(buildingIndex: number, pieceIndex: number): number {
  return buildingIndex * DAMAGE_PIECES_PER_BUILDING + pieceIndex;
}

/** True when a mask piece corresponds to this fracture chunk. */
export function chunkMatchesPiece(
  floor: number,
  quadrant: number,
  floorCount: number,
  pieceIndex: number
): boolean {
  return pieceForChunk(floor, quadrant, floorCount) === pieceIndex;
}

/** The facade quadrant a mask plan quarter came from. For restore paths. */
export function quadrantForPlanQuarter(quarter: number): number {
  return PLAN_QUARTER_TO_QUADRANT[quarter & 3]!;
}
