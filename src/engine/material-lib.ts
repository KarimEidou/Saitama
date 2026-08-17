/**
 * MATERIAL LIBRARY — one shared material per id, never one per object.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A `new MeshStandardMaterial()` per mesh is the default way to build a Three.js
 * scene and it is catastrophic here. Each distinct material is a distinct
 * shader program; each distinct program is a compile stall on first use; and
 * `KHR_parallel_shader_compile` is NOT available in this project's target
 * environment, so every one of those stalls happens synchronously on the main
 * thread. Ten thousand instanced props sharing one material is the difference
 * between a 16ms frame and a 400ms freeze mid-punch.
 *
 * Materials are therefore cached by `MaterialSpec.id`. Two specs sharing an id
 * MUST describe the same material — the contract in render.ts says so, and this
 * class enforces it loudly.
 *
 * ── THE PROGRAM BUDGET ─────────────────────────────────────────────────────
 * The whole game targets ≤24 distinct shader programs. Program identity is NOT
 * material identity: three keys programs on the feature set (which maps are
 * bound, which defines are set, light counts, tone mapping, render target).
 * Fifty materials that all bind {map, normalMap, ormMap} and no injections
 * share ONE program. Two materials that differ only in whether `normalMap` is
 * bound cost TWO.
 *
 * `programSignatures` tracks the distinct signatures this library has produced
 * so the budget is observable rather than a hope. Exceeding `programBudget`
 * warns immediately, at the moment the offending material is created, which is
 * the only time the stack trace is useful.
 *
 * ── ASSET COUPLING ─────────────────────────────────────────────────────────
 * Textures resolve through `IAssetRegistry` by key. This library never reads a
 * file path and never imports the asset system's implementation. When the
 * registry has no entry, a magenta checker is bound so broken wiring is visible
 * instead of silently rendering flat white.
 */

import * as THREE from 'three';
import type { IAssetRegistry, IDisposable, MaterialSpec, TextureHandle } from '@/types';
import { createLogger } from '@/util';
import {
  featureDefines,
  featureKey,
  fragmentDeclarations,
  hasAnyFeature,
  INSTANCE_TINT_ATTRIBUTE,
  INSTANCE_WEAR_ATTRIBUTE,
  NO_FEATURES,
  surfaceFragment,
  TRIPLANAR_MAP_FRAGMENT,
  TRIPLANAR_METALNESS_FRAGMENT,
  TRIPLANAR_NORMAL_FRAGMENT,
  TRIPLANAR_ROUGHNESS_FRAGMENT,
  vertexBody,
  vertexDeclarations,
  type IMaterialFeatures,
} from './shader-chunks';
import { addShaderHook } from './shader-hooks';
import { createMissingTexture } from './procedural-textures';

const log = createLogger('engine.materials');

/** Extra, renderer-private options layered on top of the `MaterialSpec`. */
export interface IMaterialRequest {
  readonly spec: MaterialSpec;
  /** Injection opt-ins. Omitted flags default to off. */
  readonly features?: Partial<IMaterialFeatures>;
  /** Triplanar tiles per world metre. 0.25 = one tile every 4m. */
  readonly triplanarScale?: number;
  /** Triplanar blend exponent. Higher = harder transition between axes. */
  readonly triplanarSharpness?: number;
  /**
   * Direct texture overrides, bypassing the registry. Used by the harness and
   * by procedurally generated content; production materials use texture keys.
   */
  readonly textures?: {
    readonly map?: THREE.Texture;
    readonly normalMap?: THREE.Texture;
    readonly ormMap?: THREE.Texture;
    readonly emissiveMap?: THREE.Texture;
    readonly alphaMap?: THREE.Texture;
  };
  /** Enable per-vertex colours (debris chunks tint themselves this way). */
  readonly vertexColors?: boolean;
}

export interface IMaterialLibOptions {
  /** Texture source. Optional so the library boots before assets exist. */
  readonly registry?: IAssetRegistry;
  /** Anisotropic filtering, already clamped to the hardware maximum. */
  readonly anisotropy?: number;
  /** Warn above this many distinct program signatures. */
  readonly programBudget?: number;
  /** Initial IBL intensity applied to every PBR material. */
  readonly envMapIntensity?: number;
}

