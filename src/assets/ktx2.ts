/**
 * KTX2 / BASIS WIRING
 *
 * One place that knows how the pipeline's textures were authored, so no
 * consumer has to re-derive it. Each of the following was measured against the
 * real files; getting one wrong fails SILENTLY — the texture loads, the frame
 * renders, and the shading is subtly or completely wrong.
 *
 *  1. FLIP. Every KTX2 in this set carries `KTXorientation: ru` — bottom-left
 *     origin, i.e. `flipY: false` already baked into the bytes. Three's
 *     default `flipY: true` does not apply to compressed textures anyway (it
 *     cannot: you cannot flip a block-compressed payload without decoding),
 *     but it DOES apply to the uncompressed half-float environment maps. Left
 *     alone the sky is upside down, so it is written explicitly, not assumed.
 *
 *  2. NORMALS ARE PLAIN RGB. They were encoded as ordinary UASTC RGB, not with
 *     the encoder's two-channel `--normal-mode`. That is deliberate:
 *     `KTX2Loader` only ever transcodes Basis payloads to RGBA-shaped targets
 *     (ASTC/BC7/BC1/ETC2/RGBA32), never to the RG11_EAC or RGTC2 formats that
 *     three's `isPackedRGFormat` path needs, and three samples `normalMap.xyz`.
 *     A two-channel map would therefore arrive as (X, X, X) and light every
 *     surface as if it faced one fixed direction. Bind them straight in.
 *
 *  3. ENVIRONMENT MAPS COME BACK WRONG. They are uncompressed RGBA16F, so
 *     `KTX2Loader` takes its raw-texture path and hands back a `DataTexture`
 *     with `NearestFilter` on min and mag, and no mapping. Point-sampling a
 *     1024x512 equirect makes the sun disc a flickering square and aliases the
 *     PMREM convolution. `prepareEnvironmentTexture()` is the fix.
 *
 * Confirmed transcode targets in this project's browsers: astc, etc, etc1,
 * s3tc, bptc. In headless Chromium on SwiftShader every texture lands as
 * `RGBA_BPTC_Format` (BC7) — see the note in `describeTranscodeSupport`.
 */

import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { ColorSpace, TextureCodec } from '@/types';
import { createLogger } from '@/util';

const log = createLogger('assets:ktx2');

/* -------------------------------------------------------------------------- */
/* Support detection                                                          */
/* -------------------------------------------------------------------------- */

/** Which compressed-texture families the GL context exposes. */
export interface ITranscodeSupport {
  readonly astc: boolean;
  readonly bptc: boolean;
  readonly s3tc: boolean;
  readonly etc2: boolean;
  readonly etc1: boolean;
  readonly pvrtc: boolean;
  /**
   * The GPU format `KTX2Loader` will pick for an ordinary opaque UASTC or
   * ETC1S texture on this device, e.g. 'RGBA_BPTC_Format'.
   */
  readonly predictedTarget: string;
  /** Raw extension names, for the diagnostics readout. */
  readonly extensions: readonly string[];
  /**
   * True when the loader suppressed ASTC/ETC because the driver only emulates
   * them. Chrome and Firefox on Linux expose ASTC and ETC through Mesa on AMD
   * and Intel hardware that has neither; transcoding into them would land in
   * an expensive software decompress on the main thread, so `KTX2Loader`
   * disables them and BC7 wins. This is why SwiftShader reports BC7.
   */
  readonly emulatedFormatsSuppressed: boolean;
}

interface IRendererLike {
  extensions?: { has(name: string): boolean };
}

/**
 * Mirror `KTX2Loader.detectSupport()` so the choice can be REPORTED, not just
 * made. Kept deliberately in step with the loader's own logic, including the
 * Linux/Mesa suppression, so the prediction matches what actually happens.
 */
