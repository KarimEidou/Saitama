/**
 * FALLBACKS AND MATERIAL CONSTRUCTION
 *
 * Two things are checked here that a screenshot cannot check for you:
 *
 *  - a missing asset produces something a HUMAN will notice AND something a
 *    TEST can assert on. Flat magenta fails the second half: it looks like a
 *    stylised surface in a dark frame, and nothing in the scene graph says
 *    "this is broken".
 *
 *  - the packed ORM map binds to all three slots with `aoMap.channel = 0`.
 *    These meshes have no UV1; AO reading channel 1 samples an attribute that
 *    does not exist.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { IMaterialAsset, TextureHandle } from '@/types';
import {
  disposeFallbacks,
  isMissingAsset,
  missingEnvironment,
  missingMaterial,
  missingModel,
  missingTexture,
} from '../fallback';
import { buildMaterial, requiredTextures } from '../materials';
import { bindPackedOrm, ManagedTextureHandle, withRepeat } from '../textures';
import { parseRuntimeManifest } from '../manifest';
import { testManifest } from './fixtures';

function handleFor(key: string): TextureHandle {
  const texture = new THREE.CompressedTexture([], 64, 64, THREE.RGBA_BPTC_Format);
  texture.name = key;
  return new ManagedTextureHandle({ key, texture, colorSpace: 'linear', tier: 'mobile' });
}

/** A handle in the shape the registry installs when a transcode FAILS. */
function fallbackHandleFor(key: string): ManagedTextureHandle {
  return new ManagedTextureHandle({
    key,
    texture: missingTexture(),
    colorSpace: 'linear',
    tier: 'fallback',
    fallback: true,
  });
}

/**
 * A manifest entry in the shape `mat.glass.window` and `mat.road.markings`
 * actually ship in: every texture declared by ROLE, and a spec that binds none
 * of them. Built here rather than in `fixtures.ts` because the fixture
 * deliberately mirrors the well-formed majority.
 */
function roleOnlyEntry(id: string): IMaterialAsset {
  return {
    id,
    kind: 'material',
    name: id,
    attribution: { license: 'CC0-1.0', author: 'test', sourceUrl: 'https://example.invalid' },
    sourceUrl: 'https://example.invalid',
    sha256: 'x',
    targetFormat: 'json',
    outputs: [],
    preload: true,
    spec: { id, kind: 'standard', color: 0xffffff, roughness: 1, metalness: 1 },
    textureKeys: {
      albedo: `${id}.albedo`,
      normal: `${id}.normal`,
      orm: `${id}.orm`,
    },
    tileSizeMeters: 3,
  } as IMaterialAsset;
}

