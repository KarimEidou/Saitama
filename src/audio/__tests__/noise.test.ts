/**
 * NOISE BUFFERS — determinism, sharing, level and spectral tilt.
 *
 * `noise.ts` makes three headline claims in its header and none of them was
 * asserted anywhere:
 *
 *  1. generation "is driven by the project's seeded RNG, never `Math.random()`,
 *     so an offline render of any voice is bit-identical between runs" — which
 *     is the stated foundation of every numeric assertion in `render.test.ts`;
 *  2. the buffers are "generated ONCE per `AudioContext` and shared";
 *  3. the three kinds really are flat / -3 dB per octave / -6 dB per octave.
 *
 * The generator needs nothing from a context but `sampleRate` and
 * `createBuffer`, so all three are checkable in Node in milliseconds — and the
 * tilt can be measured with the project's own analyser, which already runs
 * here (`analysis.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import { createNoiseSource, getNoiseBuffer, type NoiseKind } from '../noise';
import * as A from '../testing/analysis';

const SR = 44100;
const KINDS: readonly NoiseKind[] = ['white', 'pink', 'brown'];

/** What `createNoiseSource` writes onto the node it builds. */
interface IFakeSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly started: { when: number; offset: number }[];
  start(when?: number, offset?: number): void;
}

type FakeContext = BaseAudioContext & { readonly sources: IFakeSource[] };

/** Enough of a context for the buffer generator: it uses nothing else. */
function fakeContext(sampleRate = SR): FakeContext {
  const sources: IFakeSource[] = [];
  return {
    sampleRate,
    sources,
    createBuffer(channels: number, length: number, rate: number) {
      const data = new Float32Array(length);
      return {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: () => data,
      };
    },
    createBufferSource() {
      const src: IFakeSource = {
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        started: [],
        start(when = 0, offset = 0) {
          src.started.push({ when, offset });
        },
      };
      sources.push(src);
      return src;
    },
  } as unknown as FakeContext;
}

const channel = (ctx: BaseAudioContext, kind: NoiseKind, seconds: number): Float32Array =>
  getNoiseBuffer(ctx, kind, seconds).getChannelData(0);

/** Largest absolute sample-for-sample difference between two channels. */
function maxDiff(a: Float32Array, b: Float32Array): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
}

/* -------------------------------------------------------------------------- */

describe('buffer cache', () => {
  it('returns the identical object for a repeated request', () => {
    const ctx = fakeContext();
    expect(getNoiseBuffer(ctx, 'white', 0.5)).toBe(getNoiseBuffer(ctx, 'white', 0.5));
  });

  it('keys on kind, length and seed', () => {
    const ctx = fakeContext();
    const base = getNoiseBuffer(ctx, 'white', 0.5);
    expect(getNoiseBuffer(ctx, 'pink', 0.5)).not.toBe(base);
    expect(getNoiseBuffer(ctx, 'white', 0.6)).not.toBe(base);
    expect(getNoiseBuffer(ctx, 'white', 0.5, 12345)).not.toBe(base);
  });

  it('is per context, so an offline render gets its own set', () => {
    const a = fakeContext();
    const b = fakeContext();
    expect(getNoiseBuffer(a, 'white', 0.5)).not.toBe(getNoiseBuffer(b, 'white', 0.5));
  });
});

describe('determinism', () => {
  it('is bit-identical across contexts for the same kind, length and seed', () => {
    // This is what makes the numeric assertions in the render suite stable: a
    // single `Math.random()` anywhere in the generator would break every one
    // of them, intermittently.
    const a = fakeContext();
    const b = fakeContext();
    for (const kind of KINDS) {
      expect(maxDiff(channel(a, kind, 0.5), channel(b, kind, 0.5))).toBe(0);
    }
  });

  it('actually depends on the seed', () => {
    const ctx = fakeContext();
    for (const kind of KINDS) {
      const base = getNoiseBuffer(ctx, kind, 0.5).getChannelData(0);
      const other = getNoiseBuffer(ctx, kind, 0.5, 0xbeef).getChannelData(0);
      expect(maxDiff(base, other)).toBeGreaterThan(0);
    }
  });
});

