/**
 * ANIME COMPOSITE — radial motion blur, chromatic aberration and speed lines
 * in ONE full-screen program.
 *
 * ── WHY ONE PASS ───────────────────────────────────────────────────────────
 * All three effects are radial functions of the same vector: `uv - focalPoint`.
 * Splitting them into three `ShaderPass` objects would triple the program count
 * and, worse, force three full-screen read/write round trips of the frame
 * buffer per frame. Bandwidth, not ALU, is the constraint on mobile: the
 * fetches cost more than the maths. Fused, the shared radial term is computed
 * once and the chromatic offsets ride along inside the motion-blur tap loop for
 * free.
 *
 * ── WHY THESE THREE EFFECTS ────────────────────────────────────────────────
 * This is an anime adaptation, and the source medium signals force with drawn
 * cues rather than photographic ones: radial speed lines on impact, a violent
 * zoom smear, and a colour fringe at the frame edge. They are gameplay
 * feedback, not decoration — the player reads "that punch was serious" from the
 * screen before they read it from the damage number. Combat drives them through
 * the event bus; nothing here knows the combat system exists.
 *
 * ── COST DISCIPLINE ────────────────────────────────────────────────────────
 * When motion blur is off the shader takes a single tap. The branch is on a
 * uniform, so it is uniform-coherent across the whole draw and effectively
 * free on every GPU this ships to. Idle cost is therefore one texture fetch
 * plus a handful of ALU, which is what makes it acceptable to leave the pass
 * resident rather than adding and removing it (adding it mid-fight would
 * trigger the compile stall the effect is meant to punctuate).
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const MOTION_BLUR_TAPS = 6;

const VERTEX_SHADER = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
	}
`;

const FRAGMENT_SHADER = /* glsl */ `
	uniform sampler2D tDiffuse;
	uniform vec2 uFocal;
	uniform float uAspect;
	uniform float uTime;
	uniform float uMotionBlur;
	uniform float uChromatic;
	uniform float uSpeedLines;
	uniform vec3 uSpeedLineColor;
	uniform float uSpeedLineDensity;
	varying vec2 vUv;

	float hash11( float p ) {
		p = fract( p * 0.1031 );
		p *= p + 33.33;
		p *= p + p;
		return fract( p );
	}

	void main() {
		vec2 direction = vUv - uFocal;
		float radius = length( vec2( direction.x * uAspect, direction.y ) );

		// Chromatic aberration scales with radius: a real lens is sharp in the
		// centre and disperses towards the edge. Constant fringing looks like a
		// broken shader, not a lens.
		float ca = uChromatic * 0.010 * radius;

		vec3 color;
		if ( uMotionBlur > 0.001 ) {
			// Zoom smear towards the focal point, with the chromatic offsets
			// folded into the same taps.
			vec3 accum = vec3( 0.0 );
			for ( int i = 0; i < ${MOTION_BLUR_TAPS}; i ++ ) {
				float t = float( i ) / float( ${MOTION_BLUR_TAPS} - 1 );
				vec2 offset = direction * ( -uMotionBlur * 0.16 * t );
				vec2 uvTap = vUv + offset;
				accum.r += texture2D( tDiffuse, uvTap + direction * ca ).r;
				accum.g += texture2D( tDiffuse, uvTap ).g;
				accum.b += texture2D( tDiffuse, uvTap - direction * ca ).b;
			}
			color = accum / float( ${MOTION_BLUR_TAPS} );
		} else if ( uChromatic > 0.001 ) {
			color = vec3(
				texture2D( tDiffuse, vUv + direction * ca ).r,
				texture2D( tDiffuse, vUv ).g,
				texture2D( tDiffuse, vUv - direction * ca ).b
			);
		} else {
			color = texture2D( tDiffuse, vUv ).rgb;
		}

		if ( uSpeedLines > 0.001 ) {
			float angle = atan( direction.y, direction.x * uAspect );
			float cell = floor( ( angle / 6.2831853 + 0.5 ) * uSpeedLineDensity );
			// Two independent hashes: one picks which angular cells carry a
			// line, the other jitters its width so the fan is irregular.
			float pick = hash11( cell * 1.37 );
			float width = 0.22 + hash11( cell * 7.13 ) * 0.5;
			float local = fract( ( angle / 6.2831853 + 0.5 ) * uSpeedLineDensity );
			float line = smoothstep( width, 0.0, abs( local - 0.5 ) * 2.0 );
			line *= step( 0.55, pick );

			// Lines start away from the centre and animate outwards, so the
			// focal point stays readable during an impact.
			float inner = 0.18 + hash11( cell * 3.71 ) * 0.22;
			float travel = fract( uTime * 1.6 + hash11( cell * 11.9 ) );
			float reach = mix( 0.55, 1.05, travel );
			float radialMask = smoothstep( inner, inner + 0.16, radius ) *
				smoothstep( reach + 0.20, reach - 0.05, radius );

			color = mix( color, uSpeedLineColor, clamp( line * radialMask * uSpeedLines, 0.0, 1.0 ) );
		}

		gl_FragColor = vec4( color, 1.0 );
	}
`;

export interface IAnimeCompositeOptions {
  readonly motionBlur?: boolean;
  readonly chromaticAberration?: boolean;
  readonly speedLines?: boolean;
  /** Colour of the drawn speed lines. White reads as "impact", cyan as "aura". */
  readonly speedLineColor?: THREE.ColorRepresentation;
  /** Angular cells around the focal point. More = finer fan. */
  readonly speedLineDensity?: number;
}

