/**
 * SIGNAL ANALYSIS — the measuring instrument for the render tests.
 *
 * There is no audio hardware in CI and no way to listen to a synthesiser from
 * a test runner, so every claim this system makes about its own output has to
 * be a NUMBER. This module renders those numbers: level, spectrum, spectral
 * motion over time, and onset timing.
 *
 * Everything here is pure and dependency-free so the exact same code runs
 * inside the browser (where the audio is rendered) and inside the Node test
 * process (where it is asserted on).
 *
 * The FFT is a textbook iterative radix-2 Cooley-Tukey. It is not fast, and it
 * does not need to be: it analyses a few seconds of audio once per test run.
 */

/* -------------------------------------------------------------------------- */
/* Level                                                                      */
/* -------------------------------------------------------------------------- */

/** Root-mean-square level of a signal. */
export function rms(x: Float32Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]! * x[i]!;
  return x.length === 0 ? 0 : Math.sqrt(sum / x.length);
}

/**
 * RMS over the SOUNDING region only — from the first sample above
 * `threshold` to the last one.
 *
 * A one-shot rendered into a two-second buffer is mostly silence, so plain
 * RMS mostly measures the length of the render window rather than the
 * loudness of the sound. This measures the sound.
 */
export function activeRms(x: Float32Array | number[], threshold = 1e-3): number {
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return 0;
  let sum = 0;
  for (let i = first; i <= last; i++) sum += x[i]! * x[i]!;
  return Math.sqrt(sum / (last - first + 1));
}

/** Seconds between the first and last sample above `threshold`. */
export function activeDuration(
  x: Float32Array | number[],
  sampleRate: number,
  threshold = 1e-3
): number {
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? 0 : (last - first + 1) / sampleRate;
}

/** Absolute peak sample value. */
export function peak(x: Float32Array | number[]): number {
  let max = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]!);
    if (a > max) max = a;
  }
  return max;
}

/** Mean sample value. A non-trivial DC offset wastes headroom and is a bug. */
export function dcOffset(x: Float32Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i]!;
  return x.length === 0 ? 0 : sum / x.length;
}

/**
 * How many samples sit at or beyond full scale. A handful can be rounding; a
 * run of them is hard clipping, which is audible as a buzz.
 */
export function clippedSamples(x: Float32Array | number[], threshold = 0.9999): number {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) >= threshold) n++;
  return n;
}

