/**
 * THE BAKER AND THE SAMPLER HAVE TO AGREE ABOUT THE LAYOUT
 *
 * `bakeLutStrip` writes the shipping house look into a 1024x32 strip and
 * `LUT_STRIP_GLSL` reads it back with a hand-rolled half-texel inset and a
 * two-slice lerp. The contract — "slice index is BLUE, x is RED, y is GREEN",
 * plus the `+0.5` insets — is stated in two places, the baker's index
 * arithmetic and the sampler's UV arithmetic, and nothing checked that they
 * agree. An off-by-one there is a subtly wrong colour on every composed frame,
 * on both shipping composer tiers.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  ANIME_GRADE,
  bakeLutStrip,
  LUT_SIZE,
  LUT_STRIP_HEIGHT,
  LUT_STRIP_WIDTH,
  NEUTRAL_GRADE,
} from '../post/lut';

/** The baked bytes of a strip. */
function bytesOf(options?: Parameters<typeof bakeLutStrip>[0]): Uint8Array {
  return bakeLutStrip(options).image.data as unknown as Uint8Array;
}

/** The baker's own index arithmetic: `x = b * 32 + r`, row `g`. */
function texelAt(
  data: Uint8Array,
  r: number,
  g: number,
  b: number
): [number, number, number, number] {
  const index = (g * LUT_STRIP_WIDTH + (b * LUT_SIZE + r)) * 4;
  return [data[index]!, data[index + 1]!, data[index + 2]!, data[index + 3]!];
}

/** What a grid point must round-trip to on an identity table. */
const identityByte = (v: number): number => Math.round((v / (LUT_SIZE - 1)) * 255);

describe('LUT strip shape', () => {
  it('is a 32-slice strip with the flags a raw display-space table needs', () => {
    expect(LUT_STRIP_WIDTH).toBe(LUT_SIZE * LUT_SIZE);
    expect(LUT_STRIP_HEIGHT).toBe(LUT_SIZE);

    const texture = bakeLutStrip();
    expect(texture.image.width).toBe(1024);
    expect(texture.image.height).toBe(32);
    expect((texture.image.data as unknown as Uint8Array).length).toBe(1024 * 32 * 4);
    // Tagging this sRGB decodes the table itself: the documented double-transfer
    // trap, and a washed-out frame with no error anywhere.
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    expect(texture.flipY).toBe(false);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
    expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
  });
});

