/**
 * NOISE SOURCES
 *
 * Noise is the raw material for roughly two thirds of the sound design in this
 * game: impacts, debris, collapse rumble, wind, footsteps, the crowd bed and
 * every hi-hat in the music. Generating it per voice would be wasteful, so a
 * small set of buffers is generated ONCE per `AudioContext` and shared by
 * every voice that needs it, each reading from its own looping source node at
 * its own offset.
 *
 * All three spectra are produced by hand rather than by filtering white noise
 * at runtime, because the shaping filters would otherwise sit in the graph
 * forever costing CPU on a phone.
 *
 *  • WHITE — flat spectrum. Transients, hats, air.
 *  • PINK  — -3 dB/octave (Paul Kellet's economy filter). Natural-sounding
 *            broadband material; the crowd bed and wind are built on it.
 *  • BROWN — -6 dB/octave (leaky integrator). Almost all energy below a few
 *            hundred Hz: the foundation of the building-collapse rumble.
 *
 * Generation is driven by the project's seeded RNG, never `Math.random()`, so
 * an offline render of any voice is bit-identical between runs. That is what
 * makes the numeric assertions in the render tests stable.
 */

import { createRng } from '@/util';

/** Spectral tilt of a generated noise buffer. */
export type NoiseKind = 'white' | 'pink' | 'brown';

/** Default seed for the shared noise buffers. */
const NOISE_SEED = 0x5a17a;

/** Cross-fade length at the loop point, in seconds. */
const LOOP_FADE_SECONDS = 0.02;

/**
 * Per-kind seed salt.
 *
 * This was `kind.length`, which is 5 for BOTH `'white'` and `'brown'`: the two
 * shared a seed, so the brown buffer was a sample-for-sample lowpass of the
 * white one rather than an independent realisation, and a voice layering the
 * two (the collapse rumble and its crackle) summed them coherently wherever
 * the read heads aligned. The values below keep `'white'` and `'pink'` on the
 * streams they have always had and give `'brown'` its own.
 */
const KIND_SALT: Record<NoiseKind, number> = { white: 5, pink: 4, brown: 6 };

/** Samples that `seamless` cross-fades at the end of a buffer of `length`. */
function fadeSamplesFor(sampleRate: number, length: number): number {
  return Math.min(Math.floor(sampleRate * LOOP_FADE_SECONDS), Math.floor(length / 4));
}

/** Buffers are cached per context — one set for the live context, one per offline render. */
const cache = new WeakMap<BaseAudioContext, Map<string, AudioBuffer>>();

/**
 * Fill a channel with white noise in [-1, 1).
 */
function fillWhite(out: Float32Array, next: () => number): void {
  for (let i = 0; i < out.length; i++) out[i] = next() * 2 - 1;
}

/**
 * Paul Kellet's pink-noise filter: seven one-pole sections approximating a
 * -3 dB/octave tilt to within ~0.05 dB across the audio band, at a fraction of
 * the cost of a proper filter bank.
 */
function fillPink(out: Float32Array, next: () => number): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const white = next() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
  }
}

/**
 * Brown (red) noise: a leaky integrator over white noise. The leak coefficient
 * stops the random walk from drifting into DC over a multi-second buffer.
 */
function fillBrown(out: Float32Array, next: () => number): void {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const white = next() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    out[i] = last;
  }
}

/** Scale in place so the loudest sample sits at `peak`. */
function normalise(out: Float32Array, peak: number): void {
  let max = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.abs(out[i]!);
    if (a > max) max = a;
  }
  if (max <= 0) return;
  const scale = peak / max;
  for (let i = 0; i < out.length; i++) out[i]! *= scale;
}

/**
 * Cross-fade the buffer's tail into its head over `fadeSamples` so a looping
 * source node produces no click at the wrap point. Without this every noise
 * bed in the game ticks once per loop period, which is instantly audible.
 *
 * The fade blends the tail towards `out[0..n)`, so the region it writes is only
 * continuous with the sample that FOLLOWS the fade — which is why
 * `createNoiseSource` loops `[n, length)` rather than the whole buffer.
 */
function seamless(out: Float32Array, fadeSamples: number): void {
  const n = Math.min(fadeSamples, Math.floor(out.length / 4));
  const start = out.length - n;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const tail = out[start + i]!;
    const head = out[i]!;
    out[start + i] = tail * (1 - t) + head * t;
  }
}

/**
 * Get (and lazily generate) a shared, seamlessly-looping noise buffer.
 *
 * @param seconds Buffer length. Longer buffers cost memory but make the loop
 *                period inaudible; 2–4 s is the sweet spot for beds.
 */
export function getNoiseBuffer(
  ctx: BaseAudioContext,
  kind: NoiseKind,
  seconds = 2.5,
  seed = NOISE_SEED
): AudioBuffer {
  let perContext = cache.get(ctx);
  if (!perContext) {
    perContext = new Map<string, AudioBuffer>();
    cache.set(ctx, perContext);
  }
  const key = `${kind}:${seconds}:${seed}`;
  const existing = perContext.get(key);
  if (existing) return existing;

  const length = Math.max(128, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const rng = createRng(seed ^ (KIND_SALT[kind] << 8));
  const next = (): number => rng.next();

  if (kind === 'white') fillWhite(data, next);
  else if (kind === 'pink') fillPink(data, next);
  else fillBrown(data, next);

  normalise(data, 0.92);
  seamless(data, fadeSamplesFor(ctx.sampleRate, length));
  // Re-normalise: the cross-fade can only reduce peaks, never raise them.

  perContext.set(key, buffer);
  return buffer;
}

/**
 * Create a free-running, looping noise source.
 *
 * The node is started immediately at a pseudo-random offset and NEVER stopped
 * until the voice is disposed. This is the core of the zero-allocation design:
 * a voice's noise generator exists for the lifetime of the voice, and
 * triggering the voice only opens a gain envelope in front of it. No
 * `AudioBufferSourceNode` is ever constructed on an impact.
 */
export function createNoiseSource(
  ctx: BaseAudioContext,
  kind: NoiseKind,
  offsetFraction = 0,
  seconds = 2.5
): AudioBufferSourceNode {
  const buffer = getNoiseBuffer(ctx, kind, seconds);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  // EXCLUDE THE CROSS-FADE FROM THE LOOP.
  //
  // `seamless` blends the buffer's tail INTO its head, so the last sample is
  // continuous with `out[n]`, not with `out[0]`. Leaving `loopStart`/`loopEnd`
  // at 0 means "the whole buffer" per the specification, which wraps back to
  // `out[0]` and steps by several times the natural sample delta — the
  // once-per-loop tick the cross-fade exists to remove, still audible on every
  // wind, traffic and rumble bed. Looping `[n, length)` lands on the sample the
  // fade actually made it continuous with.
  const fade = fadeSamplesFor(ctx.sampleRate, buffer.length);
  src.loopStart = fade / ctx.sampleRate;
  src.loopEnd = buffer.duration;
  // Start at 0 with a read offset: `start(when, offset)` is exact and costs
  // nothing, and decorrelates voices that share a buffer.
  //
  // `%` keeps the sign of its dividend, so a negative fraction would reach
  // `start()` as a negative offset — a RangeError. Normalise into [0, 1).
  const fraction = Number.isFinite(offsetFraction) ? ((offsetFraction % 1) + 1) % 1 : 0;
  src.start(0, fraction * buffer.duration);
  return src;
}
