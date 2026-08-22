/**
 * BLENDED SKY TESTS
 *
 * No GL here: the renderer is a stub whose draw calls do nothing, which is
 * enough to exercise everything this module decides — which textures feed the
 * blend, when the pre-filtered radiance map is rebuilt, what it is rebuilt
 * INTO, and what the material layer is told about the diffuse half.
 */

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { IAssetRegistry } from '@/types';
import { SkyEnvironment } from '../sky-environment';
import { parseEnvironmentMeasurements, sampleSkyBlend } from '../environment-blend';
import { SKY_ASSET_IDS, type SkyKey } from '../constants';

/** A renderer that accepts every call and draws nothing. */
function stubRenderer(): { renderer: THREE.WebGLRenderer; canvas: EventTarget } {
  const canvas = new EventTarget();
  const renderer = {
    domElement: canvas,
    autoClear: true,
    xr: { enabled: false },
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget: () => undefined,
    render: () => undefined,
    compile: () => undefined,
  } as unknown as THREE.WebGLRenderer;
  return { renderer, canvas };
}

/** A registry holding only the skies named — the partial-load case. */
function registryWith(...keys: SkyKey[]): IAssetRegistry {
  const textures = new Map<string, THREE.Texture>();
  for (const key of keys) textures.set(SKY_ASSET_IDS[key], new THREE.Texture());
  return {
    getHDRI: (key: string) => textures.get(key),
    isLoaded: (key: string) => textures.has(key),
    load: async () => undefined,
  } as unknown as IAssetRegistry;
}

const MEASUREMENTS = parseEnvironmentMeasurements({
  environments: {
    'hdri.sky.dawn': { meanLuminance: 1.098 },
    'hdri.sky.day': { meanLuminance: 0.733 },
    'hdri.sky.dusk': { meanLuminance: 0.904 },
    'hdri.sky.night': { meanLuminance: 0.712 },
  },
});

function makeEnvironment(
  options: {
    registry?: IAssetRegistry;
    mode?: 'pmrem' | 'sh9';
    onSpecularOnlyChanged?: (specularOnly: boolean) => void;
  } = {}
): { sky: SkyEnvironment; scene: THREE.Scene; canvas: EventTarget } {
  const { renderer, canvas } = stubRenderer();
  const scene = new THREE.Scene();
  const sky = new SkyEnvironment({
    renderer,
    scene,
    registry: options.registry ?? registryWith('dawn', 'day', 'dusk', 'night'),
    measurements: MEASUREMENTS,
    mode: options.mode ?? 'pmrem',
    ...(options.onSpecularOnlyChanged
      ? { onSpecularOnlyChanged: options.onSpecularOnlyChanged }
      : {}),
  });
  return { sky, scene, canvas };
}

describe('radiance rebuilds', () => {
  it('rebuilds INTO one render target instead of allocating a new one each time', () => {
    // `fromEquirectangular(source)` with no target runs
    // `renderTarget || this._allocateTargets()`: a fresh cube target with its
    // whole mip chain, allocated and then disposed, on every rebuild. The
    // threshold is keyed on the cross-fade's alpha, so that is ~256 of them
    // per cycle, all inside the fifth of it that cross-fades.
    const { sky, scene } = makeEnvironment();
    sky.update(sampleSkyBlend(0.5), true);
    const first = scene.environment;
    expect(first).not.toBeNull();

    for (const t of [0.24, 0.26, 0.28, 0.65, 0.8]) sky.update(sampleSkyBlend(t), true);

    expect(sky.getStats().radianceRebuilds).toBe(6);
    expect(scene.environment).toBe(first);
    sky.dispose();
  });

  it('rebuilds after the GL context is restored, without waiting for the mix to move', () => {
    // A restored context leaves the render target valid and its CONTENTS
    // empty. The blend recovers by itself (it is re-rendered every frame); the
    // radiance map is only rebuilt when the signature moves, and the cycle
    // sits on one sky for 0.32 of its length — minutes of a city lit by
    // nothing but the key light.
    const { sky, canvas } = makeEnvironment();
    sky.update(sampleSkyBlend(0.4));
    expect(sky.getStats().radianceRebuilds).toBe(1);

    // Same sky either side, so the signature does not move at all.
    sky.update(sampleSkyBlend(0.45));
    sky.update(sampleSkyBlend(0.5));
    expect(sky.getStats().radianceRebuilds).toBe(1);

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    sky.update(sampleSkyBlend(0.52));
    expect(sky.getStats().radianceRebuilds).toBe(2);
    sky.dispose();
  });
});

describe('partial sky sets', () => {
  it('falls back to the OTHER sky when the one it wants is missing', () => {
    // `hdri.sky.day` failed to transcode. From t = 0.3 to t = 0.62 the blend
    // sits on `day` at both ends, and bailing froze the visible sky on the
    // last rendered dawn for 40% of the cycle — where the dusk map next door
    // would have been much closer.
    const { sky, scene } = makeEnvironment({ registry: registryWith('dawn', 'dusk', 'night') });

    const blend = sampleSkyBlend(0.66); // day -> dusk
    expect(blend.from).toBe('day');
    sky.update(blend);

    expect(scene.background).toBe(sky.blendedTexture);
    expect(scene.backgroundIntensity).toBeCloseTo(blend.luminance, 9);
    sky.dispose();
  });

  it('keeps the absolute scale tracking the clock even with nothing loaded', () => {
    const { sky, scene } = makeEnvironment({ registry: registryWith() });

    sky.update(sampleSkyBlend(0.5));
    expect(scene.environmentIntensity).toBeCloseTo(sampleSkyBlend(0.5).luminance, 9);
    // Midnight is ~70x darker; a frozen intensity is the bug this whole
    // workstream exists to prevent, arriving through the back door.
    sky.update(sampleSkyBlend(0.0));
    expect(scene.environmentIntensity).toBeCloseTo(sampleSkyBlend(0.0).luminance, 9);
    expect(scene.environmentIntensity).toBeLessThan(0.05);
    sky.dispose();
  });
});

describe('specular-only reporting', () => {
  it('does not claim specular-only until a diffuse probe actually exists', () => {
    // The flag tells the material layer to CANCEL its diffuse environment
    // term. Announcing it from the IBL mode alone, in a composition that never
    // installs a `LightProbe` (which is what the shipped game does), leaves
    // nothing supplying diffuse IBL and everything not hit by the key light
    // renders black.
    const onSpecularOnlyChanged = vi.fn();
    const { sky } = makeEnvironment({ mode: 'sh9', onSpecularOnlyChanged });

    sky.update(sampleSkyBlend(0.5), true);
    expect(sky.getStats().specularOnly).toBe(false);
    expect(onSpecularOnlyChanged).not.toHaveBeenCalledWith(true);

    sky.setSphericalHarmonics(new THREE.SphericalHarmonics3(), 1);
    expect(sky.getStats().specularOnly).toBe(true);
    expect(onSpecularOnlyChanged).toHaveBeenCalledWith(true);
    sky.dispose();
  });
});
