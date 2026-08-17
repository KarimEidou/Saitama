/**
 * COLOUR GRADING — a 32³ LUT baked into a 1024x32 strip.
 *
 * ── WHY A STRIP AND NOT A `Data3DTexture` ──────────────────────────────────
 * three ships `LUTPass`, which wants a `sampler3D`. That works on desktop and
 * is a liability on mobile: 3D textures are a WebGL2-only sampler type with
 * patchy driver quality on older Mali and Adreno parts, they cannot be stored
 * in any of the compressed formats this project ships (ASTC/ETC), and they
 * cannot be authored in an image editor. A 1024x32 RGBA strip is an ordinary
 * 2D texture — 128 KB, uploadable anywhere, and a colourist can open it in
 * Photoshop. The extra cost is one manual lerp between two blue slices, which
 * is three ALU instructions.
 *
 * ── LAYOUT ─────────────────────────────────────────────────────────────────
 * 32 slices laid left to right. Slice index is BLUE. Inside a slice, x is RED
 * and y is GREEN. Sampling insets by half a texel on both axes so bilinear
 * filtering interpolates between grid points rather than off the edge.
 *
 * ── COLOUR SPACE ───────────────────────────────────────────────────────────
 * The LUT is applied in DISPLAY space, after tone mapping and after the sRGB
 * transfer — that is the convention every grading tool authors against. Applying
 * it in linear space would make the same table produce a completely different
 * look, so the texture is tagged `NoColorSpace` and sampled raw.
 */

import * as THREE from 'three';

/** Edge size of the cube. 32 is the industry-standard grading resolution. */
export const LUT_SIZE = 32;
/** Strip width: `LUT_SIZE` slices of `LUT_SIZE` pixels. */
export const LUT_STRIP_WIDTH = LUT_SIZE * LUT_SIZE;
/** Strip height. */
export const LUT_STRIP_HEIGHT = LUT_SIZE;

/** Per-channel grading parameters. All operate in display space, 0..1. */
export interface IGradeOptions {
  /** Additive shadow tint, per channel. Small values, e.g. ±0.03. */
  readonly lift?: readonly [number, number, number];
  /** Midtone gamma, per channel. 1 is neutral. */
  readonly gamma?: readonly [number, number, number];
  /** Highlight multiplier, per channel. 1 is neutral. */
  readonly gain?: readonly [number, number, number];
  /** Saturation multiplier. 1 is neutral, 1.15 is a gentle boost. */
  readonly saturation?: number;
  /** S-curve contrast around 0.5. 0 is neutral, 0.2 is noticeable. */
  readonly contrast?: number;
  /** Warm/cool shift. Positive warms highlights and cools shadows. */
  readonly temperature?: number;
}

/**
 * The house look: a touch of contrast, warm highlights, cool shadows, and a
 * saturation lift. Manga panels are high-contrast and colour-separated; this
 * nudges an otherwise photographic PBR render in that direction without going
 * stylised enough to fight the lighting.
 */
export const ANIME_GRADE: IGradeOptions = {
  lift: [-0.005, 0.0, 0.012],
  gamma: [1.0, 1.0, 1.02],
  gain: [1.04, 1.0, 0.97],
  saturation: 1.14,
  contrast: 0.16,
  temperature: 0.05,
};

/** A LUT that changes nothing. Useful for A/B and for regression tests. */
export const NEUTRAL_GRADE: IGradeOptions = {};

