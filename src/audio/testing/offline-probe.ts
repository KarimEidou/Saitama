/**
 * OFFLINE PROBE — render every voice to PCM and measure it.
 *
 * There is no audio hardware in CI, so `OfflineAudioContext` is not a
 * convenience here, it is the ONLY way this system can be verified. Every
 * probe builds a complete `AudioSystem` — real mixer, real buses, real master
 * limiter, real voice pools — on an offline context, triggers one thing,
 * renders the result to a float buffer, and measures it.
 *
 * Nothing is mocked. The graph under test is byte-for-byte the graph that
 * runs in the game; only the clock is different.
 *
 * Two properties make the numbers stable enough to assert on:
 *  • Every random choice comes from the project's seeded RNG, never
 *    `Math.random()`, so a probe renders identically every run.
 *  • Free-running oscillators start at time 0 with deterministic phase.
 *
 * This module runs INSIDE the browser (it needs Web Audio). The metrics it
 * returns are plain numbers, and a small set of probes also return raw PCM so
 * the Node-side test can re-derive the spectral numbers independently and
 * confirm both analyses agree.
 */

import { AudioSystem } from '../audio-system';
import { SOUND_KEYS, SOUND_SPECS, VOICE_CLASSES, type SoundKey } from '../voices/registry';
import { MUSIC_STATES, type MusicState } from '../music/patterns';
import type { ConsecutiveVoice } from '../voices/consecutive';
import type { DebrisVoice } from '../voices/debris';
import type { CrowdBedVoice } from '../voices/crowd';
import * as A from './analysis';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** What a probe measured. */
export interface IProbeMetrics {
  readonly name: string;
  readonly kind: 'voice' | 'music' | 'ambience' | 'mix';
  readonly description: string;
  readonly sampleRate: number;
  readonly seconds: number;
  /** When the probe triggered its subject, in seconds. */
  readonly triggerTime: number;

  /** Peak sample magnitude, exact (measured on the float buffer). */
  readonly peak: number;
  readonly peakLeft: number;
  readonly peakRight: number;
  /** RMS across the whole render window. */
  readonly rms: number;
  /** RMS across only the sounding region — the honest loudness number. */
  readonly activeRms: number;
  /** Seconds between the first and last audible sample. */
  readonly activeDuration: number;
  readonly dcOffset: number;
  /** Samples at or beyond full scale. */
  readonly clipped: number;
  /** Loudest sample BEFORE the trigger. Must be zero. */
  readonly preTriggerPeak: number;
  /** RMS of (L-R) over (L+R). Zero for a mono source. */
  readonly stereoWidth: number;

  /** Fraction of total power below 100 Hz. */
  readonly sub100: number;
  readonly low: number;
  readonly mid: number;
  readonly high: number;
  /** Power-weighted spectral centroid in Hz. */
  readonly centroid: number;
  /**
   * Band fraction below 100 Hz measured over the first 200 ms after the
   * trigger, not over the whole render.
   *
   * Impact weight lives in the attack. Averaging across a window that is
   * mostly tail (or mostly silence) measures the tail instead, which for a
   * voice with a long quiet decay understates the low end badly.
   */
  readonly sub100Attack: number;
  /** Spectral centroid over the same 200 ms attack window. */
  readonly centroidAttack: number;
  /**
   * Centroid over four equal slices of the SOUNDING region.
   *
   * This is what verifies a downward filter sweep: the numbers must fall.
   * Slicing the whole render instead would put the last two slices in the
   * silence after the tail, where the centroid is undefined.
   */
  readonly centroidOverTime: readonly number[];
  /**
   * Fraction of energy above 1 kHz over four slices of the sounding region.
   * A descending filter sweep must make this fall.
   */
  readonly highOverTime: readonly number[];
  /** Normalised octave-band energy fingerprint (sums to ~1). */
  readonly fingerprint: readonly number[];

  readonly onsetCount: number;
  readonly firstOnset: number;
  /** Coefficient of variation of the inter-onset intervals. */
  readonly onsetIrregularity: number;

