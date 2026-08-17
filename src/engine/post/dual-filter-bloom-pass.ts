/**
 * DUAL-FILTER (KAWASE) BLOOM — three shader programs instead of nine.
 *
 * ── WHY THIS REPLACED `UnrealBloomPass` ────────────────────────────────────
 * `UnrealBloomPass` is nine distinct shader programs: five separable blur
 * materials (one per mip, each baking a different `KERNEL_RADIUS` into its
 * source), a luminosity high-pass, a composite, a copy and a basic blit. Nine
 * programs is more than a third of this project's ≤24 whole-game budget spent
 * on one effect — and with `KHR_parallel_shader_compile` unavailable on the
 * target devices, every one of them is a synchronous main-thread link.
 *
 * Dual filtering (Bjørge, "Bandwidth-Efficient Rendering", SIGGRAPH 2015) gets
 * the same look from two tiny fixed kernels applied repeatedly:
 *
 *   DOWN  5 taps: centre x4 plus the four diagonal half-texel corners, /8
 *   UP    8 taps: a weighted ring one and two half-texels out, /12
 *
 * Because the kernels never change, the whole pyramid — however many levels —
 * is TWO programs. A third composites bloom over the scene. Three total.
 *
 * It is also the cheaper algorithm, not merely the cheaper compile. Separable
 * Gaussian at radius r is 2r texture fetches per pixel per level; dual filtering
 * is 5 down / 8 up regardless of blur width, because width comes from pyramid
 * DEPTH rather than kernel size. That is exactly the trade a bandwidth-bound
 * mobile GPU wants: fewer fetches, more (much smaller) passes.
 *
 * ── PREFILTER IN THE SAME PROGRAM ──────────────────────────────────────────
 * The threshold/knee prefilter would naturally be a fourth program. Instead the
 * downsample shader carries a `uPrefilter` uniform and branches on it. The
 * branch is uniform-coherent — every fragment in a given draw takes the same
 * side — so it is effectively free on every GPU this ships to, and it saves a
 * program plus a full-resolution round trip.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERTEX_SHADER = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

/**
 * Downsample by 2, optionally applying the bright-pass.
 *
 * `uTexel` is one texel of the SOURCE, so the four diagonal taps land exactly
 * on the corners between source texels and the hardware's bilinear unit gives
 * four samples for the price of one — the reason this kernel is only 5 fetches.
 */
const DOWNSAMPLE_FRAGMENT = /* glsl */ `
	uniform sampler2D tSource;
	uniform vec2 uTexel;
	uniform float uPrefilter;
	uniform float uThreshold;
	uniform float uKnee;
	uniform float uClamp;
	varying vec2 vUv;

	void main() {
		vec2 halfTexel = uTexel * 0.5;

		vec3 sum = texture2D( tSource, vUv ).rgb * 4.0;
		sum += texture2D( tSource, vUv + vec2( -halfTexel.x, -halfTexel.y ) ).rgb;
		sum += texture2D( tSource, vUv + vec2(  halfTexel.x,  halfTexel.y ) ).rgb;
		sum += texture2D( tSource, vUv + vec2(  halfTexel.x, -halfTexel.y ) ).rgb;
		sum += texture2D( tSource, vUv + vec2( -halfTexel.x,  halfTexel.y ) ).rgb;
		vec3 color = sum * 0.125;

		if ( uPrefilter > 0.5 ) {
			// Clamp before thresholding: one pixel of a 5000-nit specular
			// highlight would otherwise smear a solid block across the frame
			// once the pyramid blurs it. This is the classic "firefly" fix.
			color = min( color, vec3( uClamp ) );

			// Soft-knee bright pass (Jimenez, "Next Generation Post
			// Processing"). A hard threshold makes bloom pop in and out as a
			// surface crosses it; the knee makes the onset continuous.
			float brightness = max( color.r, max( color.g, color.b ) );
			float soft = brightness - uThreshold + uKnee;
			soft = clamp( soft, 0.0, 2.0 * uKnee );
			soft = soft * soft / ( 4.0 * uKnee + 1e-4 );
			float contribution = max( soft, brightness - uThreshold ) / max( brightness, 1e-4 );
			color *= contribution;
		}

		gl_FragColor = vec4( color, 1.0 );
	}
`;

