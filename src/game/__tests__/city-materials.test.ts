/**
 * CITY MATERIAL ADOPTION
 *
 * The upgrade pass swaps the real KTX2 maps onto the SAME `THREE.Material`
 * objects the scene graph already binds, so a whole district upgrades
 * mid-frame with no rebuild and no reallocation. That is only safe while "the
 * real maps" are actually real.
 *
 * A registry material whose textures failed to load is still resident and
 * still a `MeshStandardMaterial` — it is just bound to the missing-asset
 * checker. Adopting one paints a perfectly good synthesised brick with a
 * magenta test pattern AND marks the id `upgraded`, which removes it from
 * `pendingUpgrades()` for the rest of the session, so the city can never
 * recover even after the real textures arrive. Both halves are asserted here.
 *
 * No renderer and no GPU: everything under test is a property of the material
 * objects, which is the only way it stays asserted.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { IAssetRegistry } from '@/types';
import { CityMaterialLibrary } from '../city-materials';

const KEY = 'mat.wall.brick.red';

/** A registry serving one material, swappable so a test can stage the wave. */
function stubRegistry(): {
  registry: IAssetRegistry;
  serve: (material: THREE.Material | undefined) => void;
} {
  let served: THREE.Material | undefined;
  return {
    registry: { getMaterial: () => served } as unknown as IAssetRegistry,
    serve: (material) => {
      served = material;
    },
  };
}

/** What `buildMaterial` hands back: real maps, plus the gap list it publishes. */
function registryMaterial(missingTextures: readonly string[]): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: new THREE.Texture(),
    normalMap: new THREE.Texture(),
    roughness: 0.42,
    metalness: 0.13,
  });
  material.userData.missingTextures = [...missingTextures];
  return material;
}

describe('CityMaterialLibrary.adopt', () => {
  it('refuses a checker-backed material and leaves the id upgradeable', () => {
    const { registry, serve } = stubRegistry();
    const library = new CityMaterialLibrary();
    library.useRegistry(registry);

    // Nothing resident yet, so the city gets its procedural stand-in.
    const live = library.resolve(KEY) as THREE.MeshStandardMaterial;
    const synthesised = live.map;
    expect(synthesised).not.toBeNull();
    expect(library.synthesised.has(KEY)).toBe(true);

    serve(registryMaterial(['mat.wall.brick.red.albedo']));
    expect(library.adopt([KEY])).toBe(0);

    // The good procedural map is still on the live material...
    expect(live.map).toBe(synthesised);
    // ...and the id is still queued, so a later wave can still upgrade it.
    expect(library.upgraded.has(KEY)).toBe(false);
    expect(library.synthesised.has(KEY)).toBe(true);
    expect(library.pendingUpgrades()).toContain(KEY);

    library.dispose();
  });

  it('adopts in place once every texture bound for real', () => {
    const { registry, serve } = stubRegistry();
    const library = new CityMaterialLibrary();
    library.useRegistry(registry);
    const live = library.resolve(KEY) as THREE.MeshStandardMaterial;

    const source = registryMaterial([]);
    serve(source);
    expect(library.adopt([KEY])).toBe(1);

    // Same material object, real maps on it: no scene-graph rebuild.
    expect(live.map).toBe(source.map);
    expect(live.normalMap).toBe(source.normalMap);
    expect(live.roughness).toBe(source.roughness);
    expect(live.metalness).toBe(source.metalness);
    expect(library.upgraded.has(KEY)).toBe(true);
    expect(library.synthesised.has(KEY)).toBe(false);
    expect(library.pendingUpgrades()).not.toContain(KEY);

    library.dispose();
  });
});
