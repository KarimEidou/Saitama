/**
 * MIXER — bus routing, ducking and the master safety chain.
 *
 * Signal flow, top to bottom:
 *
 *   voice -> [bus input] -> volume -> duck -> master -> limiter -> clip -> out
 *
 * ── WHY A DUCK NODE SEPARATE FROM THE VOLUME NODE ──────────────────────────
 * The player owns the volume value (settings screen). The game owns the duck
 * value (music drops under a serious punch). Sharing one node means one
 * writer stomps the other: a duck that finishes mid-slider-drag would snap the
 * user's volume back to a stale value. Two nodes in series multiply cleanly
 * and neither writer has to know about the other.
 *
 * ── WHY BOTH A COMPRESSOR AND A WAVESHAPER ─────────────────────────────────
 * `DynamicsCompressorNode` is a limiter with a finite attack time, so a fast
 * transient — which is exactly what every impact in this game is — passes
 * through above threshold before gain reduction catches up. The waveshaper
 * after it applies a `tanh` transfer curve, which makes |output| < 1
 * unconditionally, at any input level, with zero latency. The compressor does
 * the musical work of holding the mix down; the shaper makes the ceiling a
 * mathematical guarantee rather than an expectation. The render tests assert
 * that ceiling directly.
 */

import type { AudioCategory, IAudioBus, Vec3 } from '@/types';
import { clamp01 } from '@/util';
import { setListenerOrientation, setSpatialPosition } from './panner';
import { softClipCurve } from './dsp';

/** Every mixer bus, in a fixed order so iteration is deterministic. */
export const AUDIO_CATEGORIES: readonly AudioCategory[] = [
  'sfx',
  'music',
  'ambience',
  'voice',
  'ui',
] as const;

/** Default per-bus levels. Music sits below sfx so impacts always read. */
const DEFAULT_VOLUMES: Record<AudioCategory, number> = {
  sfx: 0.9,
  music: 0.55,
  ambience: 0.5,
  voice: 0.85,
  ui: 0.7,
};

/** One mixer strip: user volume, then game-owned ducking. */
class BusStrip implements IAudioBus {
  readonly category: AudioCategory;
  /** Voices connect here. */
  readonly input: GainNode;
  readonly volumeGain: GainNode;
  readonly duckGain: GainNode;

  private volumeValue: number;
  private mutedValue = false;
  /** Absolute context time at which an automatic duck should release. */
  private duckReleaseAt = Number.POSITIVE_INFINITY;
  private duckReleaseSeconds = 0.3;

  constructor(ctx: BaseAudioContext, category: AudioCategory, destination: AudioNode) {
    this.category = category;
    this.volumeValue = DEFAULT_VOLUMES[category];
    this.input = ctx.createGain();
    this.volumeGain = ctx.createGain();
    this.duckGain = ctx.createGain();
    this.input.gain.value = 1;
    this.volumeGain.gain.value = this.volumeValue;
    this.duckGain.gain.value = 1;
    this.input.connect(this.volumeGain).connect(this.duckGain).connect(destination);
  }

  get volume(): number {
    return this.volumeValue;
  }

  set volume(value: number) {
    this.volumeValue = clamp01(value);
    this.volumeGain.gain.value = this.mutedValue ? 0 : this.volumeValue;
  }

  get muted(): boolean {
    return this.mutedValue;
  }

  set muted(value: boolean) {
    this.mutedValue = value;
    this.volumeGain.gain.value = value ? 0 : this.volumeValue;
  }

  duck(to: number, seconds: number, now: number): void {
    const target = clamp01(to);
    const g = this.duckGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + Math.max(seconds, 0.001));
    this.duckReleaseAt = Number.POSITIVE_INFINITY;
  }

  unduck(seconds: number, now: number): void {
    const g = this.duckGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + Math.max(seconds, 0.001));
    this.duckReleaseAt = Number.POSITIVE_INFINITY;
  }

  /**
   * Duck now and schedule the release automatically. The whole envelope is
   * written onto the audio timeline up front, so a dropped frame cannot leave
   * the music stuck quiet.
   */
  duckFor(to: number, attack: number, hold: number, release: number, now: number): void {
    const target = clamp01(to);
    const g = this.duckGain.gain;
    const a = Math.max(attack, 0.001);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + a);
    g.setValueAtTime(target, now + a + Math.max(hold, 0));
    g.linearRampToValueAtTime(1, now + a + Math.max(hold, 0) + Math.max(release, 0.001));
    this.duckReleaseAt = now + a + Math.max(hold, 0) + Math.max(release, 0.001);
    this.duckReleaseSeconds = release;
  }

  /** True while an automatic duck is still in flight. */
  isDucking(now: number): boolean {
    return now < this.duckReleaseAt;
  }

  dispose(): void {
    this.input.disconnect();
    this.volumeGain.disconnect();
    this.duckGain.disconnect();
  }
}

