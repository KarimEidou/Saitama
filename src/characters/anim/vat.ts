/**
 * VERTEX ANIMATION TEXTURE (bone-matrix flavour)
 *
 * Bakes the skinning palette — `boneMatrix · inverseBind` for every bone of
 * every frame — into one `DataTexture`, so a crowd skins itself in the vertex
 * shader with no per-character CPU work and no per-character draw call.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS EXISTS
 *
 *  A `THREE.SkinnedMesh` costs a draw call per character and a CPU pass over
 *  27 bone matrices per character per frame. 250 civilians is 250 draw calls
 *  and 6,750 matrix composes before anything is drawn — on a mid-tier phone
 *  that is the frame budget, gone, for background pedestrians.
 *
 *  With the palette in a texture, every civilian sharing a body mesh becomes
 *  one `InstancedMesh`: one draw call per (mesh, LOD, material). The whole
 *  crowd lands in roughly six.
 *
 *  MATRICES, NOT VERTICES. The other common VAT stores deformed vertex
 *  positions, which costs `vertices × frames` texels — for a 1,000-vertex LOD0
 *  at 32 frames that is 32,000 texels per clip. Storing 27 bones × 3 texels ×
 *  32 frames is 2,592, and it works for EVERY mesh sharing the skeleton
 *  instead of one. The skinning maths moves into the shader, which is where
 *  there is spare capacity anyway.
 *
 *  DE-SYNCHRONISING THE CROWD. Per instance: a clip index, a time offset and
 *  a rate multiplier, packed into one instanced `vec4`. Without the offset,
 *  250 civilians take the same step at the same instant and the effect is
 *  immediate and ruinous — a marching column, not a crowd.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── LAYOUT ────────────────────────────────────────────────────────────────
 *   width  = boneCount × 3     three RGBA texels per bone = one 3×4 affine
 *   height = total frames      every clip stacked into one atlas
 *
 * Texel `(bone·3 + r, frame)` holds ROW r of the matrix, so the shader's
 * transform is three dot products and no transpose.
 *
 * ── FILTERING IS NEAREST, ON PURPOSE ──────────────────────────────────────
 * Hardware bilinear filtering would interpolate ACROSS BONES at the row edges,
 * which is meaningless — bone 4's translation blended with bone 5's rotation.
 * Frames are therefore fetched with NEAREST and blended in the shader, one
 * explicit `mix` between two adjacent rows. That also removes the dependency
 * on float-texture linear-filtering extensions, which are not universal on
 * mobile.
 */

import * as THREE from 'three';
import { createLogger } from '@/util';
import { poseToModelMatrices, skinningMatrices } from './pose';
import { sampleClip, type SampleOptions } from './bake';
import { clipDuration, type ClipEntry } from './clips';
import type { AnimRig, Pose } from './types';

const log = createLogger('anim:vat');

/** Texels per bone. A 3×4 affine matrix, one row per texel. */
export const TEXELS_PER_BONE = 3;

/** Where one clip lives inside the atlas. */
export interface VatClipRange {
  readonly key: string;
  /** First row of the clip in the texture. */
  readonly row: number;
  readonly frames: number;
  /** Clip duration in seconds at the baked body. */
  readonly duration: number;
  readonly loop: boolean;
}

/** A finished bake. */
export interface VatBake {
  readonly texture: THREE.DataTexture;
  readonly boneCount: number;
  readonly width: number;
  readonly height: number;
  readonly clips: readonly VatClipRange[];
  /** Clip lookup by `slot:variant`. */
  readonly index: ReadonlyMap<string, number>;
  /** Raw texel data, kept for CPU-side verification and for re-upload. */
  readonly data: Float32Array | Uint16Array;
  readonly halfFloat: boolean;
  /** Texture memory in bytes. */
  readonly bytes: number;
  dispose(): void;
}

