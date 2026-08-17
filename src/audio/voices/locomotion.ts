/**
 * LOCOMOTION — footsteps, landings, jumps, dashes and wind at speed.
 *
 * These are the sounds the player hears more than any other, which changes the
 * design brief entirely: they must be varied enough to survive ten thousand
 * repetitions. Every one of them therefore randomises pitch, filter centre and
 * decay per instance from the deterministic RNG, and footsteps additionally
 * alternate a subtle left/right weight so a walk cycle does not tick.
 *
 *  FOOTSTEP — a scuff (bandpassed noise) plus a small body thump. The SURFACE
 *             lives entirely in the filter: concrete is tight and mid, rubble
 *             is broad and gritty, metal rings, water splashes wide.
 *  LANDING  — a sub drop sized by impact speed, a broadband body, and a dust
 *             tail that outlives the impact. At crater speeds it gains an
 *             extra octave of sub and a much longer tail.
 *  JUMP     — an upward bandpass sweep: air moving past, pitch rising with
 *             the ascent.
 *  DASH     — a fall-then-rise sweep plus a pitch-bent tone, which reads as
 *             something passing the listener rather than leaving them.
 *  WIND     — sustained, three-band, driven continuously by speed. This one is
 *             a parameter, not an event: `setIntensity` is called every frame.
 */

import type { AudioCategory } from '@/types';
import { clamp, clamp01, lerp } from '@/util';
import { asr, percussive, resetParam, sweep, sweep3 } from '../dsp';
import { createNoiseSource } from '../noise';
import { SustainedVoice, SynthVoice, type ITriggerParams } from '../voice';

/* -------------------------------------------------------------------------- */
/* Footsteps                                                                  */
/* -------------------------------------------------------------------------- */

interface SurfaceShape {
  readonly scuffHz: number;
  readonly scuffQ: number;
  readonly scuffDecay: number;
  readonly scuffGain: number;
  readonly bodyHz: number;
  readonly bodyDecay: number;
  readonly bodyGain: number;
  /** Metal and water get a resonant ring on top of the scuff. */
  readonly ringHz: number;
  readonly ringQ: number;
  readonly ringDecay: number;
  readonly ringGain: number;
}

const SURFACES: Record<string, SurfaceShape> = {
  concrete: {
    scuffHz: 2200,
    scuffQ: 1.6,
    scuffDecay: 0.045,
    scuffGain: 0.3,
    bodyHz: 95,
    bodyDecay: 0.06,
    bodyGain: 0.26,
    ringHz: 0,
    ringQ: 1,
    ringDecay: 0,
    ringGain: 0,
  },
  rubble: {
    scuffHz: 1500,
    scuffQ: 0.8,
    scuffDecay: 0.09,
    scuffGain: 0.34,
    bodyHz: 78,
    bodyDecay: 0.07,
    bodyGain: 0.22,
    ringHz: 0,
    ringQ: 1,
    ringDecay: 0,
    ringGain: 0,
  },
  metal: {
    // Deliberately the brightest surface: a wide, loud scuff high up and only
    // a token body thump, so the plate rings rather than thuds.
    scuffHz: 3400,
    scuffQ: 1.1,
    scuffDecay: 0.03,
    scuffGain: 0.34,
    bodyHz: 130,
    bodyDecay: 0.04,
    bodyGain: 0.07,
    ringHz: 2800,
    ringQ: 22,
    ringDecay: 0.35,
    ringGain: 0.17,
  },
  grass: {
    scuffHz: 700,
    scuffQ: 1,
    scuffDecay: 0.07,
    scuffGain: 0.2,
    bodyHz: 65,
    bodyDecay: 0.05,
    bodyGain: 0.14,
    ringHz: 0,
    ringQ: 1,
    ringDecay: 0,
    ringGain: 0,
  },
  water: {
    scuffHz: 1200,
    scuffQ: 0.5,
    scuffDecay: 0.14,
    scuffGain: 0.32,
    bodyHz: 160,
    bodyDecay: 0.04,
    bodyGain: 0.14,
    ringHz: 900,
    ringQ: 6,
    ringDecay: 0.12,
    ringGain: 0.14,
  },
};