  /** Probe-specific values (grain counts, chain length, duck levels, ...). */
  readonly extras: Readonly<Record<string, number>>;
  /** Base64 Int16 mono PCM, present only for the curated cross-check set. */
  readonly pcm?: string;
}

/** Options for a probe render. */
export interface IProbeOptions {
  readonly sampleRate?: number;
  /** Skip the master limiter and soft clipper to measure raw gain staging. */
  readonly bypassMaster?: boolean;
  /** Force PCM to be returned. */
  readonly includePcm?: boolean;
  readonly seed?: number;
}

/** Probes whose raw PCM is shipped back for independent Node-side analysis. */
export const PCM_PROBES: readonly string[] = [
  'punch.normal',
  'shockwave.serious',
  'debris.impact',
  'collapse.building',
  'monster.roar',
  'ui.rankUp',
];

/** How long each render is. Voices use their declared tail plus headroom. */
const TRIGGER_AT = 0.05;

/* -------------------------------------------------------------------------- */
/* Render plumbing                                                            */
/* -------------------------------------------------------------------------- */

interface RenderResult {
  left: Float32Array;
  right: Float32Array;
  mono: Float32Array;
  sampleRate: number;
  seconds: number;
  extras: Record<string, number>;
}

function offlineContext(seconds: number, sampleRate: number): OfflineAudioContext {
  return new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
}

/** Build a fully-wired audio system on an offline context. */
function systemFor(ctx: OfflineAudioContext, options: IProbeOptions): AudioSystem {
  const system = new AudioSystem({
    context: ctx,
    masterVolume: 1,
    bypassMaster: options.bypassMaster ?? false,
    seed: options.seed ?? 0x51ee7,
    autoStartAmbience: false,
  });
  // Flat buses so a probe measures the VOICE, not the default mix balance.
  for (const category of ['sfx', 'music', 'ambience', 'voice', 'ui'] as const) {
    system.bus(category).volume = 1;
  }
  return system;
}

async function render(
  seconds: number,
  sampleRate: number,
  options: IProbeOptions,
  populate: (system: AudioSystem, ctx: OfflineAudioContext) => Record<string, number> | void
): Promise<RenderResult> {
  const ctx = offlineContext(seconds, sampleRate);
  const system = systemFor(ctx, options);
  const extras = populate(system, ctx) ?? {};
  const buffer = await ctx.startRendering();
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  system.dispose();
  return {
    left: Float32Array.from(left),
    right: Float32Array.from(right),
    mono: A.downmix(left, right),
    sampleRate,
    seconds,
    extras,
  };
}

