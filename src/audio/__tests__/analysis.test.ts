/**
 * Tests for the MEASURING INSTRUMENT.
 *
 * Every claim the audio system makes about itself is a number produced by
 * `analysis.ts`, so these tests come first: they validate the analyser against
 * signals whose spectra are known analytically. If the FFT, the centroid or
 * the onset detector were wrong, every downstream assertion would be
 * measuring the wrong thing while still passing.
 */

import { describe, expect, it } from 'vitest';
import * as A from '../testing/analysis';

const SR = 44100;

function sine(hz: number, seconds: number, amplitude = 0.5, sampleRate = SR): Float32Array {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Exponential chirp from `from` to `to` over `seconds`. */
function chirp(from: number, to: number, seconds: number, amplitude = 0.5): Float32Array {
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = from * Math.pow(to / from, i / n);
    phase += (2 * Math.PI * f) / SR;
    out[i] = amplitude * Math.sin(phase);
  }
  return out;
}

/** Impulse train with a fixed or randomised gap. */
function impulses(times: readonly number[], seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  for (const t of times) {
    const at = Math.floor(t * SR);
    for (let j = 0; j < 120 && at + j < out.length; j++) {
      // Decaying burst of alternating sign: broadband, like a real transient.
      out[at + j] = Math.exp(-j / 25) * (j % 2 === 0 ? 0.8 : -0.8);
    }
  }
  return out;
}