export function describeTranscodeSupport(renderer: IRendererLike): ITranscodeSupport {
  const has = (name: string): boolean => renderer.extensions?.has(name) === true;

  let astc = has('WEBGL_compressed_texture_astc');
  let etc2 = has('WEBGL_compressed_texture_etc');
  let etc1 = has('WEBGL_compressed_texture_etc1');
  const s3tc = has('WEBGL_compressed_texture_s3tc');
  const bptc = has('EXT_texture_compression_bptc');
  const pvrtc =
    has('WEBGL_compressed_texture_pvrtc') || has('WEBKIT_WEBGL_compressed_texture_pvrtc');

  const nav = (globalThis as { navigator?: { platform?: string; userAgent?: string } }).navigator;
  const linuxDesktop =
    typeof nav?.platform === 'string' &&
    typeof nav?.userAgent === 'string' &&
    nav.platform.includes('Linux') &&
    !nav.userAgent.includes('Android');

  let suppressed = false;
  if (linuxDesktop && astc && etc2 && bptc && s3tc) {
    astc = false;
    etc1 = false;
    etc2 = false;
    suppressed = true;
  }

  // Priority order for UASTC, which is what the loader uses: ASTC, BC7, ETC2,
  // ETC1, BC1/BC3, PVRTC, then uncompressed RGBA32.
  const predictedTarget = astc
    ? 'RGBA_ASTC_4x4_Format'
    : bptc
      ? 'RGBA_BPTC_Format'
      : etc2
        ? 'RGBA_ETC2_EAC_Format'
        : etc1
          ? 'RGB_ETC1_Format'
          : s3tc
            ? 'RGBA_S3TC_DXT5_Format'
            : pvrtc
              ? 'RGBA_PVRTC_4BPPV1_Format'
              : 'RGBAFormat (uncompressed — no GPU codec available)';

  const extensions = [
    astc && 'astc',
    bptc && 'bptc',
    s3tc && 's3tc',
    etc2 && 'etc',
    etc1 && 'etc1',
    pvrtc && 'pvrtc',
  ].filter((name): name is string => typeof name === 'string');

  return {
    astc,
    bptc,
    s3tc,
    etc2,
    etc1,
    pvrtc,
    predictedTarget,
    extensions,
    emulatedFormatsSuppressed: suppressed,
  };
}

/* -------------------------------------------------------------------------- */
/* Loader construction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build a `KTX2Loader` pointed at the staged Basis transcoder.
 *
 * `transcoderPath` must be a directory served VERBATIM (i.e. from `public/`),
 * not one the bundler processes: `basis_transcoder.js` is a UMD bundle and
 * Vite would rewrite it into an ES module that the worker cannot evaluate.
 */
export function createKTX2Loader(
  renderer: THREE.WebGLRenderer,
  transcoderPath: string
): KTX2Loader {
  const loader = new KTX2Loader().setTranscoderPath(transcoderPath);
  loader.detectSupport(renderer);
  const support = describeTranscodeSupport(renderer);
  log.info(
    `KTX2 transcode target: ${support.predictedTarget} ` +
      `(available: ${support.extensions.join(', ') || 'none'})` +
      (support.emulatedFormatsSuppressed ? ' — emulated ASTC/ETC suppressed' : '')
  );
  return loader;
}

/**
 * Promise wrapper around `KTX2Loader.parse`.
 *
 * The loader's own `parse` is callback-shaped and throws synchronously when
 * `detectSupport` was never called, so both failure modes are funnelled into
 * one rejected promise here. Note that the ArrayBuffer is TRANSFERRED to the
 * transcode worker for Basis payloads and is detached afterwards — never reuse
 * a buffer after passing it in.
 */
