/**
 * CITY MATERIAL RESOLUTION — the one place a manifest id becomes a material.
 *
 * The city generator binds materials by STABLE ID (`mat.wall.brick.red`) and
 * never by path, so somebody has to turn ids into `THREE.Material`s. That
 * somebody is the composition root, because it is the only module allowed to
 * hold both the asset registry and the city generator at once.
 *
 * Three things happen here that cannot happen anywhere else:
 *
 *  1. REGISTRY FIRST. `AssetRegistry.getMaterial` serves the real KTX2 set
 *     when it is resident. `createRegistryResolver` (the city's own helper)
 *     already implements exactly this lookup, so it is reused rather than
 *     reimplemented.
 *
 *  2. A PROCEDURAL FALLBACK, not a grey box. `public/assets/` is a build
 *     artefact; it can be absent, partial, or one tier short. A missing
 *     material must still read as brick or asphalt, or the world stops being
 *     legible for a reason the player cannot see. The fallback is synthesised
 *     from the engine's own noise generators, keyed by id, and is
 *     deterministic — `createRng(id)`, never `Math.random()`.
 *
 *  3. THE DESTRUCTION HOOK, on every material the city uses. A block mesh
 *     carries a per-vertex `aDestroyed` flag and the shader has to honour it,
 *     or a detached chunk keeps rendering after its mass has already become
 *     debris. `installDestructionHook` is the city's own injection, applied to
 *     a CLONE so the registry's shared instances are never mutated: the same
 *     `mat.road.asphalt.worn` may be handed to a system that has no such
 *     attribute, and an `onBeforeCompile` written onto the registry's copy
 *     would follow it there.
 */

import * as THREE from 'three';
import type { IAssetRegistry } from '@/types';
import { createNoiseAlbedo, createNoiseNormal } from '@/engine';
import { createRegistryResolver, installDestructionHook, type MaterialResolver } from '@/world/city';
import { createRng } from '@/util';

/* -------------------------------------------------------------------------- */
/* Fallback look table                                                        */
/* -------------------------------------------------------------------------- */

interface ILook {
  readonly color: number;
  readonly roughness: number;
  readonly metalness: number;
  /** Noise contrast fed to the procedural albedo. */
  readonly grain: number;
  /** Normal-map amplitude. 0 disables the map entirely. */
  readonly bump: number;
  /** UV repeats across one texture tile. Larger = finer grain. */
  readonly repeat: number;
}

const DEFAULT_LOOK: ILook = {
  color: 0xb8b4ad,
  roughness: 0.9,
  metalness: 0,
  grain: 0.16,
  bump: 0.6,
  repeat: 4,
};

/**
 * Look per material FAMILY, not per id.
 *
 * The manifest has 41 materials in eight families and the fallback only has to
 * keep the city legible, so it keys on the id PREFIX. A per-id table would be
 * 41 lines of near-duplicates that drift the moment the manifest grows.
 */
