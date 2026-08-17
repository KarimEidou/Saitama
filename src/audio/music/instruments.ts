/**
 * MUSIC INSTRUMENTS
 *
 * Ten synthesised instruments, built on exactly the same principle as the
 * sound effects: persistent graphs, free-running sources, and triggering that
 * is nothing but `AudioParam` automation. A sixteenth note at 148 bpm arrives
 * every 101 ms, so a music engine that allocated per note would allocate about
 * as often as the combat system does.
 *
 * The palette is chosen to cover the whole intensity range from one small set:
 *
 *   DRONE  — a lone sustained tone. The boredom state, and nothing else.
 *   PAD    — three detuned saws through a slow lowpass. Space, unease.
 *   PLUCK  — two-operator FM bell. Sparse melodic interest.
 *   BASS   — filtered saw + sub sine. The floor of everything above `calm`.
 *   KICK   — pitch-dropping sine with a click.
 *   HAT    — highpassed noise.
 *   SNARE  — noise plus two detuned tuned bodies.
 *   TAIKO  — a big, low, skin-headed drum. Boss only.
 *   STAB   — square through a resonant lowpass with a fast filter envelope.
 *   LEAD   — saw through a lowpass with vibrato. Boss only.
 *
 * Every instrument is polyphonic only where it needs to be — round-robining
 * across a small number of units is much cheaper than a general poly engine
 * and, at these note densities, indistinguishable.
 */

import { asr, midiToFreq, percussive, resetParam, sweep } from '../dsp';
import { createNoiseSource } from '../noise';

/** Every instrument in the palette. */
export type InstrumentId =
  | 'drone'
  | 'pad'
  | 'pluck'
  | 'bass'
  | 'kick'
  | 'hat'
  | 'snare'
  | 'taiko'
  | 'stab'
  | 'lead';

/** Common instrument surface. */
export interface IInstrument {
  readonly id: InstrumentId;
  readonly output: GainNode;
  /**
   * Play one note.
   * @param midi     MIDI note number. Percussion ignores it or uses it as a
   *                 tuning offset.
   * @param velocity 0..1.
   * @param seconds  Nominal note length; the instrument decides its own tail.
   * @returns the time the note falls silent.
   */
  noteOn(time: number, midi: number, velocity: number, seconds: number): number;
  /** Stop everything sounding, e.g. when a layer drops out. */
  allNotesOff(time: number, fadeSeconds?: number): void;
  dispose(): void;
}

/** Stop a free-running source without throwing if it never started. */
function stopSource(node: AudioScheduledSourceNode | undefined): void {
  if (!node) return;
  try {
    node.stop();
  } catch {
    /* already stopped */
  }
  node.disconnect();
}

/* -------------------------------------------------------------------------- */
/* Drone                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A single sustained tone with a slow tremolo and a bare fifth above it.
 *
 * This is the sound of the boredom state: the entire score reduced to one
 * held note. It is intentionally the least interesting instrument in the
 * palette, because that is the point being made.
 */
export class DroneInstrument implements IInstrument {
  readonly id = 'drone' as const;
  readonly output: GainNode;
  private readonly root: OscillatorNode;
  private readonly fifth: OscillatorNode;
  private readonly rootGain: GainNode;
  private readonly fifthGain: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly tremolo: OscillatorNode;
  private readonly tremoloDepth: GainNode;
  private readonly amp: GainNode;
  private readonly trem: GainNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    // The tremolo modulates a gain AFTER the envelope, never the envelope
    // itself. An `AudioParam`'s value is its intrinsic value PLUS everything
    // connected to it, so an LFO wired into the envelope gain would push a
    // silent instrument back above zero and leak a continuous tone into every
    // render — which is exactly the bug the offline probes caught here.
    this.trem = ctx.createGain();
    this.trem.gain.value = 0.9;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 900;
    this.lp.Q.value = 0.6;
    this.lp.connect(this.amp).connect(this.trem).connect(this.output);

    this.root = ctx.createOscillator();
    this.root.type = 'sine';
    this.root.frequency.value = 110;
    this.rootGain = ctx.createGain();
    this.rootGain.gain.value = 0.7;
    this.root.connect(this.rootGain).connect(this.lp);
    this.root.start();

    this.fifth = ctx.createOscillator();
    this.fifth.type = 'triangle';
    this.fifth.frequency.value = 165;
    this.fifthGain = ctx.createGain();
    this.fifthGain.gain.value = 0.18;
    this.fifth.connect(this.fifthGain).connect(this.lp);
    this.fifth.start();