/** Mono downmix of an interleaved-by-channel pair. */
export function downmix(left: Float32Array, right: Float32Array): Float32Array {
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

/**
 * Stereo width proxy: RMS of the side (L-R) signal relative to the mid (L+R).
 * Zero means a perfectly mono source.
 */
export function stereoWidth(left: Float32Array, right: Float32Array): number {
  const n = Math.min(left.length, right.length);
  let side = 0;
  let mid = 0;
  for (let i = 0; i < n; i++) {
    const s = (left[i]! - right[i]!) * 0.5;
    const m = (left[i]! + right[i]!) * 0.5;
    side += s * s;
    mid += m * m;
  }
  if (mid <= 0) return 0;
  return Math.sqrt(side / Math.max(mid, 1e-12));
}

/* -------------------------------------------------------------------------- */
/* FFT                                                                        */
/* -------------------------------------------------------------------------- */

/** In-place iterative radix-2 FFT. `re`/`im` must be a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two');

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]!;
        const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * cr - im[i + k + len / 2]! * ci;
        const vi = re[i + k + len / 2]! * ci + im[i + k + len / 2]! * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Periodic Hann window of length `n`. */
function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/**
 * Welch-averaged power spectrum: overlapping Hann-windowed frames, averaged.
 * Returns `fftSize / 2` bins; bin `k` is centred on `k * sampleRate / fftSize`.
 */
export function powerSpectrum(
  x: Float32Array | number[],
  fftSize = 2048,
  hop = fftSize / 2
): Float64Array {
  const bins = fftSize >> 1;
  const out = new Float64Array(bins);
  if (x.length < fftSize) {
    // Signal shorter than one frame: zero-pad a single frame.
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const w = hann(fftSize);
    for (let i = 0; i < x.length; i++) re[i] = x[i]! * w[i]!;
    fft(re, im);
    for (let k = 0; k < bins; k++) out[k] = re[k]! * re[k]! + im[k]! * im[k]!;
    return out;
  }

  const w = hann(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let frames = 0;
  for (let start = 0; start + fftSize <= x.length; start += hop) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = x[start + i]! * w[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < bins; k++) out[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
    frames++;
  }
  if (frames > 0) for (let k = 0; k < bins; k++) out[k]! /= frames;
  return out;
}

/** Total power across every bin. */
export function totalPower(spectrum: Float64Array): number {
  let sum = 0;
  for (let k = 0; k < spectrum.length; k++) sum += spectrum[k]!;
  return sum;
}

/**
 * Fraction of a signal's total power falling between `lo` and `hi` Hz.
 * Returns 0..1, which makes assertions independent of absolute level.
 */
export function bandFraction(
  x: Float32Array | number[],
  sampleRate: number,
  lo: number,
  hi: number,
  fftSize = 2048
): number {
  const spec = powerSpectrum(x, fftSize);
  return bandFractionOf(spec, sampleRate, lo, hi, fftSize);
}

/** As `bandFraction`, on a pre-computed spectrum. */
export function bandFractionOf(
  spectrum: Float64Array,
  sampleRate: number,
  lo: number,
  hi: number,
  fftSize = spectrum.length * 2
): number {
  const binHz = sampleRate / fftSize;
  // Bin 0 is DC and is never part of a band: a DC offset is a defect, not
  // bass, and counting it would flatter every low-band measurement.
  const kLo = Math.max(1, Math.ceil(lo / binHz));
  const kHi = Math.min(spectrum.length - 1, Math.ceil(hi / binHz) - 1);
  let band = 0;
  for (let k = kLo; k <= kHi; k++) band += spectrum[k]!;
  const total = totalPower(spectrum);
  return total <= 0 ? 0 : band / total;
}

/**
 * POWER-weighted spectral centroid in Hz — the "brightness" of a signal, and
 * the single most useful number for telling two synthesised voices apart.
 *
 * Power weighting rather than the textbook amplitude weighting is deliberate.
 * These voices are broadband: a punch has ~1000 FFT bins of low-level noise
 * above 5 kHz, and under amplitude weighting the sum of a thousand tiny
 * magnitudes drags the centroid up past 3 kHz even when 90 % of the actual
 * energy is below 100 Hz. Power weighting reports where the energy really is,
 * which is what both the ear and these tests care about.
 */
export function spectralCentroid(
  x: Float32Array | number[],
  sampleRate: number,
  fftSize = 2048
): number {
  const spec = powerSpectrum(x, fftSize);
  return spectralCentroidOf(spec, sampleRate, fftSize);
}

/** As `spectralCentroid`, on a pre-computed spectrum. */
export function spectralCentroidOf(
  spectrum: Float64Array,
  sampleRate: number,
  fftSize = spectrum.length * 2
): number {
  const binHz = sampleRate / fftSize;
  let weighted = 0;
  let total = 0;
  // Skip DC.
  for (let k = 1; k < spectrum.length; k++) {
    const p = spectrum[k]!;
    weighted += p * k * binHz;
    total += p;
  }
  return total <= 0 ? 0 : weighted / total;
}

/**
 * Centroid computed over ONE band only.
 *
 * A full-spectrum centroid cannot track the pitch of one hit inside a punch
 * chain: the still-decaying tails of the previous hits sit an octave below and
 * dominate the average. Restricting the measurement to the band the attack
 * actually occupies removes that contamination, and because a centroid is a
 * weighted mean rather than a bin index it resolves far finer than the FFT
 * grid — which matters when the thing being measured is a 4 % pitch step.
 */
export function bandCentroid(
  x: Float32Array | number[],
  sampleRate: number,
  lo: number,
  hi: number,
  fftSize = 2048
): number {
  const spec = powerSpectrum(x, fftSize);
  const binHz = sampleRate / fftSize;
  const kLo = Math.max(1, Math.ceil(lo / binHz));
  const kHi = Math.min(spec.length - 1, Math.floor(hi / binHz));
  let weighted = 0;
  let total = 0;
  for (let k = kLo; k <= kHi; k++) {
    weighted += spec[k]! * k * binHz;
    total += spec[k]!;
  }
  return total <= 0 ? 0 : weighted / total;
}

/** Frequency of the loudest bin — the rough fundamental of a tonal signal. */
export function dominantFrequency(
  x: Float32Array | number[],
  sampleRate: number,
  fftSize = 4096,
  minHz = 0
): number {
  const spec = powerSpectrum(x, fftSize);
  const binHz = sampleRate / fftSize;
  let best = -1;
  let bestK = 0;
  for (let k = Math.max(1, Math.floor(minHz / binHz)); k < spec.length; k++) {
    if (spec[k]! > best) {
      best = spec[k]!;
      bestK = k;
    }
  }
  return bestK * binHz;
}

/* -------------------------------------------------------------------------- */
/* Fingerprints                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Octave band edges from 31 Hz up. Ten bands is enough resolution to separate
 * a sub-heavy punch from a mid-heavy growl from a bright UI tick, and coarse
 * enough that the numbers stay stable across sample rates.
 */
export const OCTAVE_BAND_EDGES: readonly number[] = [
  // Starts at 10 Hz, not 20: infrasonic energy is inaudible but it is still
  // energy, and a fingerprint that silently drops it would both fail to sum
  // to one and hide a voice wasting headroom below the audible range.
  10, 20, 45, 90, 180, 355, 710, 1400, 2800, 5600, 11200, 20000,
];

/**
 * Normalised band-energy fingerprint: the fraction of total power in each
 * octave band. Sums to ~1. This is what "voices are distinguishable" is
 * measured with.
 */
export function bandFingerprint(
  x: Float32Array | number[],
  sampleRate: number,
  edges: readonly number[] = OCTAVE_BAND_EDGES,
  fftSize = 2048
): number[] {
  const spec = powerSpectrum(x, fftSize);
  const binHz = sampleRate / fftSize;
  const out: number[] = [];
  const total = totalPower(spec);
  // Half-open bands [edge, nextEdge) so every bin lands in exactly one band —
  // an overlapping partition would make the fingerprint sum above 1 and make
  // distance comparisons meaningless.
  for (let b = 0; b + 1 < edges.length; b++) {
    const kLo = Math.max(1, Math.ceil(edges[b]! / binHz));
    const kHi = Math.min(spec.length - 1, Math.ceil(edges[b + 1]! / binHz) - 1);
    let sum = 0;
    for (let k = kLo; k <= kHi; k++) sum += spec[k]!;
    out.push(total <= 0 ? 0 : sum / total);
  }
  return out;
}

/**
 * L1 distance between two fingerprints, in 0..2. Two identical spectra give 0;
 * two spectra with no overlapping energy give 2.
 */
export function fingerprintDistance(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i]! - b[i]!);
  return d;
}

