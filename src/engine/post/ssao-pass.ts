/**
 * HALF-RESOLUTION SSAO WITH A BILATERAL UPSAMPLE
 *
 * ── WHY NOT three's `SSAOPass` ─────────────────────────────────────────────
 * The stock pass runs its normal/depth prepass and its AO resolve at FULL
 * resolution with a 32-sample kernel, then blurs and composites — four
 * full-resolution passes. Ambient occlusion is an extremely low-frequency
 * signal: it is contact darkening in creases and under objects. Computing it at
 * half resolution costs a quarter of the fragment work and is essentially
 * indistinguishable once upsampled, provided the upsample is depth-aware.
 *
 * ── THE PIPELINE ───────────────────────────────────────────────────────────
 *   1. PREPASS  (half res, RGBA16F) — `scene.overrideMaterial` writes view
 *      normal in RGB and linear view depth in A. One extra scene traversal, at
 *      a quarter of the pixels.
 *   2. RESOLVE  (half res, R8)      — 8 hemisphere samples per pixel, rotated
 *      per-pixel by a hash so the undersampling becomes noise instead of bands.
 *   3. COMPOSITE (full res)         — joint bilateral upsample of the AO buffer
 *      guided by the prepass depth AND normal, then multiply into the scene.
 *
 * ── WHY THE UPSAMPLE HAS TO BE BILATERAL ───────────────────────────────────
 * A plain bilinear upscale of a half-res AO buffer bleeds occlusion across
 * silhouettes: a character standing in front of a distant wall gets a dark
 * halo traced around them. Weighting each tap by how well its depth and normal
 * agree with the surface being shaded rejects taps from the other side of the
 * edge, which is the entire difference between "cheap AO" and "obviously
 * broken AO".
 *
 * ── KNOWN LIMITATION ───────────────────────────────────────────────────────
 * `scene.overrideMaterial` replaces alpha-tested materials too, so foliage and
 * chain-link fences occlude as solid quads in the prepass. Fixing that needs a
 * per-material depth variant, which costs shader programs; at half resolution
 * the artefact is small enough to be the better trade.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/* -------------------------------------------------------------------------- */
/* Normal + depth prepass material                                            */
/* -------------------------------------------------------------------------- */

const NORMAL_DEPTH_VERTEX = /* glsl */ `
	#include <common>
	#include <batching_pars_vertex>
	#include <morphtarget_pars_vertex>
	#include <skinning_pars_vertex>

	uniform float uCameraFar;
	varying vec3 vNdNormal;
	varying float vNdDepth;

	void main() {
		#include <beginnormal_vertex>
		#include <morphinstance_vertex>
		#include <morphnormal_vertex>
		#include <skinbase_vertex>
		#include <skinnormal_vertex>
		#include <defaultnormal_vertex>

		#include <begin_vertex>
		#include <morphtarget_vertex>
		#include <skinning_vertex>
		#include <batching_vertex>
		#include <project_vertex>

		vNdNormal = normalize( transformedNormal );
		// Linear VIEW depth, normalised. Not gl_FragCoord.z: that is
		// hyperbolic, and reconstructing view position from it needs an extra
		// divide per sample in the AO loop.
		vNdDepth = -mvPosition.z / uCameraFar;
	}
`;

const NORMAL_DEPTH_FRAGMENT = /* glsl */ `
	varying vec3 vNdNormal;
	varying float vNdDepth;

	void main() {
		gl_FragColor = vec4( normalize( vNdNormal ) * 0.5 + 0.5, vNdDepth );
	}
`;

/* -------------------------------------------------------------------------- */
/* AO resolve                                                                 */
/* -------------------------------------------------------------------------- */

const FULLSCREEN_VERTEX = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

