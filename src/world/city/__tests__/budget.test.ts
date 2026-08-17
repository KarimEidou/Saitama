/**
 * DRAW-CALL AND GEOMETRY BUDGETS
 *
 * The three-slot design only pays off if it actually holds, and it is the kind
 * of invariant that decays silently — one well-meant "just use a separate
 * material for the shutters" and a block costs four draw calls, which across a
 * resident set is a hundred extra calls a frame on a phone.
 *
 * So the budget is asserted rather than documented:
 *
 *   • every merged block resolves to at most 3 draw calls;
 *   • a chunk's ground resolves to at most 4, and merges across a region;
 *   • the whole resident set stays inside 90 draw calls.
 *
 * No frame rate is measured anywhere here; these are counts, which are exact.
 */

import { describe, expect, it } from 'vitest';
import { reportDrawCalls } from '../city';
import { mergeChunkGrounds } from '../ground';
import { MAT_SLOT_COUNT } from '../mesh-builder';
import { makeGenerator, SAMPLE_CHUNKS } from './fixtures';

describe('per-block draw calls', () => {
  it('never exceeds three draw calls for a merged block', () => {
    const generator = makeGenerator('full');
    let blocks = 0;
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      for (const block of generator.generate(cx, cz).blocks) {
        expect(
          block.drawCalls,
          `${block.id} (${block.zoneKind}) has ${block.drawCalls} groups`
        ).toBeLessThanOrEqual(MAT_SLOT_COUNT);
        expect(block.geometry.buffers.groups.length).toBe(block.drawCalls);
        blocks++;
      }
    }
    expect(blocks).toBeGreaterThan(5);
  });

  it('holds across the entire city at every detail level', () => {
    for (const detail of ['full', 'reduced', 'box'] as const) {
      const generator = makeGenerator(detail);
      let worst = 0;
      let blocks = 0;
      // Sample a stride across the whole 16x16 grid rather than all 256
      // chunks at full detail, which would dominate the suite's runtime.
      for (let cz = -8; cz < 8; cz += 3) {
        for (let cx = -8; cx < 8; cx += 3) {
          for (const block of generator.generate(cx, cz).blocks) {
            worst = Math.max(worst, block.drawCalls);
            blocks++;
          }
        }
      }
      expect(blocks).toBeGreaterThan(20);
      expect(worst, `${detail} detail`).toBeLessThanOrEqual(MAT_SLOT_COUNT);
    }
  });

  it('assigns each group a distinct material slot', () => {
    const generator = makeGenerator('full');
    for (const block of generator.generate(0, 0).blocks) {
      const slots = block.geometry.buffers.groups.map((g) => g.slot);
      expect(new Set(slots).size).toBe(slots.length);
      // Groups stay in ascending slot order so `materialIndex` maps directly.
      expect(slots).toEqual([...slots].sort((a, b) => a - b));
    }
  });

  it('leaves no gaps or overlaps between material groups', () => {
    const generator = makeGenerator('full');
    for (const block of generator.generate(0, 0).blocks) {
      const groups = block.geometry.buffers.groups;
      let cursor = 0;
      for (const g of groups) {
        expect(g.start).toBe(cursor);
        cursor += g.count;
      }
      expect(cursor).toBe(block.geometry.buffers.indexCount);
    }
  });
});

describe('ground budget', () => {
  it('costs at most four draw calls per chunk', () => {
    const generator = makeGenerator('full');
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      const ground = generator.generate(cx, cz).ground;
      expect(ground).toBeDefined();
      expect(ground!.drawCalls).toBeLessThanOrEqual(4);
    }
  });

  it('merges a region down to four calls per distinct material set', () => {
    const generator = makeGenerator('box');
    const region = generator.generateRegion(0, 0, 2);
    const grounds = region.map((c) => c.ground!).filter(Boolean);
    const merged = mergeChunkGrounds(grounds);
    // 25 chunks -> a handful of merged meshes, not 25.
    expect(merged.length).toBeLessThan(grounds.length);
    for (const m of merged) expect(m.drawCalls).toBeLessThanOrEqual(4);
    const totalBefore = grounds.reduce((n, g) => n + g.triangles, 0);
    const totalAfter = merged.reduce((n, g) => n + g.triangles, 0);
    expect(totalAfter).toBe(totalBefore);
  });
});

describe('resident set budget', () => {
  it('keeps a 5x5 resident region inside 90 draw calls', () => {
    const generator = makeGenerator('full');
    const region = generator.generateRegion(0, 0, 2);
    const report = reportDrawCalls(region);
    expect(report.chunks).toBe(25);
    expect(report.worstBlockCalls).toBeLessThanOrEqual(3);
    expect(
      report.total,
      `blocks=${report.blockCalls} ground=${report.groundCalls} props=${report.propCalls}`
    ).toBeLessThanOrEqual(90);
  });

  it('keeps the densest part of downtown inside the budget too', () => {
    const generator = makeGenerator('full');
    const report = reportDrawCalls(generator.generateRegion(0, 0, 1));
    expect(report.total).toBeLessThanOrEqual(90);
    expect(report.worstBlockCalls).toBeLessThanOrEqual(3);
  });

  it('produces geometry at every sampled chunk', () => {
    const generator = makeGenerator('full');
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      const chunk = generator.generate(cx, cz);
      expect(chunk.triangles, `chunk ${cx},${cz}`).toBeGreaterThan(0);
      expect(chunk.estimatedBytes).toBeGreaterThan(0);
    }
  });
});