/** Every walkable surface, for the harness and tests. */
export const FOOTSTEP_SURFACES = Object.keys(SURFACES);

export class FootstepVoice extends SynthVoice {
  private readonly trim: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly scuff: BiquadFilterNode;
  private readonly scuffGain: GainNode;
  private readonly ring: BiquadFilterNode;
  private readonly ringGain: GainNode;
  private readonly body: OscillatorNode;
  private readonly bodyGain: GainNode;
  /** Alternates so a walk cycle has a left and a right foot. */
  private foot = 0;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'move.footstep',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.8;
    this.trim.connect(this.output);

    this.noise = createNoiseSource(ctx, 'white', noiseOffset, 2);
    this.scuff = ctx.createBiquadFilter();
    this.scuff.type = 'bandpass';
    this.scuff.frequency.value = 2200;
    this.scuff.Q.value = 1.6;
    this.scuffGain = ctx.createGain();
    this.scuffGain.gain.value = 0;
    this.noise.connect(this.scuff).connect(this.scuffGain).connect(this.trim);

    this.ring = ctx.createBiquadFilter();
    this.ring.type = 'bandpass';
    this.ring.frequency.value = 2400;
    this.ring.Q.value = 24;
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0;
    this.noise.connect(this.ring).connect(this.ringGain).connect(this.trim);

    this.body = ctx.createOscillator();
    this.body.type = 'sine';
    this.body.frequency.value = 95;
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0;
    this.body.connect(this.bodyGain).connect(this.trim);
    this.body.start();

    this.tune(this.body);
  }

  protected override schedule(p: ITriggerParams): number {
    const s = SURFACES[p.variant ?? 'concrete'] ?? SURFACES.concrete!;
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    const rng = p.rng;
    // Left/right weight difference plus per-step variation: the two together
    // are what stop a walk cycle from ticking like a metronome.
    this.foot ^= 1;
    const footBias = this.foot === 0 ? 1.06 : 0.94;
    const vary = lerp(0.88, 1.14, rng.next()) * footBias * p.rate;

    resetParam(this.scuff.frequency, t, Math.min(s.scuffHz * vary, nq * 0.45));
    resetParam(this.scuff.Q, t, s.scuffQ * lerp(0.85, 1.2, rng.next()));
    const scuffEnd = percussive(
      this.scuffGain.gain,
      t,
      s.scuffGain * lerp(0.6, 1, power),
      0.0008,
      s.scuffDecay * lerp(0.85, 1.2, rng.next())
    );

    sweep(this.body.frequency, t, s.bodyHz * vary, s.bodyHz * 0.62 * vary, s.bodyDecay, nq);
    const bodyEnd = percussive(
      this.bodyGain.gain,
      t,
      s.bodyGain * lerp(0.55, 1, power),
      0.002,
      s.bodyDecay
    );

    let ringEnd = t;
    if (s.ringGain > 0) {
      resetParam(this.ring.frequency, t, Math.min(s.ringHz * vary, nq * 0.45));
      resetParam(this.ring.Q, t, s.ringQ);
      ringEnd = percussive(this.ringGain.gain, t, s.ringGain, 0.001, s.ringDecay);
    } else {
      resetParam(this.ringGain.gain, t, 0);
    }

    return Math.max(scuffEnd, bodyEnd, ringEnd) - t;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.noise);
    SynthVoice.stopSource(this.body);
    this.trim.disconnect();
    this.scuff.disconnect();
    this.scuffGain.disconnect();
    this.ring.disconnect();
    this.ringGain.disconnect();
    this.bodyGain.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Landing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Touchdown after a fall. `intensity` maps impact speed, and at the top of the
 * range the landing becomes a crater: an extra octave of sub, a much longer
 * dust tail, and the same weight class as a heavy punch.
 */
export class LandingVoice extends SynthVoice {
  private readonly trim: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly sub: OscillatorNode;
  private readonly subGain: GainNode;
  private readonly subOctave: OscillatorNode;
  private readonly subOctaveGain: GainNode;
  private readonly bodyFilter: BiquadFilterNode;
  private readonly bodyGain: GainNode;
  private readonly dustFilter: BiquadFilterNode;
  private readonly dustGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'move.landing',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.72;
    this.trim.connect(this.output);

