/**
 * LOT SUBDIVISION
 *
 * Two invariants, checked over every parcel the district actually ships:
 * a lot never leaves its parcel (or a wall ends up over the pavement the ground
 * pass has already kerbed), and two lots never overlap (or two buildings
 * interpenetrate). Neither is visible in merged geometry.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@/util';
import { subdivideBlock } from '../block';
import { blockSeed, indexPlan } from '../plan';
import { polygonBounds } from '../polygon';
import { CITY_Z_PLAN } from './fixtures';

const EPS = 1e-6;

describe('subdivideBlock over the committed plan', () => {
  it('keeps every lot inside its parcel and clear of every other lot', () => {
    const index = indexPlan(CITY_Z_PLAN);
    let lotCount = 0;
    for (const block of CITY_Z_PLAN.blocks) {
      const zone = index.zoneOfBlock(block);
      // `generateBlock` does not subdivide these at all.
      if (zone.kind === 'park' || zone.kind === 'crater') continue;
      const rng = createRng(blockSeed(CITY_Z_PLAN.planVersion, block.id, block.salt)).derive(
        'lots'
      );
      const lots = subdivideBlock(block.outline, zone.params, block, rng);
      const parcel = polygonBounds(block.outline);
      const rects = lots.map((lot) => polygonBounds(lot.footprint));
      for (const r of rects) {
        expect(r.minX, block.id).toBeGreaterThanOrEqual(parcel.minX - EPS);
        expect(r.maxX, block.id).toBeLessThanOrEqual(parcel.maxX + EPS);
        expect(r.minZ, block.id).toBeGreaterThanOrEqual(parcel.minZ - EPS);
        expect(r.maxZ, block.id).toBeLessThanOrEqual(parcel.maxZ + EPS);
        expect(r.maxX - r.minX, block.id).toBeGreaterThan(0);
        expect(r.maxZ - r.minZ, block.id).toBeGreaterThan(0);
      }
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const overlapX =
            Math.min(rects[i].maxX, rects[j].maxX) - Math.max(rects[i].minX, rects[j].minX);
          const overlapZ =
            Math.min(rects[i].maxZ, rects[j].maxZ) - Math.max(rects[i].minZ, rects[j].minZ);
          expect(
            overlapX > EPS && overlapZ > EPS,
            `${block.id}: lots ${i} and ${j} overlap by ${overlapX.toFixed(2)} x ${overlapZ.toFixed(2)} m`
          ).toBe(false);
        }
      }
      lotCount += lots.length;
    }
    expect(lotCount).toBeGreaterThan(500);
  });
});
