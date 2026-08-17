/**
 * REAL ASSET LOADING FOR THE HARNESS
 *
 * The city binds every surface and every prop by manifest id and never by
 * path. This module is the other half of that contract: it reads the processed
 * runtime index the asset pipeline emits into `public/assets/`, and turns
 * those ids into real KTX2 materials and real Draco/meshopt GLB models — the
 * curated Poly Haven CC0 set, not a stand-in.
 *
 * ── WHY IT IS OPTIONAL ─────────────────────────────────────────────────────
 * `public/assets/` is gitignored and built by a separate workstream, so a
 * fresh clone does not have it. Everything here is therefore best-effort: if
 * the index is missing, or a single texture fails to transcode, the caller
 * falls back to the synthesised library in `city.materials.ts` and the harness
 * readout says which was used. A screenshot that silently used stand-ins while
 * claiming real materials would be worse than no screenshot.
 *
 * ── THE ONE PLACE THE THREE-SLOT BUDGET SHOWS THROUGH ──────────────────────
 * `mat.glass.window`'s manifest spec is transparent (opacity 0.35). The city
 * puts SHOP SIGNAGE in the same slot as glazing — that is what keeps a block
 * at three draw calls — so the harness builds it OPAQUE. A 35%-opaque sign
 * board is a ghost. The reflective, low-roughness response is kept, which is
 * what makes it read as glass; only the alpha is dropped.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** Shape of the entries the pipeline writes into `assets.runtime.json`. */
interface IRuntimeOutput {
  readonly tier: string;
  readonly file: string;
  readonly width?: number;
  readonly height?: number;
}

interface IRuntimeEntry {
  readonly id: string;
  readonly kind: string;
  readonly outputs?: readonly IRuntimeOutput[];
  readonly textureKeys?: Readonly<Record<string, string>>;
  readonly colorSpace?: string;
  readonly role?: string;
  readonly tileSizeMeters?: number;
  readonly spec?: {
    readonly kind?: string;
    readonly color?: number;
    readonly roughness?: number;
    readonly metalness?: number;
    readonly opacity?: number;
    readonly transparent?: boolean;
    readonly normalScale?: number;
    readonly side?: string;
  };
}

interface IRuntimeIndex {
  readonly generatedRoot?: string;
  readonly entries: readonly IRuntimeEntry[];
}

/** One instantiable model extracted from a GLB. */
export interface ILoadedModel {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

/** Loads and caches real materials and models from the processed asset set. */
export class RealAssetLibrary {
  private readonly byId = new Map<string, IRuntimeEntry>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly models = new Map<string, ILoadedModel | undefined>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly failures: string[] = [];

  private constructor(
    private readonly index: IRuntimeIndex,
    private readonly baseUrl: string,
    private readonly tier: string,
    private readonly ktx2: KTX2Loader,
    private readonly gltf: GLTFLoader,
    private readonly decorate: (m: THREE.Material) => THREE.Material,
    private readonly anisotropy: number
  ) {
    for (const entry of index.entries) this.byId.set(entry.id, entry);
  }

  /**
   * Try to open the processed asset set. Resolves undefined when it is not
   * present, which is the normal state of a fresh clone.
   */
  static async open(
    baseUrl: string,
    renderer: THREE.WebGLRenderer,
    tier: string,
    decorate: (m: THREE.Material) => THREE.Material,
    anisotropy: number
  ): Promise<RealAssetLibrary | undefined> {
    let index: IRuntimeIndex;
    try {
      const response = await fetch(`${baseUrl}/assets.runtime.json`, { cache: 'no-store' });
      if (!response.ok) return undefined;
      index = (await response.json()) as IRuntimeIndex;
    } catch {
      return undefined;
    }
    if (!index.entries || index.entries.length === 0) return undefined;

    const ktx2 = new KTX2Loader().setTranscoderPath('/basis/').detectSupport(renderer);
    const draco = new DRACOLoader().setDecoderPath('/draco/');
    const gltf = new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx2);
    gltf.setMeshoptDecoder(MeshoptDecoder);
    return new RealAssetLibrary(index, baseUrl, tier, ktx2, gltf, decorate, anisotropy);
  }

  /** Ids that could not be loaded, for the harness readout. */
  problems(): readonly string[] {
    return this.failures;
  }

  materialCount(): number {
    return this.materials.size;
  }

  modelCount(): number {
    return [...this.models.values()].filter(Boolean).length;
  }

  /* ---------------------------------------------------------------------- */
  /* Materials                                                              */
  /* ---------------------------------------------------------------------- */