    // A very slow tremolo so the tone is not literally static — a perfectly
    // steady tone stops being heard within seconds.
    this.tremolo = ctx.createOscillator();
    this.tremolo.type = 'sine';
    this.tremolo.frequency.value = 0.17;
    this.tremoloDepth = ctx.createGain();
    this.tremoloDepth.gain.value = 0.1;
    this.tremolo.connect(this.tremoloDepth).connect(this.trem.gain);
    this.tremolo.start();
  }

  noteOn(time: number, midi: number, velocity: number, seconds: number): number {
    const hz = midiToFreq(midi);
    resetParam(this.root.frequency, time, hz);
    resetParam(this.fifth.frequency, time, hz * 1.4983); // just fifth: 3/2, slightly flat
    // Long attack, long release: the drone never "starts", it appears.
    return asr(this.amp.gain, time, 0.2 * velocity, 2.5, Math.max(seconds, 2), 3);
  }

  allNotesOff(time: number, fadeSeconds = 2): void {
    this.amp.gain.cancelScheduledValues(time);
    this.amp.gain.setValueAtTime(this.amp.gain.value, time);
    this.amp.gain.linearRampToValueAtTime(0, time + fadeSeconds);
  }

  dispose(): void {
    stopSource(this.root);
    stopSource(this.fifth);
    stopSource(this.tremolo);
    this.rootGain.disconnect();
    this.fifthGain.disconnect();
    this.lp.disconnect();
    this.tremoloDepth.disconnect();
    this.amp.disconnect();
    this.trem.disconnect();
    this.output.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Pad                                                                        */
/* -------------------------------------------------------------------------- */

/** One pad voice: three detuned saws through a lowpass with a slow envelope. */
class PadUnit {
  readonly oscs: OscillatorNode[] = [];
  readonly lp: BiquadFilterNode;
  readonly amp: GainNode;
  freeAt = -1;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 1200;
    this.lp.Q.value = 1.2;
    this.lp.connect(this.amp).connect(destination);

    // Three saws at -7, 0 and +7 cents: enough beating for movement, little
    // enough that the chord still reads as in tune.
    for (const cents of [-7, 0, 7]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 220;
      osc.detune.value = cents;
      const g = ctx.createGain();
      g.gain.value = 0.33;
      osc.connect(g).connect(this.lp);
      osc.start();
      this.oscs.push(osc);
    }
  }

  dispose(): void {
    for (const o of this.oscs) stopSource(o);
    this.oscs.length = 0;
    this.lp.disconnect();
    this.amp.disconnect();
  }
}

export class PadInstrument implements IInstrument {
  readonly id = 'pad' as const;
  readonly output: GainNode;
  private readonly units: PadUnit[] = [];
  private cursor = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode, polyphony = 3) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);
    for (let i = 0; i < polyphony; i++) this.units.push(new PadUnit(ctx, this.output));
  }

  noteOn(time: number, midi: number, velocity: number, seconds: number): number {
    const unit = this.units.find((u) => u.freeAt <= time) ?? this.units[this.cursor++ % this.units.length]!;
    const hz = midiToFreq(midi);
    for (const osc of unit.oscs) resetParam(osc.frequency, time, hz);
    // The filter opens with the note and closes as it fades: the pad breathes.
    sweep(unit.lp.frequency, time, hz * 3, hz * 8, seconds * 0.5, 20000);
    unit.freeAt = asr(unit.amp.gain, time, 0.2 * velocity, seconds * 0.35, seconds * 0.3, seconds * 0.9);
    return unit.freeAt;
  }

  allNotesOff(time: number, fadeSeconds = 0.8): void {
    for (const u of this.units) {
      u.amp.gain.cancelScheduledValues(time);
      u.amp.gain.setValueAtTime(u.amp.gain.value, time);
      u.amp.gain.linearRampToValueAtTime(0, time + fadeSeconds);
      u.freeAt = time + fadeSeconds;
    }
  }

  dispose(): void {
    for (const u of this.units) u.dispose();
    this.units.length = 0;
    this.output.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Pluck (two-operator FM)                                                    */
/* -------------------------------------------------------------------------- */

class PluckUnit {
  readonly carrier: OscillatorNode;
  readonly modulator: OscillatorNode;
  readonly modDepth: GainNode;
  readonly amp: GainNode;
  freeAt = -1;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.amp.connect(destination);
    this.carrier = ctx.createOscillator();
    this.carrier.type = 'sine';
    this.carrier.frequency.value = 440;
    this.carrier.connect(this.amp);
    this.carrier.start();
    this.modulator = ctx.createOscillator();
    this.modulator.type = 'sine';
    this.modulator.frequency.value = 1540;
    this.modDepth = ctx.createGain();
    this.modDepth.gain.value = 0;
    this.modulator.connect(this.modDepth).connect(this.carrier.frequency);
    this.modulator.start();
  }

  dispose(): void {
    stopSource(this.carrier);
    stopSource(this.modulator);
    this.modDepth.disconnect();
    this.amp.disconnect();
  }
}

