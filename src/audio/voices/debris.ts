/**
 * DEBRIS — a granular impact scheduler.
 *
 * A collapsing building emits `ChunkDetached` dozens of times per frame. The
 * naive response — one impact sound per chunk — produces a machine gun: every
 * onset identical, spaced on the frame grid. It is the single most obvious
 * tell of synthesised destruction.
 *
 * This voice instead treats debris as GRAIN CLOUD. One trigger schedules a
 * burst of many short filtered-noise grains, and three things are randomised
 * per grain:
 *
 *  • ONSET TIME — drawn from an exponential distribution, so the arrivals
 *    cluster and gap the way real falling material does. The render test
 *    measures the coefficient of variation of the inter-onset intervals and
 *    requires it to stay well clear of the value a regular grid would give.
 *  • PITCH — the bandpass centre is drawn log-uniformly across two and a half
 *    octaves, so no two grains are the same size of rock.
 *  • PAN — grains scatter across the stereo field, which is what turns a
 *    point source into a spreading pile.
 *
 * Density scales with the debris count reported by the destruction system:
 * a single detached chunk is three grains, a full collapse is sixty.
 *
 * Grains are round-robined across a fixed set of pre-built grain units. No
 * node is created when debris lands.
 */

import type { AudioCategory } from '@/types';
import { clamp, clamp01, lerp } from '@/util';
import { percussive, poissonOnsets, resetParam } from '../dsp';
import { createNoiseSource } from '../noise';
import { SynthVoice, type ITriggerParams } from '../voice';

/** Concurrent grains. Enough for a dense collapse without idle cost. */
const GRAIN_UNITS = 14;

/** Per-material grain character. */
interface DebrisMaterial {
  /** Bandpass centre range in Hz (log-uniform draw). */
  readonly loHz: number;
  readonly hiHz: number;
  /** Resonance range — high Q is what makes glass and metal ring. */
  readonly qLo: number;
  readonly qHi: number;
  /** Grain length range in seconds. */
  readonly decayLo: number;
  readonly decayHi: number;
  /**
   * Grain-count multiplier.
   *
   * Materials do not fragment equally: a pane of glass becomes far more
   * pieces than a slab of concrete does. This is physically motivated and it
   * also fixes a level problem — high-Q grains pass very little energy each,
   * so glass needs many of them to register at all rather than one loud one.
   */
  readonly densityScale: number;
  /** Probability that a grain also gets a low thump body. */
  readonly thumpChance: number;
  /** Thump pitch range in Hz. */
  readonly thumpLo: number;
  readonly thumpHi: number;
  readonly gain: number;
}

const MATERIALS: Record<string, DebrisMaterial> = {
  // Concrete is the DULL, heavy end of the range: low bandpass centres, a
  // thump on most grains. Wood sits an octave above it with almost no thump,
  // which is what keeps the two materials telling apart by ear (and by
  // fingerprint distance — an earlier pass had them at 0.02 apart, i.e.
  // effectively the same sound).
  concrete: {
    loHz: 180,
    hiHz: 1800,
    qLo: 1.2,
    qHi: 4,
    decayLo: 0.012,
    decayHi: 0.07,
    densityScale: 1.0,
    thumpChance: 0.7,
    thumpLo: 48,
    thumpHi: 115,
    gain: 0.52,
  },
  rubble: {
    loHz: 220,
    hiHz: 4500,
    qLo: 1,
    qHi: 4,
    decayLo: 0.008,
    decayHi: 0.05,
    densityScale: 1.15,
    thumpChance: 0.35,
    thumpLo: 60,
    thumpHi: 160,
    gain: 0.45,
  },
  glass: {
    loHz: 2200,
    hiHz: 9000,
    qLo: 8,
    qHi: 26,
    decayLo: 0.03,
    decayHi: 0.16,
    densityScale: 2.1,
    thumpChance: 0.04,
    thumpLo: 180,
    thumpHi: 400,
    gain: 1.05,
  },
  metal: {
    loHz: 700,
    hiHz: 5200,
    qLo: 6,
    qHi: 22,
    decayLo: 0.05,
    decayHi: 0.3,
    densityScale: 1.7,
    thumpChance: 0.2,
    thumpLo: 90,
    thumpHi: 220,
    gain: 1,
  },
  wood: {
    loHz: 500,
    hiHz: 3600,
    qLo: 3.5,
    qHi: 10,
    decayLo: 0.008,
    decayHi: 0.032,
    densityScale: 1.35,
    thumpChance: 0.12,
    thumpLo: 130,
    thumpHi: 300,
    gain: 0.7,
  },
  glassAndSteel: {
    loHz: 900,
    hiHz: 8000,
    qLo: 6,
    qHi: 22,
    decayLo: 0.02,
    decayHi: 0.18,
    densityScale: 1.6,
    thumpChance: 0.25,
    thumpLo: 80,
    thumpHi: 240,
    gain: 0.36,
  },
};

/** Every debris material, for the harness, the event map and the tests. */
export const DEBRIS_MATERIALS = Object.keys(MATERIALS);

/** Resolve an arbitrary material string from the destruction system. */
export function resolveMaterial(name: string | undefined): string {
  if (!name) return 'concrete';
  const key = name.trim();
  if (MATERIALS[key]) return key;
  const lower = key.toLowerCase();
  for (const known of Object.keys(MATERIALS)) {
    if (known.toLowerCase() === lower) return known;
  }
  // Unknown materials fall back to the broadest-sounding option rather than
  // going silent — an unmapped material must never produce no sound.
  return 'rubble';
}