/** Upsample by 2 with the dual-filter tent. Blended ADDITIVELY into the target. */
const UPSAMPLE_FRAGMENT = /* glsl */ `
	uniform sampler2D tSource;
	uniform vec2 uTexel;
	varying vec2 vUv;

	void main() {
		vec2 halfTexel = uTexel * 0.5;

		vec3 sum = texture2D( tSource, vUv + vec2( -halfTexel.x * 2.0, 0.0 ) ).rgb;
		sum += texture2D( tSource, vUv + vec2( -halfTexel.x, halfTexel.y ) ).rgb * 2.0;
		sum += texture2D( tSource, vUv + vec2( 0.0, halfTexel.y * 2.0 ) ).rgb;
		sum += texture2D( tSource, vUv + vec2( halfTexel.x, halfTexel.y ) ).rgb * 2.0;
		sum += texture2D( tSource, vUv + vec2( halfTexel.x * 2.0, 0.0 ) ).rgb;
		sum += texture2D( tSource, vUv + vec2( halfTexel.x, -halfTexel.y ) ).rgb * 2.0;
		sum += texture2D( tSource, vUv + vec2( 0.0, -halfTexel.y * 2.0 ) ).rgb;
		sum += texture2D( tSource, vUv + vec2( -halfTexel.x, -halfTexel.y ) ).rgb * 2.0;

		gl_FragColor = vec4( sum / 12.0, 1.0 );
	}
`;

const COMPOSITE_FRAGMENT = /* glsl */ `
	uniform sampler2D tScene;
	uniform sampler2D tBloom;
	uniform float uStrength;
	varying vec2 vUv;

	void main() {
		vec4 scene = texture2D( tScene, vUv );
		vec3 bloom = texture2D( tBloom, vUv ).rgb;
		gl_FragColor = vec4( scene.rgb + bloom * uStrength, scene.a );
	}
`;

export interface IDualFilterBloomOptions {
  /** Bloom contribution added to the scene. */
  readonly strength?: number;
  /** Luminance above which a pixel blooms. 1.0 = anything above display white. */
  readonly threshold?: number;
  /** Width of the soft knee around the threshold. */
  readonly knee?: number;
  /** Resolution of the first pyramid level, relative to the frame. */
  readonly scale?: number;
  /**
   * Pyramid levels. Blur WIDTH comes from depth, not from kernel size, so this
   * is the "radius" knob. 4 is a wide, filmic bloom at quarter-res start.
   */
  readonly iterations?: number;
  /** Firefly clamp applied before thresholding, in linear HDR units. */
  readonly clamp?: number;
}

export class DualFilterBloomPass extends Pass {
  private readonly downsampleMaterial: THREE.ShaderMaterial;
  private readonly upsampleMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  private mips: THREE.WebGLRenderTarget[] = [];
  private readonly scale: number;
  private readonly iterations: number;
  private width = 1;
  private height = 1;

