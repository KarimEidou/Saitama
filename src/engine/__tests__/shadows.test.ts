/**
 * WHAT THE SHADOW SYSTEM OWES THE THIRD PARTY IT DELEGATES TO
 *
 * `CSM` is an addon, and everything that leaks here leaks because the addon
 * does not clean up after itself and this class assumed it did:
 *
 *   • `CSM.remove()` is a scene-graph detach and `CSM.dispose()` only touches
 *     material defines. NEITHER frees a cascade's shadow map, so every tier
 *     change orphaned a full set of depth targets — tens of MB on `high`.
 *   • `CSM.fade` is not a constructor option. The constructor fits the cascade
 *     bounds with it still `false`, and `CSM.update()` never refits them, so
 *     the fade margin the blend band needs was never added.
 *   • `CSM.setupMaterial()` puts every material in a strong `Map` and nothing
 *     takes it out; neither did `registered`. The composition root re-registers
 *     the whole scene once a second, so every chunk material that ever existed
 *     stayed pinned for the life of the process.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ShadowSystem } from '../shadows';
import { RENDER_TIER_PROFILES, type ShadowTierProfile } from '../quality';

const HIGH_SHADOWS = RENDER_TIER_PROFILES.high.shadows;
const LOW_SHADOWS = RENDER_TIER_PROFILES.low.shadows;

function makeSystem(profile: ShadowTierProfile): {
  system: ShadowSystem;
  scene: THREE.Scene;
} {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  return { system: new ShadowSystem(scene, camera, { profile }), scene };
}

/** Ortho width of the LAST cascade, where the fade margin is largest. */
function farCascadeWidth(system: ShadowSystem): number {
  const lights = system.sunLights;
  const shadow = lights[lights.length - 1]!.shadow;
  return shadow.camera.right - shadow.camera.left;
}

describe('ShadowSystem cascade lifecycle', () => {
  it('applies the fade margin to the cascade extents', () => {
    const faded = makeSystem({ ...HIGH_SHADOWS, fade: true });
    const width = farCascadeWidth(faded.system);
    faded.system.dispose();

    const plain = makeSystem({ ...HIGH_SHADOWS, fade: false });
    const baseline = farCascadeWidth(plain.system);
    plain.system.dispose();

    // Without the refit both are identical and the blend band falls outside the
    // next cascade's map — the seam `fade` exists to hide, still visible.
    expect(width).toBeGreaterThan(baseline);
  });

  it('disposes every cascade shadow map when the profile changes', () => {
    const { system } = makeSystem(HIGH_SHADOWS);
    const lights = [...system.sunLights];
    expect(lights).toHaveLength(HIGH_SHADOWS.cascades);

    const spies = lights.map((light) => vi.spyOn(light.shadow, 'dispose'));
    system.setProfile(LOW_SHADOWS);

    // `LightShadow.dispose()` is the only path that reaches `map.dispose()`.
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    system.dispose();
  });

  it('disposes every cascade shadow map on teardown', () => {
    const { system } = makeSystem(HIGH_SHADOWS);
    const spies = system.sunLights.map((light) => vi.spyOn(light.shadow, 'dispose'));
    system.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ShadowSystem material registry', () => {
  it('forgets a material as soon as it is disposed', () => {
    const { system } = makeSystem(HIGH_SHADOWS);
    const material = new THREE.MeshStandardMaterial();

    system.registerMaterial(material);
    expect(system.getStats().registeredMaterials).toBe(1);

    // A streamed chunk being evicted. Nothing else releases it.
    material.dispose();
    expect(system.getStats().registeredMaterials).toBe(0);

    system.dispose();
  });

  it('lets an owner release a material explicitly', () => {
    const { system } = makeSystem(HIGH_SHADOWS);
    const material = new THREE.MeshStandardMaterial();

    system.registerMaterial(material);
    system.unregisterMaterial(material);

    expect(system.getStats().registeredMaterials).toBe(0);
    expect(material.defines?.USE_CSM).toBeUndefined();

    // And it does not come back when the material is later disposed.
    material.dispose();
    expect(system.getStats().registeredMaterials).toBe(0);
    system.dispose();
  });
});
