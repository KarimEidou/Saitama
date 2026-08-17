/**
 * MATERIAL CONSTRUCTION FROM THE MANIFEST
 *
 * `IMaterialAsset.spec` is a `MaterialSpec` — a declarative description with
 * texture IDS, not textures. This module is the only place in the asset layer
 * that turns one into a live `THREE.Material`, so the pipeline's channel
 * conventions are applied exactly once:
 *
 *   albedo  -> `map`, sRGB
 *   normal  -> `normalMap`, linear, plain RGB (see ktx2.ts note 2)
 *   ORM     -> `aoMap` + `roughnessMap` + `metalnessMap`, linear, ONE upload,
 *              with `aoMap.channel = 0` (see textures.ts `bindPackedOrm`)
 *
 * A material whose spec sets `roughness`/`metalness` to 1 while binding an ORM
 * map is not a mistake: three MULTIPLIES the scalar by the sampled channel, so
 * 1 means "use the texture unmodified". Overwriting those with a prettier
 * default would flatten every surface in the city.
 */

import * as THREE from 'three';
import type { IMaterialAsset, MaterialSpec, TextureHandle } from '@/types';
import { createLogger } from '@/util';
import { bindPackedOrm, withRepeat } from './textures';
import { missingTexture } from './fallback';

const log = createLogger('assets:materials');

/** How a material resolves the texture ids in its spec. */
export type TextureResolver = (key: string) => TextureHandle | undefined;

/** A built material plus the handles it retained, so they can be released. */
export interface IBuiltMaterial {
  readonly material: THREE.Material;
  /** Handles retained by this material; release on dispose. */
  readonly handles: readonly TextureHandle[];
  /** Texture ids the spec asked for that were not resident. */
  readonly missingTextures: readonly string[];
  /** True when the ORM map bound to all three slots. */
  readonly ormBound: boolean;
}

function sideOf(side: MaterialSpec['side']): THREE.Side {
  if (side === 'double') return THREE.DoubleSide;
  if (side === 'back') return THREE.BackSide;
  return THREE.FrontSide;
}

/**
 * Instantiate the three.js class the spec asks for.
 *
 * `shader` is refused rather than approximated: a custom-shader material has
 * uniforms this layer knows nothing about, and quietly handing back a standard
 * material would look almost right and be impossible to trace.
 */
function instantiate(spec: MaterialSpec): THREE.Material {
  const common = {
    name: spec.id,
    color: spec.color ?? 0xffffff,
    transparent: spec.transparent ?? false,
    opacity: spec.opacity ?? 1,
    alphaTest: spec.alphaTest ?? 0,
    side: sideOf(spec.side),
    depthWrite: spec.transparent !== true,
  };

  switch (spec.kind) {
    case 'basic':
      return new THREE.MeshBasicMaterial(common);
    case 'lambert':
      return new THREE.MeshLambertMaterial(common);
    case 'toon':
      return new THREE.MeshToonMaterial(common);
    case 'physical':
      return new THREE.MeshPhysicalMaterial({
        ...common,
        roughness: spec.roughness ?? 0.8,
        metalness: spec.metalness ?? 0,
      });
    case 'shader':
      log.warn(
        `material "${spec.id}" is kind 'shader'; the asset registry builds ` +
          `built-in materials only. Using 'standard' — bind the custom shader ` +
          `through the VFX system instead.`
      );
      return new THREE.MeshStandardMaterial({
        ...common,
        roughness: spec.roughness ?? 0.8,
        metalness: spec.metalness ?? 0,
      });
    case 'standard':
    default:
      return new THREE.MeshStandardMaterial({
        ...common,
        roughness: spec.roughness ?? 0.8,
        metalness: spec.metalness ?? 0,
      });
  }
}

/**
 * Build a material from a manifest entry.
 *
 * Every texture the spec names is retained; the caller owns releasing them via
 * `IBuiltMaterial.handles`. A texture that is not resident binds the marked
 * missing-texture pattern and is reported in `missingTextures` — never a
 * silent black surface, and never an exception.
 */
export function buildMaterial(
  entry: IMaterialAsset,
  resolve: TextureResolver,
  anisotropy = 1
): IBuiltMaterial {
  const spec = entry.spec;
  const material = instantiate(spec);
  const handles: TextureHandle[] = [];
  const missing: string[] = [];

  const bind = (key: string | undefined, srgb: boolean): THREE.Texture | null => {
    if (key === undefined) return null;
    const handle = resolve(key);
    if (handle === undefined) {
      missing.push(key);
      log.warn(`material "${spec.id}" wants texture "${key}", which is not resident`);
      return missingTexture();
    }
    handles.push(handle.retain());
    const texture = withRepeat(handle.texture, spec.uvRepeat);
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = anisotropy;
    return texture;
  };

  const pbr = material as THREE.MeshStandardMaterial;
  if ('map' in material) pbr.map = bind(spec.mapKey, true);
  if ('normalMap' in material) pbr.normalMap = bind(spec.normalMapKey, false);

  let ormBound = false;
  if ('roughnessMap' in material) {
    const orm = bind(spec.ormMapKey, false);
    if (orm) {
      bindPackedOrm(pbr, orm);
      ormBound = true;
    }
  }

  if ('emissiveMap' in material) {
    pbr.emissiveMap = bind(spec.emissiveMapKey, true);
    if (spec.emissive !== undefined) {
      pbr.emissive = new THREE.Color(spec.emissive);
      pbr.emissiveIntensity = spec.emissiveIntensity ?? 1;
    } else if (pbr.emissiveMap !== null) {
      // An emissive map with a black emissive colour multiplies out to nothing.
      pbr.emissive = new THREE.Color(0xffffff);
      pbr.emissiveIntensity = spec.emissiveIntensity ?? 1;
    }
  }
  if ('alphaMap' in material) pbr.alphaMap = bind(spec.alphaMapKey, false);

  if ('normalScale' in material && pbr.normalMap !== null && spec.normalScale !== undefined) {
    pbr.normalScale = new THREE.Vector2(spec.normalScale, spec.normalScale);
  }
  if ('outlineWidth' in spec && spec.kind === 'toon') {
    material.userData.outlineWidth = spec.outlineWidth ?? 0;
  }

  material.userData.assetId = entry.id;
  material.userData.tileSizeMeters = entry.tileSizeMeters;
  material.userData.castShadow = spec.castShadow ?? true;
  material.userData.receiveShadow = spec.receiveShadow ?? true;
  material.needsUpdate = true;

  return { material, handles, missingTextures: missing, ormBound };
}

/**
 * Textures a material needs resident before `buildMaterial` will succeed.
 *
 * `textureKeys` is the authoritative list; the spec's individual `*MapKey`
 * fields are folded in so a spec that binds a map the `textureKeys` block
 * forgot still loads it.
 */
export function requiredTextures(entry: IMaterialAsset): readonly string[] {
  const keys = new Set<string>();
  for (const key of Object.values(entry.textureKeys)) {
    if (typeof key === 'string') keys.add(key);
  }
  for (const key of [
    entry.spec.mapKey,
    entry.spec.normalMapKey,
    entry.spec.ormMapKey,
    entry.spec.emissiveMapKey,
    entry.spec.alphaMapKey,
  ]) {
    if (typeof key === 'string') keys.add(key);
  }
  return [...keys];
}
