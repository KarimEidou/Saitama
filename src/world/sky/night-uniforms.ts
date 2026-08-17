/**
 * SHARED NIGHT UNIFORMS — one write turns on every light in the city.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 * City Z at street level has thousands of lit surfaces: lamp heads, shop
 * signage, vending machines, and window panes across every facade. The obvious
 * implementation walks them at dusk and sets `material.emissiveIntensity`, or
 * worse, toggles a `PointLight` per lamp. Both are catastrophic here:
 *
 *   • Per-object logic is O(lit objects) per frame on a phone CPU, over
 *     objects that are mostly instanced and therefore do not even exist as
 *     individual scene nodes.
 *   • Mutating `emissiveIntensity` on a shared material mutates it for every
 *     instance at once — which is the ONLY reason the naive version appears to
 *     work — and mutating a per-instance clone multiplies the draw calls and
 *     the shader program count.
 *   • A light per lamp is instantly out of budget; three's forward renderer
 *     compiles a different program per light count.
 *
 * ── WHAT IT DOES INSTEAD ───────────────────────────────────────────────────
 * Every lit material shares ONE `{ value }` uniform object. The day/night
 * system writes `uNightFactor.value` once per frame and every lamp, sign and
 * window pane in the world follows, on the GPU, for free. No traversal, no
 * material mutation, no per-object state.
 *
 * Which window panes light up is decided in the shader by hashing the pane's
 * world position, compared against a second shared uniform. So the windows are
 * scattered and stable — the same pane is lit every night — without a single
 * byte of per-pane CPU data.
 *
 * ── WHY `onBeforeCompile` AND NOT A CUSTOM MATERIAL ────────────────────────
 * The city's surfaces are `MeshStandardMaterial`: they need the project's PBR,
 * shadows, fog and IBL. Re-implementing that to add one emissive term would
 * fork the lighting model. Injecting into the emissive stage keeps every
 * material a standard material, keeps CSM's own shader patch working, and adds
 * exactly one program variant per attach mode.
 */

import * as THREE from 'three';
import { createLogger } from '@/util';

const log = createLogger('world.sky.lights');

/** How a material responds to nightfall. */
export type NightEmissiveMode =
  /** Always on at night: street lamps, signage, vending machines. */
  | 'lamp'
  /** A stable pseudo-random subset lights, keyed on world position. */
  | 'window';

export interface INightUniformOptions {
  /** Sodium-vapour street lamp colour. */
  readonly lampColor?: THREE.ColorRepresentation;
  /** Warm interior colour seen through glazing. */
  readonly windowColor?: THREE.ColorRepresentation;
  /** Emissive gain for lamps at full night. */
  readonly lampIntensity?: number;
  /** Emissive gain for lit windows at full night. */
  readonly windowIntensity?: number;
  /** Metres per window cell in the world-space hash. */
  readonly windowCellSize?: number;
}

/**
 * The shared uniform block. Create ONE and pass it to every lit material.
 *
 * The uniform objects are handed out by reference and mutated in place. Never
 * replace them — a material that captured the old object stops updating, and
 * the failure looks like "some lamps never turn on", which is miserable to
 * track down.
 */
export class NightUniforms {
  /** 0 by day, 1 at full night. The one value that matters. */
  readonly uNightFactor = { value: 0 };
  /** Fraction of window cells lit, 0..1. */
  readonly uWindowLitFraction = { value: 0 };
  readonly uLampColor: { value: THREE.Color };
  readonly uWindowColor: { value: THREE.Color };
  readonly uLampIntensity = { value: 1 };
  readonly uWindowIntensity = { value: 1 };
  readonly uWindowCellSize = { value: 2.2 };
  /**
   * Flicker phase, advanced with real time. Sodium lamps buzz and a couple of
   * them in every street are on their way out; a slow global phase plus a
   * position hash gives that for one more uniform.
   */
  readonly uLampPhase = { value: 0 };

  private readonly attached = new WeakSet<THREE.Material>();
  private attachedCount = 0;