/** Per-material state the library keeps alongside the Three.js object. */
interface MaterialRecord {
  readonly material: THREE.Material;
  readonly spec: MaterialSpec;
  readonly features: IMaterialFeatures;
  readonly signature: string;
  /** Cloned textures owned by this record; disposed with it. */
  readonly ownedTextures: THREE.Texture[];
  /** Retained registry handles, released on dispose. */
  readonly handles: TextureHandle[];
}

/** Uniform objects shared BY REFERENCE across every injected material. */
interface GlobalUniforms {
  uEngineDamageMask: { value: THREE.Texture | null };
  uEngineDamageRect: { value: THREE.Vector4 };
  uEngineDustColor: { value: THREE.Color };
  uEngineDustAmount: { value: number };
  uEngineWearRoughness: { value: number };
}

const DEFAULT_PROGRAM_BUDGET = 24;

export class MaterialLib implements IDisposable {
  private readonly records = new Map<string, MaterialRecord>();
  private readonly signatures = new Map<string, number>();
  private readonly observers = new Set<(material: THREE.Material, id: string) => void>();

  private registry: IAssetRegistry | undefined;
  private anisotropyValue: number;
  private envIntensity: number;
  private readonly programBudget: number;
  private missingTexture: THREE.DataTexture | undefined;
  private disposed = false;
  private budgetWarned = false;

  /**
   * Shared uniform objects. Injected materials receive these EXACT objects, so
   * writing `globals.uEngineDustAmount.value = 0.7` updates every material in
   * the scene with no traversal and no per-material bookkeeping.
   */
  private readonly globals: GlobalUniforms = {
    uEngineDamageMask: { value: null },
    uEngineDamageRect: { value: new THREE.Vector4(0, 0, 1 / 512, 1 / 512) },
    uEngineDustColor: { value: new THREE.Color(0x9a9182) },
    uEngineDustAmount: { value: 0 },
    uEngineWearRoughness: { value: 0.35 },
  };

  constructor(options: IMaterialLibOptions = {}) {
    this.registry = options.registry;
    this.anisotropyValue = options.anisotropy ?? 4;
    this.envIntensity = options.envMapIntensity ?? 1;
    this.programBudget = options.programBudget ?? DEFAULT_PROGRAM_BUDGET;
  }