    this.noise = createNoiseSource(ctx, 'white', noiseOffset, 3);

    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 110;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.connect(this.subGain).connect(this.trim);
    this.sub.start();

    this.subOctave = ctx.createOscillator();
    this.subOctave.type = 'sine';
    this.subOctave.frequency.value = 55;
    this.subOctaveGain = ctx.createGain();
    this.subOctaveGain.gain.value = 0;
    this.subOctave.connect(this.subOctaveGain).connect(this.trim);
    this.subOctave.start();

    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'bandpass';
    this.bodyFilter.frequency.value = 700;
    this.bodyFilter.Q.value = 0.9;
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0;
    this.noise.connect(this.bodyFilter).connect(this.bodyGain).connect(this.trim);

    this.dustFilter = ctx.createBiquadFilter();
    this.dustFilter.type = 'bandpass';
    this.dustFilter.frequency.value = 1800;
    this.dustFilter.Q.value = 0.6;
    this.dustGain = ctx.createGain();
    this.dustGain.gain.value = 0;
    this.noise.connect(this.dustFilter).connect(this.dustGain).connect(this.trim);

    this.tune(this.sub, this.subOctave);
  }

  protected override schedule(p: ITriggerParams): number {
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    const rate = p.rate * lerp(1.12, 0.85, power);
    const crater = p.variant === 'crater' || power > 0.75;
    const stretch = lerp(0.7, crater ? 1.9 : 1.2, power);

    sweep(this.sub.frequency, t, 140 * rate, 40 * rate, 0.12 * stretch, nq);
    const subEnd = percussive(
      this.subGain.gain,
      t,
      lerp(0.35, 0.8, power),
      0.0025,
      0.28 * stretch
    );

    // The crater octave: only present when the landing actually breaks ground.
    sweep(this.subOctave.frequency, t, 70 * rate, 22 * rate, 0.16 * stretch, nq);
    percussive(this.subOctaveGain.gain, t, crater ? 0.3 * power : 0, 0.006, 0.5 * stretch);

    sweep(this.bodyFilter.frequency, t, 900 * rate, 200 * rate, 0.09, nq);
    const bodyEnd = percussive(this.bodyGain.gain, t, lerp(0.2, 0.42, power), 0.0015, 0.1 * stretch);

    // Dust hangs around after the impact: a slow-ish attack and a long, quiet
    // tail is the difference between "landed" and "landed hard".
    sweep(this.dustFilter.frequency, t, 2400 * rate, 700 * rate, 0.5 * stretch, nq);
    const dustEnd = asr(
      this.dustGain.gain,
      t,
      lerp(0.06, 0.2, power),
      0.02,
      0.05 * stretch,
      (crater ? 1.1 : 0.4) * stretch
    );

    return Math.max(subEnd, bodyEnd, dustEnd) - t;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.noise);
    SynthVoice.stopSource(this.sub);
    SynthVoice.stopSource(this.subOctave);
    this.trim.disconnect();
    this.subGain.disconnect();
    this.subOctaveGain.disconnect();
    this.bodyFilter.disconnect();
    this.bodyGain.disconnect();
    this.dustFilter.disconnect();
    this.dustGain.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Whooshes: jump and dash                                                    */
/* -------------------------------------------------------------------------- */

interface WhooshShape {
  readonly from: number;
  readonly mid: number;
  readonly to: number;
  readonly firstPart: number;
  readonly secondPart: number;
  readonly q: number;
  readonly gain: number;
  readonly attack: number;
  readonly release: number;
  /** A pitched component riding the whoosh — the dash has one, the jump does not. */
  readonly toneGain: number;
  readonly toneFrom: number;
  readonly toneTo: number;
  /**
   * PUSH-OFF: a downward sine thump at the instant the move starts.
   *
   * A whoosh alone is air, not an action — it has no onset, so it reads as
   * ambience rather than as something the player did. This is the ground
   * taking the character's weight, and for a character who cracks pavement
   * when he jumps it is the more important half of the sound.
   */
  readonly thumpGain: number;
  readonly thumpFrom: number;
  readonly thumpTo: number;
  readonly thumpDecay: number;
  /** Highpassed noise transient: the surface itself failing. */
  readonly crackGain: number;
  readonly crackHz: number;
  readonly crackDecay: number;
}