describe('NEUTRAL_GRADE', () => {
  it('bakes the exact identity table at all 32768 grid points', () => {
    const data = bytesOf(NEUTRAL_GRADE);
    let mismatches = 0;

    for (let b = 0; b < LUT_SIZE; b++) {
      for (let g = 0; g < LUT_SIZE; g++) {
        for (let r = 0; r < LUT_SIZE; r++) {
          const [R, G, B, A] = texelAt(data, r, g, b);
          if (
            R !== identityByte(r) ||
            G !== identityByte(g) ||
            B !== identityByte(b) ||
            A !== 255
          ) {
            mismatches++;
          }
        }
      }
    }

    expect(mismatches).toBe(0);
  });

  it('places the axes where the header says', () => {
    const data = bytesOf(NEUTRAL_GRADE);
    const flat = (r: number, g: number, b: number): number =>
      (g * LUT_STRIP_WIDTH + (b * LUT_SIZE + r)) * 4;

    // Stated separately from the sweep above so a failure is readable.
    expect(flat(1, 0, 0) - flat(0, 0, 0)).toBe(4); // r: one texel in x
    expect(flat(0, 0, 1) - flat(0, 0, 0)).toBe(32 * 4); // b: one slice in x
    expect(flat(0, 1, 0) - flat(0, 0, 0)).toBe(1024 * 4); // g: one row
    expect(data.length).toBe(1024 * 32 * 4);
  });

  it('round-trips through the GLSL sampler at every grid point', () => {
    const data = bytesOf(NEUTRAL_GRADE);

    /**
     * `LUT_STRIP_GLSL` ported literally, restricted to GRID-ALIGNED colours:
     * `u = (0.5 + r) / 1024` lands exactly on texel centre `r`, `v = (0.5 + g)
     * / 32` on row `g`, and `blue = b` gives `blend === 0`. Bilinear filtering
     * therefore degenerates to a nearest fetch and no filter emulation is
     * needed. Non-grid inputs are DELIBERATELY out of scope — do not "fix" this
     * test by emulating bilinear filtering.
     */
    const sampleNeutralGrid = (r: number, g: number, b: number): [number, number, number] => {
      const last = LUT_SIZE - 1;
      const u = (0.5 + (r / last) * last) / (LUT_SIZE * LUT_SIZE);
      const v = (0.5 + (g / last) * last) / LUT_SIZE;
      const px = Math.floor(u * LUT_STRIP_WIDTH) + b * LUT_SIZE;
      const py = Math.floor(v * LUT_STRIP_HEIGHT);
      const i = (py * LUT_STRIP_WIDTH + px) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    };

    const mismatches: string[] = [];
    for (let b = 0; b < LUT_SIZE; b++) {
      for (let g = 0; g < LUT_SIZE; g++) {
        for (let r = 0; r < LUT_SIZE; r++) {
          const [R, G, B] = sampleNeutralGrid(r, g, b);
          if (R !== identityByte(r) || G !== identityByte(g) || B !== identityByte(b)) {
            mismatches.push(`(${r},${g},${b}) -> ${R},${G},${B}`);
          }
        }
      }
    }

    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe('ANIME_GRADE', () => {
  it('keeps its stated look: warm highlights, cool shadows', () => {
    const data = bytesOf(ANIME_GRADE);

    const white = texelAt(data, 31, 31, 31);
    expect(white[0]).toBe(255);
    expect(white[2]).toBeLessThan(white[0]);

    const black = texelAt(data, 0, 0, 0);
    expect(black[0]).toBe(0);
    expect(black[2]).toBeGreaterThan(black[0]);
  });

  it('stays monotonic per channel, so the table cannot band', () => {
    const data = bytesOf(ANIME_GRADE);

    // lift/gamma/gain/temperature/saturation and the S-curve are each monotonic
    // in the channel; a non-monotonic table means banding or posterisation.
    for (const [g, b] of [
      [0, 0],
      [15, 15],
      [31, 31],
      [7, 24],
      [24, 7],
    ]) {
      let previous = -1;
      for (let r = 0; r < LUT_SIZE; r++) {
        const value = texelAt(data, r, g!, b!)[0];
        expect(value, `R at r=${r}, g=${g}, b=${b}`).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });
});

describe('grade parameters', () => {
  it('saturation 0 collapses every grid point onto the luma axis', () => {
    const data = bytesOf({ saturation: 0 });
    for (let b = 0; b < LUT_SIZE; b += 3) {
      for (let g = 0; g < LUT_SIZE; g += 3) {
        for (let r = 0; r < LUT_SIZE; r += 3) {
          const [R, G, B] = texelAt(data, r, g, b);
          expect(Math.abs(R - G)).toBeLessThanOrEqual(1);
          expect(Math.abs(G - B)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('a zero gain channel zeroes that channel everywhere', () => {
    const data = bytesOf({ gain: [1, 1, 0] });
    for (let b = 0; b < LUT_SIZE; b += 3) {
      for (let g = 0; g < LUT_SIZE; g += 3) {
        for (let r = 0; r < LUT_SIZE; r += 3) {
          expect(texelAt(data, r, g, b)[2]).toBe(0);
        }
      }
    }
  });

  it('contrast 0 is a true no-op', () => {
    expect(bytesOf({ contrast: 0 })).toEqual(bytesOf(NEUTRAL_GRADE));
  });
});