function applyGrade(
  r: number,
  g: number,
  b: number,
  options: IGradeOptions
): [number, number, number] {
  const lift = options.lift ?? [0, 0, 0];
  const gamma = options.gamma ?? [1, 1, 1];
  const gain = options.gain ?? [1, 1, 1];
  const saturation = options.saturation ?? 1;
  const contrast = options.contrast ?? 0;
  const temperature = options.temperature ?? 0;

  let out: [number, number, number] = [r, g, b];

  // Lift / gamma / gain, the standard colourist triad.
  for (let i = 0; i < 3; i++) {
    const value = Math.max(0, out[i]! + lift[i]!);
    out[i] = Math.pow(value, 1 / Math.max(1e-3, gamma[i]!)) * gain[i]!;
  }

  // Temperature: push red up and blue down in the highlights, the reverse in
  // the shadows. Weighted by luma so midtones stay put.
  if (temperature !== 0) {
    const luma = out[0]! * 0.2126 + out[1]! * 0.7152 + out[2]! * 0.0722;
    const shift = temperature * (luma - 0.5) * 2;
    out[0] = out[0]! + shift * 0.06;
    out[2] = out[2]! - shift * 0.06;
  }

  // Saturation around the luma axis.
  if (saturation !== 1) {
    const luma = out[0]! * 0.2126 + out[1]! * 0.7152 + out[2]! * 0.0722;
    for (let i = 0; i < 3; i++) out[i] = luma + (out[i]! - luma) * saturation;
  }

  // Smoothstep-shaped S-curve, blended by `contrast` so 0 is a true no-op.
  if (contrast !== 0) {
    for (let i = 0; i < 3; i++) {
      const x = Math.min(1, Math.max(0, out[i]!));
      const s = x * x * (3 - 2 * x);
      out[i] = x + (s - x) * contrast * 2;
    }
  }

  out = [
    Math.min(1, Math.max(0, out[0]!)),
    Math.min(1, Math.max(0, out[1]!)),
    Math.min(1, Math.max(0, out[2]!)),
  ];
  return out;
}

/**
 * Bake a grading function into a strip texture.
 *
 * @returns A 1024x32 RGBA `DataTexture`. The caller owns and disposes it.
 */
export function bakeLutStrip(options: IGradeOptions = ANIME_GRADE): THREE.DataTexture {
  const size = LUT_SIZE;
  const width = LUT_STRIP_WIDTH;
  const height = LUT_STRIP_HEIGHT;
  const data = new Uint8Array(width * height * 4);
  const last = size - 1;

  for (let b = 0; b < size; b++) {
    const blue = b / last;
    for (let g = 0; g < size; g++) {
      const green = g / last;
      for (let r = 0; r < size; r++) {
        const red = r / last;
        const [outR, outG, outB] = applyGrade(red, green, blue, options);
        const x = b * size + r;
        const index = (g * width + x) * 4;
        data[index] = Math.round(outR * 255);
        data[index + 1] = Math.round(outG * 255);
        data[index + 2] = Math.round(outB * 255);
        data[index + 3] = 255;
      }
    }
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.name = 'lut.strip32';
  // Display-referred values, sampled raw. Tagging this sRGB would decode the
  // table itself and produce a washed-out double transfer.
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * GLSL for sampling the strip. Shared by any pass that wants grading.
 *
 * `uLutSize` is the cube edge (32); the strip is assumed `size*size` wide and
 * `size` tall, which is what `bakeLutStrip` produces.
 */
export const LUT_STRIP_GLSL = /* glsl */ `
	vec3 sampleLutStrip( sampler2D lut, vec3 color, float size ) {
		vec3 c = clamp( color, 0.0, 1.0 );
		float last = size - 1.0;
		float sliceWidth = 1.0 / size;

		// Half-texel inset so bilinear filtering lands between grid points.
		float u = ( 0.5 + c.r * last ) / ( size * size );
		float v = ( 0.5 + c.g * last ) / size;

		float blue = c.b * last;
		float slice0 = floor( blue );
		float slice1 = min( slice0 + 1.0, last );
		float blend = blue - slice0;

		vec3 sample0 = texture2D( lut, vec2( u + slice0 * sliceWidth, v ) ).rgb;
		vec3 sample1 = texture2D( lut, vec2( u + slice1 * sliceWidth, v ) ).rgb;
		return mix( sample0, sample1, blend );
	}
`;
