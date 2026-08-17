/**
 * GLB MODEL LOADING
 *
 * The pipeline's models are meshopt-compressed, quantised
 * (`KHR_mesh_quantization`) and carry their textures as KTX2 inside the
 * container (`KHR_texture_basisu`). All three extensions are REQUIRED, not
 * optional, so a `GLTFLoader` missing any one of them fails the parse outright
 * — which is why the decoder wiring lives here and not in each caller.
 *
 * ── THE THREE-LOD LAYOUT ───────────────────────────────────────────────────
 * Each part of a model is emitted as:
 *
 *     <part>                     (transform node)
 *       └ <part>__LOD            extras.lod.levels = [{level, triangles, …}]
 *           ├ LOD0               full density
 *           ├ LOD1               ~35%
 *           └ LOD2               ~12%
 *
 * GLTFLoader has no idea those are alternatives: left alone it adds all three
 * to the scene and the model draws at 1.47x its LOD0 triangle count while
 * looking identical. `extractLodGroups()` finds them and `setLodLevel()` shows
 * exactly one, with LOD0 selected on load. `toThreeLOD()` hands the streaming
 * system a real `THREE.LOD` with the manifest's switch distances when it wants
 * automatic selection instead.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { IAssetLOD, IModelAsset } from '@/types';
import { createLogger } from '@/util';

const log = createLogger('assets:models');

/* -------------------------------------------------------------------------- */
/* Loader                                                                     */
/* -------------------------------------------------------------------------- */

export interface IModelLoaderOptions {
  readonly ktx2: KTX2Loader;
  /**
   * Directory serving the Draco decoder. Optional: no model in this project
   * uses `KHR_draco_mesh_compression` today, and wiring a decoder path that
   * does not exist would turn a working load into a 404 on first use.
   */
  readonly dracoPath?: string;
}

/** A `GLTFLoader` wired for this pipeline's containers. */
export function createModelLoader(options: IModelLoaderOptions): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setKTX2Loader(options.ktx2);
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (options.dracoPath !== undefined) {
    const draco = new DRACOLoader().setDecoderPath(options.dracoPath);
    loader.setDRACOLoader(draco);
  }
  return loader;
}

/* -------------------------------------------------------------------------- */
/* LOD extraction                                                             */
/* -------------------------------------------------------------------------- */

/** One decimated variant inside a model. */
export interface IModelLodLevel {
  readonly level: number;
  readonly object: THREE.Object3D;
  readonly triangles: number;
  /** Distance in metres beyond which this level is used, from the manifest. */
  readonly screenDistance: number;
}

/** One `__LOD` node and its alternatives. */
export interface IModelLodGroup {
  readonly name: string;
  /** The `__LOD` node itself; its children are the levels. */
  readonly root: THREE.Object3D;
  readonly levels: readonly IModelLodLevel[];
}

interface ILodExtras {
  readonly lod?: { readonly levels?: ReadonlyArray<{ level?: number; triangles?: number }> };
}

function countTriangles(object: THREE.Object3D): number {
  let total = 0;
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    if (index) total += index.count / 3;
    else if (position) total += position.count / 3;
  });
  return Math.round(total);
}

/**
 * Find every `__LOD` node in a loaded scene.
 *
 * Matches on the node-name suffix the pipeline emits AND on the presence of
 * `LOD<n>` children, so an artist-named node that merely happens to end in
 * `__LOD` cannot be mistaken for one.
 */
export function extractLodGroups(
  root: THREE.Object3D,
  manifestLods: readonly IAssetLOD[] = []
): readonly IModelLodGroup[] {
  const groups: IModelLodGroup[] = [];
  const distances = new Map<number, number>();
  for (const lod of manifestLods) distances.set(lod.level, lod.screenDistance ?? 0);

  root.traverse((node) => {
    if (!node.name.endsWith('__LOD')) return;
    const levels: IModelLodLevel[] = [];
    const extras = node.userData as ILodExtras;

    for (const child of node.children) {
      const match = /^LOD(\d+)$/.exec(child.name);
      if (match === null) continue;
      const level = Number(match[1]);
      const declared = extras.lod?.levels?.find((entry) => entry.level === level);
      levels.push({
        level,
        object: child,
        triangles: declared?.triangles ?? countTriangles(child),
        screenDistance: distances.get(level) ?? level * 25,
      });
    }
    if (levels.length === 0) return;
    levels.sort((a, b) => a.level - b.level);
    groups.push({ name: node.name, root: node, levels });
  });

  return groups;
}

/* -------------------------------------------------------------------------- */
/* Loaded model                                                               */
/* -------------------------------------------------------------------------- */