/**
 * A bell/pluck. The modulator sits at 3.5x the carrier — an inharmonic ratio,
 * which is what makes a bell a bell — and its depth decays faster than the
 * amplitude, so the note starts bright and settles into a sine. That decaying
 * modulation index is the whole trick of FM percussion.
 */
export class PluckInstrument implements IInstrument {
  readonly id = 'pluck' as const;
  readonly output: GainNode;
  private readonly units: PluckUnit[] = [];
  private cursor = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode, polyphony = 4) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);
    for (let i = 0; i < polyphony; i++) this.units.push(new PluckUnit(ctx, this.output));
  }

  noteOn(time: number, midi: number, velocity: number, seconds: number): number {
    const unit =
      this.units.find((u) => u.freeAt <= time) ?? this.units[this.cursor++ % this.units.length]!;
    const hz = midiToFreq(midi);
    resetParam(unit.carrier.frequency, time, hz);
    resetParam(unit.modulator.frequency, time, hz * 3.5);
    percussive(unit.modDepth.gain, time, hz * 2.2 * velocity, 0.002, seconds * 0.25);
    unit.freeAt = percussive(unit.amp.gain, time, 0.22 * velocity, 0.003, seconds * 0.9);
    return unit.freeAt;
  }

  allNotesOff(time: number, fadeSeconds = 0.15): void {
    for (const u of this.units) {
      u.amp.gain.cancelScheduledValues(time);
      u.amp.gain.setValueAtTime(u.amp.gain.value, time);
      u.amp.gain.linearRampToValueAtTime(0, time + fadeSeconds);
      u.freeAt = time + fadeSeconds;
    }
  }

  dispose(): void {
    for (const u of this.units) u.dispose();
    this.units.length = 0;
    this.output.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Bass                                                                       */
/* -------------------------------------------------------------------------- */

class BassUnit {
  readonly saw: OscillatorNode;
  readonly sub: OscillatorNode;
  readonly subGain: GainNode;
  readonly lp: BiquadFilterNode;
  readonly amp: GainNode;
  freeAt = -1;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 400;
    this.lp.Q.value = 4;
    this.lp.connect(this.amp).connect(destination);

    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.saw.frequency.value = 55;
    this.saw.connect(this.lp);
    this.saw.start();

    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 27.5;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0.6;
    this.sub.connect(this.subGain).connect(this.amp);
    this.sub.start();
  }

  dispose(): void {
    stopSource(this.saw);
    stopSource(this.sub);
    this.subGain.disconnect();
    this.lp.disconnect();
    this.amp.disconnect();
  }
}