function aoFragment(sampleCount: number): string {
  return /* glsl */ `
	uniform sampler2D tNormalDepth;
	uniform vec3 uKernel[ ${sampleCount} ];
	uniform mat4 uProjection;
	uniform mat4 uProjectionInverse;
	uniform float uCameraFar;
	uniform float uRadius;
	uniform float uBias;
	uniform float uIntensity;
	varying vec2 vUv;

	vec3 viewPositionFromDepth( vec2 uv, float linearDepth ) {
		vec4 clip = vec4( uv * 2.0 - 1.0, -1.0, 1.0 );
		vec4 view = uProjectionInverse * clip;
		vec3 ray = view.xyz / view.w;
		ray /= -ray.z;
		return ray * ( linearDepth * uCameraFar );
	}

	float hash12( vec2 p ) {
		vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
		p3 += dot( p3, p3.yzx + 33.33 );
		return fract( ( p3.x + p3.y ) * p3.z );
	}

	void main() {
		vec4 centre = texture2D( tNormalDepth, vUv );
		float depth = centre.a;

		// Depth 0 means nothing was drawn — sky. Occluding the sky produces a
		// dark rim around every silhouette.
		if ( depth <= 0.0001 ) {
			gl_FragColor = vec4( 1.0 );
			return;
		}

		vec3 normal = normalize( centre.rgb * 2.0 - 1.0 );
		vec3 origin = viewPositionFromDepth( vUv, depth );

		// Per-pixel rotation of the kernel. Without it, 8 samples produce
		// visible banding; with it they produce noise, which the bilateral
		// upsample then smooths.
		float angle = hash12( gl_FragCoord.xy ) * 6.2831853;
		vec3 randomVec = vec3( cos( angle ), sin( angle ), 0.0 );
		vec3 tangent = normalize( randomVec - normal * dot( randomVec, normal ) );
		vec3 bitangent = cross( normal, tangent );
		mat3 tbn = mat3( tangent, bitangent, normal );

		float occlusion = 0.0;
		for ( int i = 0; i < ${sampleCount}; i ++ ) {
			vec3 samplePos = origin + tbn * uKernel[ i ] * uRadius;

			vec4 offset = uProjection * vec4( samplePos, 1.0 );
			vec2 sampleUv = ( offset.xy / offset.w ) * 0.5 + 0.5;
			if ( sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0 ) continue;

			float sampleDepth = texture2D( tNormalDepth, sampleUv ).a;
			if ( sampleDepth <= 0.0001 ) continue;
			float sampleViewZ = -sampleDepth * uCameraFar;

			// Range check: a wall 40m behind the sample must not occlude it.
			float rangeCheck = smoothstep( 0.0, 1.0, uRadius / abs( origin.z - sampleViewZ ) );
			occlusion += ( sampleViewZ >= samplePos.z + uBias ? 1.0 : 0.0 ) * rangeCheck;
		}

		float ao = 1.0 - ( occlusion / float( ${sampleCount} ) ) * uIntensity;
		gl_FragColor = vec4( vec3( clamp( ao, 0.0, 1.0 ) ), 1.0 );
	}
`;
}

const COMPOSITE_FRAGMENT = /* glsl */ `
	uniform sampler2D tDiffuse;
	uniform sampler2D tAO;
	uniform sampler2D tNormalDepth;
	uniform vec2 uHalfResolution;
	uniform float uDepthSigma;
	uniform float uNormalPower;
	uniform float uBlend;
	varying vec2 vUv;

	void main() {
		vec4 scene = texture2D( tDiffuse, vUv );

		// Point-sample the guide buffer: the nearest half-res texel is a real
		// surface, whereas a bilinear read across a silhouette is a surface
		// that does not exist and would match nothing.
		vec2 texel = 1.0 / uHalfResolution;
		vec2 nearestUv = ( floor( vUv * uHalfResolution ) + 0.5 ) * texel;
		vec4 guide = texture2D( tNormalDepth, nearestUv );
		float guideDepth = guide.a;

		if ( guideDepth <= 0.0001 ) {
			gl_FragColor = scene;
			return;
		}

		vec3 guideNormal = normalize( guide.rgb * 2.0 - 1.0 );

		float aoSum = 0.0;
		float weightSum = 0.0;
		for ( int y = -1; y <= 1; y ++ ) {
			for ( int x = -1; x <= 1; x ++ ) {
				vec2 tapUv = nearestUv + vec2( float( x ), float( y ) ) * texel;
				vec4 tap = texture2D( tNormalDepth, tapUv );
				if ( tap.a <= 0.0001 ) continue;

				float depthWeight = exp( -abs( tap.a - guideDepth ) * uDepthSigma );
				vec3 tapNormal = normalize( tap.rgb * 2.0 - 1.0 );
				float normalWeight = pow( max( dot( tapNormal, guideNormal ), 0.0 ), uNormalPower );
				float weight = depthWeight * normalWeight;

				aoSum += texture2D( tAO, tapUv ).r * weight;
				weightSum += weight;
			}
		}

		float ao = weightSum > 0.0 ? aoSum / weightSum : 1.0;
		ao = mix( 1.0, ao, uBlend );
		gl_FragColor = vec4( scene.rgb * ao, scene.a );
	}
`;

/* -------------------------------------------------------------------------- */

export interface IHalfResSSAOOptions {
  /** Hemisphere samples per pixel. 8 is the mobile-viable count. */
  readonly samples?: number;
  /** Render scale of the AO buffers. 0.5 = half res. */
  readonly scale?: number;
  /** World-space sampling radius in metres. */
  readonly radius?: number;
  /** Depth bias in metres; fights self-occlusion acne on flat surfaces. */
  readonly bias?: number;
  /** Occlusion strength, 0..1+. */
  readonly intensity?: number;
}

export class HalfResSSAOPass extends Pass {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private readonly scale: number;
  private readonly sampleCount: number;

