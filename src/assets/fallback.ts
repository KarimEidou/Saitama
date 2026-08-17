/**
 * FALLBACKS FOR MISSING ASSETS
 *
 * A missing asset must never crash the game and must never look like art.
 *
 * The classic failure is a flat magenta fill: it is unmistakable in a
 * screenshot the author is staring at, and completely invisible in a build
 * where one prop out of four hundred is magenta at dusk. Games have shipped
 * that way. So the fallback here is:
 *
 *   - a COARSE 64px checker, which reads as "test pattern" at any distance;
 *   - alternating magenta and near-black, which no material in this project
 *     uses, so it cannot be confused with a dark surface;
 *   - a diagonal slash across it, which survives mipmapping down to a few
 *     pixels as a visible streak rather than averaging to flat grey;
 *   - `name = 'MISSING:<key>'` on the texture, material and object, so the
 *     inspector, the harness and any log line names the asset that is absent.
 *
 * The registry also records every fallback in `AssetRegistry.missing`, so a
 * verification pass can assert zero rather than relying on someone noticing a
 * checker in a screenshot.
 */

import * as THREE from 'three';
import { FALLBACK_CHECKER_CELL, FALLBACK_TEXTURE_SIZE } from './constants';

/** Marker put on every stand-in, so consumers can detect one programmatically. */
export const MISSING_ASSET_FLAG = 'isMissingAssetFallback';

/** True when `value` is one of this module's stand-ins. */
export function isMissingAsset(value: object | undefined | null): boolean {
  if (!value) return false;
  const holder = value as { userData?: Record<string, unknown> } & Record<string, unknown>;
  return holder[MISSING_ASSET_FLAG] === true || holder.userData?.[MISSING_ASSET_FLAG] === true;
}

let sharedTexture: THREE.DataTexture | undefined;

/**
 * The shared missing-texture pattern.
 *
 * One instance for the whole process: it is 16 KB and immutable, and cloning
 * it per miss would make a broken build cost memory as well as pixels.
 */
export function missingTexture(): THREE.DataTexture {
  if (sharedTexture) return sharedTexture;

  const size = FALLBACK_TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell =
        (Math.floor(x / FALLBACK_CHECKER_CELL) + Math.floor(y / FALLBACK_CHECKER_CELL)) % 2 === 0;
      // The slash is 3px wide so it stays visible two mip levels down.
      const onSlash = Math.abs(x - y) < 3 || Math.abs(x + y - size) < 3;
      const index = (y * size + x) * 4;
      const [r, g, b] = onSlash ? [255, 255, 0] : cell ? [255, 0, 200] : [12, 12, 16];
      data[index] = r!;
      data[index + 1] = g!;
      data[index + 2] = b!;
      data[index + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.name = 'MISSING';
  (texture as unknown as Record<string, unknown>)[MISSING_ASSET_FLAG] = true;
  texture.needsUpdate = true;

  sharedTexture = texture;
  return texture;
}

/** A material that is obviously a stand-in, named for the asset it replaces. */
export function missingMaterial(key: string): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name: `MISSING:${key}`,
    map: missingTexture(),
    roughness: 0.9,
    metalness: 0,
  });
  material.userData[MISSING_ASSET_FLAG] = true;
  material.userData.missingKey = key;
  return material;
}

/**
 * A unit cube stand-in for a model that could not be loaded.
 *
 * A cube rather than an empty `Object3D`: an invisible placeholder makes a
 * missing building indistinguishable from one that was culled, and the bug
 * gets filed against streaming instead of against the asset.
 */
export function missingModel(key: string): THREE.Object3D {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), missingMaterial(key));
  mesh.name = `MISSING:${key}`;
  mesh.userData[MISSING_ASSET_FLAG] = true;
  mesh.userData.missingKey = key;
  const group = new THREE.Group();
  group.name = `MISSING:${key}`;
  group.userData[MISSING_ASSET_FLAG] = true;
  group.userData.missingKey = key;
  group.add(mesh);
  return group;
}

/**
 * A neutral 1x1 environment so a missing HDRI leaves the scene lit rather than
 * black. Deliberately dim grey, not magenta: an environment map tints EVERY
 * surface, and a magenta world is unusable rather than merely obvious.
 */
export function missingEnvironment(key: string): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    new Uint8Array([48, 48, 56, 255]),
    1,
    1,
    THREE.RGBAFormat
  );
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.name = `MISSING:${key}`;
  (texture as unknown as Record<string, unknown>)[MISSING_ASSET_FLAG] = true;
  texture.needsUpdate = true;
  return texture;
}

/** Release the shared pattern. Shutdown/testing only. */
export function disposeFallbacks(): void {
  sharedTexture?.dispose();
  sharedTexture = undefined;
}