/** A model template. Clone `scene` before adding it to the world. */
export interface ILoadedModel {
  readonly key: string;
  readonly scene: THREE.Object3D;
  readonly lodGroups: readonly IModelLodGroup[];
  /** Triangles at the currently selected level. */
  readonly triangles: number;
  /** Levels available, i.e. `max(levels.length)` across the groups. */
  readonly lodCount: number;
  /** Currently displayed level. */
  readonly activeLevel: number;
  /** Show exactly one level across every group. Clamped per group. */
  setLodLevel(level: number): void;
  /** Build a distance-switching `THREE.LOD` from the extracted groups. */
  toThreeLOD(): THREE.LOD;
  dispose(): void;
}

class LoadedModel implements ILoadedModel {
  private level = 0;

  constructor(
    readonly key: string,
    readonly scene: THREE.Object3D,
    readonly lodGroups: readonly IModelLodGroup[]
  ) {
    this.setLodLevel(0);
  }

  get lodCount(): number {
    return this.lodGroups.reduce((max, group) => Math.max(max, group.levels.length), 0);
  }

  get activeLevel(): number {
    return this.level;
  }

  get triangles(): number {
    if (this.lodGroups.length === 0) return countTriangles(this.scene);
    let total = 0;
    for (const group of this.lodGroups) {
      const chosen = group.levels[Math.min(this.level, group.levels.length - 1)];
      total += chosen?.triangles ?? 0;
    }
    return total;
  }

  setLodLevel(level: number): void {
    this.level = Math.max(0, Math.floor(level));
    for (const group of this.lodGroups) {
      const index = Math.min(this.level, group.levels.length - 1);
      for (let i = 0; i < group.levels.length; i++) {
        group.levels[i]!.object.visible = i === index;
      }
    }
  }

  toThreeLOD(): THREE.LOD {
    const lod = new THREE.LOD();
    lod.name = `${this.key}:LOD`;
    const count = this.lodCount;
    for (let level = 0; level < count; level++) {
      const container = new THREE.Group();
      container.name = `${this.key}:L${level}`;
      let distance = 0;
      for (const group of this.lodGroups) {
        const entry = group.levels[Math.min(level, group.levels.length - 1)];
        if (entry === undefined) continue;
        distance = Math.max(distance, entry.screenDistance);
        const clone = entry.object.clone(true);
        clone.visible = true;
        // Re-apply the ancestor transforms the original level inherited, so a
        // level lifted out of its group lands in the same place.
        entry.object.updateWorldMatrix(true, false);
        clone.matrix.copy(entry.object.matrixWorld);
        clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
        container.add(clone);
      }
      lod.addLevel(container, level === 0 ? 0 : distance);
    }
    return lod;
  }

  dispose(): void {
    disposeSceneGraph(this.scene);
  }
}

/** Free geometries and materials under an object. Textures are registry-owned. */
export function disposeSceneGraph(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) for (const entry of material) entry.dispose();
    else material?.dispose();
  });
}

/**
 * Parse GLB bytes into a model template.
 *
 * Bytes rather than a URL so the provider's tier-fallback logic owns the
 * fetch — a loader that fetches for itself would bypass the tier chain and
 * reintroduce the 404 this runtime exists to prevent.
 */
export async function parseModel(
  loader: GLTFLoader,
  key: string,
  bytes: ArrayBuffer,
  entry: IModelAsset | undefined,
  anisotropy: number
): Promise<ILoadedModel> {
  const gltf = await loader.parseAsync(bytes, '');
  const scene = gltf.scene;
  scene.name = key;

  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const pbr = material as THREE.MeshStandardMaterial;
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'] as const) {
        const texture = pbr[slot];
        if (texture) texture.anisotropy = anisotropy;
      }
      // glTF puts occlusion on its own texCoord; these meshes have UV0 only.
      if (pbr.aoMap) pbr.aoMap.channel = 0;
    }
  });

  const lodLevels = entry?.outputs.flatMap((output) => output.lods ?? []) ?? [];
  const groups = extractLodGroups(scene, lodLevels);
  if (groups.length === 0) {
    log.debug(`model "${key}" has no __LOD groups; treating it as a single level`);
  }
  return new LoadedModel(key, scene, groups);
}

/** Parse a character GLB, keeping its animation clips. */
export async function parseCharacter(
  loader: GLTFLoader,
  key: string,
  bytes: ArrayBuffer,
  anisotropy: number
): Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  const gltf = await loader.parseAsync(bytes, '');
  gltf.scene.name = key;
  gltf.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const pbr = material as THREE.MeshStandardMaterial;
      if (pbr.map) pbr.map.anisotropy = anisotropy;
      if (pbr.aoMap) pbr.aoMap.channel = 0;
    }
  });
  return { scene: gltf.scene, clips: gltf.animations };
}