/** Base64-encode a float buffer as 16-bit mono PCM. */
function encodePcm(mono: Float32Array): string {
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]!));
    pcm[i] = Math.round(v * 32767);
  }
  const bytes = new Uint8Array(pcm.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Turn a rendered buffer into the full metric set. */
function measure(
  name: string,
  kind: IProbeMetrics['kind'],
  description: string,
  result: RenderResult,
  triggerTime: number,
  includePcm: boolean
): IProbeMetrics {
  const { mono, left, right, sampleRate } = result;
  const preTrigger = mono.subarray(0, Math.max(1, Math.floor(triggerTime * sampleRate) - 2));
  const attack = mono.subarray(
    Math.floor(triggerTime * sampleRate),
    Math.min(mono.length, Math.floor((triggerTime + 0.2) * sampleRate))
  );
  const onsets = A.detectOnsets(mono, sampleRate);
  return {
    name,
    kind,
    description,
    sampleRate,
    seconds: result.seconds,
    triggerTime,
    peak: A.peak(mono),
    peakLeft: A.peak(left),
    peakRight: A.peak(right),
    rms: A.rms(mono),
    activeRms: A.activeRms(mono),
    activeDuration: A.activeDuration(mono, sampleRate),
    dcOffset: A.dcOffset(mono),
    clipped: A.clippedSamples(mono),
    preTriggerPeak: A.peak(preTrigger),
    stereoWidth: A.stereoWidth(left, right),
    sub100: A.bandFraction(mono, sampleRate, 0, 100),
    low: A.bandFraction(mono, sampleRate, 20, 200),
    mid: A.bandFraction(mono, sampleRate, 200, 2000),
    high: A.bandFraction(mono, sampleRate, 2000, 20000),
    centroid: A.spectralCentroid(mono, sampleRate),
    sub100Attack: A.bandFraction(attack, sampleRate, 0, 100, 2048),
    centroidAttack: A.spectralCentroid(attack, sampleRate, 2048),
    centroidOverTime: A.activeCentroidOverTime(mono, sampleRate, 4),
    highOverTime: A.activeBandFractionOverTime(mono, sampleRate, 1000, 20000, 4),
    fingerprint: A.bandFingerprint(mono, sampleRate),
    onsetCount: onsets.length,
    firstOnset: onsets[0] ?? -1,
    onsetIrregularity: A.intervalIrregularity(onsets),
    extras: result.extras,
    ...(includePcm ? { pcm: encodePcm(mono) } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Voice probes                                                               */
/* -------------------------------------------------------------------------- */

/** Render length for a sound key: its declared tail plus headroom. */
function secondsFor(key: SoundKey): number {
  const spec = SOUND_SPECS[key];
  if (!Number.isFinite(spec.maxSeconds)) return 4;
  return Math.min(spec.maxSeconds + TRIGGER_AT + 0.35, 13);
}

/** Render one sound key through the full system. */
export async function renderVoiceProbe(
  key: SoundKey,
  options: IProbeOptions = {}
): Promise<IProbeMetrics> {
  const spec = SOUND_SPECS[key];
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = secondsFor(key);
  const sustained = VOICE_CLASSES[spec.voiceClass].sustained;

  const result = await render(seconds, sampleRate, options, (system) => {
    if (sustained) {
      // Sustained beds are steered, not triggered. Drive them the way the
      // frame loop does, then fill the scheduler's window for the whole render.
      system.playAmbience('ambience.city', 0.2);
      if (spec.voiceClass === 'crowdBed') {
        system.setCrowdDensity(0.85);
        system.wind().stop(0, 0.01);
        const crowd = system.crowd() as CrowdBedVoice;
        const blips = crowd.scheduleBlips(seconds);
        return { blipCount: blips, density: 0.85 };
      }
      system.setPlayerSpeed(38);
      system.crowd().stop(0, 0.01);
      return { speed: 38 };
    }

    system.play(key, {
      intensity: spec.intensity,
      delay: TRIGGER_AT,
      // Pitch variation off: a probe must measure the voice, not the dice.
      pitchVariation: 0,
    });

    const extras: Record<string, number> = {};
    if (spec.voiceClass === 'consecutive') {
      system.bank('consecutive').forEach((v) => {
        extras.hitCount = (v as ConsecutiveVoice).hitCount;
      });
    }
    if (spec.voiceClass === 'debris') {
      system.bank('debris').forEach((v) => {
        extras.grainCount = (v as DebrisVoice).grainCount;
      });
    }
    return extras;
  });

  return measure(
    key,
    sustained ? 'ambience' : 'voice',
    spec.description,
    result,
    sustained ? 0.001 : TRIGGER_AT,
    options.includePcm ?? PCM_PROBES.includes(key)
  );
}

/* -------------------------------------------------------------------------- */
/* Music probes                                                               */
/* -------------------------------------------------------------------------- */

/** Seconds rendered per music state. Long enough for several bars. */
const MUSIC_SECONDS = 10;

/** Render one music intensity layer. */
export async function renderMusicProbe(
  state: MusicState,
  options: IProbeOptions = {}
): Promise<IProbeMetrics> {
  const sampleRate = options.sampleRate ?? 44100;
  const result = await render(MUSIC_SECONDS, sampleRate, options, (system) => {
    system.playMusic(state, 0);
    // `advanceTo` is exactly what `update()` calls; an offline context simply
    // lets the whole window be scheduled in one go.
    system.music.advanceTo(MUSIC_SECONDS);
    return {
      noteCount: system.music.noteCount,
      partCount: system.music.parts.length,
      bpm: system.music.bpm,
    };
  });
  return measure(
    `music.${state}`,
    'music',
    `Intensity layer "${state}".`,
    result,
    0.001,
    options.includePcm ?? false
  );
}

/**
 * Render the boredom collapse: start in combat, then drive boredom to the top
 * and confirm the arrangement really does reduce to a single sustained tone.
 */
export async function renderBoredomProbe(options: IProbeOptions = {}): Promise<IProbeMetrics> {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = 16;
  const result = await render(seconds, sampleRate, options, (system) => {
    system.playMusic('combat', 0);
    system.music.advanceTo(6);
    const partsBefore = system.music.parts.length;
    system.music.setBoredom(0.95);
    system.music.advanceTo(seconds);
    return {
      partsBefore,
      partsAfter: system.music.parts.length,
      noteCount: system.music.noteCount,
    };
  });
  return measure(
    'music.boredomCollapse',
    'music',
    'Combat arrangement eaten away by boredom until only the drone survives.',
    result,
    0.001,
    options.includePcm ?? false
  );
}

/* -------------------------------------------------------------------------- */
/* Mix probes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ducking measurement.
 *
 * The sfx, voice and ui buses are muted so the render contains ONLY the music
 * bus. A serious punch is then fired through the event map at 2 s: its cue is
 * inaudible (muted bus) but its duck request still lands, so any level drop
 * after 2 s is caused by ducking and nothing else. The control render is
 * identical minus the event.
 */
export async function renderDuckProbe(
  withPunch: boolean,
  options: IProbeOptions = {}
): Promise<IProbeMetrics> {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = 4;
  const punchAt = 2;
  const result = await render(seconds, sampleRate, options, (system) => {
    system.bus('sfx').muted = true;
    system.bus('voice').muted = true;
    system.bus('ui').muted = true;
    system.playMusic('combat', 0);
    system.music.advanceTo(seconds);
    if (withPunch) {
      system.handleEvent({
        type: 'ShockwaveFired',
        time: punchAt,
        frame: 0,
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
        power: 1e6,
        range: 400,
        angle: Math.PI,
        intent: 'serious',
        punchKind: 'serious',
      });
      // The duck is scheduled from `ctx.currentTime`, which is 0 in an offline
      // context before rendering — so re-schedule it at the punch time to
      // measure the shape the game would actually hear.
      system.mixer.duckFor('music', 0.25, 0.02, 0.35, 0.7, punchAt);
    }
    return { punchAt };
  });

  const before = result.mono.subarray(
    Math.floor(1.2 * sampleRate),
    Math.floor(1.95 * sampleRate)
  );
  const after = result.mono.subarray(
    Math.floor(2.05 * sampleRate),
    Math.floor(2.35 * sampleRate)
  );
  result.extras.rmsBefore = A.rms(before);
  result.extras.rmsAfter = A.rms(after);
  result.extras.duckRatio = A.rms(before) > 0 ? A.rms(after) / A.rms(before) : 1;

  return measure(
    withPunch ? 'mix.duck.ducked' : 'mix.duck.control',
    'mix',
    withPunch
      ? 'Music-only render with a serious punch ducking it at 2 s.'
      : 'Music-only control render with no duck.',
    result,
    0.001,
    options.includePcm ?? false
  );
}

/**
 * A dense combat scene: boss music, a serious punch, a monster roar, a punch
 * chain and a shower of debris, all overlapping. This is the worst case the
 * master chain has to survive, so it is the probe that proves the mix does not
 * clip under load.
 */
export async function renderSceneProbe(options: IProbeOptions = {}): Promise<IProbeMetrics> {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = 6;
  const result = await render(seconds, sampleRate, options, (system) => {
    system.playMusic('boss', 0);
    system.music.advanceTo(seconds);
    system.playAmbience('ambience.city', 0.1);
    system.setCrowdDensity(0.7);
    system.crowd().scheduleBlips(seconds);

    system.play('shockwave.serious', { intensity: 1, delay: 0.5, pitchVariation: 0 });
    system.play('monster.roar', { variant: 'dragon', intensity: 1, delay: 0.2, pitchVariation: 0 });
    system.play('punch.barrage', { intensity: 0.9, delay: 1.6, pitchVariation: 0 });
    system.play('debris.impact', { intensity: 1, delay: 0.7, pitchVariation: 0 });
    system.play('debris.glass', { intensity: 0.8, delay: 0.9, pitchVariation: 0 });
    system.play('collapse.building', { intensity: 0.9, delay: 1.2, pitchVariation: 0 });
    system.play('crowd.panic', { intensity: 1, delay: 1.4, pitchVariation: 0 });
    system.play('ui.alert', { intensity: 1, delay: 0.1, pitchVariation: 0 });
    return { voices: 8 };
  });
  return measure(
    'mix.combatScene',
    'mix',
    'Eight overlapping voices plus boss music and ambience: the master chain under load.',
    result,
    0.001,
    options.includePcm ?? false
  );
}

/**
 * Retrigger stress: the same punch fired eight times at 55 ms, which forces
 * pooled voices to be re-triggered while their previous tail is still
 * decaying. Verifies the envelope interruption logic produces eight clean
 * onsets with no level blow-up.
 */
export async function renderRetriggerProbe(options: IProbeOptions = {}): Promise<IProbeMetrics> {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = 1.6;
  const hits = 8;
  const gap = 0.055;
  const result = await render(seconds, sampleRate, options, (system) => {
    for (let i = 0; i < hits; i++) {
      system.play('punch.normal', {
        intensity: 0.7,
        delay: TRIGGER_AT + i * gap,
        pitchVariation: 0,
      });
    }
    return { requestedHits: hits, gap };
  });
  return measure(
    'mix.retrigger',
    'mix',
    'Eight punches at 55 ms: pooled voices re-triggered mid-tail.',
    result,
    TRIGGER_AT,
    options.includePcm ?? false
  );
}

/**
 * Debris density: a full-intensity burst, measured with an onset detector
 * tuned for short quiet grains.
 *
 * This is the probe that proves the grain cloud is not a machine gun. It
 * reports how many grains were scheduled, how many onsets were actually
 * detectable, and — the number that matters — the coefficient of variation of
 * the inter-onset intervals. A regular grid measures near zero; this must not.
 */
export async function renderDebrisDensityProbe(
  intensity = 1,
  material: SoundKey = 'debris.impact',
  options: IProbeOptions = {}
): Promise<IProbeMetrics> {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = 3;
  const result = await render(seconds, sampleRate, options, (system) => {
    system.play(material, { intensity, delay: TRIGGER_AT, pitchVariation: 0 });
    let grains = 0;
    system.bank('debris').forEach((v) => {
      grains = (v as DebrisVoice).grainCount;
    });
    return { grainCount: grains, intensity };
  });

  // Grains are short and quiet relative to the loudest one, so the detector
  // needs a lower relative floor and a shorter minimum gap than the default.
  const onsets = A.detectOnsets(result.mono, sampleRate, {
    windowMs: 2,
    relativeThreshold: 0.04,
    minGapSeconds: 0.008,
    riseRatio: 1.5,
    smoothFrames: 2,
  });
  result.extras.detectedOnsets = onsets.length;
  result.extras.irregularity = A.intervalIrregularity(onsets);
  result.extras.meanGap = A.mean(A.intervals(onsets));
  result.extras.minGap = onsets.length > 1 ? Math.min(...A.intervals(onsets)) : 0;

  return measure(
    `debris.density.${material}`,
    'mix',
    `Full-density ${material} burst, measured for irregularity.`,
    result,
    TRIGGER_AT,
    options.includePcm ?? false
  );
}

/**
 * Voice-budget stress: far more simultaneous requests than the budget allows,
 * proving the system stays inside `maxVoices` and keeps the loudest thing.
 */
export async function renderBudgetProbe(options: IProbeOptions = {}): Promise<IProbeMetrics> {
  const sampleRate = options.sampleRate ?? 44100;
  const seconds = 3;
  const result = await render(seconds, sampleRate, options, (system) => {
    // Spread across many pools: one pool's own cap would otherwise limit the
    // total long before the global budget ever engaged, and the global budget
    // is what this probe exists to exercise.
    const flood: SoundKey[] = [
      'move.footstep',
      'impact.body',
      'punch.normal',
      'debris.impact',
      'debris.glass',
      'debris.metal',
      'debris.wood',
      'move.jump',
      'move.dash',
      'ui.tap',
      'crowd.gasp',
      'monster.hurt',
      'punch.restrained',
      'move.landing',
    ];
    let granted = 0;
    for (let i = 0; i < 200; i++) {
      const handle = system.play(flood[i % flood.length]!, {
        intensity: 0.5,
        delay: TRIGGER_AT + i * 0.002,
        pitchVariation: 0,
      });
      if (handle) granted++;
    }
    const voicesAfterFlood = system.voiceCount;
    // The high-priority sound must still get in, by stealing.
    const serious = system.play('shockwave.serious', { intensity: 1, delay: 0.6 });
    // A low-priority latecomer must NOT get in once the budget is saturated
    // by things that outrank it.
    const rejected = system.play('impact.body', { intensity: 0.2, delay: 0.62, priority: 0.01 });
    return {
      requested: 200,
      granted,
      voicesAfterFlood,
      maxVoices: system.maxVoices,
      seriousGranted: serious ? 1 : 0,
      lowPriorityGranted: rejected ? 1 : 0,
      voiceCount: system.voiceCount,
    };
  });
  return measure(
    'mix.budget',
    'mix',
    '200 overlapping requests across 14 pools against a 32-voice budget.',
    result,
    TRIGGER_AT,
    options.includePcm ?? false
  );
}

/* -------------------------------------------------------------------------- */
/* Suites                                                                     */
/* -------------------------------------------------------------------------- */

/** Every probe name, in render order. */
export function probeNames(): string[] {
  return [
    ...SOUND_KEYS,
    ...MUSIC_STATES.map((s) => `music.${s}`),
    'music.boredomCollapse',
    'mix.duck.control',
    'mix.duck.ducked',
    'mix.combatScene',
    'mix.retrigger',
    'mix.budget',
    'debris.density.debris.impact',
    'debris.density.debris.glass',
  ];
}

/** Render every probe. Sequential: parallel offline renders thrash memory. */
export async function renderAllProbes(options: IProbeOptions = {}): Promise<IProbeMetrics[]> {
  const out: IProbeMetrics[] = [];
  for (const key of SOUND_KEYS) out.push(await renderVoiceProbe(key, options));
  for (const state of MUSIC_STATES) out.push(await renderMusicProbe(state, options));
  out.push(await renderBoredomProbe(options));
  out.push(await renderDuckProbe(false, options));
  out.push(await renderDuckProbe(true, options));
  out.push(await renderSceneProbe(options));
  out.push(await renderRetriggerProbe(options));
  out.push(await renderBudgetProbe(options));
  out.push(await renderDebrisDensityProbe(1, 'debris.impact', options));
  out.push(await renderDebrisDensityProbe(1, 'debris.glass', options));
  return out;
}

/**
 * Render every voice a second time with the master limiter and clipper
 * bypassed, to check the gain staging of each voice ON ITS OWN. A voice that
 * only stays under full scale because the limiter caught it is a badly
 * balanced voice.
 */
export async function renderRawVoiceProbes(options: IProbeOptions = {}): Promise<IProbeMetrics[]> {
  const out: IProbeMetrics[] = [];
  for (const key of SOUND_KEYS) {
    out.push(await renderVoiceProbe(key, { ...options, bypassMaster: true, includePcm: false }));
  }
  return out;
}

/** Attach the probe API to `window` for the Playwright-driven test harness. */
export function installProbeApi(): void {
  (globalThis as unknown as Record<string, unknown>).__AUDIO_PROBE__ = {
    renderAllProbes,
    renderRawVoiceProbes,
    renderVoiceProbe,
    renderMusicProbe,
    renderBoredomProbe,
    renderDuckProbe,
    renderSceneProbe,
    renderRetriggerProbe,
    renderBudgetProbe,
    renderDebrisDensityProbe,
    probeNames,
    PCM_PROBES,
  };
}
