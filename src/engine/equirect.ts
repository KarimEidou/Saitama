/**
 * EQUIRECTANGULAR TEXTURE ACCESS
 *
 * Reading pixels back out of a `THREE.Texture` is fiddly in ways that are easy
 * to get subtly wrong: half-float payloads need manual decoding, channel count
 * depends on the pixel format, and byte data may or may not carry an sRGB
 * transfer. Two consumers need exactly the same logic — the CPU spherical-
 * harmonic projector and the environment downsampler — so it lives here once.
 *
 * Everything here is CPU-side and synchronous. It is only ever called during
 * loading, never per frame.
 */

import * as THREE from 'three';

/** Numeric image payload a readable texture can carry. */
type TexelArray = Float32Array | Uint16Array | Uint8Array | Uint8ClampedArray;

interface ReadableImage {
  data?: TexelArray;
  width?: number;
  height?: number;
}

/** Linear-space random access to a texture's pixels. */
export interface IEquirectReader {
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  /** Linear value of one component. `index` is a raw component offset. */
  read(index: number): number;
}

/** IEC 61966-2-1 sRGB electro-optical transfer function. */
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** How many components each texel occupies. */
function channelsFor(format: THREE.AnyPixelFormat): number {
  switch (format) {
    case THREE.RedFormat:
      return 1;
    case THREE.RGFormat:
      return 2;
    case THREE.RGBAFormat:
      return 4;
    default:
      return 4;
  }
}

/**
 * Open a texture for CPU reading, or return null when its pixels are not
 * reachable.
 *
 * Readable: `DataTexture`, and the output of `RGBELoader` / `EXRLoader` /
 * `UltraHDRLoader`. NOT readable: anything built from a DOM `<img>` (the pixels
 * live in the browser's decoder) or a compressed KTX2 (the pixels are in a GPU
 * format nothing here can decode). Callers must handle null rather than assume.
 */
export function createEquirectReader(texture: THREE.Texture): IEquirectReader | null {
  const image = texture.image as ReadableImage | undefined;
  const data = image?.data;
  const width = image?.width ?? 0;
  const height = image?.height ?? 0;
  if (!data || width < 2 || height < 2) return null;

  const channels = channelsFor(texture.format);

  let read: (index: number) => number;
  if (texture.type === THREE.HalfFloatType && data instanceof Uint16Array) {
    read = (index) => THREE.DataUtils.fromHalfFloat(data[index]!);
  } else if (data instanceof Float32Array) {
    read = (index) => data[index]!;
  } else {
    // Byte data: normalise, and undo the sRGB transfer when the texture is
    // tagged as colour. An LDR "HDRI" is unusual but a caller may hand one over.
    const isSrgb = texture.colorSpace === THREE.SRGBColorSpace;
    read = (index) => {
      const value = data[index]! / 255;
      return isSrgb ? srgbToLinear(value) : value;
    };
  }

  return { width, height, channels, read };
}

/**
 * Box-filter an equirectangular radiance map down to `targetWidth` (height is
 * always half the width).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `PMREMGenerator` derives its cube size from the SOURCE resolution
 * (`equirect.width / 4`) and offers no way to ask for a smaller one. Feeding it
 * a real 4096-wide HDRI therefore produces a 1024px cube — roughly 25 MB of
 * RGBA16F. When all that is wanted is a low-frequency SPECULAR probe, the
 * source has to be shrunk first. Shrinking it here, on the CPU, costs a few
 * milliseconds during loading and needs no render target, no extra shader
 * program, and no GPU readback.
 *
 * A box filter is the right choice: the result is about to be convolved into
 * roughness mips anyway, so filter quality below the Nyquist limit is
 * irrelevant, and averaging every source texel (rather than point-sampling)
 * keeps the sun's total energy intact instead of losing or duplicating it
 * depending on where the disc lands.
 *
 * @returns A float RGBA `DataTexture` the caller owns and must dispose, or null
 *          when the source pixels are unreachable.
 */
export function downsampleEquirect(
  texture: THREE.Texture,
  targetWidth: number
): THREE.DataTexture | null {
  const reader = createEquirectReader(texture);
  if (!reader) return null;

  const width = Math.max(8, Math.min(reader.width, Math.round(targetWidth)));
  const height = Math.max(4, width >> 1);
  if (width >= reader.width && height >= reader.height) {
    // Already at or below the target; nothing to gain from a copy.
    return null;
  }

  const { channels, read } = reader;
  const out = new Float32Array(width * height * 4);
  const xRatio = reader.width / width;
  const yRatio = reader.height / height;

  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.min(reader.height, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)));

    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.min(reader.width, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)));

      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const index = (sy * reader.width + sx) * channels;
          const cr = read(index);
          r += cr;
          g += channels > 1 ? read(index + 1) : cr;
          b += channels > 2 ? read(index + 2) : cr;
          count++;
        }
      }

      const inverse = count > 0 ? 1 / count : 0;
      const target = (y * width + x) * 4;
      out[target] = r * inverse;
      out[target + 1] = g * inverse;
      out[target + 2] = b * inverse;
      out[target + 3] = 1;
    }
  }

  const result = new THREE.DataTexture(out, width, height, THREE.RGBAFormat, THREE.FloatType);
  result.name = `${texture.name || 'hdri'}.x${width}`;
  result.mapping = THREE.EquirectangularReflectionMapping;
  result.colorSpace = THREE.LinearSRGBColorSpace;
  result.wrapS = THREE.RepeatWrapping;
  result.wrapT = THREE.ClampToEdgeWrapping;
  result.minFilter = THREE.LinearFilter;
  result.magFilter = THREE.LinearFilter;
  result.generateMipmaps = false;
  // Matches the source convention: data row 0 is v = 0, i.e. straight down.
  result.flipY = false;
  result.needsUpdate = true;
  return result;
}