export class BassInstrument implements IInstrument {
  readonly id = 'bass' as const;
  readonly output: GainNode;
  private readonly units: BassUnit[] = [];
  private cursor = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode, polyphony = 2) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);
    for (let i = 0; i < polyphony; i++) this.units.push(new BassUnit(ctx, this.output));
  }

  noteOn(time: number, midi: number, velocity: number, seconds: number): number {
    const unit =
      this.units.find((u) => u.freeAt <= time) ?? this.units[this.cursor++ % this.units.length]!;
    const hz = midiToFreq(midi);
    resetParam(unit.saw.frequency, time, hz);
    resetParam(unit.sub.frequency, time, hz * 0.5);
    // A filter envelope on every note is what gives a synth bass its attack.
    sweep(unit.lp.frequency, time, hz * 14, hz * 3.2, Math.min(seconds * 0.6, 0.25), 20000);
    unit.freeAt = asr(unit.amp.gain, time, 0.17 * velocity, 0.006, seconds * 0.55, seconds * 0.45);
    return unit.freeAt;
  }

  allNotesOff(time: number, fadeSeconds = 0.1): void {
    for (const u of this.units) {
      u.amp.gain.cancelScheduledValues(time);
      u.amp.gain.setValueAtTime(u.amp.gain.value, time);
      u.amp.gain.linearRampToValueAtTime(0, time + fadeSeconds);
      u.freeAt = time + fadeSeconds;
    }
  }

  dispose(): void {
    for (const u of this.units) u.dispose();
    this.units.length = 0;
    this.output.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Percussion                                                                 */
/* -------------------------------------------------------------------------- */

/** Shared shape for the pitched drums. */
interface DrumShape {
  readonly from: number;
  readonly to: number;
  readonly pitchTime: number;
  readonly decay: number;
  readonly gain: number;
  readonly noiseGain: number;
  readonly noiseHz: number;
  readonly noiseQ: number;
  readonly noiseDecay: number;
  readonly noiseType: BiquadFilterType;
}

const KICK: DrumShape = {
  from: 150,
  to: 44,
  pitchTime: 0.055,
  decay: 0.3,
  gain: 0.42,
  noiseGain: 0.08,
  noiseHz: 2200,
  noiseQ: 0.8,
  noiseDecay: 0.012,
  noiseType: 'highpass',
};

const TAIKO: DrumShape = {
  from: 210,
  to: 68,
  pitchTime: 0.09,
  decay: 0.75,
  gain: 0.4,
  noiseGain: 0.13,
  noiseHz: 900,
  noiseQ: 1.1,
  noiseDecay: 0.09,
  noiseType: 'bandpass',
};

/** A pitch-dropping drum with a noise transient. Kick and taiko share it. */
export class DrumInstrument implements IInstrument {
  readonly id: InstrumentId;
  readonly output: GainNode;
  private readonly shape: DrumShape;
  private readonly oscs: OscillatorNode[] = [];
  private readonly amps: GainNode[] = [];
  private readonly noise: AudioBufferSourceNode;
  private readonly noiseFilter: BiquadFilterNode;
  private readonly noiseGain: GainNode;
  private cursor = 0;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    id: 'kick' | 'taiko',
    noiseOffset = 0
  ) {
    this.id = id;
    this.shape = id === 'kick' ? KICK : TAIKO;
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    // Two bodies so consecutive sixteenth notes do not cut each other off.
    for (let i = 0; i < 2; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = this.shape.from;
      const amp = ctx.createGain();
      amp.gain.value = 0;
      osc.connect(amp).connect(this.output);
      osc.start();
      this.oscs.push(osc);
      this.amps.push(amp);
    }

    this.noise = createNoiseSource(ctx, 'white', noiseOffset, 2);
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = this.shape.noiseType;
    this.noiseFilter.frequency.value = this.shape.noiseHz;
    this.noiseFilter.Q.value = this.shape.noiseQ;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.output);
  }

  noteOn(time: number, midi: number, velocity: number, _seconds: number): number {
    const i = this.cursor++ % this.oscs.length;
    // MIDI acts as a tuning offset around the shape's natural pitch.
    const tune = Math.pow(2, (midi - 36) / 12);
    sweep(
      this.oscs[i]!.frequency,
      time,
      this.shape.from * tune,
      this.shape.to * tune,
      this.shape.pitchTime,
      20000
    );
    const bodyEnd = percussive(
      this.amps[i]!.gain,
      time,
      this.shape.gain * velocity,
      0.0015,
      this.shape.decay
    );
    const noiseEnd = percussive(
      this.noiseGain.gain,
      time,
      this.shape.noiseGain * velocity,
      0.0005,
      this.shape.noiseDecay
    );
    return Math.max(bodyEnd, noiseEnd);
  }

  allNotesOff(time: number, fadeSeconds = 0.05): void {
    for (const amp of this.amps) {
      amp.gain.cancelScheduledValues(time);
      amp.gain.setValueAtTime(amp.gain.value, time);
      amp.gain.linearRampToValueAtTime(0, time + fadeSeconds);
    }
    this.noiseGain.gain.cancelScheduledValues(time);
    this.noiseGain.gain.setValueAtTime(0, time);
  }

  dispose(): void {
    for (const o of this.oscs) stopSource(o);
    stopSource(this.noise);
    for (const a of this.amps) a.disconnect();
    this.noiseFilter.disconnect();
    this.noiseGain.disconnect();
    this.output.disconnect();
  }
}