  /* ---------------------------------------------------------------------- */
  /* Lookup                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Live material for an id, or undefined when it has not been acquired. */
  get(id: string): THREE.Material | undefined {
    return this.records.get(id)?.material;
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  /** Number of distinct materials held. */
  get size(): number {
    return this.records.size;
  }

  /** Distinct program signatures produced so far, with a use count each. */
  get programSignatures(): ReadonlyMap<string, number> {
    return this.signatures;
  }

  /** How many distinct shader programs this library's materials imply. */
  get programCount(): number {
    return this.signatures.size;
  }

  forEach(callback: (material: THREE.Material, id: string) => void): void {
    for (const [id, record] of this.records) callback(record.material, id);
  }

  /**
   * Observe material creation. The shadow system uses this to attach CSM to
   * every material as it appears, without either system importing the other.
   * Fires immediately for materials that already exist.
   */
  onMaterialCreated(callback: (material: THREE.Material, id: string) => void): () => void {
    this.observers.add(callback);
    for (const [id, record] of this.records) callback(record.material, id);
    return () => this.observers.delete(callback);
  }

  /* ---------------------------------------------------------------------- */
  /* Creation                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Fetch or build the shared material for `request.spec.id`.
   *
   * NEVER mutate the returned material: it is shared by every mesh using that
   * id. Per-object variation goes through instanced attributes (see
   * `applyInstanceVariation`) or the global damage mask, both of which exist
   * precisely so nobody needs a private material.
   */
  acquire(request: IMaterialRequest): THREE.Material {
    const { spec } = request;
    const existing = this.records.get(spec.id);
    if (existing) {
      if (existing.spec !== spec && !specsMatch(existing.spec, spec)) {
        log.warn(
          `material id "${spec.id}" was acquired with two different specs. ` +
            `Ids are the cache key — the first spec wins and the second is ignored.`
        );
      }
      return existing.material;
    }

    const features = this.resolveFeatures(request);
    const ownedTextures: THREE.Texture[] = [];
    const handles: TextureHandle[] = [];
    const material = this.build(request, features, ownedTextures, handles);

    const signature = this.signatureFor(request, features, material);
    this.signatures.set(signature, (this.signatures.get(signature) ?? 0) + 1);

    const record: MaterialRecord = { material, spec, features, signature, ownedTextures, handles };
    this.records.set(spec.id, record);

    if (this.signatures.size > this.programBudget && !this.budgetWarned) {
      this.budgetWarned = true;
      log.warn(
        `program budget exceeded: ${this.signatures.size} distinct material ` +
          `signatures (budget ${this.programBudget}). Every one is a synchronous ` +
          `compile stall on Android. Signatures:\n  ` +
          [...this.signatures.keys()].join('\n  ')
      );
    }

    for (const observer of this.observers) observer(material, spec.id);
    return material;
  }

  private resolveFeatures(request: IMaterialRequest): IMaterialFeatures {
    const requested: IMaterialFeatures = { ...NO_FEATURES, ...request.features };
    const kind = request.spec.kind;
    if (!hasAnyFeature(requested)) return requested;

    if (kind !== 'standard' && kind !== 'physical') {
      // The splice points are meshphysical chunk names. Injecting them into
      // toon/lambert/basic would silently no-op (the replace finds nothing),
      // which is worse than refusing.
      log.warn(
        `material "${request.spec.id}" requested shader injections but is kind ` +
          `"${kind}"; injections apply to 'standard'/'physical' only. Ignoring.`
      );
      return NO_FEATURES;
    }
    return requested;
  }

  private build(
    request: IMaterialRequest,
    features: IMaterialFeatures,
    ownedTextures: THREE.Texture[],
    handles: TextureHandle[]
  ): THREE.Material {
    const { spec } = request;
    const side =
      spec.side === 'double' ? THREE.DoubleSide : spec.side === 'back' ? THREE.BackSide : THREE.FrontSide;

    const common = {
      name: spec.id,
      color: spec.color ?? 0xffffff,
      transparent: spec.transparent ?? false,
      opacity: spec.opacity ?? 1,
      alphaTest: spec.alphaTest ?? 0,
      side,
      // Alpha-tested foliage renders correctly from both sides but must not
      // write depth-sorted transparency; alphaTest keeps it in the opaque pass.
      depthWrite: spec.transparent === true ? false : true,
    };

    let material: THREE.Material;
    switch (spec.kind) {
      case 'basic':
        material = new THREE.MeshBasicMaterial(common);
        break;
      case 'lambert':
        material = new THREE.MeshLambertMaterial(common);
        break;
      case 'toon':
        material = new THREE.MeshToonMaterial(common);
        break;
      case 'physical':
        material = new THREE.MeshPhysicalMaterial({
          ...common,
          roughness: spec.roughness ?? 0.8,
          metalness: spec.metalness ?? 0,
        });
        break;
      case 'shader':
        log.warn(
          `material "${spec.id}" is kind 'shader'; MaterialLib only manages ` +
            `built-in materials. Falling back to 'standard'.`
        );
        material = new THREE.MeshStandardMaterial({ ...common, roughness: 0.8, metalness: 0 });
        break;
      case 'standard':
      default:
        material = new THREE.MeshStandardMaterial({
          ...common,
          roughness: spec.roughness ?? 0.8,
          metalness: spec.metalness ?? 0,
        });
        break;
    }

    if (request.vertexColors === true) material.vertexColors = true;

    const pbr = material as THREE.MeshStandardMaterial;
    if (spec.emissive !== undefined && 'emissive' in material) {
      pbr.emissive = new THREE.Color(spec.emissive);
      pbr.emissiveIntensity = spec.emissiveIntensity ?? 1;
    }
    if ('envMapIntensity' in material) pbr.envMapIntensity = this.envIntensity;

    this.bindTextures(request, pbr, ownedTextures, handles);

    if (hasAnyFeature(features)) {
      this.installInjections(pbr, request, features);
    }

    return material;
  }

  /* ---------------------------------------------------------------------- */
  /* Textures                                                               */
  /* ---------------------------------------------------------------------- */

  private bindTextures(
    request: IMaterialRequest,
    material: THREE.MeshStandardMaterial,
    ownedTextures: THREE.Texture[],
    handles: TextureHandle[]
  ): void {
    const { spec } = request;
    const repeat = spec.uvRepeat;

    const prepare = (
      texture: THREE.Texture | undefined,
      colorSpace: THREE.ColorSpace
    ): THREE.Texture | null => {
      if (!texture) return null;
      let out = texture;
      // A shared texture must never have its repeat mutated in place — every
      // other material bound to it would silently change. Cloning shares the
      // same `source`, so three still uploads exactly one GPU texture.
      if (repeat && (repeat[0] !== 1 || repeat[1] !== 1)) {
        out = texture.clone();
        out.repeat.set(repeat[0], repeat[1]);
        out.wrapS = THREE.RepeatWrapping;
        out.wrapT = THREE.RepeatWrapping;
        out.needsUpdate = true;
        ownedTextures.push(out);
      }
      out.colorSpace = colorSpace;
      out.anisotropy = this.anisotropyValue;
      return out;
    };

    const resolve = (key: string | undefined, direct: THREE.Texture | undefined) => {
      if (direct) return direct;
      if (!key) return undefined;
      const handle = this.registry?.getTexture(key);
      if (handle) {
        handles.push(handle.retain());
        return handle.texture;
      }
      log.warn(`texture "${key}" is not resident for material "${spec.id}"; binding placeholder`);
      return this.getMissingTexture();
    };

    const direct = request.textures;
    material.map = prepare(resolve(spec.mapKey, direct?.map), THREE.SRGBColorSpace);
    material.normalMap = prepare(resolve(spec.normalMapKey, direct?.normalMap), THREE.NoColorSpace);

    // Packed ORM: one texture, three slots. Occlusion in R, roughness in G,
    // metalness in B — three samples exactly those channels for each slot, so
    // binding the same object three times costs one upload.
    const orm = prepare(resolve(spec.ormMapKey, direct?.ormMap), THREE.NoColorSpace);
    if (orm) {
      material.aoMap = orm;
      material.roughnessMap = orm;
      material.metalnessMap = orm;
    }

    material.emissiveMap = prepare(
      resolve(spec.emissiveMapKey, direct?.emissiveMap),
      THREE.SRGBColorSpace
    );
    material.alphaMap = prepare(resolve(spec.alphaMapKey, direct?.alphaMap), THREE.NoColorSpace);

    if (material.normalMap && spec.normalScale !== undefined) {
      material.normalScale = new THREE.Vector2(spec.normalScale, spec.normalScale);
    }
  }

  private getMissingTexture(): THREE.DataTexture {
    this.missingTexture ??= createMissingTexture();
    return this.missingTexture;
  }

  /* ---------------------------------------------------------------------- */
  /* Injection                                                              */
  /* ---------------------------------------------------------------------- */

  private installInjections(
    material: THREE.MeshStandardMaterial,
    request: IMaterialRequest,
    features: IMaterialFeatures
  ): void {
    let effective = features;

    // Triplanar REPLACES `#include <map_fragment>`, which only declares `map`
    // when a map is bound. Without one the injected GLSL references an
    // undeclared sampler and the material fails to compile — refuse instead.
    if (effective.triplanar && !material.map) {
      log.warn(
        `material "${request.spec.id}" requested triplanar mapping without an ` +
          `albedo map; triplanar needs a texture to project. Disabling it.`
      );
      effective = { ...effective, triplanar: false };
      if (!hasAnyFeature(effective)) return;
    }

    material.defines = { ...(material.defines ?? {}), ...featureDefines(effective) };

    const local = {
      scale: { value: request.triplanarScale ?? 0.25 },
      sharpness: { value: request.triplanarSharpness ?? 4 },
    };
    const hasNormalMap = material.normalMap !== null;
    const hasOrm = material.roughnessMap !== null;
    const key = `mat${featureKey(effective)}${hasNormalMap ? 'n' : ''}${hasOrm ? 'o' : ''}`;

    addShaderHook(material, key, (shader) => {
      if (effective.triplanar) {
        shader.uniforms.uEngineTriplanarScale = local.scale;
        shader.uniforms.uEngineTriplanarSharpness = local.sharpness;
      }
      if (effective.instanceVariation) {
        shader.uniforms.uEngineWearRoughness = this.globals.uEngineWearRoughness;
      }
      if (effective.damageMask) {
        shader.uniforms.uEngineDamageMask = this.globals.uEngineDamageMask;
        shader.uniforms.uEngineDamageRect = this.globals.uEngineDamageRect;
        shader.uniforms.uEngineDustColor = this.globals.uEngineDustColor;
        shader.uniforms.uEngineDustAmount = this.globals.uEngineDustAmount;
      }

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${vertexDeclarations(effective)}`)
        .replace('#include <fog_vertex>', `${vertexBody(effective)}\n\t#include <fog_vertex>`);

      let fragment = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>\n${fragmentDeclarations(effective)}`
      );

      if (effective.triplanar) {
        fragment = fragment.replace('#include <map_fragment>', TRIPLANAR_MAP_FRAGMENT);
        if (hasOrm) {
          fragment = fragment
            .replace('#include <roughnessmap_fragment>', TRIPLANAR_ROUGHNESS_FRAGMENT)
            .replace('#include <metalnessmap_fragment>', TRIPLANAR_METALNESS_FRAGMENT);
        }
        if (hasNormalMap) {
          fragment = fragment.replace(
            '#include <normal_fragment_maps>',
            TRIPLANAR_NORMAL_FRAGMENT
          );
        }
      }

      const surface = surfaceFragment(effective);
      if (surface.length > 0) {
        // The metalness splice may already have been rewritten above, so anchor
        // on whatever is there now rather than on the original include.
        const anchor = effective.triplanar && hasOrm
          ? TRIPLANAR_METALNESS_FRAGMENT
          : '#include <metalnessmap_fragment>';
        fragment = fragment.replace(anchor, `${anchor}\n${surface}`);
      }

      shader.fragmentShader = fragment;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Global state                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Publish the world-space damage/dust mask every injected material samples.
   *
   * One top-down R-channel texture covering a square region of the world. The
   * destruction system paints into it; the renderer never inspects its content.
   * A single texture bound once beats per-material dust parameters by a mile:
   * no traversal, no extra draw calls, no per-object state.
   *
   * @param texture Mask texture, R = 0..1 dust amount. Null restores neutral.
   * @param centerX World X of the mask centre.
   * @param centerZ World Z of the mask centre.
   * @param sizeX   World-space width the mask covers, in metres.
   * @param sizeZ   World-space depth the mask covers, in metres.
   */
  setDamageMask(
    texture: THREE.Texture | null,
    centerX = 0,
    centerZ = 0,
    sizeX = 512,
    sizeZ = 512
  ): void {
    this.globals.uEngineDamageMask.value = texture;
    this.globals.uEngineDamageRect.value.set(
      centerX,
      centerZ,
      1 / Math.max(1e-3, sizeX),
      1 / Math.max(1e-3, sizeZ)
    );
  }

  /** Global dust floor applied everywhere, on top of the mask. 0..1. */
  setDustAmount(amount: number): void {
    this.globals.uEngineDustAmount.value = Math.min(1, Math.max(0, amount));
  }

  /** Colour dust tends towards. Concrete grey by default. */
  setDustColor(color: THREE.ColorRepresentation): void {
    this.globals.uEngineDustColor.value.set(color);
  }

  /** How much per-instance wear pushes roughness up. */
  setWearRoughness(amount: number): void {
    this.globals.uEngineWearRoughness.value = amount;
  }

  /** Current global dust floor. */
  get dustAmount(): number {
    return this.globals.uEngineDustAmount.value;
  }

  /** Re-point IBL intensity on every PBR material. Called by the IBL system. */
  setEnvMapIntensity(intensity: number): void {
    this.envIntensity = intensity;
    for (const record of this.records.values()) {
      const material = record.material as THREE.MeshStandardMaterial;
      if ('envMapIntensity' in material) material.envMapIntensity = intensity;
    }
  }

  /** Re-apply anisotropy after a quality-tier change. */
  setAnisotropy(anisotropy: number): void {
    if (anisotropy === this.anisotropyValue) return;
    this.anisotropyValue = anisotropy;
    const seen = new Set<THREE.Texture>();
    for (const record of this.records.values()) {
      const material = record.material as THREE.MeshStandardMaterial;
      for (const texture of [
        material.map,
        material.normalMap,
        material.roughnessMap,
        material.emissiveMap,
        material.alphaMap,
      ]) {
        if (texture && !seen.has(texture)) {
          seen.add(texture);
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
        }
      }
    }
  }

  /** Late-bind the asset registry once the asset system has booted. */
  setRegistry(registry: IAssetRegistry | undefined): void {
    this.registry = registry;
  }

  /* ---------------------------------------------------------------------- */
  /* Signatures and teardown                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * The program-identity fingerprint of a material.
   *
   * Mirrors the inputs three actually keys its program cache on. It is a
   * conservative approximation — light counts and render target also matter and
   * are not knowable here — but it captures every axis this library controls,
   * which is what makes the budget actionable.
   */
  private signatureFor(
    request: IMaterialRequest,
    features: IMaterialFeatures,
    material: THREE.Material
  ): string {
    const pbr = material as THREE.MeshStandardMaterial;
    const maps = [
      pbr.map ? 'm' : '',
      pbr.normalMap ? 'n' : '',
      pbr.roughnessMap ? 'r' : '',
      pbr.metalnessMap ? 'l' : '',
      pbr.aoMap ? 'a' : '',
      pbr.emissiveMap ? 'e' : '',
      pbr.alphaMap ? 'x' : '',
    ].join('');
    return [
      request.spec.kind,
      featureKey(features),
      maps || '-',
      material.transparent ? 'T' : 'O',
      material.alphaTest > 0 ? 'C' : '-',
      material.side === THREE.DoubleSide ? 'D' : material.side === THREE.BackSide ? 'B' : 'F',
      material.vertexColors ? 'V' : '-',
    ].join('/');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const record of this.records.values()) {
      for (const texture of record.ownedTextures) texture.dispose();
      for (const handle of record.handles) handle.release();
      record.material.dispose();
    }
    this.records.clear();
    this.signatures.clear();
    this.observers.clear();
    this.missingTexture?.dispose();
    this.missingTexture = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Instance variation helpers                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Attach the per-instance tint and wear attributes an `instanceVariation`
 * material expects.
 *
 * A material with the injection enabled reads `instanceTint` / `instanceWear`
 * unconditionally. On a mesh that lacks them WebGL supplies the default vertex
 * attribute (0,0,0,1) — the tint multiplies to black and the object vanishes.
 * Always call this on every InstancedMesh using such a material.
 *
 * @param mesh    Target instanced mesh.
 * @param random  Source of randomness, so world generation stays deterministic.
 * @param options Ranges for the generated variation.
 */
export function applyInstanceVariation(
  mesh: THREE.InstancedMesh,
  random: () => number,
  options: {
    /** Multiplicative brightness range, e.g. [0.82, 1.08]. */
    readonly tintRange?: readonly [number, number];
    /** Hue jitter in 0..1 turns. Small values keep the palette coherent. */
    readonly hueJitter?: number;
    /** Wear range in 0..1. */
    readonly wearRange?: readonly [number, number];
    /** Base colour instances vary around. */
    readonly baseColor?: THREE.ColorRepresentation;
  } = {}
): void {
  const count = mesh.count;
  const tint = new Float32Array(count * 3);
  const wear = new Float32Array(count);
  const [tintLo, tintHi] = options.tintRange ?? [0.82, 1.1];
  const [wearLo, wearHi] = options.wearRange ?? [0, 0.85];
  const hueJitter = options.hueJitter ?? 0.02;
  const color = new THREE.Color();

  for (let i = 0; i < count; i++) {
    color.set(options.baseColor ?? 0xffffff);
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    color.setHSL(
      (hsl.h + (random() - 0.5) * 2 * hueJitter + 1) % 1,
      hsl.s,
      Math.min(1, hsl.l * (tintLo + random() * (tintHi - tintLo)))
    );
    tint[i * 3] = color.r;
    tint[i * 3 + 1] = color.g;
    tint[i * 3 + 2] = color.b;
    wear[i] = wearLo + random() * (wearHi - wearLo);
  }

  mesh.geometry.setAttribute(
    INSTANCE_TINT_ATTRIBUTE,
    new THREE.InstancedBufferAttribute(tint, 3)
  );
  mesh.geometry.setAttribute(
    INSTANCE_WEAR_ATTRIBUTE,
    new THREE.InstancedBufferAttribute(wear, 1)
  );
}

/** Structural equality of the fields that affect the built material. */
function specsMatch(a: MaterialSpec, b: MaterialSpec): boolean {
  return (
    a.kind === b.kind &&
    a.color === b.color &&
    a.roughness === b.roughness &&
    a.metalness === b.metalness &&
    a.emissive === b.emissive &&
    a.opacity === b.opacity &&
    a.transparent === b.transparent &&
    a.alphaTest === b.alphaTest &&
    a.side === b.side &&
    a.mapKey === b.mapKey &&
    a.normalMapKey === b.normalMapKey &&
    a.ormMapKey === b.ormMapKey &&
    a.emissiveMapKey === b.emissiveMapKey &&
    a.alphaMapKey === b.alphaMapKey
  );
}
