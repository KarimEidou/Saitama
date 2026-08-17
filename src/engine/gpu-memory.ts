/**
 * GPU MEMORY ESTIMATION
 *
 * `renderer.info.memory` reports COUNTS — how many textures and geometries are
 * alive — not bytes. Counts are close to useless for budgeting: one 4096²
 * albedo is 64 MB and one 4×4 mask is 128 bytes, and `textures: 2` says nothing
 * about which situation you are in. Every real out-of-memory crash on Android
 * is a byte problem.
 *
 * So bytes are computed here by walking what is actually resident. The numbers
 * are ESTIMATES — the driver may pad, may keep a staging copy, may store a
 * compressed texture in a different layout — but they are estimates that track
 * reality closely enough to catch a texture budget being blown, which is the
 * job.
 */

import * as THREE from 'three';

/** Bytes per texel for the formats this renderer actually produces. */
function bytesPerTexel(texture: THREE.Texture): number {
  const format = texture.format;
  const type = texture.type;

  let channels = 4;
  if (format === THREE.RedFormat) channels = 1;
  else if (format === THREE.RGFormat) channels = 2;
  else if (format === THREE.RGBAFormat) channels = 4;

  let bytes = 1;
  if (type === THREE.HalfFloatType) bytes = 2;
  else if (type === THREE.FloatType) bytes = 4;
  else if (type === THREE.UnsignedInt248Type || type === THREE.UnsignedIntType) bytes = 4;
  else if (type === THREE.UnsignedShortType || type === THREE.ShortType) bytes = 2;

  return channels * bytes;
}

/**
 * Approximate GPU bytes for one texture, mip chain included.
 *
 * Compressed textures report their own byte length when the loader kept the
 * mip data around, which is the accurate path; everything else is
 * width × height × bytesPerTexel × 4/3 for the mips.
 */
export function estimateTextureBytes(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;

  const compressed = texture as THREE.CompressedTexture;
  if (compressed.isCompressedTexture && Array.isArray(compressed.mipmaps)) {
    let total = 0;
    for (const mip of compressed.mipmaps) {
      const data = (mip as { data?: ArrayBufferView }).data;
      if (data) total += data.byteLength;
    }
    if (total > 0) return total;
  }

  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (width <= 0 || height <= 0) return 0;

  const base = width * height * bytesPerTexel(texture);
  // A full mip chain adds 1/3 on top of the base level.
  return texture.generateMipmaps || (texture.mipmaps?.length ?? 0) > 1 ? base * (4 / 3) : base;
}

/** Every texture slot a built-in material may hold. */
const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'lightMap',
  'envMap',
  'specularMap',
  'gradientMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'sheenColorMap',
  'transmissionMap',
  'thicknessMap',
  'iridescenceMap',
] as const;

export interface ISceneMemoryReport {
  /** Distinct textures reachable from the scene graph. */
  readonly textureCount: number;
  /** Estimated bytes those textures occupy, mips included. */
  readonly textureBytes: number;
  /** Distinct geometries. */
  readonly geometryCount: number;
  /** Estimated vertex + index buffer bytes. */
  readonly geometryBytes: number;
  /** Distinct materials. */
  readonly materialCount: number;
  /** Meshes, including instanced ones (counted once each). */
  readonly meshCount: number;
  /** Total instances across every InstancedMesh. */
  readonly instanceCount: number;
  /** Triangles across every resident geometry, ignoring visibility. */
  readonly triangles: number;
}

/**
 * Walk a scene graph and total what it costs on the GPU.
 *
 * De-duplicates by object identity, so a hundred meshes sharing one material
 * and one texture report one texture — which is the whole point of
 * `MaterialLib` and exactly what this report is used to verify.
 */
export function estimateSceneMemory(root: THREE.Object3D): ISceneMemoryReport {
  const textures = new Set<THREE.Texture>();
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  let meshCount = 0;
  let instanceCount = 0;

  const collectMaterial = (material: THREE.Material): void => {
    if (materials.has(material)) return;
    materials.add(material);
    const record = material as unknown as Record<string, unknown>;
    for (const slot of TEXTURE_SLOTS) {
      const value = record[slot];
      if (value && (value as THREE.Texture).isTexture) textures.add(value as THREE.Texture);
    }
    // Custom ShaderMaterial uniforms hold textures nothing else knows about.
    const uniforms = (material as THREE.ShaderMaterial).uniforms;
    if (uniforms) {
      for (const key of Object.keys(uniforms)) {
        const value = uniforms[key]?.value as THREE.Texture | undefined;
        if (value && value.isTexture) textures.add(value);
      }
    }
  };

  root.traverse((object) => {
    const mesh = object as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
    if (mesh.geometry) {
      geometries.add(mesh.geometry);
      meshCount++;
      if (mesh.isInstancedMesh) instanceCount += mesh.count ?? 0;
    }
    const material = mesh.material;
    if (!material) return;
    if (Array.isArray(material)) {
      for (const entry of material) collectMaterial(entry);
    } else {
      collectMaterial(material);
    }
  });

  // A scene's environment map is not reachable from any mesh.
  const scene = root as THREE.Scene;
  if (scene.isScene) {
    if (scene.environment) textures.add(scene.environment);
    if (scene.background && (scene.background as THREE.Texture).isTexture) {
      textures.add(scene.background as THREE.Texture);
    }
  }

  let textureBytes = 0;
  for (const texture of textures) textureBytes += estimateTextureBytes(texture);

  let geometryBytes = 0;
  let triangles = 0;
  for (const geometry of geometries) {
    for (const name of Object.keys(geometry.attributes)) {
      // Interleaved attributes share one buffer; `array` may be absent on the
      // view, in which case the underlying `data.array` carries the bytes.
      const attribute = geometry.attributes[name] as unknown as {
        array?: ArrayBufferView;
        data?: { array?: ArrayBufferView };
      };
      const array = attribute?.array ?? attribute?.data?.array;
      if (array) geometryBytes += array.byteLength;
    }
    if (geometry.index) {
      geometryBytes += geometry.index.array.byteLength;
      triangles += geometry.index.count / 3;
    } else {
      triangles += (geometry.attributes.position?.count ?? 0) / 3;
    }
  }

  return {
    textureCount: textures.size,
    textureBytes: Math.round(textureBytes),
    geometryCount: geometries.size,
    geometryBytes: Math.round(geometryBytes),
    materialCount: materials.size,
    meshCount,
    instanceCount,
    triangles: Math.round(triangles),
  };
}

/** Human-readable byte count. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