/** Highpassed noise. Short for a closed hat, longer for an open one. */
export class HatInstrument implements IInstrument {
  readonly id = 'hat' as const;
  readonly output: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly hp: BiquadFilterNode;
  private readonly amp: GainNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode, noiseOffset = 0) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);
    this.noise = createNoiseSource(ctx, 'white', noiseOffset, 2);
    this.hp = ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 7000;
    this.hp.Q.value = 0.8;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.noise.connect(this.hp).connect(this.amp).connect(this.output);
  }

  noteOn(time: number, midi: number, velocity: number, seconds: number): number {
    // MIDI selects openness: higher note, longer hat.
    const decay = Math.min(0.02 + (midi - 60) * 0.01, seconds);
    resetParam(this.hp.frequency, time, 6000 + velocity * 3000);
    return percussive(this.amp.gain, time, 0.1 * velocity, 0.0004, Math.max(decay, 0.012));
  }

  allNotesOff(time: number): void {
    this.amp.gain.cancelScheduledValues(time);
    this.amp.gain.setValueAtTime(0, time);
  }

  dispose(): void {
    stopSource(this.noise);
    this.hp.disconnect();
    this.amp.disconnect();
    this.output.disconnect();
  }
}

/** Noise plus two detuned tuned bodies: the classic subtractive snare. */
export class SnareInstrument implements IInstrument {
  readonly id = 'snare' as const;
  readonly output: GainNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly bp: BiquadFilterNode;
  private readonly noiseAmp: GainNode;
  private readonly bodyA: OscillatorNode;
  private readonly bodyB: OscillatorNode;
  private readonly bodyAmp: GainNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode, noiseOffset = 0) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    this.noise = createNoiseSource(ctx, 'white', noiseOffset, 2);
    this.bp = ctx.createBiquadFilter();
    this.bp.type = 'bandpass';
    this.bp.frequency.value = 2200;
    this.bp.Q.value = 0.7;
    this.noiseAmp = ctx.createGain();
    this.noiseAmp.gain.value = 0;
    this.noise.connect(this.bp).connect(this.noiseAmp).connect(this.output);

    this.bodyAmp = ctx.createGain();
    this.bodyAmp.gain.value = 0;
    this.bodyAmp.connect(this.output);
    this.bodyA = ctx.createOscillator();
    this.bodyA.type = 'triangle';
    this.bodyA.frequency.value = 185;
    this.bodyA.connect(this.bodyAmp);
    this.bodyA.start();
    this.bodyB = ctx.createOscillator();
    this.bodyB.type = 'triangle';
    this.bodyB.frequency.value = 278;
    this.bodyB.connect(this.bodyAmp);
    this.bodyB.start();
  }

  noteOn(time: number, midi: number, velocity: number, _seconds: number): number {
    const tune = Math.pow(2, (midi - 38) / 12);
    resetParam(this.bodyA.frequency, time, 185 * tune);
    resetParam(this.bodyB.frequency, time, 278 * tune);
    const bodyEnd = percussive(this.bodyAmp.gain, time, 0.12 * velocity, 0.001, 0.09);
    const noiseEnd = percussive(this.noiseAmp.gain, time, 0.18 * velocity, 0.001, 0.16);
    return Math.max(bodyEnd, noiseEnd);
  }

  allNotesOff(time: number): void {
    this.noiseAmp.gain.cancelScheduledValues(time);
    this.noiseAmp.gain.setValueAtTime(0, time);
    this.bodyAmp.gain.cancelScheduledValues(time);
    this.bodyAmp.gain.setValueAtTime(0, time);
  }

  dispose(): void {
    stopSource(this.noise);
    stopSource(this.bodyA);
    stopSource(this.bodyB);
    this.bp.disconnect();
    this.noiseAmp.disconnect();
    this.bodyAmp.disconnect();
    this.output.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Stab and lead                                                              */
/* -------------------------------------------------------------------------- */

class StabUnit {
  readonly osc: OscillatorNode;
  readonly lp: BiquadFilterNode;
  readonly amp: GainNode;
  freeAt = -1;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 1200;
    this.lp.Q.value = 7;
    this.lp.connect(this.amp).connect(destination);
    this.osc = ctx.createOscillator();
    this.osc.type = 'square';
    this.osc.frequency.value = 220;
    this.osc.connect(this.lp);
    this.osc.start();
  }

  dispose(): void {
    stopSource(this.osc);
    this.lp.disconnect();
    this.amp.disconnect();
  }
}