/** One grain: bandpassed noise plus an optional low body, panned. */
class GrainUnit {
  readonly bp: BiquadFilterNode;
  readonly gain: GainNode;
  readonly pan: StereoPannerNode;
  readonly thump: OscillatorNode;
  readonly thumpGain: GainNode;
  /** Context time this grain is free again. */
  freeAt = -1;

  constructor(ctx: BaseAudioContext, noise: AudioBufferSourceNode, destination: AudioNode) {
    this.pan = ctx.createStereoPanner();
    this.pan.connect(destination);

    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 1200;
    this.bp.Q.value = 4;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    noise.connect(this.bp).connect(this.gain).connect(this.pan);

    this.thump = ctx.createOscillator();
    this.thump.type = 'sine';
    this.thump.frequency.value = 90;
    this.thumpGain = ctx.createGain();
    this.thumpGain.gain.value = 0;
    this.thump.connect(this.thumpGain).connect(this.pan);
    this.thump.start();
  }

  dispose(): void {
    SynthVoice.stopSource(this.thump);
    this.bp.disconnect();
    this.gain.disconnect();
    this.thumpGain.disconnect();
    this.pan.disconnect();
  }
}

export class DebrisVoice extends SynthVoice {
  private readonly trim: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly grains: GrainUnit[] = [];
  private lastGrainCount = 0;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    key = 'debris.impact',
    category: AudioCategory = 'sfx',
    noiseOffset = 0
  ) {
    super(ctx, key, category, destination);
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.7;
    this.trim.connect(this.output);

    this.noise = createNoiseSource(ctx, 'white', noiseOffset, 3);
    for (let i = 0; i < GRAIN_UNITS; i++) {
      const grain = new GrainUnit(ctx, this.noise, this.trim);
      this.grains.push(grain);
      this.tune(grain.thump);
    }
  }

  /** Grains scheduled by the most recent trigger. */
  get grainCount(): number {
    return this.lastGrainCount;
  }

  protected override schedule(p: ITriggerParams): number {
    const material = MATERIALS[resolveMaterial(p.variant)]!;
    const power = clamp01(p.intensity);
    // Density: one chunk is a few grains, a collapse is a shower.
    const requested = Math.round(lerp(3, 60, power * power) * material.densityScale);
    // The burst gets longer as well as denser — a big collapse rains for
    // longer, it does not just get louder.
    const spread = lerp(0.22, 1.4, power);
    const rng = p.rng;
    const onsets = poissonOnsets(requested, spread, () => rng.next(), 0.006);
    this.lastGrainCount = onsets.length;

    let end = p.time;
    let cursor = 0;
    for (const offset of onsets) {
      const t = p.time + offset;
      // Round-robin, preferring a grain whose previous instance has finished.
      let unit = this.grains[cursor % GRAIN_UNITS]!;
      for (let probe = 0; probe < GRAIN_UNITS; probe++) {
        const candidate = this.grains[(cursor + probe) % GRAIN_UNITS]!;
        if (candidate.freeAt <= t) {
          unit = candidate;
          cursor = cursor + probe + 1;
          break;
        }
        if (probe === GRAIN_UNITS - 1) cursor++;
      }

      // Log-uniform pitch draw: linear draws cluster everything at the top of
      // the range and all the grains end up sounding the same size.
      const u = rng.next();
      const centre =
        material.loHz * Math.pow(material.hiHz / material.loHz, u) * clamp(p.rate, 0.25, 4);
      const q = lerp(material.qLo, material.qHi, rng.next());
      const decay = lerp(material.decayLo, material.decayHi, rng.next() * rng.next());
      // Nearer/bigger grains first: level tapers across the burst so the
      // cloud has a front and a tail rather than a flat wall.
      const taper = lerp(1, 0.45, offset / Math.max(spread, 1e-3));
      const gain = material.gain * lerp(0.45, 1, rng.next()) * taper;

      resetParam(unit.bp.frequency, t, Math.min(centre, this.nyquist * 0.45));
      resetParam(unit.bp.Q, t, q);
      // Wide even when sparse: a handful of isolated chunks should scatter
      // around the listener, not cluster in the centre. Spread narrows
      // slightly rather than widening with density, because a dense shower
      // reads as one mass in one place.
      resetParam(unit.pan.pan, t, (rng.next() * 2 - 1) * lerp(0.6, 0.95, power));
      const grainEnd = percussive(unit.gain.gain, t, gain, 0.0008, decay);

      let thumpEnd = grainEnd;
      if (rng.next() < material.thumpChance) {
        const hz = lerp(material.thumpLo, material.thumpHi, rng.next());
        resetParam(unit.thump.frequency, t, hz);
        unit.thump.frequency.exponentialRampToValueAtTime(hz * 0.6, t + decay * 1.5);
        thumpEnd = percussive(unit.thumpGain.gain, t, gain * 0.9, 0.002, decay * 2.2);
      }

      unit.freeAt = Math.max(grainEnd, thumpEnd);
      end = Math.max(end, unit.freeAt);
    }

    return end - p.time;
  }

  protected override teardown(): void {
    for (const g of this.grains) g.dispose();
    this.grains.length = 0;
    SynthVoice.stopSource(this.noise);
    this.trim.disconnect();
  }
}