const FAMILY_LOOKS: readonly (readonly [string, Partial<ILook>])[] = [
  ['mat.road.markings', { color: 0xe8e6df, roughness: 0.7, grain: 0.04, bump: 0 }],
  ['mat.road.asphalt', { color: 0x4c4c4f, roughness: 0.96, grain: 0.24, bump: 0.35, repeat: 6 }],
  ['mat.ground.cobblestone', { color: 0x8e8a84, roughness: 0.95, grain: 0.3, bump: 1.1, repeat: 8 }],
  ['mat.ground.sidewalk', { color: 0xa9a69f, roughness: 0.91, grain: 0.14, bump: 0.5, repeat: 5 }],
  ['mat.ground.plaza', { color: 0xb4b1a9, roughness: 0.85, grain: 0.12, bump: 0.5, repeat: 5 }],
  ['mat.ground.gravel', { color: 0x9c9489, roughness: 1, grain: 0.4, bump: 1.2, repeat: 10 }],
  ['mat.ground.dirt', { color: 0x8d7d67, roughness: 1, grain: 0.28, bump: 0.7, repeat: 6 }],
  ['mat.ground.grass', { color: 0x4d6b34, roughness: 1, grain: 0.34, bump: 0.8, repeat: 8 }],
  ['mat.debris', { color: 0x8f877c, roughness: 1, grain: 0.42, bump: 1.1, repeat: 8 }],
  ['mat.wall.brick', { color: 0x9a5c47, roughness: 0.93, grain: 0.2, bump: 1, repeat: 6 }],
  ['mat.wall.plaster', { color: 0xcdc3ae, roughness: 0.88, grain: 0.11, bump: 0.4, repeat: 4 }],
  ['mat.wall.concrete', { color: 0xacaaa2, roughness: 0.9, grain: 0.18, bump: 0.5, repeat: 4 }],
  ['mat.wall.planks', { color: 0x8a7255, roughness: 0.92, grain: 0.24, bump: 0.9, repeat: 6 }],
  ['mat.wood', { color: 0x8a7255, roughness: 0.92, grain: 0.24, bump: 0.9, repeat: 6 }],
  ['mat.metal.rust', { color: 0x86603f, roughness: 0.88, metalness: 0.32, grain: 0.32, bump: 0.8 }],
  ['mat.metal.grate', { color: 0x6b5c4d, roughness: 0.85, metalness: 0.4, grain: 0.3, bump: 1 }],
  ['mat.metal', { color: 0x969b9d, roughness: 0.62, metalness: 0.55, grain: 0.14, bump: 0.5 }],
  ['mat.roof.tiles.ceramic', { color: 0x8f5f45, roughness: 0.85, grain: 0.18, bump: 0.9, repeat: 8 }],
  ['mat.roof.tiles', { color: 0x6f7276, roughness: 0.88, grain: 0.16, bump: 0.9, repeat: 8 }],
  ['mat.roof', { color: 0x4d4b48, roughness: 0.96, grain: 0.2, bump: 0.5, repeat: 6 }],
  // Glass is near-white on purpose: every window and shop sign gets its colour
  // from the per-vertex tint, so a tinted base map would double-multiply it.
  ['mat.glass', { color: 0xeef2f4, roughness: 0.14, metalness: 0.06, grain: 0.03, bump: 0 }],
];

/** Edge of a synthesised stand-in map. See `synthesise` for why it is not 256. */
const FALLBACK_TEXTURE_SIZE = 128;

function lookFor(id: string): ILook {
  for (const [prefix, patch] of FAMILY_LOOKS) {
    if (id.startsWith(prefix)) return { ...DEFAULT_LOOK, ...patch };
  }
  return DEFAULT_LOOK;
}

/* -------------------------------------------------------------------------- */
/* Library                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolves city material ids, hooks them for destruction, and owns the ones it
 * synthesised.
 */
export class CityMaterialLibrary {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly owned: (THREE.Material | THREE.Texture)[] = [];
  /** Shared normal maps, keyed by bump bucket. See `normalFor`. */
  private readonly normals = new Map<number, THREE.Texture>();
  private readonly anisotropy: number;
  private registry: IAssetRegistry | undefined;
  private registryResolver: MaterialResolver | undefined;

  /** Ids currently served by a synthesised stand-in rather than the real map. */
  readonly synthesised = new Set<string>();
  /** Ids upgraded in place once the real textures finished loading. */
  readonly upgraded = new Set<string>();

  constructor(anisotropy = 4) {
    this.anisotropy = Math.max(1, Math.floor(anisotropy));
  }

  /**
   * Point the library at a live registry.
   *
   * Called after `preloadCore` rather than at construction, so the boot screen
   * can put a world on screen before every texture has transcoded.
   */
  useRegistry(registry: IAssetRegistry): void {
    this.registry = registry;
    this.registryResolver = createRegistryResolver(registry, (key) => this.synthesise(key));
  }

  /** The resolver handed to `buildChunkNodes` / `buildBlockMesh`. */
  get resolve(): MaterialResolver {
    return (key: string): THREE.Material => {
      const cached = this.cache.get(key);
      if (cached) return cached;
      const base = this.registryResolver ? this.registryResolver(key) : this.synthesise(key);
      // Clone before hooking: `base` may be the registry's shared instance.
      const material = this.prepare(base, key);
      this.cache.set(key, material);
      return material;
    };
  }

  get size(): number {
    return this.cache.size;
  }

  /** Every material handed out so far. Fed to the shader warmup. */
  all(): THREE.Material[] {
    return [...this.cache.values()];
  }

  /**
   * ══════════════════════════════════════════════════════════════════════
   *  UPGRADE IN PLACE
   * ══════════════════════════════════════════════════════════════════════
   * The 41 city materials are 51 MB of KTX2 at the mobile tier and only 7 of
   * them are flagged `preload`. Waiting for the other 34 would put a minute on
   * the boot screen for a world the player is already standing in.
   *
   * So the city is built with whatever the registry can serve NOW plus a
   * synthesised stand-in for the rest, and the real maps are swapped onto the
   * SAME material objects when they land. Nothing in the scene graph is
   * touched: a `THREE.Material` is referenced by every block mesh that binds
   * it, so assigning `map`/`normalMap` and setting `needsUpdate` upgrades the
   * whole district at once, mid-frame, with no rebuild and no reallocation.
   *
   * Returns the number of materials actually upgraded.
   */
  adoptAll(): number {
    return this.adopt([...this.cache.keys()]);
  }

