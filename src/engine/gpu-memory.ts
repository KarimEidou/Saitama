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

/**
 * Bytes per pixel for each block-compressed GPU format three can hold.
 *
 * Quoted as the amortised per-pixel cost: BC7/ASTC 4x4 and ETC2 EAC RGBA are
 * 16 bytes per 4x4 block = 1 B/px; BC1/ETC1/ETC2 RGB are 8 bytes per block =
 * 0.5 B/px; ASTC 6x6 is 16 bytes per 36 pixels.
 *
 * KNOWINGLY DUPLICATED from `compressedBytesPerPixel` in `src/assets/memory.ts`.
 * The architecture rule is that `src/engine` imports only `src/types` +
 * `src/util`, so it may not reach into `src/assets` for the shared table. The
 * two copies must be kept in step: change one, change the other.
 */
function compressedBytesPerPixel(format: THREE.AnyPixelFormat): number {
  switch (format) {
    case THREE.RGBA_ASTC_4x4_Format:
    case THREE.RGBA_BPTC_Format:
    case THREE.RGB_BPTC_UNSIGNED_Format:
    case THREE.RGBA_S3TC_DXT5_Format:
    case THREE.RGBA_ETC2_EAC_Format:
    case THREE.RED_GREEN_RGTC2_Format:
      return 1;
    case THREE.RGBA_ASTC_6x6_Format:
      return 16 / 36;
    case THREE.RGBA_S3TC_DXT1_Format:
    case THREE.RGB_S3TC_DXT1_Format:
    case THREE.RGB_ETC2_Format:
    case THREE.RGB_ETC1_Format:
    case THREE.RED_RGTC1_Format:
    case THREE.RGBA_PVRTC_4BPPV1_Format:
    case THREE.RGB_PVRTC_4BPPV1_Format:
      return 0.5;
    default:
      return 1;
  }
}

/** Bytes per texel for the formats this renderer actually produces. */
function bytesPerTexel(texture: THREE.Texture): number {
  const format = texture.format;
  const type = texture.type;

  let channels = 4;
  if (format === THREE.RedFormat) channels = 1;
  else if (format === THREE.RGFormat) channels = 2;
  else if (format === THREE.RGBFormat) channels = 3;
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
 * A texture whose loader kept EVERY mip level's payload reports its own byte
 * length, which is the accurate path; everything else is
 * width × height × bytes-per-pixel, plus 4/3 for the mips when the texture
 * actually has mips — a texture with `generateMipmaps: false` and no mip chain
 * is charged its base level alone.
 *
 * The per-pixel rate depends on the kind: a block-compressed page costs
 * 0.5–1 B/px, not the 4 B/px an uncompressed RGBA8 texel costs. Charging every
 * unrecognised format 4 channels over-reported a BC7 page 4x and an ETC2 RGB
 * page 8x — in the direction that makes a healthy budget look blown, which is
 * the failure mode this module exists to avoid.
 */
export function estimateTextureBytes(texture: THREE.Texture): number {
  const image = texture.image as { width?: number; height?: number } | undefined;

  // Exact path, but only when the payload is COMPLETE. A partly-populated
  // `mipmaps` array (levels dropped by the loader, or an empty array on a
  // GPU-resident compressed texture) previously returned the sum of whatever
  // levels happened to carry data, silently under-reporting the rest.
  const mipmaps = texture.mipmaps as ReadonlyArray<{ data?: ArrayBufferView }> | undefined;
  if (mipmaps !== undefined && mipmaps.length > 0) {
    let total = 0;
    let complete = true;
    for (const mip of mipmaps) {
      const data = mip?.data;
      if (data) total += data.byteLength;
      else complete = false;
    }
    if (complete && total > 0) return total;
  }

  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (width <= 0 || height <= 0) return 0;

  const perPixel =
    (texture as THREE.CompressedTexture).isCompressedTexture === true
      ? compressedBytesPerPixel(texture.format)
      : bytesPerTexel(texture);

  const base = width * height * perPixel;
  // A full mip chain adds 1/3 on top of the base level.
  return texture.generateMipmaps || (mipmaps?.length ?? 0) > 1 ? base * (4 / 3) : base;
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
  /** `instanceMatrix`/`instanceColor` bytes: they live on the MESH, not the geometry. */
  let instanceBufferBytes = 0;

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
      if (mesh.isInstancedMesh) {
        instanceCount += mesh.count ?? 0;
        // 64 bytes per instance for the matrix — easily megabytes for a crowd —
        // and it hangs off the mesh, so the geometry walk below never sees it.
        const instanced = mesh as unknown as THREE.InstancedMesh;
        instanceBufferBytes += instanced.instanceMatrix?.array.byteLength ?? 0;
        instanceBufferBytes += instanced.instanceColor?.array.byteLength ?? 0;
      }
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

  let geometryBytes = instanceBufferBytes;
  let triangles = 0;
  // three keys its GPU buffers on the `InterleavedBuffer` when there is one and
  // on the attribute otherwise, so that is the identity to de-duplicate on:
  // position/normal/uv views onto ONE interleaved buffer (the standard layout
  // for glTF-loaded and packed props) are one upload, not three. Without this
  // set such a geometry reported 3x its true vertex cost and the whole report
  // stopped being usable for the budget decision it exists to support.
  const buffers = new Set<object>();
  for (const geometry of geometries) {
    for (const name of Object.keys(geometry.attributes)) {
      const attribute = geometry.attributes[name] as unknown as {
        array?: ArrayBufferView;
        data?: { array?: ArrayBufferView };
      };
      if (!attribute) continue;
      const buffer: object = attribute.data ?? attribute;
      if (buffers.has(buffer)) continue;
      buffers.add(buffer);
      const array = attribute.array ?? attribute.data?.array;
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