export function parseKTX2(loader: KTX2Loader, bytes: ArrayBuffer): Promise<THREE.Texture> {
  return new Promise<THREE.Texture>((resolve, reject) => {
    try {
      loader.parse(
        bytes,
        (texture) => resolve(texture as unknown as THREE.Texture),
        (error) => reject(error instanceof Error ? error : new Error(String(error)))
      );
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Format reporting                                                           */
/* -------------------------------------------------------------------------- */

/** three's numeric format constants, reversed into names. */
const FORMAT_NAMES = new Map<number, string>([
  [THREE.RGBA_ASTC_4x4_Format, 'RGBA_ASTC_4x4_Format'],
  [THREE.RGBA_ASTC_6x6_Format, 'RGBA_ASTC_6x6_Format'],
  [THREE.RGBA_BPTC_Format, 'RGBA_BPTC_Format'],
  [THREE.RGB_BPTC_UNSIGNED_Format, 'RGB_BPTC_UNSIGNED_Format'],
  [THREE.RGBA_S3TC_DXT5_Format, 'RGBA_S3TC_DXT5_Format'],
  [THREE.RGBA_S3TC_DXT1_Format, 'RGBA_S3TC_DXT1_Format'],
  [THREE.RGB_S3TC_DXT1_Format, 'RGB_S3TC_DXT1_Format'],
  [THREE.RGBA_ETC2_EAC_Format, 'RGBA_ETC2_EAC_Format'],
  [THREE.RGB_ETC2_Format, 'RGB_ETC2_Format'],
  [THREE.RGB_ETC1_Format, 'RGB_ETC1_Format'],
  [THREE.RGBA_PVRTC_4BPPV1_Format, 'RGBA_PVRTC_4BPPV1_Format'],
  [THREE.RGB_PVRTC_4BPPV1_Format, 'RGB_PVRTC_4BPPV1_Format'],
  [THREE.RED_RGTC1_Format, 'RED_RGTC1_Format'],
  [THREE.RED_GREEN_RGTC2_Format, 'RED_GREEN_RGTC2_Format'],
  [THREE.RGBAFormat, 'RGBAFormat'],
  [THREE.RGFormat, 'RGFormat'],
  [THREE.RedFormat, 'RedFormat'],
]);

/** Human-readable name of a texture's GPU format. */
export function gpuFormatName(texture: THREE.Texture): string {
  return FORMAT_NAMES.get(texture.format) ?? `format#${texture.format}`;
}

/** True when three uploaded this as a block-compressed GPU texture. */
export function isCompressedTexture(texture: THREE.Texture): boolean {
  return (texture as { isCompressedTexture?: boolean }).isCompressedTexture === true;
}

/**
 * Map a GPU format onto the closed `TextureCodec` union in `types/assets.ts`.
 *
 * The union predates this pipeline and cannot name S3TC, ETC2 or PVRTC, so
 * those degrade to the nearest honest member and the exact truth is carried
 * alongside on `IManagedTextureHandle.gpuFormat`. Never report a codec the
 * device is not actually using.
 */
export function codecOf(texture: THREE.Texture, sourceCodec?: TextureCodec): TextureCodec {
  if (!isCompressedTexture(texture)) return 'none';
  switch (texture.format) {
    case THREE.RGBA_ASTC_4x4_Format:
    case THREE.RGBA_ASTC_6x6_Format:
      return 'astc';
    case THREE.RGBA_BPTC_Format:
    case THREE.RGB_BPTC_UNSIGNED_Format:
      return 'bc7';
    case THREE.RGBA_ETC2_EAC_Format:
    case THREE.RGB_ETC2_Format:
    case THREE.RGB_ETC1_Format:
      return 'etc1s';
    default:
      // S3TC / PVRTC / RGTC have no member in the union. Report what the file
      // was encoded as rather than inventing a target name.
      return sourceCodec ?? 'uastc';
  }
}

/* -------------------------------------------------------------------------- */
/* Texture preparation                                                        */
/* -------------------------------------------------------------------------- */

/** Apply the settings a colour/data texture from this pipeline needs. */
export function prepareTexture(
  texture: THREE.Texture,
  colorSpace: ColorSpace,
  anisotropy: number,
  tileable: boolean
): THREE.Texture {
  texture.colorSpace = colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  // Bottom-left origin is baked in (KTXorientation: ru). Flipping again would
  // invert every normal map's green channel and mirror the albedo.
  texture.flipY = false;
  texture.wrapS = tileable ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = tileable ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  // Mips are in the container; asking three to build more would decode the
  // compressed payload on the CPU.
  texture.generateMipmaps = false;
  if (texture.mipmaps !== undefined && texture.mipmaps.length > 1) {
    texture.minFilter = THREE.LinearMipmapLinearFilter;
  } else {
    texture.minFilter = THREE.LinearFilter;
  }
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Undo the two things `KTX2Loader` gets wrong for equirectangular environment
 * maps. Exported because it is a correctness fix rather than an internal
 * detail: anything loading these files needs it.
 */
export function prepareEnvironmentTexture(texture: THREE.Texture): THREE.Texture {
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter =
    texture.mipmaps !== undefined && texture.mipmaps.length > 1
      ? THREE.LinearMipmapLinearFilter
      : THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // Radiance, not colour: no transfer function to undo.
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}