const WHOOSHES: Record<string, WhooshShape> = {
  /** Rising: air accelerating past on the way up. */
  jump: {
    from: 320,
    mid: 1500,
    to: 2600,
    firstPart: 0.1,
    secondPart: 0.18,
    q: 2.2,
    gain: 0.52,
    attack: 0.015,
    release: 0.22,
    toneGain: 0,
    toneFrom: 0,
    toneTo: 0,
    // Traversal is this character's primary verb, so the jump has to register
    // as an ACT. It stays well under a punch, but it now has an onset.
    thumpGain: 0.6,
    thumpFrom: 105,
    thumpTo: 44,
    thumpDecay: 0.17,
    crackGain: 0.3,
    crackHz: 2800,
    crackDecay: 0.03,
  },
  /**
   * Fall-then-rise with a pitch-bent tone: reads as something passing the
   * listener, which is what a dash is, rather than something departing.
   */
  dash: {
    from: 1800,
    mid: 420,
    to: 2200,
    firstPart: 0.13,
    secondPart: 0.14,
    q: 3.4,
    gain: 0.56,
    attack: 0.01,
    release: 0.18,
    toneGain: 0.22,
    toneFrom: 620,
    toneTo: 180,
    // A dash is lateral, so it pushes off far less than a jump does.
    thumpGain: 0.22,
    thumpFrom: 130,
    thumpTo: 62,
    thumpDecay: 0.09,
    crackGain: 0.18,
    crackHz: 3400,
    crackDecay: 0.02,
  },
  /** A heavier version used for a leap that leaves the ground cracked. */
  leap: {
    from: 260,
    mid: 1100,
    to: 3000,
    firstPart: 0.16,
    secondPart: 0.3,
    q: 1.8,
    gain: 0.6,
    attack: 0.03,
    release: 0.4,
    toneGain: 0.18,
    toneFrom: 140,
    toneTo: 420,
    // A leap leaves the ground cracked; it is the heaviest push-off there is.
    thumpGain: 0.78,
    thumpFrom: 120,
    thumpTo: 34,
    thumpDecay: 0.3,
    crackGain: 0.4,
    crackHz: 2400,
    crackDecay: 0.06,
  },
};

/** Every whoosh variant, for the harness and tests. */
export const WHOOSH_VARIANTS = Object.keys(WHOOSHES);

export class WhooshVoice extends SynthVoice {
  private readonly trim: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly bp: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  private readonly tone: OscillatorNode;
  private readonly toneGain: GainNode;
  private readonly thump: OscillatorNode;
  private readonly thumpGain: GainNode;
  private readonly crackHp: BiquadFilterNode;
  private readonly crackGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'move.dash',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.85;
    this.trim.connect(this.output);

    this.noise = createNoiseSource(ctx, 'pink', noiseOffset, 3);
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 800;
    this.bp.Q.value = 2.5;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(this.bp).connect(this.noiseGain).connect(this.trim);

    this.tone = ctx.createOscillator();
    this.tone.type = 'triangle';
    this.tone.frequency.value = 500;
    this.toneGain = ctx.createGain();
    this.toneGain.gain.value = 0;
    this.tone.connect(this.toneGain).connect(this.trim);
    this.tone.start();

    this.thump = ctx.createOscillator();
    this.thump.type = 'sine';
    this.thump.frequency.value = 105;
    this.thumpGain = ctx.createGain();
    this.thumpGain.gain.value = 0;
    this.thump.connect(this.thumpGain).connect(this.trim);
    this.thump.start();

    this.crackHp = ctx.createBiquadFilter();
    this.crackHp.type = 'highpass';
    this.crackHp.frequency.value = 2800;
    this.crackHp.Q.value = 0.7;
    this.crackGain = ctx.createGain();
    this.crackGain.gain.value = 0;
    this.noise.connect(this.crackHp).connect(this.crackGain).connect(this.trim);

