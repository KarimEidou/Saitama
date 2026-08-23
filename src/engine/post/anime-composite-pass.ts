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

/**
 * Motion-blur sampling. These two are ONE decision and have to be read
 * together: `MOTION_BLUR_SPAN_PX` is how far the pixel furthest from the focal
 * point is smeared at full intensity, in DEVICE pixels, and
 * `MOTION_BLUR_TAPS` is how many samples that span is divided into. What the
 * eye judges is the QUOTIENT — the gap between consecutive taps.
 *
 * Bilinear filtering blends a tap into its neighbour only while their 2x2
 * texel footprints still overlap, i.e. while the taps are under about 1.5 px
 * apart. Wider than that and the taps stop reading as a blur and start reading
 * as N discrete copies of the frame. That is precisely what shipped: 6 taps
 * spread across 16% of each pixel's own radius put the copies ~47 px apart on
 * a 1440p frame (0.16 x 1469 px corner radius / 5 intervals), and ~23 px apart
 * on a 1280x720 one. On screen it was not motion blur at all — it was a
 * violent dark smear with the kerb, the road markings and every building edge
 * repeated six times over, and it destroyed readability at the exact moment
 * the player was trying to read what had just landed.
 *
 * 16 px across 12 taps is 1.33 px between taps, and it stays 1.33 px at every
 * resolution: the span is budgeted in pixels and converted to a UV reach in
 * `setSize` rather than being a fixed fraction of the frame, so a 4K buffer
 * gets a 16 px smear sampled 12 times instead of a 42 px one sampled 12 times.
 * RAISING THE SPAN REQUIRES RAISING THE TAPS IN PROPORTION — 24 px wants 18
 * taps — or the ghosting comes straight back.
 *
 * Cost: three fetches per tap (the chromatic offsets ride along), so 36
 * texture fetches per pixel while a burst is live against 18 before. It is
 * paid on the HIGH tier alone — `low` and `medium` set all three anime flags
 * false and `PostProcessing` never constructs this pass for them — and only
 * for the ~0.9 s a burst takes to decay. Idle cost is untouched — a frame with
 * no burst in flight never enters this loop at all.
 */
const MOTION_BLUR_TAPS = 12;
const MOTION_BLUR_SPAN_PX = 16;

/**
 * Resting chromatic aberration, present at all times on the HIGH tier as a
 * subtle lens characteristic. Deliberately small: fringing you can NOTICE
 * outside of an impact reads as a broken shader rather than as a lens.
 */
const REST_CHROMATIC = 0.16;

/**
 * The UV reach one unit of `direction` earns at full intensity.
 *
 * `direction` is a UV vector, so `direction * reach` is a UV offset, and that
 * offset's length in pixels is `reach * radius * height` — it grows with the
 * pixel's distance from the focal point, which is what makes a zoom blur a
 * zoom blur rather than a uniform one. Anchoring the reach to the frame's own
 * corner radius (half the diagonal, in pixels) is what turns
 * `MOTION_BLUR_SPAN_PX` into a promise the shader can keep at any resolution.
 */
function motionBlurReach(width: number, height: number): number {
  return MOTION_BLUR_SPAN_PX / Math.max(1, 0.5 * Math.hypot(width, height));
}

/**
 * The value `radius` takes at the frame corner, which is where the smear is
 * budgeted to be exactly `MOTION_BLUR_SPAN_PX` long. The shader saturates
 * `radius` here so a focal point parked off to one side — or off-screen
 * entirely — cannot buy a longer smear, and therefore cannot buy back the
 * tap spacing this pass exists to keep down.
 */
