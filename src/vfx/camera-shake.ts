/**
 * TRAUMA-BASED CAMERA SHAKE — `ICameraShake` from the VFX contract.
 *
 * Callers add TRAUMA, never displacement. The system squares it and decays it,
 * which is the difference between shake that composes and shake that fights
 * itself:
 *
 *   • Squaring makes small hits nearly invisible and big ones violent, so a
 *     collapsing building does not read the same as a pebble.
 *   • Two impacts in one frame add their trauma and produce ONE stronger
 *     shake, rather than two offset animations interfering.
 *   • Decay is a property of the system, so nothing has to remember to stop.
 *
 * ── WHY IT DOES NOT TOUCH THE CAMERA ───────────────────────────────────────
 * This produces an OFFSET and a ROLL and stops. The camera rig belongs to the
 * player workstream and composes shake with collision, look input and framing
 * in whatever order it needs. A VFX module reaching into the camera transform
 * would fight it every frame.
 *
 * ── WHY THE NOISE IS SEEDED ────────────────────────────────────────────────
 * `Math.random()` would make a replay of the same events produce a different
 * camera path, so a recorded verification run could never be compared frame to
 * frame. Interpolated hash noise gives smooth, deterministic, non-repeating
 * motion for the cost of two hashes per axis.
 */

import * as THREE from 'three';
import type { ICameraShake } from '@/types';
import { hash1 } from './noise';

export interface ICameraShakeOptions {
  /** Trauma lost per second. 1.4 clears a full hit in about 0.7 s. */
  readonly decayRate?: number;
  /** Oscillations per second. 16-22 reads as impact; below 10 reads as a boat. */
  readonly frequency?: number;
  /** Metres of translation at full shake. */
  readonly maxOffset?: number;
  /** Radians of roll at full shake. */
  readonly maxRoll?: number;
  readonly seed?: number;
}

export class CameraShake implements ICameraShake {
  /** Live translation offset in metres. Read by the camera rig. */
  readonly offset = new THREE.Vector3();
  /** Live roll about the view axis, in radians. */
  roll = 0;

  decayRate: number;

  /** Where the "camera" is, for distance attenuation. Updated by the system. */
  readonly listenerPosition = new THREE.Vector3();

  private traumaValue = 0;
  private elapsed = 0;
  private readonly frequency: number;
  private readonly maxOffset: number;
  private readonly maxRoll: number;
  private readonly seed: number;

  constructor(options: ICameraShakeOptions = {}) {
    this.decayRate = options.decayRate ?? 1.4;
    this.frequency = options.frequency ?? 19;
    this.maxOffset = options.maxOffset ?? 0.55;
    this.maxRoll = options.maxRoll ?? 0.055;
    this.seed = options.seed ?? 0x5a17a;
  }

  get trauma(): number {
    return this.traumaValue;
  }

  /** Shake amplitude — trauma SQUARED. See the class header. */
  get amplitude(): number {
    return this.traumaValue * this.traumaValue;
  }

  add(trauma: number): void {
    if (!(trauma > 0)) return;
    this.traumaValue = Math.min(1, this.traumaValue + trauma);
  }

  /**
   * Add trauma attenuated by distance.
   *
   * Quadratic falloff, not linear: a distant collapse should be a rumble, and
   * linear attenuation makes everything within the radius feel equally close.
   */
  addAtPosition(trauma: number, position: THREE.Vector3, falloffRadius: number): void {
    if (!(trauma > 0) || falloffRadius <= 0) return;
    const distance = this.listenerPosition.distanceTo(position);
    if (distance >= falloffRadius) return;
    const attenuation = 1 - distance / falloffRadius;
    this.add(trauma * attenuation * attenuation);
  }

  reset(): void {
    this.traumaValue = 0;
    this.offset.set(0, 0, 0);
    this.roll = 0;
  }

  /** @param dt SCALED seconds, so the shake holds through the impact freeze. */
  update(dt: number): void {
    if (dt > 0) {
      this.elapsed += dt;
      if (this.traumaValue > 0) {
        this.traumaValue -= this.decayRate * dt;
        if (this.traumaValue < 0) this.traumaValue = 0;
      }
    }

    const amplitude = this.amplitude;
    if (amplitude <= 0) {
      this.offset.set(0, 0, 0);
      this.roll = 0;
      return;
    }
    this.offset.set(
      this.noise(0) * this.maxOffset * amplitude,
      this.noise(1) * this.maxOffset * amplitude,
      this.noise(2) * this.maxOffset * amplitude * 0.4
    );
    this.roll = this.noise(3) * this.maxRoll * amplitude;
  }

  /** Smooth, seeded, non-repeating noise in [-1, 1] for one axis. */
  private noise(channel: number): number {
    const x = this.elapsed * this.frequency + channel * 137.73;
    const i = Math.floor(x);
    const f = x - i;
    const smooth = f * f * (3 - 2 * f);
    const a = hash1(i, this.seed + channel * 7919) * 2 - 1;
    const b = hash1(i + 1, this.seed + channel * 7919) * 2 - 1;
    return a + (b - a) * smooth;
  }
}
