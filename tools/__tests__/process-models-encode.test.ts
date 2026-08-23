/**
 * MODEL TEXTURE ENCODING — THE PURE PARAMETER HELPERS
 *
 * `uastcQualityFor` exists because the model stage used to derive the encoder
 * effort arithmetically — `Math.round(quality / 25)`, capped at 4 — while every
 * ultra model entry declares quality 92. That rounds to 4, and the measurement
 * recorded in the sibling texture stage says level 4 costs 224.0 s against
 * 12.3 s for level 3, for +0.07 dB. The texture stage acts on that and
 * hard-codes 3; this stage now agrees.
 *
 * `toQLevel` and `fitSize` sit beside it, are equally pure, and were equally
 * untested.
 */

import { describe, expect, it } from 'vitest';
import { fitSize, toQLevel, uastcQualityFor } from '../process-models.ts';

describe('uastcQualityFor', () => {
  it.each([
    [0, 0],
    [40, 2],
    [55, 2],
    [80, 3],
    [87, 3],
    // The case that motivates the cap: every ultra model entry asks for 92.
    [92, 3],
    [100, 3],
    [-5, 0],
    [Number.NaN, 0],
  ])('maps quality %p to encoder level %p', (quality, expected) => {
    expect(uastcQualityFor(quality)).toBe(expected);
  });

  it('is non-decreasing and stays inside 0..3 across the whole range', () => {
    let previous = -1;
    for (let q = 0; q <= 100; q += 1) {
      const level = uastcQualityFor(q);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(3);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });
});

describe('toQLevel', () => {
  it.each([
    [0, 1],
    [50, 128],
    [100, 255],
  ])('maps quality %p to qlevel %p', (quality, expected) => {
    expect(toQLevel(quality)).toBe(expected);
  });

  it('never leaves 1..255', () => {
    for (const q of [-100, -1, 0, 1, 50, 99, 100, 1000]) {
      expect(toQLevel(q)).toBeGreaterThanOrEqual(1);
      expect(toQLevel(q)).toBeLessThanOrEqual(255);
    }
  });
});

describe('fitSize', () => {
  it('clamps the longest edge and keeps the aspect ratio', () => {
    expect(fitSize(4096, 2048, 1024)).toEqual([1024, 512]);
  });

  it('never upscales', () => {
    expect(fitSize(100, 100, 512)).toEqual([100, 100]);
  });

  it('always returns block-encodable dimensions', () => {
    // KTX-Software's block encoders require a multiple of four, and a zero or
    // one-pixel edge is not encodable at all.
    const cases: [number, number, number][] = [
      [1023, 511, 512],
      [7, 3, 512],
      [1, 1, 512],
      [4096, 2048, 1024],
      [513, 257, 256],
      [2, 4093, 1024],
    ];
    for (const [w, h, max] of cases) {
      for (const dimension of fitSize(w, h, max)) {
        expect(dimension).toBeGreaterThanOrEqual(4);
        expect(dimension % 4).toBe(0);
      }
    }
  });
});