/* -------------------------------------------------------------------------- */
/* Time-varying analysis                                                      */
/* -------------------------------------------------------------------------- */

/** Short-time RMS envelope, one value per `windowMs` window. */
export function envelope(
  x: Float32Array | number[],
  sampleRate: number,
  windowMs = 5
): Float32Array {
  const win = Math.max(1, Math.round((windowMs / 1000) * sampleRate));
  const n = Math.floor(x.length / win);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < win; j++) {
      const v = x[i * win + j]!;
      sum += v * v;
    }
    out[i] = Math.sqrt(sum / win);
  }
  return out;
}

/**
 * Spectral centroid measured over `segments` equal slices, which is how the
 * shockwave's downward filter sweep is verified: the numbers must fall.
 */
export function centroidOverTime(
  x: Float32Array | number[],
  sampleRate: number,
  segments = 4,
  fftSize = 1024
): number[] {
  const out: number[] = [];
  const len = Math.floor(x.length / segments);
  for (let s = 0; s < segments; s++) {
    const slice = new Float32Array(len);
    for (let i = 0; i < len; i++) slice[i] = x[s * len + i]!;
    out.push(spectralCentroid(slice, sampleRate, Math.min(fftSize, nextPow2(len))));
  }
  return out;
}

/**
 * The sounding region of a signal, trimmed of leading and trailing silence.
 *
 * Spectral motion has to be measured over the part that is actually sounding.
 * A voice with a 2 s tail rendered into a 6 s buffer would otherwise report
 * its last two slices as pure silence, and "did the centroid fall?" becomes
 * unanswerable.
 */
export function activeRegion(x: Float32Array, threshold = 1e-4): Float32Array {
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]!) > threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return new Float32Array(0);
  return x.subarray(first, last + 1);
}

/** Centroid over equal slices of the SOUNDING region only. */
export function activeCentroidOverTime(
  x: Float32Array,
  sampleRate: number,
  segments = 4,
  threshold = 1e-4
): number[] {
  const region = activeRegion(x, threshold);
  if (region.length < segments * 256) return centroidOverTime(x, sampleRate, segments);
  return centroidOverTime(region, sampleRate, segments);
}

/**
 * Band fraction over equal slices of the SOUNDING region.
 *
 * For a descending resonant filter sweep this is the most direct measurement
 * available: the fraction of energy above ~1 kHz must fall away as the cutoff
 * descends, and unlike the centroid it is unaffected by what the tail does at
 * the bottom of the spectrum.
 */
export function activeBandFractionOverTime(
  x: Float32Array,
  sampleRate: number,
  lo: number,
  hi: number,
  segments = 4,
  threshold = 1e-4
): number[] {
  const region = activeRegion(x, threshold);
  const source = region.length < segments * 256 ? x : region;
  return bandFractionOverTime(source, sampleRate, lo, hi, segments);
}

/** Band fraction measured over equal slices, for tracking a moving sweep. */
export function bandFractionOverTime(
  x: Float32Array | number[],
  sampleRate: number,
  lo: number,
  hi: number,
  segments = 4,
  fftSize = 1024
): number[] {
  const out: number[] = [];
  const len = Math.floor(x.length / segments);
  for (let s = 0; s < segments; s++) {
    const slice = new Float32Array(len);
    for (let i = 0; i < len; i++) slice[i] = x[s * len + i]!;
    out.push(bandFraction(slice, sampleRate, lo, hi, Math.min(fftSize, nextPow2(len))));
  }
  return out;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return Math.max(64, p >> 1);
}