  /** Load every material id the city may bind. Failures are recorded, not thrown. */
  async loadMaterials(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.loadMaterial(key)));
  }

  getMaterial(key: string): THREE.Material | undefined {
    return this.materials.get(key);
  }

  private async loadMaterial(key: string): Promise<void> {
    const entry = this.byId.get(key);
    if (!entry || entry.kind !== 'material') {
      this.failures.push(`${key}: not a material in the runtime index`);
      return;
    }
    try {
      const keys = entry.textureKeys ?? {};
      const [map, normalMap, orm] = await Promise.all([
        this.loadTexture(keys.albedo, true),
        this.loadTexture(keys.normal, false),
        this.loadTexture(keys.orm, false),
      ]);

      const spec = entry.spec ?? {};
      const isGlass = key === 'mat.glass.window';
      const material = new THREE.MeshStandardMaterial({
        map: map ?? null,
        normalMap: normalMap ?? null,
        // The pipeline packs occlusion/roughness/metalness into one texture,
        // which is exactly the layout MeshStandardMaterial reads from R/G/B —
        // one upload serves three slots.
        aoMap: orm ?? null,
        roughnessMap: orm ?? null,
        metalnessMap: orm ?? null,
        color: new THREE.Color(spec.color ?? 0xffffff),
        roughness: orm ? 1 : (spec.roughness ?? 0.9),
        metalness: orm ? 1 : (spec.metalness ?? 0),
        // The city writes UVs in tile units and bakes per-building tint into
        // vertex colour; both are load-bearing.
        vertexColors: true,
        side: spec.side === 'double' ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (normalMap) material.normalScale = new THREE.Vector2(1, 1);
      if (isGlass) {
        // Opaque on purpose — see the note at the top of this file.
        material.roughness = 0.18;
        material.metalness = 0.05;
        material.envMapIntensity = 1.6;
        material.side = THREE.FrontSide;
      }
      if (key === 'mat.road.markings') {
        material.polygonOffset = true;
        material.polygonOffsetFactor = -2;
        material.polygonOffsetUnits = -2;
      }
      this.materials.set(key, this.decorate(material));
    } catch (error) {
      this.failures.push(`${key}: ${(error as Error).message}`);
    }
  }

  private async loadTexture(key: string | undefined, srgb: boolean): Promise<THREE.Texture | undefined> {
    if (!key) return undefined;
    const cached = this.textures.get(key);
    if (cached) return cached;
    const entry = this.byId.get(key);
    const output = entry?.outputs?.find((o) => o.tier === this.tier) ?? entry?.outputs?.[0];
    if (!output) return undefined;
    const texture = await this.ktx2.loadAsync(`${this.baseUrl}/${output.file}`);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.anisotropy = this.anisotropy;
    texture.needsUpdate = true;
    this.textures.set(key, texture);
    return texture;
  }

  /* ---------------------------------------------------------------------- */
  /* Models                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Load prop models. Each collapses to one geometry + material for instancing. */
  async loadModels(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((key) => this.loadModel(key)));
  }

  getModel(key: string): ILoadedModel | undefined {
    return this.models.get(key);
  }

  private async loadModel(key: string): Promise<void> {
    const entry = this.byId.get(key);
    const output = entry?.outputs?.find((o) => o.tier === this.tier) ?? entry?.outputs?.[0];
    if (!output) {
      this.models.set(key, undefined);
      return;
    }
    try {
      const gltf = await this.gltf.loadAsync(`${this.baseUrl}/${output.file}`);
      // Instancing needs ONE geometry and ONE material. Take the largest mesh
      // in the file and bake its world transform in: a lamp post split across
      // five sub-meshes would otherwise need five InstancedMeshes, and the
      // whole point of a prop batch is that it costs one draw call.
      let best: THREE.Mesh | undefined;
      let bestCount = 0;
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((child) => {
        if (!(child as THREE.Mesh).isMesh) return;
        const mesh = child as THREE.Mesh;
        const count = mesh.geometry.getAttribute('position')?.count ?? 0;
        if (count > bestCount) {
          bestCount = count;
          best = mesh;
        }
      });
      if (!best) {
        this.models.set(key, undefined);
        return;
      }
      const geometry = best.geometry.clone();
      geometry.applyMatrix4(best.matrixWorld);
      const source = Array.isArray(best.material) ? best.material[0] : best.material;
      const material = (source as THREE.Material).clone();
      this.models.set(key, { geometry, material: this.decorate(material) });
    } catch (error) {
      this.failures.push(`${key}: ${(error as Error).message}`);
      this.models.set(key, undefined);
    }
  }
}