    this.tune(this.tone, this.thump);
  }

  protected override schedule(p: ITriggerParams): number {
    const s = WHOOSHES[p.variant ?? 'dash'] ?? WHOOSHES.dash!;
    const t = p.time;
    const nq = this.nyquist;
    const power = clamp01(p.intensity);
    const rng = p.rng;
    const vary = lerp(0.9, 1.12, rng.next()) * p.rate;
    const speed = lerp(1.35, 0.8, power); // faster movement = shorter whoosh

    sweep3(
      this.bp.frequency,
      t,
      s.from * vary,
      s.mid * vary,
      s.to * vary,
      s.firstPart * speed,
      s.secondPart * speed,
      nq
    );
    resetParam(this.bp.Q, t, s.q);
    const noiseEnd = asr(
      this.noiseGain.gain,
      t,
      s.gain * lerp(0.55, 1, power),
      s.attack,
      (s.firstPart + s.secondPart) * speed * 0.6,
      s.release * speed
    );

    // Push-off: the onset that makes this an action rather than air.
    let thumpEnd = t;
    if (s.thumpGain > 0) {
      sweep(this.thump.frequency, t, s.thumpFrom * vary, s.thumpTo * vary, s.thumpDecay * 0.35, nq);
      thumpEnd = percussive(
        this.thumpGain.gain,
        t,
        s.thumpGain * lerp(0.55, 1, power),
        0.0015,
        s.thumpDecay * lerp(0.75, 1.2, power)
      );
    } else {
      resetParam(this.thumpGain.gain, t, 0);
    }

    let crackEnd = t;
    if (s.crackGain > 0) {
      resetParam(this.crackHp.frequency, t, Math.min(s.crackHz * vary, nq * 0.45));
      crackEnd = percussive(
        this.crackGain.gain,
        t,
        s.crackGain * lerp(0.5, 1, power),
        0.0005,
        s.crackDecay
      );
    } else {
      resetParam(this.crackGain.gain, t, 0);
    }

    let toneEnd = t;
    if (s.toneGain > 0) {
      sweep(
        this.tone.frequency,
        t,
        s.toneFrom * vary,
        s.toneTo * vary,
        (s.firstPart + s.secondPart) * speed,
        nq
      );
      toneEnd = asr(
        this.toneGain.gain,
        t,
        s.toneGain * power,
        s.attack,
        (s.firstPart + s.secondPart) * speed * 0.4,
        s.release * speed
      );
    } else {
      resetParam(this.toneGain.gain, t, 0);
    }

    return Math.max(noiseEnd, toneEnd, thumpEnd, crackEnd) - t;
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.noise);
    SynthVoice.stopSource(this.tone);
    SynthVoice.stopSource(this.thump);
    this.trim.disconnect();
    this.bp.disconnect();
    this.noiseGain.disconnect();
    this.toneGain.disconnect();
    this.thumpGain.disconnect();
    this.crackHp.disconnect();
    this.crackGain.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Wind at speed                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Continuous wind, driven by the player's speed every frame.
 *
 * Three bands, because wind noise is not one sound:
 *  • BUFFET — brown noise under ~200 Hz. Pressure against the body. Comes in
 *    first and dominates at moderate speed.
 *  • BODY   — a resonant bandpass that RISES in centre frequency with speed,
 *    from 400 Hz to about 2 kHz. This is the parameter that actually conveys
 *    "faster", far more than level does.
 *  • HISS   — highpassed white noise above 4 kHz. Only appears near the top
 *    of the range, which is what makes the top of the range feel like a limit.
 *
 * Everything glides; nothing steps. A jump in any of these is instantly
 * audible as a click or a zipper.
 */
export class WindVoice extends SustainedVoice {
  private readonly trim: GainNode;
  private readonly buffetNoise: AudioBufferSourceNode;
  private readonly buffetHp: BiquadFilterNode;
  private readonly buffetLp: BiquadFilterNode;
  private readonly buffetGain: GainNode;
  private readonly bodyNoise: AudioBufferSourceNode;
  private readonly bodyBp: BiquadFilterNode;
  private readonly bodyGain: GainNode;
  private readonly hissHp: BiquadFilterNode;
  private readonly hissGain: GainNode;
  private readonly gustLfo: OscillatorNode;
  private readonly gustDepth: GainNode;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'move.wind',
    category: AudioCategory = 'ambience',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.9;
    this.trim.connect(this.output);

