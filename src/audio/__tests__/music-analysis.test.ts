/**
 * SHORT-SIGNAL SPECTRAL MEASUREMENT.
 *
 * (Named for this unit's `music-*`/`voices-*` test convention; the subject is
 * `src/audio/testing/analysis.ts`, alongside `analysis.test.ts`.)
 *
 * `powerSpectrum` has a separate branch for a signal shorter than one FFT
 * frame, and nothing exercised it: `measure()`'s attack window is 8820 samples
 * at `fftSize` 2048, and `centroidOverTime`/`bandFractionOverTime` always pick
 * an FFT size no larger than the slice. So this is the one part of the
 * measuring instrument the render suite never touches — which is exactly why it
 * needs its own test rather than none.
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

describe('spectral metrics on a signal shorter than one FFT frame', () => {
  it('measures a 10 ms tone without leaking out of its own band', () => {
    // 441 samples in a 2048-point frame. Windowing that with the first 441
    // coefficients of `hann(2048)` — a ramp from 0 to 0.045 ending on a step
    // discontinuity — leaked ~3 % of the tone's power out of a 500–2000 Hz band
    // and pulled the centroid 21 Hz low.
    const short = sine(1000, 0.01);
    expect(A.spectralCentroid(short, SR, 2048)).toBeCloseTo(1000, -1);
    expect(A.bandFraction(short, SR, 500, 2000, 2048)).toBeGreaterThan(0.99);
  });

  it('measures a 20 ms tone as accurately as a long one', () => {
    const short = sine(1000, 0.02);
    const long = sine(1000, 0.5);
    expect(A.spectralCentroid(short, SR, 2048)).toBeCloseTo(A.spectralCentroid(long, SR, 2048), -1);
  });

  it('still measures the pitch of a short tone', () => {
    for (const hz of [500, 1000, 3000]) {
      const short = sine(hz, 0.01);
      // One bin of a 2048-point frame at 44.1 kHz is 21.5 Hz.
      expect(Math.abs(A.dominantFrequency(short, SR, 2048) - hz)).toBeLessThanOrEqual(22);
    }
  });

  it('reports nothing for a short silence rather than dividing by zero', () => {
    const silence = new Float32Array(441);
    expect(A.spectralCentroid(silence, SR, 2048)).toBe(0);
    expect(A.bandFraction(silence, SR, 500, 2000, 2048)).toBe(0);
  });
});