/** Options for the master chain. */
export interface IMixerOptions {
  readonly masterVolume?: number;
  /**
   * Skip the limiter and soft-clipper. Used ONLY by the offline render tests,
   * to measure a voice's raw gain staging before the safety net touches it.
   */
  readonly bypassMaster?: boolean;
  /** Master saturation amount for the soft clipper. */
  readonly drive?: number;
}

/**
 * The mixer. One per audio system; owns the whole post-voice signal path.
 */
export class Mixer {
  readonly ctx: BaseAudioContext;
  /** Bus outputs sum here, before master gain. */
  readonly masterBus: GainNode;
  readonly masterGain: GainNode;
  readonly limiter: DynamicsCompressorNode | undefined;
  readonly clipper: WaveShaperNode | undefined;

  private readonly strips = new Map<AudioCategory, BusStrip>();
  private masterVolumeValue: number;

  constructor(ctx: BaseAudioContext, options: IMixerOptions = {}) {
    this.ctx = ctx;
    this.masterVolumeValue = clamp01(options.masterVolume ?? 1);

    this.masterBus = ctx.createGain();
    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.masterVolumeValue;
    this.masterBus.connect(this.masterGain);

    if (options.bypassMaster) {
      this.limiter = undefined;
      this.clipper = undefined;
      this.masterGain.connect(ctx.destination);
    } else {
      const limiter = ctx.createDynamicsCompressor();
      // Brickwall-ish settings: hard knee, high ratio, fast attack, musical
      // release so a burst of debris does not pump the whole mix.
      limiter.threshold.value = -6;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.18;

      const clipper = ctx.createWaveShaper();
      clipper.curve = softClipCurve(8192, options.drive ?? 1.35);
      clipper.oversample = '2x';

      this.masterGain.connect(limiter).connect(clipper).connect(ctx.destination);
      this.limiter = limiter;
      this.clipper = clipper;
    }

    for (const category of AUDIO_CATEGORIES) {
      this.strips.set(category, new BusStrip(ctx, category, this.masterBus));
    }
  }

  /** Master gain 0..1, applied above every bus. */
  get masterVolume(): number {
    return this.masterVolumeValue;
  }

  set masterVolume(value: number) {
    this.masterVolumeValue = clamp01(value);
    this.masterGain.gain.value = this.masterVolumeValue;
  }

  /** Mixer bus by category. */
  bus(category: AudioCategory): IAudioBus {
    return this.strip(category);
  }

  /** The node a voice on `category` should connect to. */
  input(category: AudioCategory): GainNode {
    return this.strip(category).input;
  }

  private strip(category: AudioCategory): BusStrip {
    const strip = this.strips.get(category);
    if (!strip) throw new Error(`[audio] unknown mixer bus "${category}"`);
    return strip;
  }

  duck(category: AudioCategory, toVolume: number, seconds: number, now = this.ctx.currentTime): void {
    this.strip(category).duck(toVolume, seconds, now);
  }

  unduck(category: AudioCategory, seconds: number, now = this.ctx.currentTime): void {
    this.strip(category).unduck(seconds, now);
  }

  /**
   * Duck with an automatic release. This is the form combat uses: a serious
   * punch pulls the music down instantly, holds it under the impact tail, and
   * lets it back up over half a second.
   */
  duckFor(
    category: AudioCategory,
    toVolume: number,
    attack: number,
    hold: number,
    release: number,
    now = this.ctx.currentTime
  ): void {
    this.strip(category).duckFor(toVolume, attack, hold, release, now);
  }

  isDucking(category: AudioCategory, now = this.ctx.currentTime): boolean {
    return this.strip(category).isDucking(now);
  }

  /** Move the 3D listener. Called once per frame from the camera. */
  setListener(position: Vec3, forward: Vec3, up: Vec3, time = this.ctx.currentTime): void {
    const listener = this.ctx.listener;
    setSpatialPosition(listener, position, time);
    setListenerOrientation(listener, forward, up, time);
  }

  /** Current limiter gain reduction in dB (0 when no limiting is happening). */
  get gainReductionDb(): number {
    return this.limiter?.reduction ?? 0;
  }

  dispose(): void {
    for (const strip of this.strips.values()) strip.dispose();
    this.strips.clear();
    this.masterBus.disconnect();
    this.masterGain.disconnect();
    this.limiter?.disconnect();
    this.clipper?.disconnect();
  }
}