  constructor(options: IDualFilterBloomOptions = {}) {
    super();
    this.needsSwap = true;
    this.scale = Math.min(1, Math.max(0.05, options.scale ?? 0.25));
    this.iterations = Math.max(1, Math.min(8, options.iterations ?? 4));

    this.downsampleMaterial = new THREE.ShaderMaterial({
      name: 'DualFilterBloom.down',
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uPrefilter: { value: 0 },
        uThreshold: { value: options.threshold ?? 1 },
        uKnee: { value: options.knee ?? 0.35 },
        uClamp: { value: options.clamp ?? 24 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: DOWNSAMPLE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.upsampleMaterial = new THREE.ShaderMaterial({
      name: 'DualFilterBloom.up',
      uniforms: {
        tSource: { value: null },
        uTexel: { value: new THREE.Vector2() },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: UPSAMPLE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      // Additive so each level accumulates into the one below it without a
      // ping-pong buffer and without a second "combine" program.
      blending: THREE.AdditiveBlending,
      transparent: true,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'DualFilterBloom.composite',
      uniforms: {
        tScene: { value: null },
        tBloom: { value: null },
        uStrength: { value: options.strength ?? 0.35 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.compositeMaterial);
  }

  /** Bloom contribution added to the scene. */
  get strength(): number {
    return this.compositeMaterial.uniforms.uStrength!.value as number;
  }

  set strength(value: number) {
    this.compositeMaterial.uniforms.uStrength!.value = value;
  }

  get threshold(): number {
    return this.downsampleMaterial.uniforms.uThreshold!.value as number;
  }

  set threshold(value: number) {
    this.downsampleMaterial.uniforms.uThreshold!.value = value;
  }

  /** Levels actually allocated, which may be fewer than requested at low res. */
  get levels(): number {
    return this.mips.length;
  }

  /** Total bytes the pyramid holds. RGBA16F, 8 bytes per texel. */
  get gpuBytes(): number {
    let total = 0;
    for (const mip of this.mips) total += mip.width * mip.height * 8;
    return total;
  }

  override setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.disposeMips();

    let mipWidth = Math.max(2, Math.round(this.width * this.scale));
    let mipHeight = Math.max(2, Math.round(this.height * this.scale));

    for (let i = 0; i < this.iterations; i++) {
      const target = new THREE.WebGLRenderTarget(mipWidth, mipHeight, {
        // Half float: the pyramid carries pre-tone-map HDR values. An LDR
        // pyramid would clip every highlight to 1.0 and a threshold of 1.0
        // would then match nothing at all.
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
      target.texture.name = `bloom.mip${i}`;
      // Clamped: the kernels sample outside the level at its edges, and
      // repeating would wrap the top of the frame into the bottom.
      target.texture.wrapS = THREE.ClampToEdgeWrapping;
      target.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.mips.push(target);

      if (mipWidth <= 4 || mipHeight <= 4) break;
      mipWidth = Math.max(2, Math.floor(mipWidth / 2));
      mipHeight = Math.max(2, Math.floor(mipHeight / 2));
    }
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    if (this.mips.length === 0) this.setSize(this.width, this.height);

    // Every step writes its whole target, and the upsample chain must NOT be
    // cleared between levels — it accumulates. `FullScreenQuad.render()` goes
    // through `renderer.render()`, which honours `autoClear`.
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    const texel = this.downsampleMaterial.uniforms.uTexel!.value as THREE.Vector2;

    /* --- prefilter + first downsample, straight from the scene ---------- */
    this.fsQuad.material = this.downsampleMaterial;
    this.downsampleMaterial.uniforms.tSource!.value = readBuffer.texture;
    this.downsampleMaterial.uniforms.uPrefilter!.value = 1;
    texel.set(1 / readBuffer.width, 1 / readBuffer.height);
    renderer.setRenderTarget(this.mips[0]!);
    this.fsQuad.render(renderer);

    /* --- remaining downsamples ------------------------------------------ */
    this.downsampleMaterial.uniforms.uPrefilter!.value = 0;
    for (let i = 1; i < this.mips.length; i++) {
      const source = this.mips[i - 1]!;
      this.downsampleMaterial.uniforms.tSource!.value = source.texture;
      texel.set(1 / source.width, 1 / source.height);
      renderer.setRenderTarget(this.mips[i]!);
      this.fsQuad.render(renderer);
    }

    /* --- upsample, accumulating downwards ------------------------------- */
    this.fsQuad.material = this.upsampleMaterial;
    const upTexel = this.upsampleMaterial.uniforms.uTexel!.value as THREE.Vector2;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const source = this.mips[i]!;
      this.upsampleMaterial.uniforms.tSource!.value = source.texture;
      upTexel.set(1 / source.width, 1 / source.height);
      renderer.setRenderTarget(this.mips[i - 1]!);
      this.fsQuad.render(renderer);
    }

    /* --- composite over the scene --------------------------------------- */
    this.fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.tScene!.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tBloom!.value = this.mips[0]!.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);

    renderer.autoClear = previousAutoClear;
  }

  private disposeMips(): void {
    for (const mip of this.mips) mip.dispose();
    this.mips = [];
  }

  override dispose(): void {
    this.disposeMips();
    this.downsampleMaterial.dispose();
    this.upsampleMaterial.dispose();
    this.compositeMaterial.dispose();
    this.fsQuad.dispose();
  }
}