/** Bake options. */
export interface VatOptions extends SampleOptions {
  /**
   * Store as RGBA16F instead of RGBA32F. Halves the memory for about 1 mm of
   * positional error on a 2 m character — invisible on a background civilian
   * and measured rather than assumed (see `analysis.ts`).
   */
  readonly halfFloat?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Baking                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bake a set of clips for one skeleton into a single texture atlas.
 *
 * One bake serves every character that shares the skeleton and every LOD of
 * their mesh, because the palette is per-skeleton and skinning is per-vertex.
 */
export function bakeVat(rig: AnimRig, entries: readonly ClipEntry[], options: VatOptions = {}): VatBake {
  const frames = Math.max(2, options.frames ?? 32);
  const halfFloat = options.halfFloat ?? true;
  const boneCount = rig.boneCount;
  const width = boneCount * TEXELS_PER_BONE;
  const height = frames * entries.length;

  const floats = new Float32Array(width * height * 4);
  const clips: VatClipRange[] = [];
  const index = new Map<string, number>();

  const modelMatrices: THREE.Matrix4[] = [];
  const skinMatrices: THREE.Matrix4[] = [];

  entries.forEach((entry, clipIndex) => {
    const poses = sampleClip(rig, entry, { ...options, frames });
    const row = clipIndex * frames;
    const key = `${entry.def.slot}:${entry.def.variant}`;
    clips.push({
      key,
      row,
      frames,
      duration: clipDuration(entry, rig),
      loop: entry.def.loop,
    });
    index.set(key, clipIndex);
    for (let f = 0; f < frames; f++) {
      writeFrame(floats, width, row + f, poses[f]!, rig, modelMatrices, skinMatrices);
    }
  });

  const data = halfFloat ? toHalf(floats) : floats;
  const texture = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    halfFloat ? THREE.HalfFloatType : THREE.FloatType
  );
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  texture.name = 'vat-palette';

  const bytes = width * height * 4 * (halfFloat ? 2 : 4);
  log.debug?.(
    `baked ${entries.length} clips x ${frames} frames -> ${width}x${height} ` +
      `${halfFloat ? 'RGBA16F' : 'RGBA32F'} (${(bytes / 1024).toFixed(1)} KB)`
  );

  return {
    texture,
    boneCount,
    width,
    height,
    clips,
    index,
    data,
    halfFloat,
    bytes,
    dispose(): void {
      texture.dispose();
    },
  };
}

/** Write one pose's skinning palette into a texture row. */
function writeFrame(
  out: Float32Array,
  width: number,
  row: number,
  pose: Pose,
  rig: AnimRig,
  modelMatrices: THREE.Matrix4[],
  skinMatrices: THREE.Matrix4[]
): void {
  poseToModelMatrices(pose, rig, modelMatrices);
  skinningMatrices(modelMatrices, rig.boneInverses, skinMatrices);
  const base = row * width * 4;
  for (let b = 0; b < rig.boneCount; b++) {
    const e = skinMatrices[b]!.elements;
    const o = base + b * TEXELS_PER_BONE * 4;
    // Row 0 of the 3x4: (m00, m01, m02, m03). three.js stores column-major.
    out[o] = e[0]!;
    out[o + 1] = e[4]!;
    out[o + 2] = e[8]!;
    out[o + 3] = e[12]!;
    out[o + 4] = e[1]!;
    out[o + 5] = e[5]!;
    out[o + 6] = e[9]!;
    out[o + 7] = e[13]!;
    out[o + 8] = e[2]!;
    out[o + 9] = e[6]!;
    out[o + 10] = e[10]!;
    out[o + 11] = e[14]!;
  }
}

function toHalf(source: Float32Array): Uint16Array {
  const out = new Uint16Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = THREE.DataUtils.toHalfFloat(source[i]!);
  return out;
}

/* -------------------------------------------------------------------------- */
/* CPU-side read-back                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Reconstruct one bone matrix from the baked texels.
 *
 * The verification path. Whatever the GPU will read, this reads too, through
 * the same quantisation — so a round-trip test measures the real storage error
 * rather than the error of a parallel implementation.
 */
