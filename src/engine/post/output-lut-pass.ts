/**
 * OUTPUT PASS — tone mapping, colour grading, vignette and sRGB encode in ONE
 * full-screen program.
 *
 * three's stock `OutputPass` does tone mapping + colour space, and `LUTPass`
 * does grading, and a vignette is normally a third `ShaderPass`. That is three
 * full-screen passes: three programs, three render-target ping-pongs, three
 * full reads and writes of the frame buffer. On a mobile GPU the bandwidth of
 * those copies costs more than everything they compute.
 *
 * Merging them is possible because they are all pure per-pixel functions of the
 * same input with no neighbourhood access, so they compose trivially:
 *
 *   vignette (linear, pre-tonemap — it is a lens falloff, not a colour effect)
 *     -> ACES filmic tone map (HDR -> display range)
 *       -> sRGB transfer (display encode)
 *         -> LUT (display space, where grading is authored)
 *
 * Order matters. Grading before tone mapping would grade values above 1 that
 * the tone map then crushes; vignetting after tone mapping darkens toward black
 * in a perceptual space and produces a muddy ring instead of a lens falloff.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { LUT_SIZE, LUT_STRIP_GLSL } from './lut';

const VERTEX_SHADER = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

const FRAGMENT_SHADER = /* glsl */ `
	uniform sampler2D tDiffuse;
	uniform sampler2D uLut;
	uniform float uLutSize;
	uniform float uLutIntensity;
	uniform float uExposure;
	uniform float uVignette;
	uniform float uVignetteSoftness;
	varying vec2 vUv;

${LUT_STRIP_GLSL}

	// ACES filmic, Narkowicz's fit. Matches THREE.ACESFilmicToneMapping so the
	// LOW tier (which tone maps in-material) and the composer tiers agree.
	vec3 acesFilmic( vec3 color ) {
		const mat3 ACESInputMat = mat3(
			0.59719, 0.07600, 0.02840,
			0.35458, 0.90834, 0.13383,
			0.04823, 0.01566, 0.83777
		);
		const mat3 ACESOutputMat = mat3(
			1.60475, -0.10208, -0.00327,
			-0.53108, 1.10813, -0.07276,
			-0.07367, -0.00605, 1.07602
		);
		color = ACESInputMat * color;
		vec3 a = color * ( color + 0.0245786 ) - 0.000090537;
		vec3 b = color * ( 0.983729 * color + 0.4329510 ) + 0.238081;
		color = a / b;
		color = ACESOutputMat * color;
		return clamp( color, 0.0, 1.0 );
	}

	vec3 linearToSRGB( vec3 value ) {
		return mix(
			pow( value, vec3( 0.41666 ) ) * 1.055 - vec3( 0.055 ),
			value * 12.92,
			vec3( lessThanEqual( value, vec3( 0.0031308 ) ) )
		);
	}

	void main() {
		vec4 texel = texture2D( tDiffuse, vUv );
		vec3 color = texel.rgb * uExposure;

		if ( uVignette > 0.0 ) {
			vec2 centered = vUv - 0.5;
			float radius = length( centered ) * 1.4142;
			float falloff = smoothstep( 1.0, uVignetteSoftness, radius );
			color *= mix( 1.0, falloff, uVignette );
		}

		color = acesFilmic( color );
		color = linearToSRGB( color );

		if ( uLutIntensity > 0.0 ) {
			vec3 graded = sampleLutStrip( uLut, color, uLutSize );
			color = mix( color, graded, uLutIntensity );
		}

		gl_FragColor = vec4( color, texel.a );
	}
`;

export interface IOutputLutPassOptions {
  /** Baked 1024x32 strip. Grading is skipped when null. */
  readonly lut?: THREE.Texture | null;
  /** Grading blend, 0..1. */
  readonly lutIntensity?: number;
  /** Vignette strength, 0..1. */
  readonly vignette?: number;
  /** Radius where the vignette starts, 0..1. Larger = tighter ring. */
  readonly vignetteSoftness?: number;
  /** Exposure applied before tone mapping. Driven by `ILightingState`. */
  readonly exposure?: number;
}

export class OutputLutPass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  constructor(options: IOutputLutPassOptions = {}) {
    super();
    this.material = new THREE.ShaderMaterial({
      name: 'OutputLutPass',
      uniforms: {
        tDiffuse: { value: null },
        uLut: { value: options.lut ?? null },
        uLutSize: { value: LUT_SIZE },
        uLutIntensity: { value: options.lut ? (options.lutIntensity ?? 1) : 0 },
        uExposure: { value: options.exposure ?? 1 },
        uVignette: { value: options.vignette ?? 0.35 },
        uVignetteSoftness: { value: options.vignetteSoftness ?? 0.35 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  /** ACES exposure. Mirrors `renderer.toneMappingExposure` for the composer path. */
  setExposure(exposure: number): void {
    this.material.uniforms.uExposure!.value = exposure;
  }

  setLut(lut: THREE.Texture | null, intensity = 1): void {
    this.material.uniforms.uLut!.value = lut;
    this.material.uniforms.uLutIntensity!.value = lut ? intensity : 0;
  }

  setVignette(strength: number, softness?: number): void {
    this.material.uniforms.uVignette!.value = Math.min(1, Math.max(0, strength));
    if (softness !== undefined) this.material.uniforms.uVignetteSoftness!.value = softness;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    this.material.uniforms.tDiffuse!.value = readBuffer.texture;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
      this.fsQuad.render(renderer);
    }
  }

  override dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
