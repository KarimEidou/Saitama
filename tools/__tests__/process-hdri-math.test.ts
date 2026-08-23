/**
 * HDRI MATH — HALF-FLOAT ENCODING AND SH9 PROJECTION
 *
 * `projectSH9`, `peakLuminance` and `toHalfFloat` are already exported "for
 * verification" and nothing verified them. They are the only diffuse lighting
 * the mobile tier has, and their two most dangerous failure modes are silent:
 *
 *   • A SIGN FLIP in the vertical convention lights the whole city from below,
 *     with no error anywhere. `process-hdri.ts` spends a paragraph on the flip
 *     precisely because it cannot be checked by looking at the output.
 *   • A NORMALISATION change scales every baked probe by a constant that reads
 *     as an art decision rather than a regression.
 *
 * All of it is pure arithmetic — no files, no `ktx` binary, no network — so the
 * conventions can simply be pinned. The exact values below were measured
 * against the implementation, so this encodes real behaviour, not a guess.
 *
 * `decodeRadianceHdr` is deliberately out of scope here.
 */

import { describe, expect, it } from 'vitest';
import { peakLuminance, projectSH9, toHalfFloat } from '../process-hdri.ts';

/** `IHdrImage` is module-private; name it through the function that takes it. */
type HdrImage = Parameters<typeof projectSH9>[0];

function image(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number]
): HdrImage {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = fill(x, y);
      const o = (y * width + x) * 3;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
    }
  }
  return { width, height, data };
}

const WHITE: [number, number, number] = [1, 1, 1];
const BLACK: [number, number, number] = [0, 0, 0];

describe('toHalfFloat', () => {
  it.each([
    ['zero', 0, 0x0000],
    ['one', 1, 0x3c00],
    ['minus one', -1, 0xbc00],
    ['a half', 0.5, 0x3800],
    ['two', 2, 0x4000],
    ['the largest finite half', 65504, 0x7bff],
    ['an overflow', 70000, 0x7bff],
    ['a negative overflow', -70000, 0xfbff],
    ['positive infinity', Number.POSITIVE_INFINITY, 0x7bff],
    ['negative infinity', Number.NEGATIVE_INFINITY, 0xfbff],
    ['NaN', Number.NaN, 0x0000],
    ['the smallest normal (2^-14)', 6.103515625e-5, 0x0400],
    ['the smallest subnormal (2^-24)', 2 ** -24, 0x0001],
    ['an underflow (2^-25)', 2 ** -25, 0x0000],
    ['an exact tie, rounded to even', 1 + 2 ** -11, 0x3c00],
    ['just above the tie, rounded up', 1 + 3 * 2 ** -12, 0x3c01],
  ])('encodes %s', (_label, input, expected) => {
    expect(toHalfFloat(input)).toBe(expected);
  });

  it('saturates rather than overflowing to half-Inf', () => {
    // 0x7C00 is half-Inf. One Inf texel in the solar disc spreads through every
    // mip level that averages it and turns a quarter of the sky into NaN the
    // first time something multiplies it by zero — which is the entire reason
    // this encoder clamps instead of overflowing.
    expect(toHalfFloat(1e30)).not.toBe(0x7c00);
    expect(toHalfFloat(1e30)).toBe(0x7bff);
  });
});

describe('peakLuminance', () => {
  it('reads the brightest texel of a 2x1 image', () => {
    expect(peakLuminance(image(2, 1, (x) => (x === 0 ? WHITE : BLACK)))).toBe(1);
  });

  it('is zero for a black image', () => {
    expect(peakLuminance(image(2, 2, () => BLACK))).toBe(0);
  });

  it('weights the channels by Rec.709', () => {
    expect(peakLuminance(image(2, 1, () => [0, 2, 0]))).toBeCloseTo(0.7152 * 2, 6);
  });

  it('is the peak, not the mean', () => {
    const sparse = image(4, 2, (x, y) => (x === 1 && y === 1 ? [10, 10, 10] : BLACK));
    expect(peakLuminance(sparse)).toBeCloseTo(10, 6);
  });
});

describe('projectSH9 over a constant sky', () => {
  const sky = projectSH9(image(256, 128, () => WHITE));

  it('returns 27 finite coefficients', () => {
    expect(sky.flat).toHaveLength(27);
    expect(sky.flat.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("uses three.js's LightProbeGenerator normalisation", () => {
    // Getting this constant wrong scales ALL baked lighting by a factor that
    // looks like someone's exposure preference.
    const expected = 4 * Math.PI * 0.282095;
    for (const channel of [0, 1, 2]) {
      expect(sky.flat[channel]).toBeCloseTo(expected, 9);
    }
  });

  it('leaves every directional band at zero', () => {
    // Measured worst residual at this resolution: 1.7e-4, in flat[24]. It is
    // 2.8e-3 at 64x32, so do not shrink the image without loosening this.
    expect(Math.max(...sky.flat.slice(3).map(Math.abs))).toBeLessThan(1e-3);
  });

  it('reports a mean luminance of 1', () => {
    expect(sky.meanLuminance).toBeCloseTo(1, 9);
  });

  it('is linear in radiance', () => {
    const doubled = projectSH9(image(256, 128, () => [2, 2, 2]));
    expect(doubled.flat[0]).toBeCloseTo(sky.flat[0] * 2, 9);
    expect(doubled.meanLuminance).toBeCloseTo(2, 9);
  });
});

/**
 * The direction conventions. `flat[j * 3 + channel]`, so the y/z/x dipoles of
 * the red channel are flat[3], flat[6] and flat[9]. Row 0 is v = 0.
 */
describe('projectSH9 direction conventions', () => {
  const half = (bright: (y: number) => boolean) =>
    projectSH9(image(64, 32, (_x, y) => (bright(y) ? WHITE : BLACK)));

  const band = (centre: number) =>
    projectSH9(image(64, 32, (x) => (Math.abs((x + 0.5) / 64 - centre) < 0.1 ? WHITE : BLACK)));

  it('puts a bright lower half on the positive y lobe', () => {
    // A regression that flips the buffer, or drops `flipVertical`, fails here —
    // and nothing downstream would have noticed the city being lit from below.
    const lower = half((y) => y >= 16);
    expect(lower.flat[3]).toBeGreaterThan(0.5);
    expect(Math.abs(lower.flat[6])).toBeLessThan(1e-6);
    expect(Math.abs(lower.flat[9])).toBeLessThan(1e-6);
  });

  it('mirrors the y lobe for a bright upper half', () => {
    expect(half((y) => y < 16).flat[3]).toBeLessThan(-0.5);
  });

  it('puts a band centred at u = 0.5 on the positive x lobe', () => {
    const centred = band(0.5);
    expect(centred.flat[9]).toBeGreaterThan(0.5);
    expect(Math.abs(centred.flat[6])).toBeLessThan(1e-6);
  });

  it('puts a band centred at u = 0.75 on the positive z lobe', () => {
    const quarter = band(0.75);
    expect(quarter.flat[6]).toBeGreaterThan(0.5);
    expect(Math.abs(quarter.flat[9])).toBeLessThan(1e-6);
  });

  it('puts a band centred at u = 0.25 on the negative z lobe', () => {
    expect(band(0.25).flat[6]).toBeLessThan(-0.5);
  });
});