/** Square through a resonant lowpass with a fast filter envelope. */
export class StabInstrument implements IInstrument {
  readonly id = 'stab' as const;
  readonly output: GainNode;
  private readonly units: StabUnit[] = [];
  private cursor = 0;

  constructor(ctx: BaseAudioContext, destination: AudioNode, polyphony = 3) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);
    for (let i = 0; i < polyphony; i++) this.units.push(new StabUnit(ctx, this.output));
  }

  noteOn(time: number, midi: number, velocity: number, seconds: number): number {
    const unit =
      this.units.find((u) => u.freeAt <= time) ?? this.units[this.cursor++ % this.units.length]!;
    const hz = midiToFreq(midi);
    resetParam(unit.osc.frequency, time, hz);
    sweep(unit.lp.frequency, time, hz * 10, hz * 2, Math.min(seconds, 0.18), 20000);
    unit.freeAt = percussive(unit.amp.gain, time, 0.13 * velocity, 0.004, seconds * 0.8);
    return unit.freeAt;
  }

  allNotesOff(time: number, fadeSeconds = 0.08): void {
    for (const u of this.units) {
      u.amp.gain.cancelScheduledValues(time);
      u.amp.gain.setValueAtTime(u.amp.gain.value, time);
      u.amp.gain.linearRampToValueAtTime(0, time + fadeSeconds);
      u.freeAt = time + fadeSeconds;
    }
  }

  dispose(): void {
    for (const u of this.units) u.dispose();
    this.units.length = 0;
    this.output.disconnect();
  }
}

/** Saw through a lowpass with vibrato. The boss layer's melodic voice. */
export class LeadInstrument implements IInstrument {
  readonly id = 'lead' as const;
  readonly output: GainNode;
  private readonly osc: OscillatorNode;
  private readonly lp: BiquadFilterNode;
  private readonly amp: GainNode;
  private readonly vibrato: OscillatorNode;
  private readonly vibratoDepth: GainNode;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(destination);

    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 2400;
    this.lp.Q.value = 3;
    this.lp.connect(this.amp).connect(this.output);

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 440;
    this.osc.connect(this.lp);
    this.osc.start();

    this.vibrato = ctx.createOscillator();
    this.vibrato.type = 'sine';
    this.vibrato.frequency.value = 5.4;
    this.vibratoDepth = ctx.createGain();
    this.vibratoDepth.gain.value = 4;
    this.vibrato.connect(this.vibratoDepth).connect(this.osc.detune);
    this.vibrato.start();
  }

  noteOn(time: number, midi: number, velocity: number, seconds: number): number {
    const hz = midiToFreq(midi);
    resetParam(this.osc.frequency, time, hz);
    sweep(this.lp.frequency, time, hz * 8, hz * 3, seconds * 0.5, 20000);
    // Vibrato arrives late, the way a played note does.
    resetParam(this.vibratoDepth.gain, time, 0);
    this.vibratoDepth.gain.linearRampToValueAtTime(9, time + seconds * 0.6);
    return asr(this.amp.gain, time, 0.13 * velocity, 0.012, seconds * 0.5, seconds * 0.6);
  }

  allNotesOff(time: number, fadeSeconds = 0.1): void {
    this.amp.gain.cancelScheduledValues(time);
    this.amp.gain.setValueAtTime(this.amp.gain.value, time);
    this.amp.gain.linearRampToValueAtTime(0, time + fadeSeconds);
  }

  dispose(): void {
    stopSource(this.osc);
    stopSource(this.vibrato);
    this.lp.disconnect();
    this.amp.disconnect();
    this.vibratoDepth.disconnect();
    this.output.disconnect();
  }
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

/** Build the whole palette on a destination node. */
export function createInstruments(
  ctx: BaseAudioContext,
  destination: AudioNode
): Record<InstrumentId, IInstrument> {
  return {
    drone: new DroneInstrument(ctx, destination),
    pad: new PadInstrument(ctx, destination),
    pluck: new PluckInstrument(ctx, destination),
    bass: new BassInstrument(ctx, destination),
    kick: new DrumInstrument(ctx, destination, 'kick', 0.1),
    taiko: new DrumInstrument(ctx, destination, 'taiko', 0.2),
    hat: new HatInstrument(ctx, destination, 0.3),
    snare: new SnareInstrument(ctx, destination, 0.4),
    stab: new StabInstrument(ctx, destination),
    lead: new LeadInstrument(ctx, destination),
  };
}