    this.buffetNoise = createNoiseSource(ctx, 'brown', noiseOffset, 4);
    // Brown noise is -6 dB/octave all the way down, so most of its energy is
    // BELOW hearing. Left in, it eats headroom the audible band needs and
    // turns into distortion on a phone speaker, which cannot move that far.
    this.buffetHp = ctx.createBiquadFilter();
    this.buffetHp.type = 'highpass';
    this.buffetHp.frequency.value = 32;
    this.buffetHp.Q.value = 0.7;
    this.buffetLp = ctx.createBiquadFilter();
    this.buffetLp.type = 'lowpass';
    this.buffetLp.frequency.value = 200;
    this.buffetGain = ctx.createGain();
    this.buffetGain.gain.value = 0;
    this.buffetNoise
      .connect(this.buffetHp)
      .connect(this.buffetLp)
      .connect(this.buffetGain)
      .connect(this.trim);

    this.bodyNoise = createNoiseSource(ctx, 'pink', (noiseOffset + 0.41) % 1, 4);
    this.bodyBp = ctx.createBiquadFilter();
    this.bodyBp.type = 'bandpass';
    this.bodyBp.frequency.value = 500;
    this.bodyBp.Q.value = 1.1;
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0;
    this.bodyNoise.connect(this.bodyBp).connect(this.bodyGain).connect(this.trim);

    this.hissHp = ctx.createBiquadFilter();
    this.hissHp.type = 'highpass';
    this.hissHp.frequency.value = 4000;
    this.hissHp.Q.value = 0.7;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.bodyNoise.connect(this.hissHp).connect(this.hissGain).connect(this.trim);

    // Gusting: a slow LFO on the body band's centre so the wind is alive even
    // at a constant speed.
    this.gustLfo = ctx.createOscillator();
    this.gustLfo.type = 'sine';
    this.gustLfo.frequency.value = 0.23;
    this.gustDepth = ctx.createGain();
    this.gustDepth.gain.value = 120;
    this.gustLfo.connect(this.gustDepth).connect(this.bodyBp.frequency);
    this.gustLfo.start();
  }

  override setIntensity(intensity: number, time: number, glideSeconds = 0.25): void {
    const speed = clamp01(intensity);
    const g = Math.max(glideSeconds, 0.02);
    const nq = this.nyquist;

    const ramp = (param: AudioParam, value: number): void => {
      param.cancelScheduledValues(time);
      param.setValueAtTime(param.value, time);
      param.linearRampToValueAtTime(value, time + g);
    };

    ramp(this.buffetGain.gain, lerp(0.05, 0.5, Math.pow(speed, 0.7)));
    ramp(this.buffetLp.frequency, clamp(lerp(120, 260, speed), 20, nq * 0.4));
    // Rising centre frequency is what conveys speed.
    ramp(this.bodyGain.gain, lerp(0.02, 0.4, speed * speed));
    ramp(this.bodyBp.frequency, clamp(lerp(400, 2000, speed), 20, nq * 0.4));
    ramp(this.bodyBp.Q, lerp(0.8, 2.6, speed));
    // Hiss only near the top of the range.
    ramp(this.hissGain.gain, Math.max(0, speed - 0.55) * 0.4);
    ramp(this.gustDepth.gain, lerp(60, 320, speed));
  }

  protected override teardown(): void {
    SynthVoice.stopSource(this.buffetNoise);
    SynthVoice.stopSource(this.bodyNoise);
    SynthVoice.stopSource(this.gustLfo);
    this.trim.disconnect();
    this.buffetHp.disconnect();
    this.buffetLp.disconnect();
    this.buffetGain.disconnect();
    this.bodyBp.disconnect();
    this.bodyGain.disconnect();
    this.hissHp.disconnect();
    this.hissGain.disconnect();
    this.gustDepth.disconnect();
  }
}
