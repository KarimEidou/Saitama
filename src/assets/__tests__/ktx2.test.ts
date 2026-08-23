/**
 * KTX2 / BASIS CONVENTIONS
 *
 * Every setting this module applies was measured against the real files, and
 * getting one wrong fails SILENTLY — the texture loads, the frame renders, and
 * the shading is subtly or completely wrong. Nothing downstream throws, so
 * these assertions are the only thing standing between a three.js bump and an
 * upside-down sky or a normal map sampled as colour.
 *
 * `createKTX2Loader` and `parseKTX2` are deliberately absent: they need a live
 * renderer and a transcoder worker. Everything else here is a pure function
 * over a `THREE.Texture` and needs no GL context at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
  codecOf,
  describeTranscodeSupport,
  gpuFormatName,
  isCompressedTexture,
  prepareEnvironmentTexture,
  prepareTexture,
} from '../ktx2';

/** A renderer stub exposing exactly the extensions named. */
function rendererWith(...extensions: readonly string[]): {
  extensions: { has(n: string): boolean };
} {
  const available = new Set(extensions);
  return { extensions: { has: (name: string): boolean => available.has(name) } };
}

const ASTC = 'WEBGL_compressed_texture_astc';
const ETC = 'WEBGL_compressed_texture_etc';
const ETC1 = 'WEBGL_compressed_texture_etc1';
const S3TC = 'WEBGL_compressed_texture_s3tc';
const BPTC = 'EXT_texture_compression_bptc';

describe('prepareTexture', () => {
  it('applies the pipeline conventions to a tileable colour map', () => {
    const texture = prepareTexture(new THREE.Texture(), 'srgb', 8, true);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    // Bottom-left origin is baked in (KTXorientation: ru). Flipping again would
    // invert every normal map's green channel and mirror the albedo.
    expect(texture.flipY).toBe(false);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(texture.anisotropy).toBe(8);
    // Mips ship inside the container; building more would decode the
    // compressed payload on the CPU.
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.minFilter).toBe(THREE.LinearFilter);
  });

  it('clamps a non-tileable map and leaves a data map in linear', () => {
    const texture = prepareTexture(new THREE.Texture(), 'linear', 1, false);
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
  });

  it('filters through the mip chain the container already carries', () => {
    const texture = new THREE.Texture();
    texture.mipmaps = [{}, {}] as unknown as THREE.Texture['mipmaps'];
    prepareTexture(texture, 'srgb', 4, true);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(texture.generateMipmaps).toBe(false);
  });
});

describe('prepareEnvironmentTexture', () => {
  it('undoes what KTX2Loader gets wrong for an equirect', () => {
    // The environment maps are uncompressed RGBA16F, so the loader takes its
    // raw-texture path and hands back NearestFilter on min and mag with no
    // mapping. Point-sampling a 1024x512 equirect makes the sun disc a
    // flickering square and aliases the PMREM convolution.
    const texture = prepareEnvironmentTexture(new THREE.Texture());
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    // Clamped vertically: a wrapping wrapT mirrors the poles into each other.
    expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
    // Radiance, not colour: there is no transfer function to undo.
    expect(texture.colorSpace).toBe(THREE.NoColorSpace);
    expect(texture.flipY).toBe(false);
    expect(texture.generateMipmaps).toBe(false);
  });
});

describe('gpuFormatName', () => {
  it('names a format three knows', () => {
    const texture = new THREE.CompressedTexture([], 4, 4, THREE.RGBA_BPTC_Format);
    expect(gpuFormatName(texture)).toBe('RGBA_BPTC_Format');
  });

  it('degrades honestly for one it does not', () => {
    const texture = new THREE.Texture();
    texture.format = THREE.RGBAIntegerFormat;
    expect(gpuFormatName(texture)).toMatch(/^format#\d+$/);
  });
});

describe('isCompressedTexture', () => {
  it('separates a block-compressed upload from a plain one', () => {
    expect(isCompressedTexture(new THREE.CompressedTexture([], 4, 4, THREE.RGBA_BPTC_Format))).toBe(
      true
    );
    expect(isCompressedTexture(new THREE.Texture())).toBe(false);
  });
});

describe('codecOf', () => {
  function compressed(format: THREE.CompressedPixelFormat): THREE.Texture {
    return new THREE.CompressedTexture([], 4, 4, format) as unknown as THREE.Texture;
  }

  it('reports no codec for an uncompressed upload', () => {
    expect(codecOf(new THREE.Texture())).toBe('none');
  });

  it('maps the formats the union can name', () => {
    expect(codecOf(compressed(THREE.RGBA_ASTC_4x4_Format))).toBe('astc');
    expect(codecOf(compressed(THREE.RGBA_BPTC_Format))).toBe('bc7');
    expect(codecOf(compressed(THREE.RGB_ETC2_Format))).toBe('etc1s');
  });

  it('reports what the FILE was for a format the union cannot name', () => {
    // The union predates this pipeline and has no S3TC member. Inventing a
    // target the device is not using would misreport the memory cost as well
    // as the codec.
    const dxt5 = compressed(THREE.RGBA_S3TC_DXT5_Format);
    expect(codecOf(dxt5)).toBe('uastc');
    expect(codecOf(dxt5, 'etc1s')).toBe('etc1s');
  });
});

describe('describeTranscodeSupport', () => {
  it('reports the families the context actually exposes', () => {
    const support = describeTranscodeSupport(rendererWith(S3TC, BPTC));
    expect(support.s3tc).toBe(true);
    expect(support.bptc).toBe(true);
    expect(support.astc).toBe(false);
    expect(support.etc2).toBe(false);
    expect(support.etc1).toBe(false);
    expect(support.pvrtc).toBe(false);
    expect(support.extensions).toEqual(['bptc', 's3tc']);
    expect(support.emulatedFormatsSuppressed).toBe(false);
  });

  describe('on Linux', () => {
    const stubNavigator = (platform: string, userAgent: string): void => {
      vi.stubGlobal('navigator', { platform, userAgent });
    };
    beforeEach(() => stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124'));
    afterEach(() => vi.unstubAllGlobals());

    it('suppresses ASTC and ETC that Mesa only emulates', () => {
      // Chrome and Firefox on Linux expose ASTC and ETC through Mesa on AMD and
      // Intel hardware that has neither; transcoding into them lands in an
      // expensive software decompress on the main thread. `KTX2Loader` disables
      // them and BC7 wins — which is why SwiftShader reports BC7.
      const support = describeTranscodeSupport(rendererWith(ASTC, ETC, ETC1, BPTC, S3TC));
      expect(support.astc).toBe(false);
      expect(support.etc1).toBe(false);
      expect(support.etc2).toBe(false);
      expect(support.bptc).toBe(true);
      expect(support.emulatedFormatsSuppressed).toBe(true);
    });

    it('never fires on a phone that really has ASTC', () => {
      // A real Android UA reports `Linux` too, and a phone's ASTC is hardware.
      stubNavigator('Linux armv8l', 'Mozilla/5.0 (Linux; Android 13) Chrome/124');
      const support = describeTranscodeSupport(rendererWith(ASTC, ETC, ETC1, BPTC, S3TC));
      expect(support.astc).toBe(true);
      expect(support.etc2).toBe(true);
      expect(support.emulatedFormatsSuppressed).toBe(false);
    });
  });
});
