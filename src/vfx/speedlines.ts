/**
 * SPEEDLINES — the anime signature, and the cheapest drama in the game.
 *
 * One full-screen triangle, one shader program, no textures, no render
 * targets. It works identically on the LOW tier, which has no post-processing
 * chain at all — and that is the point. The renderer's `AnimeCompositePass`
 * has its own speedline term, but it only exists on the HIGH desktop profile;
 * this one is the version a phone actually gets.
 *
 * ── TWO CHANNELS, DELIBERATELY ─────────────────────────────────────────────
 *   sustained  held while dashing or charging. Set and cleared by state.
 *   pulse      a burst on impact, decaying on its own.
 * The final intensity is the maximum of the two, so a punch landing mid-dash
 * spikes rather than merely continuing, and releasing the dash during a punch
 * does not cut the impact lines off.
 *
 * ── WHY IT DECAYS ON SCALED TIME ───────────────────────────────────────────
 * The renderer freezes the game clock to 4% for 90 ms on a lethal hit. Because
 * this decays on the SCALED delta, the lines HOLD through that freeze instead
 * of washing out during it — which is the entire anime beat being imitated:
 * the frame stops, and it stops with the lines on it.
 */

import * as THREE from 'three';
import type { IVFXTierProfile } from './constants';
import { createFullScreenGeometry, excludeFromOverridePasses } from './geometry';
import { createSpeedlinesMaterial } from './materials';

export interface ISpeedlinesOptions {
  /** Angular line count of the base field. */
  readonly density?: number;
  /** Normalised radius at which lines begin. Keeps the subject clear. */
  readonly innerRadius?: number;
  /** Over-brightness of the line colour; >1 gives the bloom something to find. */
  readonly glow?: number;
}

export class Speedlines {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  private readonly enabled: boolean;
  private sustained = 0;
  private sustainedTarget = 0;
  private pulse = 0;
  private pulseDecay = 4;
  private phaseCounter = 0;

  private readonly focus = new THREE.Vector2(0, 0);
  private readonly scratch = new THREE.Vector3();

  constructor(profile: IVFXTierProfile, options: ISpeedlinesOptions = {}) {
    this.enabled = profile.speedlines;
    this.material = createSpeedlinesMaterial(profile);
    this.material.uniforms.uDensity!.value = options.density ?? (profile.tier === 'low' ? 96 : 150);
    this.material.uniforms.uInner!.value = options.innerRadius ?? 0.68;
    this.material.uniforms.uGlow!.value = options.glow ?? 1.15;

    this.mesh = new THREE.Mesh(createFullScreenGeometry(), this.material);
    this.mesh.name = 'vfx.speedlines';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    // Above every other transparent object in the scene, including the VFX.
    this.mesh.renderOrder = 10_000;
    excludeFromOverridePasses(this.mesh);
    this.mesh.visible = false;
  }

  /** Current on-screen intensity, 0..1. */
  get intensity(): number {
    return Math.max(this.sustained, this.pulse);
  }

  /** Hold lines at `level` — dashes and charge-ups. */
  setSustained(level: number): void {
    this.sustainedTarget = Math.min(1, Math.max(0, level));
  }

  /**
   * Fire a burst.
   *
   * @param strength 0..1.
   * @param decay    Per-second falloff. Small values hold longer; an impact
   *                 wants roughly 3-5.
   */
  burst(strength: number, decay = 4): void {
    const clamped = Math.min(1, Math.max(0, strength));
    if (clamped <= this.pulse) return;
    this.pulse = clamped;
    this.pulseDecay = decay;
    // A new burst gets a new line pattern. Advancing the phase every FRAME
    // instead would make the lines crawl, which reads as television static.
    this.phaseCounter = (this.phaseCounter + 17.31) % 997;
    this.material.uniforms.uPhase!.value = this.phaseCounter;
  }

  /** Focus point in normalised device coordinates, -1..1. */
  setFocus(x: number, y: number): void {
    this.focus.set(x, y);
  }

  /**
   * Focus on a world position — the thing that just got hit.
   *
   * Radial lines converging on the impact rather than on the middle of the
   * screen is a small change that makes the composition point at the subject.
   */
  setFocusWorld(x: number, y: number, z: number, camera: THREE.Camera): void {
    this.scratch.set(x, y, z).project(camera);
    // Behind the camera: `project` mirrors the point, so fall back to centre.
    if (this.scratch.z > 1) this.focus.set(0, 0);
    else
      this.focus.set(
        Math.max(-1.4, Math.min(1.4, this.scratch.x)),
        Math.max(-1.4, Math.min(1.4, this.scratch.y))
      );
  }

  setColor(color: THREE.ColorRepresentation): void {
    (this.material.uniforms.uColor!.value as THREE.Color).set(color);
  }

  /** Aspect correction so the lines stay radial rather than elliptical. */
  setViewport(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    (this.material.uniforms.uAspect!.value as THREE.Vector2).set(aspect, 1);
  }

  /** @param dt SCALED seconds — see the class header. */
  update(dt: number): void {
    if (dt > 0) {
      // Sustained lines ease so a dash does not snap on.
      const rate = Math.min(1, dt * 9);
      this.sustained += (this.sustainedTarget - this.sustained) * rate;
      if (this.pulse > 0) {
        this.pulse -= this.pulseDecay * dt;
        if (this.pulse < 0) this.pulse = 0;
      }
    }
    const intensity = this.intensity;
    this.material.uniforms.uIntensity!.value = intensity;
    (this.material.uniforms.uFocus!.value as THREE.Vector2).copy(this.focus);
    // A disabled tier keeps the object but never submits it: no draw call, no
    // program, no branch anywhere else in the system.
    this.mesh.visible = this.enabled && intensity > 0.004;
  }

  clear(): void {
    this.sustained = 0;
    this.sustainedTarget = 0;
    this.pulse = 0;
    this.material.uniforms.uIntensity!.value = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
