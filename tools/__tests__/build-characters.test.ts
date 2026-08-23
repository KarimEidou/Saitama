/**
 * THE CHARACTER BAKER'S PURE HELPERS
 *
 * `parseArgs` and `matches` decide what gets baked and — through the
 * `describesRoster` gate — whether the COMMITTED manifest is rewritten, so a
 * silently-ignored typo in either is a 14-character bake that quietly rewrites
 * a tracked file. `writePng` and `sha256` are the integrity path for every file
 * the baker declares: the manifest's `sha256` is now taken from the buffer
 * `writePng` returns rather than from a read-back, and that substitution is
 * only sound if the two agree, which is asserted here.
 *
 * `atlasPatchSize` and `rootBoneIndex` are the two places where the baker used
 * to disagree with something else and say nothing about it — with
 * `compositeFace`'s texel count, and with the idea that a rig has a root.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type * as THREE from 'three';
import type { RosterEntry } from '@/characters/roster';
import {
  atlasPatchSize,
  matches,
  parseArgs,
  rootBoneIndex,
  sha256,
  srgbToLinear,
  writePng,
} from '../build-characters.ts';

/** Every scratch tree made during a test, torn down in `afterEach`. */
const scratch: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'baker-'));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** `matches` reads only `id`; nothing else needs to exist. */
function entry(id: string): RosterEntry {
  return { id } as unknown as RosterEntry;
}

/* -------------------------------------------------------------------------- */
/* parseArgs                                                                  */
/* -------------------------------------------------------------------------- */

