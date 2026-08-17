/**
 * STRUCTURAL SUPPORT — WHEN DOES A FLOOR STOP HOLDING THE ONE ABOVE IT
 *
 * The city generator bakes a `supportShare` per fracture chunk summing to 1
 * across each storey, so "how much of this floor is still standing" is a sum,
 * not a simulation. A floor whose surviving share drops below
 * `collapseSupportRatio` (0.4 — i.e. more than 60% gone) fails, and everything
 * above it comes with it.
 *
 * ── WHY THIS EXISTS WHEN THE GENERATOR ALREADY HAS IT ──────────────────────
 * The generator's `collapsingFloors` is the authority, and the bootstrap
 * injects it (`CollapsingFloorsFn`). This is the FALLBACK, so the destruction
 * system runs standalone — in a unit test, in a headless replay, in a build
 * where the city module has not loaded yet — with identical behaviour.
 *
 * "Identical" is asserted, not asserted-in-a-comment: `__tests__/support.test.ts`
 * runs both implementations over thousands of randomised destruction patterns
 * on real generated layouts and requires byte-equal output.
 */

import type { IStructureLayout } from './ports';

/**
 * Support remaining on one floor, 0..1.
 *
 * O(chunks in the floor) — four, for a rectangular building. The system keeps
 * a running total per floor anyway (see `structure.ts`); this is the
 * definition that total is checked against.
 */
export function remainingSupport(
  layout: IStructureLayout,
  floor: number,
  isDestroyed: (chunkIndex: number) => boolean
): number {
  const info = layout.floors[floor];
  if (info === undefined) return 1;
  let remaining = 0;
  for (const index of info.chunks) {
    const chunk = layout.chunks[index];
    if (chunk !== undefined && !isDestroyed(index)) remaining += chunk.supportShare;
  }
  return remaining;
}

/**
 * Floors that must come down: the LOWEST floor whose support has fallen below
 * the threshold, and everything above it.
 *
 * Lowest-first is the whole model. A building does not fail at the storey you
 * punched, it fails at the lowest storey that can no longer carry its load,
 * and then pancakes upward from there.
 */
export function collapsingFloors(
  layout: IStructureLayout,
  isDestroyed: (chunkIndex: number) => boolean
): number[] {
  for (let f = 0; f < layout.floors.length; f++) {
    if (remainingSupport(layout, f, isDestroyed) < layout.collapseSupportRatio) {
      const out: number[] = [];
      for (let g = f; g < layout.floors.length; g++) out.push(g);
      return out;
    }
  }
  return [];
}