  adopt(keys: readonly string[]): number {
    const registry = this.registry;
    if (registry === undefined) return 0;
    let count = 0;
    for (const key of keys) {
      const live = this.cache.get(key);
      if (live === undefined || this.upgraded.has(key)) continue;
      const real = registry.getMaterial(key);
      if (real === undefined || !(real as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        continue;
      }
      const source = real as THREE.MeshStandardMaterial;
      live.map = source.map;
      live.normalMap = source.normalMap;
      live.roughnessMap = source.roughnessMap;
      live.metalnessMap = source.metalnessMap;
      live.aoMap = source.aoMap;
      live.roughness = source.roughness;
      live.metalness = source.metalness;
      live.normalScale.copy(source.normalScale);
      live.needsUpdate = true;
      this.synthesised.delete(key);
      this.upgraded.add(key);
      count++;
    }
    return count;
  }

  /**
   * Clone, enable vertex colours, and install the destruction hook.
   *
   * Vertex colours are not optional: the city writes per-vertex tint for every
   * facade, window and shop sign, and a material without `vertexColors` renders
   * the whole district in the base map's single colour.
   */
  private prepare(base: THREE.Material, key: string): THREE.MeshStandardMaterial {
    const material = base.clone() as THREE.MeshStandardMaterial;
    material.name = key;
    material.vertexColors = true;
    this.owned.push(material);
    installDestructionHook(material);
    return material;
  }

  /**
   * Build a stand-in for one id. Deterministic, and marked in `synthesised`.
   *
   * `FALLBACK_TEXTURE_SIZE` is 128 and not 256 because this runs on the BOOT
   * PATH: fbm over a 256² albedo plus a 256² height field for the normal is
   * 130 k noise evaluations per material, and a downtown chunk asks for ten of
   * them before the first frame. At 128 the same work is a quarter of the cost
   * and, tiled at 4-10 repeats across a facade, indistinguishable — and it is
   * replaced by the real 2 K map a few seconds later anyway.
   */
  private synthesise(key: string): THREE.Material {
    const look = lookFor(key);
    this.synthesised.add(key);
    const seed = createRng(`material:${key}`).int(1, 0xffff);

    // The accent is the base darkened by the grain amount, so `grain` reads as
    // contrast rather than as an unrelated second colour to keep in sync.
    const accent = new THREE.Color(look.color).multiplyScalar(1 - Math.min(0.85, look.grain * 2));

    const map = createNoiseAlbedo({
      size: FALLBACK_TEXTURE_SIZE,
      seed,
      color: look.color,
      accent: accent.getHex(),
    });
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(look.repeat, look.repeat);
    map.anisotropy = this.anisotropy;
    this.owned.push(map);

    const material = new THREE.MeshStandardMaterial({
      map,
      color: 0xffffff,
      roughness: look.roughness,
      metalness: look.metalness,
      vertexColors: true,
    });

    const normalMap = this.normalFor(look.bump);
    if (normalMap !== undefined) {
      material.normalMap = normalMap;
      material.normalScale = new THREE.Vector2(0.85, 0.85);
    }
    return material;
  }

  /**
   * One shared normal map per bump bucket.
   *
   * A per-id normal map is the single most expensive thing on this path and the
   * least visible: the relief is tiling noise either way, and asphalt and
   * concrete differ in their ALBEDO, which is still per id. Bucketing to one
   * decimal collapses twenty-one family looks onto about five textures.
   */
  private normalFor(bump: number): THREE.Texture | undefined {
    if (bump <= 0) return undefined;
    const bucket = Math.round(bump * 10) / 10;
    const cached = this.normals.get(bucket);
    if (cached) return cached;
    const texture = createNoiseNormal(FALLBACK_TEXTURE_SIZE, bucket * 2.5, 0x51 + bucket * 977);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(6, 6);
    texture.anisotropy = this.anisotropy;
    this.normals.set(bucket, texture);
    this.owned.push(texture);
    return texture;
  }

  dispose(): void {
    for (const item of this.owned) item.dispose();
    this.owned.length = 0;
    this.normals.clear();
    this.cache.clear();
  }
}