/* -------------------------------------------------------------------------- */
/* Onsets                                                                     */
/* -------------------------------------------------------------------------- */

/** Options for onset detection. */
export interface IOnsetOptions {
  /** Envelope window in milliseconds. */
  readonly windowMs?: number;
  /** Peak must exceed this fraction of the loudest peak to count. */
  readonly relativeThreshold?: number;
  /** Minimum separation between reported onsets, in seconds. */
  readonly minGapSeconds?: number;
  /** Rise ratio a peak must show over the preceding trough. */
  readonly riseRatio?: number;
  /**
   * Apply a first-difference pre-emphasis before measuring energy.
   *
   * Without it, a 45 Hz sub sine ripples the short-time RMS at its own period
   * and every impact reports three or four onsets instead of one. Onsets are
   * a transient phenomenon, so measuring them on the high-frequency-weighted
   * signal is both more correct and far more robust.
   */
  readonly preEmphasis?: boolean;
  /** Frames of moving-average smoothing applied to the envelope. */
  readonly smoothFrames?: number;
}

/** y[n] = x[n] - a*x[n-1]: a one-pole high-pass used as onset pre-emphasis. */
function preEmphasise(x: Float32Array | number[], a = 0.97): Float32Array {
  const out = new Float32Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i]!;
    out[i] = v - a * prev;
    prev = v;
  }
  return out;
}

/** Centred moving average. */
function smooth(x: Float32Array, frames: number): Float32Array {
  if (frames <= 1) return x;
  const out = new Float32Array(x.length);
  const half = frames >> 1;
  for (let i = 0; i < x.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= x.length) continue;
      sum += x[j]!;
      n++;
    }
    out[i] = n > 0 ? sum / n : 0;
  }
  return out;
}

/**
 * Detect note/impact onsets: peaks in the short-time energy envelope that rise
 * sharply out of a trough.
 *
 * Used to count hits in a punch chain, grains in a debris burst and steps in a
 * music pattern — and, critically, to measure the IRREGULARITY of the debris
 * scheduler, which is the difference between rubble and a machine gun.
 */
export function detectOnsets(
  x: Float32Array | number[],
  sampleRate: number,
  options: IOnsetOptions = {}
): number[] {
  const windowMs = options.windowMs ?? 3;
  const relativeThreshold = options.relativeThreshold ?? 0.12;
  const minGap = options.minGapSeconds ?? 0.01;
  const riseRatio = options.riseRatio ?? 2.2;
  const usePreEmphasis = options.preEmphasis ?? true;
  const smoothFrames = options.smoothFrames ?? 3;

  const source = usePreEmphasis ? preEmphasise(x) : x;
  const env = smooth(envelope(source, sampleRate, windowMs), smoothFrames);
  if (env.length < 3) return [];
  const secondsPerFrame = windowMs / 1000;
  const maxEnv = peak(env);
  if (maxEnv <= 0) return [];
  const floor = maxEnv * relativeThreshold;

  const onsets: number[] = [];
  let lastOnset = -Infinity;
  // Track the running minimum since the last onset: an onset is a frame that
  // is both a local maximum and a clear rise above the trough before it.
  let trough = env[0]!;
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i]!;
    if (v < trough) trough = v;
    const isPeak = v >= env[i - 1]! && v > env[i + 1]!;
    const rises = v > Math.max(floor, trough * riseRatio, 1e-6);
    const time = i * secondsPerFrame;
    if (isPeak && rises && time - lastOnset >= minGap) {
      onsets.push(time);
      lastOnset = time;
      trough = v;
    }
  }
  return onsets;
}

/** Gaps between consecutive values. */
export function intervals(times: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < times.length; i++) out.push(times[i]! - times[i - 1]!);
  return out;
}

/** Mean of a numeric list. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation. */
export function stdDev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) * (v - m);
  return Math.sqrt(sum / values.length);
}

/**
 * Coefficient of variation of the inter-onset intervals.
 *
 * This is the "does it sound like rubble or like a machine gun" metric. A
 * perfectly regular grid gives 0. A Poisson process gives ~1. Anything above
 * ~0.35 no longer reads as mechanical.
 */
export function intervalIrregularity(times: readonly number[]): number {
  const gaps = intervals(times);
  const m = mean(gaps);
  return m <= 0 ? 0 : stdDev(gaps) / m;
}

/** Index of the first sample whose magnitude exceeds `threshold`. */
export function firstSampleAbove(x: Float32Array | number[], threshold: number): number {
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]!) > threshold) return i;
  return -1;
}