  constructor(options: INightUniformOptions = {}) {
    this.uLampColor = { value: new THREE.Color(options.lampColor ?? 0xffc37a) };
    this.uWindowColor = { value: new THREE.Color(options.windowColor ?? 0xffd9a0) };
    this.uLampIntensity.value = options.lampIntensity ?? 2.6;
    this.uWindowIntensity.value = options.windowIntensity ?? 1.5;
    this.uWindowCellSize.value = options.windowCellSize ?? 2.2;
  }

  /** Materials currently wired to this block. */
  get materialCount(): number {
    return this.attachedCount;
  }

  /**
   * Push the frame's values. THE only per-frame cost of the whole system:
   * four number writes, regardless of how many lit surfaces exist.
   */
  update(nightFactor: number, windowLitFraction: number, elapsedSeconds: number): void {
    this.uNightFactor.value = nightFactor;
    this.uWindowLitFraction.value = windowLitFraction;
    this.uLampPhase.value = elapsedSeconds;
  }

  /**
   * Wire one material into the block. Idempotent per material.
   *
   * Chains onto any existing `onBeforeCompile` (the shadow system installs one
   * of its own), rather than replacing it.
   */
  attach(material: THREE.Material, mode: NightEmissiveMode): void {
    if (this.attached.has(material)) return;
    this.attached.add(material);
    this.attachedCount++;

    const previous = material.onBeforeCompile?.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous?.(shader, renderer);

      shader.uniforms.uNightFactor = this.uNightFactor;
      shader.uniforms.uLampColor = this.uLampColor;
      shader.uniforms.uLampIntensity = this.uLampIntensity;
      shader.uniforms.uLampPhase = this.uLampPhase;

      if (mode === 'window') {
        shader.uniforms.uWindowColor = this.uWindowColor;
        shader.uniforms.uWindowIntensity = this.uWindowIntensity;
        shader.uniforms.uWindowLitFraction = this.uWindowLitFraction;
        shader.uniforms.uWindowCellSize = this.uWindowCellSize;
      }

      // World position is needed for the window hash and the lamp flicker.
      // `worldpos_vertex` is included by the shadow chunks, so the varying is
      // declared separately and filled from `#include <worldpos_vertex>`'s
      // output where available, or recomputed where it is not.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vSkyWorldPos;`)
        .replace(
          '#include <fog_vertex>',
          `#include <fog_vertex>\n  vSkyWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vSkyWorldPos;
uniform float uNightFactor;
uniform vec3  uLampColor;
uniform float uLampIntensity;
uniform float uLampPhase;
${
  mode === 'window'
    ? `uniform vec3  uWindowColor;
uniform float uWindowIntensity;
uniform float uWindowLitFraction;
uniform float uWindowCellSize;`
    : ''
}
/* Stable 0..1 hash of an integer cell. No texture, no attribute, no CPU. */
float skyHash(vec3 cell) {
  return fract(sin(dot(cell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
}`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
${
  mode === 'lamp'
    ? `  {
    // One lamp in a dozen buzzes. The hash keeps it the SAME lamp every night.
    float lampId = skyHash(floor(vSkyWorldPos * 0.35));
    float flickerAmount = step(0.92, lampId);
    float flicker = mix(1.0, 0.72 + 0.28 * sin(uLampPhase * 22.0 + lampId * 40.0), flickerAmount);
    totalEmissiveRadiance += uLampColor * uLampIntensity * uNightFactor * flicker;
  }`
    : `  {
    vec3 cell = floor(vSkyWorldPos / max(0.05, uWindowCellSize));
    float lit = step(skyHash(cell), uWindowLitFraction);
    totalEmissiveRadiance += uWindowColor * uWindowIntensity * uNightFactor * lit;
  }`
}`
        );
    };

    // Force a recompile if the material has already been used this session.
    material.needsUpdate = true;
  }

  /** Attach every material found under a subtree whose name matches a mode. */
  attachByName(
    root: THREE.Object3D,
    match: (name: string) => NightEmissiveMode | undefined
  ): number {
    let count = 0;
    root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        const mode = match(material.name || mesh.name);
        if (!mode) continue;
        this.attach(material, mode);
        count++;
      }
    });
    if (count > 0) log.debug(`attached ${count} materials to the shared night uniforms`);
    return count;
  }
}