describe('level', () => {
  it('normalises every kind to the 0.92 target', () => {
    for (const kind of KINDS) {
      const peak = A.peak(channel(fakeContext(), kind, 0.5));
      // The loop cross-fade is a convex blend, so it can only lower a peak.
      expect(peak).toBeLessThanOrEqual(0.92 + 1e-6);
      // ...and it did normalise: a silent or unnormalised buffer fails here.
      expect(peak).toBeGreaterThanOrEqual(0.5);
    }
  });
});

describe('spectral tilt', () => {
  const low = (d: Float32Array): number => A.bandFraction(d, SR, 20, 200);

  it('orders the three kinds by low-frequency energy', () => {
    const ctx = fakeContext();
    const white = low(channel(ctx, 'white', 0.5));
    const pink = low(channel(ctx, 'pink', 0.5));
    const brown = low(channel(ctx, 'brown', 0.5));
    // -6 dB/oct below -3 dB/oct below flat: the reason all three exist.
    expect(brown).toBeGreaterThan(pink);
    expect(pink).toBeGreaterThan(white);
  });

  it('holds absolute margins, so the test still bites if the ordering survives', () => {
    // Measured over bins 1-9 of a 2048-point FFT at 44.1 kHz:
    // brown ~0.52, pink ~0.35, white ~0.009.
    const ctx = fakeContext();
    expect(low(channel(ctx, 'brown', 0.5))).toBeGreaterThan(0.45);
    expect(low(channel(ctx, 'pink', 0.5))).toBeGreaterThan(0.15);
    expect(low(channel(ctx, 'pink', 0.5))).toBeLessThan(0.5);
    expect(low(channel(ctx, 'white', 0.5))).toBeLessThan(0.06);
  });
});

describe('length', () => {
  it('never produces a buffer too short to loop', () => {
    const ctx = fakeContext();
    expect(getNoiseBuffer(ctx, 'white', 0.0001).length).toBeGreaterThanOrEqual(128);
    expect(getNoiseBuffer(ctx, 'white', 1).length).toBeGreaterThanOrEqual(SR);
  });
});

describe('createNoiseSource', () => {
  it('loops a SHARED buffer and starts immediately', () => {
    const ctx = fakeContext();
    const src = createNoiseSource(ctx, 'pink', 0.25, 2.5) as unknown as IFakeSource;
    expect(src.loop).toBe(true);
    // Shared, not regenerated: this is the whole point of the module cache.
    expect(src.buffer).toBe(getNoiseBuffer(ctx, 'pink', 2.5));
    expect(src.started.length).toBe(1);
    expect(src.started[0]!.when).toBe(0);
    const duration = getNoiseBuffer(ctx, 'pink', 2.5).duration;
    expect(src.started[0]!.offset).toBeCloseTo(0.25 * duration, 9);
  });
});

describe('offset normalisation', () => {
  const offsetFor = (fraction: number): number => {
    const ctx = fakeContext();
    const src = createNoiseSource(ctx, 'white', fraction, 1) as unknown as IFakeSource;
    return src.started[0]!.offset;
  };
  const duration = getNoiseBuffer(fakeContext(), 'white', 1).duration;

  it('leaves an in-range fraction untouched', () => {
    expect(offsetFor(0.25)).toBeCloseTo(0.25 * duration, 9);
  });

  it('wraps a NEGATIVE fraction into [0, 1) instead of throwing', () => {
    // `%` keeps the sign of its dividend, so -0.25 reached `start()` as a
    // negative offset — a RangeError from a publicly exported helper.
    expect(offsetFor(-0.25)).toBeCloseTo(0.75 * duration, 9);
    expect(offsetFor(-3.5)).toBeCloseTo(0.5 * duration, 9);
  });

  it('wraps a fraction at or above 1', () => {
    expect(offsetFor(1.25)).toBeCloseTo(0.25 * duration, 9);
    expect(offsetFor(1)).toBe(0);
  });

  it('treats a non-finite fraction as zero', () => {
    expect(offsetFor(Number.NaN)).toBe(0);
    expect(offsetFor(Number.POSITIVE_INFINITY)).toBe(0);
    expect(offsetFor(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('always lands inside the buffer', () => {
    for (const fraction of [-3.5, -0.25, 0, 0.5, 1, 1.25, 7.75]) {
      const offset = offsetFor(fraction);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(duration);
    }
  });
});
