/**
 * THE CPU ENVIRONMENT MATH, PINNED AGAINST ITS OWN CONVENTION
 *
 * `sh9.ts` carries a CONVENTION block ending "Do not 'fix' the normalisation
 * without checking against that function", and `procedural-sky.ts` says
 * "`sh9.ts` uses the same inverse mapping — if you change one, change both."
 * Neither statement was enforced by anything.
 *
 * These are the functions where a sign flip or a factor of pi produces a scene
 * that is merely DIFFERENTLY lit — no crash, no warning — and the mobile tier
 * is the one that takes this path. It is all pure CPU maths over `DataTexture`
 * payloads, so it tests exactly.
 *
 * Assertions are on the returned `SphericalHarmonics3` only, never on an
 * internal resolution: every source here is <= 128px wide, below any plausible
 * downsample threshold, so a future pre-projection downsample leaves them alone.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createEquirectReader, downsampleEquirect } from '../equirect';
import { averageIrradiance, deserializeSH9, projectEquirectToSH9, serializeSH9 } from '../sh9';
import { createProceduralSkyTexture } from '../procedural-sky';

/** A readable float equirect map, in the module's own row-0-is-down convention. */
function floatEquirect(
  w: number,
  h: number,
  fill: (x: number, y: number) => [number, number, number]
): THREE.DataTexture {
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  t.colorSpace = THREE.LinearSRGBColorSpace;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

/** A byte equirect map filled with one value, tagged as `colorSpace`. */
function byteEquirect(value: number, colorSpace: THREE.ColorSpace): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array(4 * 4 * 4).fill(value), 4, 4);
  t.colorSpace = colorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * The band-1 dominant direction, in three's basis order — `[1]=y, [2]=z,
 * [3]=x` (`SphericalHarmonics3.getBasisAt`).
 */
function dominantDirection(sh: THREE.SphericalHarmonics3): THREE.Vector3 {
  const sum = (v: THREE.Vector3): number => v.x + v.y + v.z;
  return new THREE.Vector3(
    sum(sh.coefficients[3]!),
    sum(sh.coefficients[1]!),
    sum(sh.coefficients[2]!)
  ).normalize();
}

describe('createEquirectReader', () => {
  it('refuses a texture whose pixels are not reachable', () => {
    // A DOM-image or compressed-KTX2 texture: no `image.data` to read.
    expect(createEquirectReader(new THREE.Texture())).toBeNull();
    // Below the 2x2 guard.
    expect(createEquirectReader(new THREE.DataTexture(new Uint8Array(4), 1, 1))).toBeNull();
  });

  it('reads Float32 RGBA verbatim', () => {
    const reader = createEquirectReader(floatEquirect(4, 2, () => [0.25, 0.5, 0.75]));
    expect(reader).not.toBeNull();
    expect(reader!.channels).toBe(4);
    expect(reader!.width).toBe(4);
    expect(reader!.height).toBe(2);
    expect(reader!.read(0)).toBe(0.25);
    expect(reader!.read(1)).toBe(0.5);
  });

  it('decodes half-float payloads', () => {
    const data = new Uint16Array(2 * 2 * 4);
    data[0] = THREE.DataUtils.toHalfFloat(0.5);
    const texture = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat, THREE.HalfFloatType);
    expect(createEquirectReader(texture)!.read(0)).toBeCloseTo(0.5, 4);
  });

  it('undoes the sRGB transfer only when the texture is tagged as colour', () => {
    // This pair is the whole reason the module exists: the same byte means two
    // different radiances depending on the tag, and getting it wrong is a full
    // gamma of error with no diagnostic.
    const srgb = createEquirectReader(byteEquirect(188, THREE.SRGBColorSpace))!;
    expect(srgb.read(0)).toBeCloseTo(0.5029, 4);

    const raw = createEquirectReader(byteEquirect(128, THREE.NoColorSpace))!;
    expect(raw.read(0)).toBeCloseTo(0.50196, 5);
  });

  it('reports the channel count the format implies', () => {
    const make = (format: THREE.PixelFormat, stride: number): number =>
      createEquirectReader(new THREE.DataTexture(new Uint8Array(4 * 4 * stride), 4, 4, format))!
        .channels;

    expect(make(THREE.RedFormat, 1)).toBe(1);
    expect(make(THREE.RGFormat, 2)).toBe(2);
    expect(make(THREE.RGBAFormat, 4)).toBe(4);
  });
});

describe('downsampleEquirect', () => {
  it('returns null when the request would not shrink the source', () => {
    const source = floatEquirect(16, 8, () => [1, 1, 1]);
    expect(downsampleEquirect(source, 32)).toBeNull();
    expect(downsampleEquirect(source, 16)).toBeNull();
  });

  it('box-filters each output texel from exactly its source block', () => {
    const source = floatEquirect(16, 8, (x, y) =>
      x >= 2 && x <= 3 && y >= 2 && y <= 3 ? [4, 4, 4] : [0, 0, 0]
    );
    const out = downsampleEquirect(source, 8)!;
    expect(out.image.width).toBe(8);
    expect(out.image.height).toBe(4);

    const data = out.image.data as unknown as Float32Array;
    const at = (x: number, y: number): number => data[(y * 8 + x) * 4]!;

    expect(at(1, 1)).toBe(4);
    expect(at(0, 1)).toBe(0);
    expect(at(2, 1)).toBe(0);
    expect(at(1, 0)).toBe(0);
    expect(at(1, 2)).toBe(0);
  });

  it('conserves energy — the documented reason a box filter was chosen', () => {
    // Point-sampling would lose or duplicate the sun's energy depending on
    // where the disc landed; averaging every source texel cannot.
    let seed = 12345;
    const random = (): number => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const source = floatEquirect(16, 8, () => [random() * 4, random() * 2, random()]);
    const out = downsampleEquirect(source, 8)!;

    const mean = (data: ArrayLike<number>, texels: number, channel: number): number => {
      let total = 0;
      for (let i = 0; i < texels; i++) total += data[i * 4 + channel]!;
      return total / texels;
    };
    const sourceData = source.image.data as unknown as Float32Array;
    const outData = out.image.data as unknown as Float32Array;

    for (let channel = 0; channel < 3; channel++) {
      expect(mean(outData, 8 * 4, channel)).toBeCloseTo(mean(sourceData, 16 * 8, channel), 6);
    }
  });

  it('tags the result for PMREM consumption', () => {
    const out = downsampleEquirect(
      floatEquirect(32, 16, () => [1, 1, 1]),
      16
    )!;
    expect(out.flipY).toBe(false);
    expect(out.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    expect(out.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(out.type).toBe(THREE.FloatType);
    expect(out.generateMipmaps).toBe(false);
    expect(out.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(out.image.height).toBe(out.image.width / 2);
  });
});

describe('projectEquirectToSH9', () => {
  it('returns null and says why when the pixels are unreachable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(projectEquirectToSH9(new THREE.Texture())).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toContain('no readable pixel');
    warn.mockRestore();
  });

  it('reproduces a uniform environment analytically', () => {
    // The single case that pins the entire normalisation convention the header
    // warns about: coefficients are normalised so the weights sum to 4pi, which
    // is what `SphericalHarmonics3.getIrradianceAt()` expects.
    const sh = projectEquirectToSH9(floatEquirect(128, 64, () => [0.5, 0.25, 0.125]))!;

    for (const [channel, c] of (['x', 'y', 'z'] as const).map(
      (k, i) => [k, [0.5, 0.25, 0.125][i]!] as const
    )) {
      expect(sh.coefficients[0]![channel]).toBeCloseTo(c * 4 * Math.PI * 0.282095, 4);
    }

    // A uniform environment has no directional content at all.
    for (let j = 1; j < 9; j++) {
      expect(sh.coefficients[j]!.length()).toBeLessThan(1e-3);
    }

    // Diffuse irradiance from a uniform radiance L is exactly pi * L.
    const out = new THREE.Vector3();
    for (const d of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      sh.getIrradianceAt(new THREE.Vector3(...d), out);
      expect(out.x).toBeCloseTo(Math.PI * 0.5, 3);
      expect(out.y).toBeCloseTo(Math.PI * 0.25, 3);
      expect(out.z).toBeCloseTo(Math.PI * 0.125, 3);
    }
  });

  it('averageIrradiance recovers the same constant', () => {
    const sh = projectEquirectToSH9(floatEquirect(128, 64, () => [0.5, 0.25, 0.125]))!;
    const average = averageIrradiance(sh);
    expect(average.r).toBeCloseTo(Math.PI * 0.5, 3);
    expect(average.g).toBeCloseTo(Math.PI * 0.25, 3);
    expect(average.b).toBeCloseTo(Math.PI * 0.125, 3);
  });

  it('scales linearly with intensity', () => {
    const source = floatEquirect(64, 32, () => [0.5, 0.25, 0.125]);
    const once = projectEquirectToSH9(source)!;
    const twice = projectEquirectToSH9(source, 2)!;

    for (let j = 0; j < 9; j++) {
      expect(twice.coefficients[j]!.x).toBeCloseTo(once.coefficients[j]!.x * 2, 10);
      expect(twice.coefficients[j]!.y).toBeCloseTo(once.coefficients[j]!.y * 2, 10);
      expect(twice.coefficients[j]!.z).toBeCloseTo(once.coefficients[j]!.z * 2, 10);
    }
  });

  it('maps u to azimuth: column 3/4 of the way across is +Z', () => {
    // u ~ 0.75 -> phi = pi/2 -> (cos phi, ., sin phi) = +Z.
    const sh = projectEquirectToSH9(
      floatEquirect(64, 32, (x, y) =>
        Math.abs(x - 48) < 2 && Math.abs(y - 16) < 2 ? [10, 10, 10] : [0, 0, 0]
      )
    )!;

    const front = new THREE.Vector3();
    const back = new THREE.Vector3();
    sh.getIrradianceAt(new THREE.Vector3(0, 0, 1), front);
    sh.getIrradianceAt(new THREE.Vector3(0, 0, -1), back);
    expect(front.x).toBeGreaterThan(back.x);

    expect(dominantDirection(sh).dot(new THREE.Vector3(0, 0, 1))).toBeGreaterThan(0.9);
  });

  it('maps v to elevation with row 0 straight DOWN', () => {
    const patchAt = (row: number): THREE.SphericalHarmonics3 =>
      projectEquirectToSH9(
        floatEquirect(64, 32, (x, y) =>
          Math.abs(x - 48) < 2 && Math.abs(y - row) < 2 ? [10, 10, 10] : [0, 0, 0]
        )
      )!;

    // `DataTexture.flipY` is false, so row 0 is v = 0, i.e. straight down.
    expect(dominantDirection(patchAt(24)).y).toBeGreaterThan(0);
    expect(dominantDirection(patchAt(8)).y).toBeLessThan(0);
  });

  it('agrees with procedural-sky about where the sun is', () => {
    // Both headers state this invariant ("if you change one, change both") and
    // nothing enforced it. A sign flip in EITHER file fails here.
    const sunDirection = new THREE.Vector3(-1, -0.15, 0);
    const sky = createProceduralSkyTexture({ width: 128, sunDirection });
    const sh = projectEquirectToSH9(sky)!;

    // `sunDirection` travels FROM the sun, so the direction TO it is negated.
    const toSun = sunDirection.clone().negate().normalize();
    const lit = new THREE.Vector3();
    const away = new THREE.Vector3();
    sh.getIrradianceAt(toSun, lit);
    sh.getIrradianceAt(toSun.clone().negate(), away);

    expect(lit.x).toBeGreaterThan(away.x);
    expect(lit.y).toBeGreaterThan(away.y);
    expect(lit.z).toBeGreaterThan(away.z);
  });
});

describe('SH9 serialisation', () => {
  it('round-trips 27 floats exactly', () => {
    const sh = projectEquirectToSH9(floatEquirect(64, 32, (x) => [x / 64, 0.25, 0.125]))!;
    const values = serializeSH9(sh);
    expect(values).toHaveLength(27);

    const restored = deserializeSH9(values)!;
    expect(restored).not.toBeNull();
    for (let j = 0; j < 9; j++) {
      expect(restored.coefficients[j]!.toArray()).toEqual(sh.coefficients[j]!.toArray());
    }
  });

  it('rejects a malformed array rather than half-loading it', () => {
    expect(deserializeSH9(new Array<number>(26).fill(0))).toBeNull();
    expect(deserializeSH9(new Array<number>(28).fill(0))).toBeNull();
  });
});