export class AnimeCompositePass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private readonly fsQuad: FullScreenQuad;

  private motionBlurEnabled: boolean;
  private chromaticEnabled: boolean;
  private speedLinesEnabled: boolean;

  /** Target values the live uniforms ease towards. */
  private targetMotionBlur = 0;
  private targetChromatic = 0;
  private targetSpeedLines = 0;
  /** Seconds remaining on a triggered burst before it starts decaying. */
  private burstHold = 0;

  constructor(options: IAnimeCompositeOptions = {}) {
    super();
    this.motionBlurEnabled = options.motionBlur ?? true;
    this.chromaticEnabled = options.chromaticAberration ?? true;
    this.speedLinesEnabled = options.speedLines ?? true;

    this.material = new THREE.ShaderMaterial({
      name: 'AnimeCompositePass',
      uniforms: {
        tDiffuse: { value: null },
        uFocal: { value: new THREE.Vector2(0.5, 0.5) },
        uAspect: { value: 1 },
        uTime: { value: 0 },
        uMotionBlur: { value: 0 },
        uChromatic: { value: this.chromaticEnabled ? 0.35 : 0 },
        uSpeedLines: { value: 0 },
        uSpeedLineColor: { value: new THREE.Color(options.speedLineColor ?? 0xffffff) },
        uSpeedLineDensity: { value: options.speedLineDensity ?? 120 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this.targetChromatic = this.chromaticEnabled ? 0.35 : 0;
  }

  /**
   * Fire a combat burst. Intensities ramp in immediately and decay over
   * `hold + falloff` seconds.
   *
   * @param intensity 0..1, saturated from the punch's unbounded power.
   * @param focal     Screen-space impact point in 0..1, defaults to centre.
   * @param hold      Seconds at full intensity before the decay starts.
   */
  trigger(intensity: number, focal?: THREE.Vector2, hold = 0.08): void {
    const clamped = Math.min(1, Math.max(0, intensity));
    if (focal) (this.material.uniforms.uFocal!.value as THREE.Vector2).copy(focal);
    this.targetMotionBlur = this.motionBlurEnabled ? Math.max(this.targetMotionBlur, clamped) : 0;
    this.targetSpeedLines = this.speedLinesEnabled
      ? Math.max(this.targetSpeedLines, clamped)
      : 0;
    if (this.chromaticEnabled) {
      this.targetChromatic = Math.max(this.targetChromatic, 0.35 + clamped * 0.9);
    }
    this.burstHold = Math.max(this.burstHold, hold);
    // Jump straight to the target: an impact cue that eases IN is a cue that
    // arrives after the moment it was meant to punctuate.
    this.material.uniforms.uMotionBlur!.value = this.targetMotionBlur;
    this.material.uniforms.uSpeedLines!.value = this.targetSpeedLines;
    this.material.uniforms.uChromatic!.value = this.targetChromatic;
  }

  /** Advance the decay. `dt` is UNSCALED seconds — the effect must keep moving during hit-stop. */
  update(dt: number): void {
    this.material.uniforms.uTime!.value += dt;

    if (this.burstHold > 0) {
      this.burstHold -= dt;
      return;
    }

    const restChromatic = this.chromaticEnabled ? 0.35 : 0;
    // Exponential decay, frame-rate independent.
    const decay = Math.pow(0.0008, dt);
    this.targetMotionBlur *= decay;
    this.targetSpeedLines *= decay;
    this.targetChromatic = restChromatic + (this.targetChromatic - restChromatic) * decay;

    if (this.targetMotionBlur < 0.002) this.targetMotionBlur = 0;
    if (this.targetSpeedLines < 0.002) this.targetSpeedLines = 0;

    this.material.uniforms.uMotionBlur!.value = this.targetMotionBlur;
    this.material.uniforms.uSpeedLines!.value = this.targetSpeedLines;
    this.material.uniforms.uChromatic!.value = this.targetChromatic;
  }

  setEffectEnabled(effect: 'motionBlur' | 'chromaticAberration' | 'speedLines', enabled: boolean): void {
    switch (effect) {
      case 'motionBlur':
        this.motionBlurEnabled = enabled;
        if (!enabled) {
          this.targetMotionBlur = 0;
          this.material.uniforms.uMotionBlur!.value = 0;
        }
        break;
      case 'chromaticAberration':
        this.chromaticEnabled = enabled;
        this.targetChromatic = enabled ? 0.35 : 0;
        this.material.uniforms.uChromatic!.value = this.targetChromatic;
        break;
      case 'speedLines':
        this.speedLinesEnabled = enabled;
        if (!enabled) {
          this.targetSpeedLines = 0;
          this.material.uniforms.uSpeedLines!.value = 0;
        }
        break;
    }
  }

  /** Directly set an intensity, bypassing the burst envelope. */
  setIntensity(effect: 'motionBlur' | 'chromaticAberration' | 'speedLines', value: number): void {
    const clamped = Math.min(1, Math.max(0, value));
    switch (effect) {
      case 'motionBlur':
        this.targetMotionBlur = this.motionBlurEnabled ? clamped : 0;
        this.material.uniforms.uMotionBlur!.value = this.targetMotionBlur;
        break;
      case 'chromaticAberration':
        this.targetChromatic = this.chromaticEnabled ? clamped : 0;
        this.material.uniforms.uChromatic!.value = this.targetChromatic;
        break;
      case 'speedLines':
        this.targetSpeedLines = this.speedLinesEnabled ? clamped : 0;
        this.material.uniforms.uSpeedLines!.value = this.targetSpeedLines;
        break;
    }
  }

  /** Where the radial effects converge, in 0..1 screen space. */
  setFocalPoint(x: number, y: number): void {
    (this.material.uniforms.uFocal!.value as THREE.Vector2).set(x, y);
  }

  override setSize(width: number, height: number): void {
    this.material.uniforms.uAspect!.value = width / Math.max(1, height);
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    this.material.uniforms.tDiffuse!.value = readBuffer.texture;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  override dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