describe('parseArgs', () => {
  it('defaults to a full roster bake at the roster atlas edge', () => {
    expect(parseArgs([])).toEqual({
      only: [],
      size: 1024,
      ao: true,
      vat: true,
      glb: true,
      manifest: true,
    });
  });

  it('splits --only on commas', () => {
    expect(parseArgs(['--only', 'saitama,genos']).only).toEqual(['saitama', 'genos']);
  });

  it('accepts every --no-* flag without disturbing the others', () => {
    const options = parseArgs(['--no-ao', '--no-vat', '--no-glb', '--no-manifest']);
    expect(options.ao).toBe(false);
    expect(options.vat).toBe(false);
    expect(options.glb).toBe(false);
    expect(options.manifest).toBe(false);
    expect(options.only).toEqual([]);
    expect(options.size).toBe(1024);
  });

  it('reads --size as an integer', () => {
    expect(parseArgs(['--size', '512']).size).toBe(512);
  });

  it.each([['--size', '1k'], ['--size', ''], ['--size', '32'], ['--size', '8192'], ['--size']])(
    'rejects a --size that is not an in-range integer (%s %s)',
    (...argv) => {
      // The failure has to land on the ARGUMENT. Unvalidated, `Number('1k')` is
      // NaN and the run died eight frames deep in the face rasteriser with a
      // message about `sharp`.
      expect(() => parseArgs(argv)).toThrow(/--size expects an integer/);
    }
  );

  it('rejects an unknown flag instead of silently discarding it', () => {
    // The whole point: a typo used to run the slowest job in the repository to
    // completion with the flag ignored.
    expect(() => parseArgs(['--no-mainfest'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--onlY', 'saitama'])).toThrow(/unknown argument/);
  });

  it('rejects a bare positional — the flag is --only', () => {
    expect(() => parseArgs(['saitama'])).toThrow(/unknown argument/);
  });

  it('names every accepted flag in the rejection message', () => {
    let message = '';
    try {
      parseArgs(['--nope']);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const flag of ['--only', '--size', '--no-ao', '--no-vat', '--no-glb', '--no-manifest']) {
      expect(message).toContain(flag);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* matches                                                                    */
/* -------------------------------------------------------------------------- */

describe('matches', () => {
  it('matches everything when no filter is given', () => {
    expect(matches(entry('chr.saitama'), [])).toBe(true);
    expect(matches(entry('anything'), [])).toBe(true);
  });

  it('matches an exact id and a dot-suffixed one', () => {
    expect(matches(entry('saitama'), ['saitama'])).toBe(true);
    expect(matches(entry('chr.saitama'), ['saitama'])).toBe(true);
  });

  it('does not match a deeper suffix', () => {
    expect(matches(entry('chr.saitama.alt'), ['saitama'])).toBe(false);
  });

  it('is a segment test, never a substring one', () => {
    // Pins the deliberate choice of `endsWith('.' + filter)`: `--only tama`
    // must not silently bake Saitama.
    expect(matches(entry('chr.saitama'), ['tama'])).toBe(false);
  });

  it('matches if any filter matches', () => {
    expect(matches(entry('chr.genos'), ['saitama', 'genos'])).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* sha256                                                                     */
/* -------------------------------------------------------------------------- */

describe('sha256', () => {
  it('hashes the empty input to the published SHA-256 of zero bytes', () => {
    expect(sha256(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
  });

  it('agrees with node:crypto on a 1 KiB buffer', () => {
    const buffer = Buffer.alloc(1024);
    for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 31 + 7) & 0xff;
    expect(sha256(buffer)).toBe(createHash('sha256').update(buffer).digest('hex'));
  });
});

/* -------------------------------------------------------------------------- */
/* srgbToLinear                                                               */
/* -------------------------------------------------------------------------- */

describe('srgbToLinear', () => {
  it('pins the endpoints', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
  });

  it('maps mid grey to the standard linear value', () => {
    expect(srgbToLinear(0.5)).toBeCloseTo(0.214, 4);
  });

  it('is strictly increasing across 0…1', () => {
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const value = srgbToLinear(i / 100);
      expect(value).toBeGreaterThan(previous);
      previous = value;
    }
  });

  it('is continuous at the 0.04045 knee', () => {
    // The two branches must meet there, or every dark texel picks up a step.
    // The tolerance is 1e-8 rather than 0 on purpose: the sRGB standard rounds
    // its own constants (0.04045 / 12.92 / 0.055 / 1.055), which leaves a
    // ~2.3e-9 step at the breakpoint — 6 orders of magnitude below one 8-bit
    // code value, and a property of the spec rather than of this function. A
    // transposed constant would move the seam by far more than this.
    const knee = 0.04045;
    expect(Math.abs(srgbToLinear(knee) - srgbToLinear(knee + 1e-12))).toBeLessThan(1e-8);
  });
});

/* -------------------------------------------------------------------------- */
/* atlasPatchSize                                                             */
/* -------------------------------------------------------------------------- */

describe('atlasPatchSize', () => {
  it('uses compositeFace’s formula, which the old one disagreed with', () => {
    // 613 - 309 = 304, while `round((u1 - u0) * size)` gives 305. One texel is
    // the difference between a copy and a nearest-neighbour resample of every
    // face in the roster, so the divergent case is asserted explicitly.
    expect(atlasPatchSize(0.3013, 0.5987, 1024)).toBe(304);
    expect(atlasPatchSize(0.3013, 0.5987, 1024)).not.toBe(Math.round((0.5987 - 0.3013) * 1024));
  });

  it('never returns less than one texel', () => {
    expect(atlasPatchSize(0.5, 0.5, 1024)).toBe(1);
    expect(atlasPatchSize(0.5, 0.5001, 1024)).toBe(1);
  });

  it('agrees with compositeFace for a thousand random rects at 512 and 1024', () => {
    // A plain LCG rather than a shared helper: this test must not depend on
    // another unit to state what it is checking.
    let state = 0x5a17a;
    const next = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let i = 0; i < 1000; i++) {
      const u0 = next();
      const u1 = u0 + next() * (1 - u0);
      for (const size of [512, 1024]) {
        const value = atlasPatchSize(u0, u1, size);
        expect(value).toBe(Math.max(1, Math.round(u1 * size) - Math.round(u0 * size)));
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* rootBoneIndex                                                              */
/* -------------------------------------------------------------------------- */

/** Structural stand-ins: `rootBoneIndex` reads only `parent`. */
function chain(length: number, rootAt: number): readonly THREE.Bone[] {
  const bones = Array.from({ length }, () => ({ parent: null as unknown }));
  for (let i = 0; i < length; i++) {
    if (i === rootAt) continue;
    bones[i]!.parent = bones[rootAt]!;
  }
  return bones as unknown as readonly THREE.Bone[];
}

describe('rootBoneIndex', () => {
  it('finds a root that comes first', () => {
    expect(rootBoneIndex(chain(3, 0))).toBe(0);
  });

  it('finds a root that does not come first', () => {
    // Proves the answer is computed, not the hard-coded 0 the old
    // `Math.max(0, findIndex(...))` collapsed to.
    expect(rootBoneIndex(chain(3, 2))).toBe(2);
  });

  it('throws on a cycle instead of rooting the skin at an arm', () => {
    const a = { parent: null as unknown };
    const b = { parent: a as unknown };
    a.parent = b;
    const bones = [a, b] as unknown as readonly THREE.Bone[];
    expect(() => rootBoneIndex(bones)).toThrow(/no root bone/);
  });
});

/* -------------------------------------------------------------------------- */
/* writePng                                                                   */
/* -------------------------------------------------------------------------- */

describe('writePng', () => {
  /** A 4x4 RGB gradient, tightly packed. */
  function rgb4(): Uint8Array {
    const data = new Uint8Array(4 * 4 * 3);
    for (let i = 0; i < 16; i++) {
      data[i * 3] = i * 16;
      data[i * 3 + 1] = 255 - i * 16;
      data[i * 3 + 2] = 128;
    }
    return data;
  }

  it('writes a PNG at the source size when no resize is asked for', async () => {
    const file = path.join(freshDir(), 'albedo.png');
    const png = await writePng(file, rgb4(), 4, 3);

    expect(existsSync(file)).toBe(true);
    const metadata = await sharp(file).metadata();
    expect(metadata.width).toBe(4);
    expect(metadata.height).toBe(4);
    expect(png.byteLength).toBeGreaterThan(0);
  });

  it('resizes to resizeTo, leaving the source buffer alone', async () => {
    const file = path.join(freshDir(), 'albedo.png');
    const source = rgb4();
    await writePng(file, source, 4, 3, 2);

    const metadata = await sharp(file).metadata();
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(2);
    // 4x4x3 still: the resize happens inside sharp, not in our buffer.
    expect(source.byteLength).toBe(48);
  });

  it('returns exactly the bytes it wrote, on both the resize and no-resize paths', async () => {
    // This is what makes hashing the returned buffer sound: the manifest's
    // `sha256` used to come from reading the file straight back off disk.
    const dir = freshDir();
    for (const [name, resizeTo] of [
      ['plain.png', undefined],
      ['small.png', 2],
    ] as const) {
      const file = path.join(dir, name);
      const returned = await writePng(file, rgb4(), 4, 3, resizeTo);
      expect(sha256(returned)).toBe(sha256(await readFile(file)));
      expect(returned.byteLength).toBe(statSync(file).size);
    }
  });
});