export function readVatMatrix(bake: VatBake, row: number, bone: number, out: THREE.Matrix4): THREE.Matrix4 {
  const o = (row * bake.width + bone * TEXELS_PER_BONE) * 4;
  const v = (i: number): number =>
    bake.halfFloat
      ? THREE.DataUtils.fromHalfFloat((bake.data as Uint16Array)[o + i]!)
      : (bake.data as Float32Array)[o + i]!;
  return out.set(
    v(0), v(1), v(2), v(3),
    v(4), v(5), v(6), v(7),
    v(8), v(9), v(10), v(11),
    0, 0, 0, 1
  );
}

/**
 * Sample the palette exactly as the shader does: two adjacent frames, linear
 * blend of the matrix elements.
 *
 * Blending matrices element-wise is not a rotation-correct interpolation, and
 * that is deliberate — it is what the GPU can afford, so the CPU reference has
 * to make the same compromise or the comparison means nothing. The error it
 * introduces is a function of frame count and is measured directly.
 */
export function sampleVatMatrix(
  bake: VatBake,
  clipIndex: number,
  frameTime: number,
  bone: number,
  out: THREE.Matrix4
): THREE.Matrix4 {
  const clip = bake.clips[clipIndex]!;
  const f = clip.loop
    ? ((frameTime % clip.frames) + clip.frames) % clip.frames
    : Math.min(Math.max(frameTime, 0), clip.frames - 1);
  const f0 = Math.floor(f);
  const f1 = clip.loop ? (f0 + 1) % clip.frames : Math.min(f0 + 1, clip.frames - 1);
  const mix = f - f0;

  readVatMatrix(bake, clip.row + f0, bone, out);
  if (mix <= 0) return out;
  readVatMatrix(bake, clip.row + f1, bone, _m1);
  for (let i = 0; i < 16; i++) {
    out.elements[i] = out.elements[i]! + (_m1.elements[i]! - out.elements[i]!) * mix;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Instancing                                                                 */
/* -------------------------------------------------------------------------- */

/** Per-instance crowd animation state. */
export interface VatInstance {
  /** Index into `VatBake.clips`. */
  readonly clip: number;
  /** Seconds added to the global clock for this instance. */
  readonly offset: number;
  /** Playback rate multiplier. 1 is the baked rate. */
  readonly rate?: number;
}

/**
 * Build the instanced attribute that de-synchronises a crowd.
 *
 * `xyzw = (atlas row, frame count, time offset, rate)`. Packing the row and
 * count rather than an index means the shader never needs a uniform array,
 * which keeps the whole crowd on one material.
 */
export function vatInstanceAttribute(
  bake: VatBake,
  instances: readonly VatInstance[]
): THREE.InstancedBufferAttribute {
  const data = new Float32Array(instances.length * 4);
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i]!;
    const clip = bake.clips[Math.min(instance.clip, bake.clips.length - 1)]!;
    data[i * 4] = clip.row;
    data[i * 4 + 1] = clip.frames;
    data[i * 4 + 2] = instance.offset;
    data[i * 4 + 3] = instance.rate ?? 1;
  }
  return new THREE.InstancedBufferAttribute(data, 4);
}

/**
 * Frames-per-second the shader should advance a clip at, so that the baked
 * frames span the clip's real duration.
 */
export function vatClipFps(clip: VatClipRange): number {
  return clip.frames / Math.max(1e-4, clip.duration);
}

/* -------------------------------------------------------------------------- */
/* Material                                                                   */
/* -------------------------------------------------------------------------- */

/** Uniforms a VAT material owns. Advance `vatTime` once per frame. */
export interface VatUniforms {
  readonly vatTexture: { value: THREE.Texture | null };
  readonly vatTexelSize: { value: THREE.Vector2 };
  readonly vatTime: { value: number };
  readonly vatFps: { value: number };
}