function motionBlurMaxRadius(width: number, height: number): number {
  return 0.5 * Math.hypot(width / Math.max(1, height), 1);
}

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
	uniform float uMotionBlurReach;
	uniform float uMotionBlurMaxRadius;
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
			//
			// The centre is PROTECTED. Everything radial here converges on the
			// focal point, and the subject is standing on it — that is what an
			// impact focal point means. Smearing hardest exactly there made the
			// player the least readable object on screen during the one moment
			// the frame exists to communicate. The speed lines below hold their
			// centre clear for the same reason, but their mask is a moving
			// annulus rebuilt per angular cell, so it cannot be shared; this is
			// a plain static guard over the same radial term.
			float centreGuard = smoothstep( 0.12, 0.45, radius );
			// Nothing clamps the focal point to the frame, and callers can leave
			// a stale one behind, so the radius may run to twice its corner
			// value on the far side of an edge-anchored focal point. Left alone
			// that doubles the span AND the tap spacing, which is the ghosting
			// back. Saturating the radius costs one divide and holds the budget
			// for any focal point at all.
			float radiusGuard = min( 1.0, uMotionBlurMaxRadius / max( radius, 0.0001 ) );
			float smear = uMotionBlur * uMotionBlurReach * centreGuard * radiusGuard;
			vec3 accum = vec3( 0.0 );
			for ( int i = 0; i < ${MOTION_BLUR_TAPS}; i ++ ) {
				// The MIDPOINT of each of the ${MOTION_BLUR_TAPS} equal slices of
				// the span, not i/(N-1) across its two ends: the same fetch count
				// then buys N gaps instead of N-1, and the box being averaged
				// stops being double-weighted at the ends.
				float t = ( float( i ) + 0.5 ) / float( ${MOTION_BLUR_TAPS} );
				vec2 offset = direction * ( -smear * t );
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
			// focal point stays readable during an impact. BOTH ends advance
			// together — the spoke translates at constant length — and a
			// half-sine envelope puts the fract() wrap at zero opacity.
			// Ramping only the outer end snapped every spoke back to half
			// length once per 0.625 s, which is roughly one wrap per cell
			// inside a typical burst: the fan shattered instead of streaming.
			float inner = 0.18 + hash11( cell * 3.71 ) * 0.22;
			float travel = fract( uTime * 1.6 + hash11( cell * 11.9 ) );
			float start = inner + travel * 0.45;
			float reach = start + 0.35;
			float radialMask = smoothstep( start, start + 0.16, radius ) *
				smoothstep( reach + 0.20, reach - 0.05, radius ) *
				sin( travel * 3.1415927 );

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
  /**
   * Sustained floors the decay eases TOWARDS rather than through.
   *
   * `setIntensity` writes these. Without them the decay in `update()` pulls
   * every directly-set intensity to zero within about 0.8 s at 60 fps, so a
   * settings slider wired to `IPostProcessing.setEffectIntensity` — documented
   * as a plain "scalar intensity in 0..1" — would silently undo itself.
   * `trigger()` still spikes above the floor and relaxes back down to it.
   */
  private sustainMotionBlur = 0;
  private sustainChromatic = 0;
  private sustainSpeedLines = 0;
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
        // Overwritten by the first `setSize`, which `EffectComposer` calls the
        // moment the pass joins a chain. The 1080p seed is what a pass built
        // and never sized gets — the unit tests do exactly that.
        uMotionBlurReach: { value: motionBlurReach(1920, 1080) },
        uMotionBlurMaxRadius: { value: motionBlurMaxRadius(1920, 1080) },
        uChromatic: { value: this.chromaticEnabled ? REST_CHROMATIC : 0 },
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
    this.sustainChromatic = this.chromaticEnabled ? REST_CHROMATIC : 0;
    this.targetChromatic = this.sustainChromatic;
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
    this.targetSpeedLines = this.speedLinesEnabled ? Math.max(this.targetSpeedLines, clamped) : 0;
    if (this.chromaticEnabled) {
      this.targetChromatic = Math.max(this.targetChromatic, REST_CHROMATIC + clamped * 1.1);
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
    // Wrapped: a mediump float loses sub-frame precision past a few thousand,
    // and a long play session would make the speed lines visibly quantise.
    // 1000 is comfortably above the longest effect period here.
    this.material.uniforms.uTime!.value = (this.material.uniforms.uTime!.value + dt) % 1000;

    if (this.burstHold > 0) {
      this.burstHold -= dt;
      return;
    }

    // Exponential decay, frame-rate independent. Everything relaxes towards its
    // sustained floor, which is 0 unless a caller set one through
    // `setIntensity` (and `REST_CHROMATIC` for chromatic aberration).
    const decay = Math.pow(0.0008, dt);
    this.targetMotionBlur =
      this.sustainMotionBlur + (this.targetMotionBlur - this.sustainMotionBlur) * decay;
    this.targetSpeedLines =
      this.sustainSpeedLines + (this.targetSpeedLines - this.sustainSpeedLines) * decay;
    this.targetChromatic =
      this.sustainChromatic + (this.targetChromatic - this.sustainChromatic) * decay;

    if (this.targetMotionBlur - this.sustainMotionBlur < 0.002) {
      this.targetMotionBlur = this.sustainMotionBlur;
    }
    if (this.targetSpeedLines - this.sustainSpeedLines < 0.002) {
      this.targetSpeedLines = this.sustainSpeedLines;
    }

    this.material.uniforms.uMotionBlur!.value = this.targetMotionBlur;
    this.material.uniforms.uSpeedLines!.value = this.targetSpeedLines;
    this.material.uniforms.uChromatic!.value = this.targetChromatic;
  }

  setEffectEnabled(
    effect: 'motionBlur' | 'chromaticAberration' | 'speedLines',
    enabled: boolean
  ): void {
    switch (effect) {
      case 'motionBlur':
        this.motionBlurEnabled = enabled;
        if (!enabled) {
          this.sustainMotionBlur = 0;
          this.targetMotionBlur = 0;
          this.material.uniforms.uMotionBlur!.value = 0;
        }
        break;
      case 'chromaticAberration':
        this.chromaticEnabled = enabled;
        this.sustainChromatic = enabled ? REST_CHROMATIC : 0;
        this.targetChromatic = this.sustainChromatic;
        this.material.uniforms.uChromatic!.value = this.targetChromatic;
        break;
      case 'speedLines':
        this.speedLinesEnabled = enabled;
        if (!enabled) {
          this.sustainSpeedLines = 0;
          this.targetSpeedLines = 0;
          this.material.uniforms.uSpeedLines!.value = 0;
        }
        break;
    }
  }

  /**
   * Directly set a SUSTAINED intensity, bypassing the burst envelope.
   *
   * The value becomes the floor `update()`'s decay relaxes towards, so it
   * survives for as long as the caller leaves it set — a settings slider stays
   * where the player put it. A later `trigger()` still spikes above it and
   * falls back to it.
   */
  setIntensity(effect: 'motionBlur' | 'chromaticAberration' | 'speedLines', value: number): void {
    const clamped = Math.min(1, Math.max(0, value));
    switch (effect) {
      case 'motionBlur':
        this.sustainMotionBlur = this.motionBlurEnabled ? clamped : 0;
        this.targetMotionBlur = this.sustainMotionBlur;
        this.material.uniforms.uMotionBlur!.value = this.targetMotionBlur;
        break;
      case 'chromaticAberration':
        this.sustainChromatic = this.chromaticEnabled ? clamped : 0;
        this.targetChromatic = this.sustainChromatic;
        this.material.uniforms.uChromatic!.value = this.targetChromatic;
        break;
      case 'speedLines':
        this.sustainSpeedLines = this.speedLinesEnabled ? clamped : 0;
        this.targetSpeedLines = this.sustainSpeedLines;
        this.material.uniforms.uSpeedLines!.value = this.targetSpeedLines;
        break;
    }
  }

  /** Live sustained intensity for one effect. Survives a tier rebuild via `PostProcessing`. */
  getIntensity(effect: 'motionBlur' | 'chromaticAberration' | 'speedLines'): number {
    switch (effect) {
      case 'motionBlur':
        return this.sustainMotionBlur;
      case 'chromaticAberration':
        return this.sustainChromatic;
      case 'speedLines':
        return this.sustainSpeedLines;
    }
  }

  /** Whether an effect is currently allowed to run at all. */
  isEffectEnabled(effect: 'motionBlur' | 'chromaticAberration' | 'speedLines'): boolean {
    switch (effect) {
      case 'motionBlur':
        return this.motionBlurEnabled;
      case 'chromaticAberration':
        return this.chromaticEnabled;
      case 'speedLines':
        return this.speedLinesEnabled;
    }
  }

  /** Where the radial effects currently converge, in 0..1 screen space. */
  get focalPoint(): THREE.Vector2 {
    return this.material.uniforms.uFocal!.value as THREE.Vector2;
  }

  /** Where the radial effects converge, in 0..1 screen space. */
  setFocalPoint(x: number, y: number): void {
    (this.material.uniforms.uFocal!.value as THREE.Vector2).set(x, y);
  }

  override setSize(width: number, height: number): void {
    this.material.uniforms.uAspect!.value = width / Math.max(1, height);
    // These arrive in DRAWING-BUFFER pixels — `PostProcessing.setSize` is fed
    // `Renderer.width/height`, which are physical, DPR-clamped and already
    // scaled by the resolution governor. That is the right domain for the
    // budget: the smear is spent in pixels the GPU actually rasterises, so a
    // frame the governor has shrunk gets a proportionally shorter smear and
    // holds the same 1.33 px between taps rather than stretching them apart.
    this.material.uniforms.uMotionBlurReach!.value = motionBlurReach(width, height);
    this.material.uniforms.uMotionBlurMaxRadius!.value = motionBlurMaxRadius(width, height);
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