describe('missing-asset fallbacks', () => {
  it('is a marked checker, not a flat magenta fill', () => {
    disposeFallbacks();
    const texture = missingTexture();
    const data = texture.image.data as Uint8Array;

    const colours = new Set<string>();
    for (let i = 0; i < data.length; i += 4) {
      colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    // Magenta, near-black and the diagonal slash: three distinct colours means
    // it cannot read as a single stylised surface.
    expect(colours.size).toBe(3);
    expect(colours.has('255,0,200')).toBe(true);
    expect(colours.has('12,12,16')).toBe(true);
    expect(colours.has('255,255,0')).toBe(true);
  });

  it('is detectable programmatically on every kind of stand-in', () => {
    expect(isMissingAsset(missingTexture())).toBe(true);
    expect(isMissingAsset(missingMaterial('mat.x'))).toBe(true);
    expect(isMissingAsset(missingModel('model.x'))).toBe(true);
    expect(isMissingAsset(missingEnvironment('hdri.x'))).toBe(true);
    expect(isMissingAsset(new THREE.MeshStandardMaterial())).toBe(false);
    expect(isMissingAsset(undefined)).toBe(false);
  });

  it('names the asset it stands in for', () => {
    const material = missingMaterial('mat.road.asphalt.worn');
    expect(material.name).toBe('MISSING:mat.road.asphalt.worn');
    expect(material.userData.missingKey).toBe('mat.road.asphalt.worn');

    const model = missingModel('model.building.a');
    expect(model.name).toBe('MISSING:model.building.a');
  });

  it('leaves a missing environment neutral rather than magenta', () => {
    const environment = missingEnvironment('hdri.sky.day');
    const data = environment.image.data as Uint8Array;
    // A magenta environment map tints the entire world and makes the build
    // unusable rather than merely obviously broken.
    expect(data[0]).toBeLessThan(data[2]!);
    expect(Math.abs(data[0]! - data[1]!)).toBeLessThan(16);
    expect(environment.mapping).toBe(THREE.EquirectangularReflectionMapping);
  });

  it('shares one texture instance across every miss', () => {
    expect(missingTexture()).toBe(missingTexture());
  });
});

describe('buildMaterial', () => {
  const manifest = parseRuntimeManifest(testManifest());
  const entry = manifest.entries.find(
    (candidate) => candidate.id === 'mat.road.asphalt.worn'
  ) as IMaterialAsset;

  it('binds one ORM texture to all three slots with aoMap.channel 0', () => {
    const handles = new Map<string, TextureHandle>();
    for (const key of requiredTextures(entry)) handles.set(key, handleFor(key));

    const built = buildMaterial(entry, (key) => handles.get(key));
    const material = built.material as THREE.MeshStandardMaterial;

    expect(built.ormBound).toBe(true);
    expect(material.aoMap).not.toBeNull();
    expect(material.aoMap).toBe(material.roughnessMap);
    expect(material.aoMap).toBe(material.metalnessMap);
    expect(material.aoMap?.channel).toBe(0);
    expect(material.aoMap?.name).toBe('mat.road.asphalt.worn.orm');
  });

  it('keeps roughness and metalness at 1 so the ORM channels pass through', () => {
    const handles = new Map<string, TextureHandle>();
    for (const key of requiredTextures(entry)) handles.set(key, handleFor(key));
    const material = buildMaterial(entry, (key) => handles.get(key))
      .material as THREE.MeshStandardMaterial;
    // three multiplies scalar by sampled channel; anything below 1 darkens the
    // whole map.
    expect(material.roughness).toBe(1);
    expect(material.metalness).toBe(1);
  });

  it('puts albedo in sRGB and the data maps in linear', () => {
    const handles = new Map<string, TextureHandle>();
    for (const key of requiredTextures(entry)) handles.set(key, handleFor(key));
    const material = buildMaterial(entry, (key) => handles.get(key))
      .material as THREE.MeshStandardMaterial;
    expect(material.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(material.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(material.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('retains every texture it binds so nothing can be evicted underneath it', () => {
    const handles = new Map<string, TextureHandle>();
    for (const key of requiredTextures(entry)) handles.set(key, handleFor(key));
    const built = buildMaterial(entry, (key) => handles.get(key));
    expect(built.handles).toHaveLength(3);
    for (const handle of handles.values()) expect(handle.refCount).toBe(1);
  });

  it('substitutes the marked pattern and reports the gap when a map is absent', () => {
    const built = buildMaterial(entry, () => undefined);
    const material = built.material as THREE.MeshStandardMaterial;
    expect(built.missingTextures).toHaveLength(3);
    expect(isMissingAsset(material.map ?? undefined)).toBe(true);
    // It still built a usable material — no throw, no null material.
    expect(material.isMeshStandardMaterial).toBe(true);
  });

  it('reports a RESIDENT stand-in, not just an absent one', () => {
    // The live failure this exists for: with no Basis transcoder EVERY texture
    // load fails, and the registry answers each one with a `fallback: true`
    // handle wrapping the checker. `resolve` therefore SUCCEEDS for all three,
    // so the material was 100% magenta while `missingTextures` was empty and
    // every safety net downstream of it stayed asleep.
    const handles = new Map<string, ManagedTextureHandle>();
    for (const key of requiredTextures(entry)) handles.set(key, fallbackHandleFor(key));

    const built = buildMaterial(entry, (key) => handles.get(key));
    const material = built.material as THREE.MeshStandardMaterial;

    expect([...built.missingTextures].sort()).toEqual([...requiredTextures(entry)].sort());
    // `IAssetRegistry` exposes only `getMaterial(key): THREE.Material`, so
    // `userData` is the one channel a consumer has to ask through.
    expect(material.userData.missingTextures).toEqual(built.missingTextures);
    // The marked pattern still has to be ON SCREEN — this reports the gap, it
    // does not hide it.
    expect(isMissingAsset(material.map ?? undefined)).toBe(true);
    // And reference counting is untouched: retained exactly once each.
    expect(built.handles).toHaveLength(3);
    for (const handle of handles.values()) expect(handle.refCount).toBe(1);
  });

  it('publishes an empty gap list when every map bound for real', () => {
    const handles = new Map<string, TextureHandle>();
    for (const key of requiredTextures(entry)) handles.set(key, handleFor(key));
    const built = buildMaterial(entry, (key) => handles.get(key));
    expect(built.missingTextures).toHaveLength(0);
    expect(built.material.userData.missingTextures).toEqual([]);
  });

  it('binds by ROLE when the spec names no map keys at all', () => {
    // `mat.glass.window` and `mat.road.markings` ship exactly like this. The
    // registry preloads all three of their textures because `requiredTextures`
    // unions both sides — so an unbound role is a texture that was fetched,
    // transcoded and never sampled, on a surface that renders flat.
    const byRole = roleOnlyEntry('mat.glass.window');
    const handles = new Map<string, TextureHandle>();
    for (const key of requiredTextures(byRole)) handles.set(key, handleFor(key));

    const built = buildMaterial(byRole, (key) => handles.get(key));
    const material = built.material as THREE.MeshStandardMaterial;

    expect(built.missingTextures).toHaveLength(0);
    expect(material.map?.name).toBe('mat.glass.window.albedo');
    expect(material.normalMap?.name).toBe('mat.glass.window.normal');
    expect(material.roughnessMap?.name).toBe('mat.glass.window.orm');
    expect(built.ormBound).toBe(true);
    expect(isMissingAsset(material.map ?? undefined)).toBe(false);
  });

  it('lists every texture the spec needs, including ones textureKeys forgot', () => {
    expect(requiredTextures(entry)).toEqual([
      'mat.road.asphalt.worn.albedo',
      'mat.road.asphalt.worn.normal',
      'mat.road.asphalt.worn.orm',
    ]);
  });
});

describe('texture slot helpers', () => {
  it('bindPackedOrm forces the AO channel to UV0', () => {
    const material = new THREE.MeshStandardMaterial();
    const orm = new THREE.Texture();
    orm.channel = 1;
    bindPackedOrm(material, orm);
    expect(orm.channel).toBe(0);
    expect(material.aoMap).toBe(orm);
    expect(material.roughnessMap).toBe(orm);
    expect(material.metalnessMap).toBe(orm);
  });

  it('withRepeat clones rather than retiling the shared texture', () => {
    const shared = new THREE.Texture();
    const tiled = withRepeat(shared, [4, 4]);
    expect(tiled).not.toBe(shared);
    expect(tiled.repeat.x).toBe(4);
    expect(shared.repeat.x).toBe(1);
    // A clone shares `source`, so three still uploads one GPU texture.
    expect(tiled.source).toBe(shared.source);
  });

  it('withRepeat returns the original when there is nothing to change', () => {
    const shared = new THREE.Texture();
    expect(withRepeat(shared, [1, 1])).toBe(shared);
    expect(withRepeat(shared, undefined)).toBe(shared);
  });
});