  private readonly normalDepthMaterial: THREE.ShaderMaterial;
  private readonly aoMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  private normalDepthTarget: THREE.WebGLRenderTarget;
  private aoTarget: THREE.WebGLRenderTarget;
  private width = 1;
  private height = 1;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    options: IHalfResSSAOOptions = {}
  ) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.scale = options.scale ?? 0.5;
    this.sampleCount = Math.max(4, Math.min(32, options.samples ?? 8));
    this.needsSwap = true;

    this.normalDepthMaterial = new THREE.ShaderMaterial({
      name: 'SSAO.normalDepth',
      uniforms: { uCameraFar: { value: camera.far } },
      vertexShader: NORMAL_DEPTH_VERTEX,
      fragmentShader: NORMAL_DEPTH_FRAGMENT,
    });

    this.aoMaterial = new THREE.ShaderMaterial({
      name: 'SSAO.resolve',
      uniforms: {
        tNormalDepth: { value: null },
        uKernel: { value: buildKernel(this.sampleCount) },
        uProjection: { value: new THREE.Matrix4() },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uCameraFar: { value: camera.far },
        uRadius: { value: options.radius ?? 0.7 },
        uBias: { value: options.bias ?? 0.03 },
        uIntensity: { value: options.intensity ?? 0.9 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: aoFragment(this.sampleCount),
      depthTest: false,
      depthWrite: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'SSAO.composite',
      uniforms: {
        tDiffuse: { value: null },
        tAO: { value: null },
        tNormalDepth: { value: null },
        uHalfResolution: { value: new THREE.Vector2(1, 1) },
        uDepthSigma: { value: 220 },
        uNormalPower: { value: 16 },
        uBlend: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COMPOSITE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.compositeMaterial);

    this.normalDepthTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.normalDepthTarget.texture.name = 'SSAO.normalDepth';
    this.aoTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.aoTarget.texture.name = 'SSAO.ao';
  }

  /** Re-point at a different scene/camera without rebuilding the pass. */
  setSceneAndCamera(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.camera = camera;
  }

  /** Occlusion strength, 0..1. 0 disables the effect without removing the pass. */
  setIntensity(intensity: number): void {
    this.compositeMaterial.uniforms.uBlend!.value = Math.min(1, Math.max(0, intensity));
  }

  setRadius(radius: number): void {
    this.aoMaterial.uniforms.uRadius!.value = radius;
  }

  override setSize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const halfWidth = Math.max(1, Math.round(this.width * this.scale));
    const halfHeight = Math.max(1, Math.round(this.height * this.scale));
    this.normalDepthTarget.setSize(halfWidth, halfHeight);
    this.aoTarget.setSize(halfWidth, halfHeight);
    (this.compositeMaterial.uniforms.uHalfResolution!.value as THREE.Vector2).set(
      halfWidth,
      halfHeight
    );
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    const camera = this.camera;
    this.normalDepthMaterial.uniforms.uCameraFar!.value = camera.far;
    this.aoMaterial.uniforms.uCameraFar!.value = camera.far;
    (this.aoMaterial.uniforms.uProjection!.value as THREE.Matrix4).copy(camera.projectionMatrix);
    (this.aoMaterial.uniforms.uProjectionInverse!.value as THREE.Matrix4).copy(
      camera.projectionMatrixInverse
    );

    /* --- 1. normal + depth prepass ------------------------------------- */
    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    const previousClearAlpha = renderer.getClearAlpha();
    const previousClearColor = new THREE.Color();
    renderer.getClearColor(previousClearColor);

    this.scene.overrideMaterial = this.normalDepthMaterial;
    // The sky must not write into the guide buffer: `overrideMaterial` does not
    // apply to the background, so it would land as opaque garbage.
    this.scene.background = null;
    renderer.setRenderTarget(this.normalDepthTarget);
    // Alpha 0 = "no surface here", which the shaders test for.
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);

    this.scene.overrideMaterial = previousOverride;
    this.scene.background = previousBackground;
    renderer.setClearColor(previousClearColor, previousClearAlpha);

    /* --- 2. AO resolve at half res -------------------------------------- */
    this.aoMaterial.uniforms.tNormalDepth!.value = this.normalDepthTarget.texture;
    this.fsQuad.material = this.aoMaterial;
    renderer.setRenderTarget(this.aoTarget);
    renderer.clear();
    this.fsQuad.render(renderer);

    /* --- 3. bilateral upsample and multiply into the scene -------------- */
    this.compositeMaterial.uniforms.tDiffuse!.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tAO!.value = this.aoTarget.texture;
    this.compositeMaterial.uniforms.tNormalDepth!.value = this.normalDepthTarget.texture;
    this.fsQuad.material = this.compositeMaterial;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  override dispose(): void {
    this.normalDepthMaterial.dispose();
    this.aoMaterial.dispose();
    this.compositeMaterial.dispose();
    this.normalDepthTarget.dispose();
    this.aoTarget.dispose();
    this.fsQuad.dispose();
  }
}

/**
 * Cosine-ish hemisphere kernel, deterministic so two runs produce identical
 * frames. Samples are pushed towards the origin with a quadratic falloff, which
 * concentrates them where contact occlusion actually happens.
 */
function buildKernel(count: number): THREE.Vector3[] {
  const kernel: THREE.Vector3[] = [];
  // Fixed LCG: SSAO is a rendering detail, but a nondeterministic one makes
  // screenshot comparison in the verification harness useless.
  let seed = 0x2f6e2b1;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < count; i++) {
    const vector = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random());
    vector.normalize();
    const t = i / count;
    vector.multiplyScalar(0.1 + 0.9 * t * t);
    kernel.push(vector);
  }
  return kernel;
}