describe('level metrics', () => {
  it('reports the analytic RMS and peak of a sine', () => {
    const s = sine(440, 1, 0.5);
    expect(A.rms(s)).toBeCloseTo(0.5 / Math.SQRT2, 3);
    expect(A.peak(s)).toBeCloseTo(0.5, 3);
    expect(Math.abs(A.dcOffset(s))).toBeLessThan(1e-3);
  });

  it('measures RMS over the sounding region, not the silence around it', () => {
    const tone = sine(440, 0.25, 0.5);
    const padded = new Float32Array(SR * 2);
    padded.set(tone, SR / 2);
    // Whole-buffer RMS is diluted by silence; active RMS is not.
    expect(A.rms(padded)).toBeLessThan(0.15);
    expect(A.activeRms(padded)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(A.activeDuration(padded, SR)).toBeCloseTo(0.25, 2);
  });

  it('counts full-scale samples', () => {
    const x = new Float32Array([0.1, 1, -1, 0.5, 0.99999]);
    expect(A.clippedSamples(x)).toBe(3);
    expect(A.clippedSamples(sine(100, 0.1, 0.5))).toBe(0);
  });

  it('reports zero stereo width for identical channels', () => {
    const a = sine(300, 0.2);
    expect(A.stereoWidth(a, a)).toBeCloseTo(0, 6);
    const b = sine(300, 0.2, 0.25);
    expect(A.stereoWidth(a, b)).toBeGreaterThan(0.1);
  });
});

describe('spectral metrics', () => {
  it('puts the centroid of a pure sine on the sine', () => {
    // `dominantFrequency` quantises to the FFT grid, so the tolerance has to
    // be at least one bin — 10.8 Hz at the 4096-point default.
    const binHz = SR / 4096;
    for (const hz of [60, 220, 1000, 4000, 9000]) {
      expect(A.spectralCentroid(sine(hz, 0.5), SR)).toBeCloseTo(hz, -1);
      const tolerance = Math.max(binHz, hz * 0.03);
      expect(Math.abs(A.dominantFrequency(sine(hz, 0.5), SR) - hz)).toBeLessThanOrEqual(tolerance);
    }
  });

  it('puts essentially all of a sine s power in its own band', () => {
    expect(A.bandFraction(sine(60, 0.5), SR, 20, 100)).toBeGreaterThan(0.9);
    expect(A.bandFraction(sine(60, 0.5), SR, 1000, 20000)).toBeLessThan(0.01);
    expect(A.bandFraction(sine(5000, 0.5), SR, 2000, 20000)).toBeGreaterThan(0.95);
    expect(A.bandFraction(sine(5000, 0.5), SR, 0, 100)).toBeLessThan(0.01);
  });

  it('produces a fingerprint that partitions the spectrum exactly once', () => {
    const fp = A.bandFingerprint(sine(1000, 0.5), SR);
    expect(fp).toHaveLength(A.OCTAVE_BAND_EDGES.length - 1);
    const total = fp.reduce((a, b) => a + b, 0);
    // Overlapping bands would push this above 1; gaps would push it below.
    expect(total).toBeGreaterThan(0.97);
    expect(total).toBeLessThan(1.0001);
    // 1000 Hz falls in the 710-1400 band, index 5.
    expect(fp[5]).toBeGreaterThan(0.9);
  });

  it('separates distinct spectra and collapses identical ones', () => {
    const low = A.bandFingerprint(sine(60, 0.5), SR);
    const high = A.bandFingerprint(sine(8000, 0.5), SR);
    expect(A.fingerprintDistance(low, low)).toBeCloseTo(0, 9);
    // No shared energy at all: the L1 distance approaches its maximum of 2.
    expect(A.fingerprintDistance(low, high)).toBeGreaterThan(1.9);
  });

  it('tracks a falling chirp with a falling centroid', () => {
    const falling = A.centroidOverTime(chirp(4000, 100, 2), SR, 4);
    for (let i = 1; i < falling.length; i++) {
      expect(falling[i]!).toBeLessThan(falling[i - 1]!);
    }
    expect(falling[0]! / falling[3]!).toBeGreaterThan(4);
  });

  it('tracks a falling chirp with falling high-band energy', () => {
    const high = A.bandFractionOverTime(chirp(6000, 80, 2), SR, 1000, 20000, 4);
    expect(high[0]!).toBeGreaterThan(0.8);
    expect(high[3]!).toBeLessThan(0.05);
  });

  it('measures spectral motion on the sounding region, ignoring trailing silence', () => {
    const sound = chirp(4000, 100, 1);
    const padded = new Float32Array(SR * 4);
    padded.set(sound, 0);
    // Naive slicing puts three of four slices in silence and reports zeros.
    const naive = A.centroidOverTime(padded, SR, 4);
    expect(naive[3]).toBe(0);
    const active = A.activeCentroidOverTime(padded, SR, 4);
    expect(active[3]).toBeGreaterThan(0);
    expect(active[3]!).toBeLessThan(active[0]!);
  });
});

describe('onset detection', () => {
  it('finds every hit in a regular impulse train', () => {
    const times = Array.from({ length: 20 }, (_, i) => 0.05 + i * 0.09);
    const onsets = A.detectOnsets(impulses(times, 2.2), SR, { relativeThreshold: 0.05 });
    expect(onsets.length).toBeGreaterThanOrEqual(18);
    expect(onsets.length).toBeLessThanOrEqual(20);
    expect(onsets[0]!).toBeCloseTo(0.05, 1);
  });

  it('scores a regular grid as regular and a clustered train as irregular', () => {
    const regular = Array.from({ length: 20 }, (_, i) => 0.05 + i * 0.09);
    // Deliberately clustered, the way falling rubble arrives.
    const clustered = [
      0.05, 0.06, 0.09, 0.24, 0.26, 0.5, 0.52, 0.53, 0.79, 1.05, 1.06, 1.2, 1.55, 1.57, 1.9,
    ];
    expect(A.intervalIrregularity(regular)).toBeLessThan(0.05);
    expect(A.intervalIrregularity(clustered)).toBeGreaterThan(0.5);
  });

  it('does not report a low sine as repeated onsets', () => {
    // Without pre-emphasis the short-time RMS ripples at the sine's own period
    // and a single 45 Hz thump reports as a dozen hits.
    const s = sine(45, 0.5, 0.6);
    const onsets = A.detectOnsets(s, SR);
    expect(onsets.length).toBeLessThanOrEqual(2);
  });

  it('returns nothing for silence', () => {
    expect(A.detectOnsets(new Float32Array(SR), SR)).toHaveLength(0);
    expect(A.rms(new Float32Array(SR))).toBe(0);
    expect(A.activeRms(new Float32Array(SR))).toBe(0);
  });
});

describe('fft', () => {
  it('round-trips a known bin exactly', () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    // Exactly 8 cycles across the frame: all energy lands in bin 8.
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 8 * i) / n);
    A.fft(re, im);
    const mag = (k: number): number => Math.hypot(re[k]!, im[k]!);
    expect(mag(8)).toBeCloseTo(n / 2, 6);
    expect(mag(7)).toBeLessThan(1e-8);
    expect(mag(9)).toBeLessThan(1e-8);
  });

  it('rejects a non-power-of-two length', () => {
    expect(() => A.fft(new Float64Array(100), new Float64Array(100))).toThrow(/power of two/);
  });
});
