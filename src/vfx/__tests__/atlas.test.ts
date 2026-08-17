/**
 * The generated atlases: determinism, channel sanity and the mip-safety margin.
 *
 * These textures are the art. If they regress, every effect regresses with
 * them, and nothing downstream would notice — a wrong occlusion channel just
 * makes dust look slightly flat. So they are asserted on directly.
 */

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { ATLAS_TILES, CRACK_TILES, SpriteTile } from '../constants';
import { atlasBytes, createCrackAtlas, createParticleAtlas } from '../atlas';

function pixels(texture: THREE.DataTexture): Uint8Array {
  return texture.image.data as unknown as Uint8Array;
}

/** Mean alpha over one tile of an atlas. */
function tileAlpha(data: Uint8Array, size: number, tiles: number, tile: number): number {
  const tileSize = size / tiles;
  const tx = (tile % tiles) * tileSize;
  const ty = Math.floor(tile / tiles) * tileSize;
  let total = 0;
  for (let y = 0; y < tileSize; y++) {
    for (let x = 0; x < tileSize; x++) {
      total += data[((ty + y) * size + (tx + x)) * 4 + 3]!;
    }
  }
  return total / (tileSize * tileSize);
}

/** Maximum alpha on the one-texel frame around a tile. */
function tileBorderAlpha(data: Uint8Array, size: number, tiles: number, tile: number): number {
  const tileSize = size / tiles;
  const tx = (tile % tiles) * tileSize;
  const ty = Math.floor(tile / tiles) * tileSize;
  let max = 0;
  for (let i = 0; i < tileSize; i++) {
    const samples = [
      data[(ty * size + (tx + i)) * 4 + 3]!,
      data[((ty + tileSize - 1) * size + (tx + i)) * 4 + 3]!,
      data[((ty + i) * size + tx) * 4 + 3]!,
      data[((ty + i) * size + tx + tileSize - 1) * 4 + 3]!,
    ];
    for (const value of samples) if (value > max) max = value;
  }
  return max;
}

describe('particle atlas', () => {
  const size = 128;
  const atlas = createParticleAtlas(size, 'test');

  it('is deterministic for a given seed', () => {
    const again = createParticleAtlas(size, 'test');
    expect(Array.from(pixels(again))).toEqual(Array.from(pixels(atlas)));
  });

  it('differs for a different seed', () => {
    const other = createParticleAtlas(size, 'different');
    expect(Array.from(pixels(other))).not.toEqual(Array.from(pixels(atlas)));
  });

  it('fills every tile with real coverage', () => {
    for (let tile = 0; tile < ATLAS_TILES * ATLAS_TILES; tile++) {
      const mean = tileAlpha(pixels(atlas), size, ATLAS_TILES, tile);
      expect(mean, `tile ${tile} is empty`).toBeGreaterThan(2);
      expect(mean, `tile ${tile} is a solid block`).toBeLessThan(240);
    }
  });

  it('keeps a transparent border on every tile so mips cannot bleed', () => {
    for (let tile = 0; tile < ATLAS_TILES * ATLAS_TILES; tile++) {
      expect(
        tileBorderAlpha(pixels(atlas), size, ATLAS_TILES, tile),
        `tile ${tile} touches its own edge`
      ).toBe(0);
    }
  });

  it('gives the dust tiles a solid core rather than uniform haze', () => {
    // The whole "grey puff" failure mode is puffs that are semi-transparent
    // everywhere. A dust tile must reach full opacity somewhere.
    const data = pixels(atlas);
    const tileSize = size / ATLAS_TILES;
    for (const tile of [SpriteTile.DustSoft, SpriteTile.DustDense, SpriteTile.Cloud]) {
      const tx = (tile % ATLAS_TILES) * tileSize;
      const ty = Math.floor(tile / ATLAS_TILES) * tileSize;
      let max = 0;
      for (let y = 0; y < tileSize; y++) {
        for (let x = 0; x < tileSize; x++) {
          const a = data[((ty + y) * size + (tx + x)) * 4 + 3]!;
          if (a > max) max = a;
        }
      }
      expect(max, `tile ${tile} never reaches opacity`).toBeGreaterThan(250);
    }
  });

  it('varies the occlusion channel inside a dust tile', () => {
    // A flat occlusion channel means the fake volumetric shading has nothing
    // to work with and every puff shades like a billiard ball.
    const data = pixels(atlas);
    const tileSize = size / ATLAS_TILES;
    const tile = SpriteTile.DustSoft;
    const tx = (tile % ATLAS_TILES) * tileSize;
    const ty = Math.floor(tile / ATLAS_TILES) * tileSize;
    let min = 255;
    let max = 0;
    for (let y = 0; y < tileSize; y++) {
      for (let x = 0; x < tileSize; x++) {
        const index = ((ty + y) * size + (tx + x)) * 4;
        if (data[index + 3]! < 200) continue;
        const g = data[index + 1]!;
        if (g < min) min = g;
        if (g > max) max = g;
      }
    }
    expect(max - min).toBeGreaterThan(40);
  });
});

describe('crack atlas', () => {
  const size = 128;
  const atlas = createCrackAtlas(size, 'test');

  it('is deterministic for a given seed', () => {
    const again = createCrackAtlas(size, 'test');
    expect(Array.from(pixels(again))).toEqual(Array.from(pixels(atlas)));
  });

  it('draws something in every tile', () => {
    for (let tile = 0; tile < CRACK_TILES * CRACK_TILES; tile++) {
      expect(tileAlpha(pixels(atlas), size, CRACK_TILES, tile)).toBeGreaterThan(1);
    }
  });

  it('reports its GPU footprint including mips', () => {
    // 512^2 RGBA is 1 MB; the mip chain adds a third.
    expect(atlasBytes(512)).toBeGreaterThan(1024 * 1024);
    expect(atlasBytes(512)).toBeLessThan(1.5 * 1024 * 1024);
  });
});