const VAT_VERTEX_HEADER = /* glsl */ `
attribute vec4 skinIndex;
attribute vec4 skinWeight;
attribute vec4 vatParams;
uniform sampler2D vatTexture;
uniform vec2 vatTexelSize;
uniform float vatTime;
uniform float vatFps;

// Fetch one 3x4 bone matrix from a texture row. Texel centres exactly, so
// NEAREST filtering returns the stored value bit for bit.
void vatFetchBone(float bone, float row, out vec4 r0, out vec4 r1, out vec4 r2) {
  float v = (row + 0.5) * vatTexelSize.y;
  float u = (bone * 3.0 + 0.5) * vatTexelSize.x;
  r0 = texture2D(vatTexture, vec2(u, v));
  r1 = texture2D(vatTexture, vec2(u + vatTexelSize.x, v));
  r2 = texture2D(vatTexture, vec2(u + vatTexelSize.x * 2.0, v));
}

// The two rows the current time falls between, and the blend between them.
void vatFrames(out float rowA, out float rowB, out float mixT) {
  float base = vatParams.x;
  float count = max(vatParams.y, 1.0);
  float t = (vatTime + vatParams.z) * vatParams.w * vatFps;
  float f = mod(t, count);
  float f0 = floor(f);
  mixT = f - f0;
  rowA = base + f0;
  rowB = base + mod(f0 + 1.0, count);
}

mat4 vatBoneMatrix(float bone, float rowA, float rowB, float mixT) {
  vec4 a0, a1, a2, b0, b1, b2;
  vatFetchBone(bone, rowA, a0, a1, a2);
  vatFetchBone(bone, rowB, b0, b1, b2);
  vec4 r0 = mix(a0, b0, mixT);
  vec4 r1 = mix(a1, b1, mixT);
  vec4 r2 = mix(a2, b2, mixT);
  // Column-major construction from three stored rows.
  return mat4(
    r0.x, r1.x, r2.x, 0.0,
    r0.y, r1.y, r2.y, 0.0,
    r0.z, r1.z, r2.z, 0.0,
    r0.w, r1.w, r2.w, 1.0
  );
}

mat4 vatSkinMatrix() {
  float rowA, rowB, mixT;
  vatFrames(rowA, rowB, mixT);
  return
    vatBoneMatrix(skinIndex.x, rowA, rowB, mixT) * skinWeight.x +
    vatBoneMatrix(skinIndex.y, rowA, rowB, mixT) * skinWeight.y +
    vatBoneMatrix(skinIndex.z, rowA, rowB, mixT) * skinWeight.z +
    vatBoneMatrix(skinIndex.w, rowA, rowB, mixT) * skinWeight.w;
}
`;

/**
 * Patch any three.js material into a VAT-skinning one.
 *
 * `onBeforeCompile` rather than a bespoke `ShaderMaterial`: the crowd still
 * wants the engine's lighting, fog, shadows and tone mapping, and
 * reimplementing those to add one matrix multiply would be a poor trade.
 */
export function applyVatSkinning(material: THREE.Material, bake: VatBake): VatUniforms {
  const uniforms: VatUniforms = {
    vatTexture: { value: bake.texture },
    vatTexelSize: { value: new THREE.Vector2(1 / bake.width, 1 / bake.height) },
    vatTime: { value: 0 },
    vatFps: { value: bake.clips.length > 0 ? vatClipFps(bake.clips[0]!) : 30 },
  };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.vatTexture = uniforms.vatTexture;
    shader.uniforms.vatTexelSize = uniforms.vatTexelSize;
    shader.uniforms.vatTime = uniforms.vatTime;
    shader.uniforms.vatFps = uniforms.vatFps;
    shader.vertexShader = VAT_VERTEX_HEADER + shader.vertexShader;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
  mat4 vatMatrix = vatSkinMatrix();
  objectNormal = mat3(vatMatrix) * objectNormal;
  #ifdef USE_TANGENT
  objectTangent = mat3(vatMatrix) * objectTangent;
  #endif`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  transformed = (vatMatrix * vec4(transformed, 1.0)).xyz;`
      );
  };
  // Two materials with different `onBeforeCompile` bodies must not share a
  // compiled program; three.js keys the cache on this string.
  material.customProgramCacheKey = (): string => `vat-${bake.width}x${bake.height}`;
  material.needsUpdate = true;
  return uniforms;
}

const _m1 = new THREE.Matrix4();
