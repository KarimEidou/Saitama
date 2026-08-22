/**
 * TIER-GATED POST-PROCESSING
 *
 * Implements `IPostProcessing` (engine.ts). Three chains, chosen by render tier.
 *
 * ── LOW: NO EFFECT COMPOSER AT ALL ─────────────────────────────────────────
 * This is the important one. The low tier does not build a composer, does not
 * allocate an HDR render target, and does not run a single full-screen pass.
 * `render()` calls `renderer.render(scene, camera)` and the frame goes straight
 * to the default framebuffer, tone mapped inside the material shaders, with the
 * context's own MSAA resolving for free in tile memory.
 *
 * A minimal composer chain (RenderPass -> OutputPass) is not "cheap post
 * processing": it costs a full-screen write to an offscreen HDR target and a
 * full-screen read back out of it. At 1080p that is roughly 16 MB of traffic
 * per frame, every frame, for zero visual difference — and on a tiled mobile
 * GPU it additionally forces the tile buffer to be flushed to main memory,
 * which is the exact thing tilers exist to avoid. Skipping the composer is
 * worth more than every other optimisation in this file combined.
 *
 * ── MID: RenderPass -> quarter-res bloom -> output/LUT ──────────────────────
 * Bloom at quarter resolution is indistinguishable from full resolution (it is
 * a blur) at a sixteenth of the fragment cost. The output pass fuses tone
 * mapping, grading and vignette into one program (see `OutputLutPass`).
 *
 * ── HIGH: adds SSAO, AA and the anime composite ────────────────────────────
 * Half-res SSAO before bloom (occluded areas must not bloom), then the fused
 * anime pass, then AA last — FXAA and SMAA both expect display-space input, so
 * they must follow the output pass.
 *
 * ── PROGRAM BUDGET NOTE ────────────────────────────────────────────────────
 * `UnrealBloomPass` costs NINE shader programs on its own: five separable blur
 * materials (one per mip, each with a different KERNEL_RADIUS define), a
 * luminosity high-pass, a composite, a copy and a basic blit. That was more
 * than a third of the whole-game budget for one effect, so the mobile tiers use
 * `DualFilterBloomPass` instead — three programs, and fewer texture fetches per
 * pixel. Desktop keeps the Unreal path, where the budget is not the binding
 * constraint. See `PostTierProfile.bloomKind`.
 *
 * That substitution is why every other effect here is fused rather than
 * chained: the anime pass folds motion blur, chromatic aberration, speed lines
 * and vignette into one program, and the output pass folds tone mapping,
 * grading and vignette into another.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import type { IPostProcessing, IQualitySettings, PostEffectName } from '@/types';
import { createLogger } from '@/util';
import { renderProfileFor, type PostTierProfile } from '../quality';
import { bakeLutStrip, ANIME_GRADE, type IGradeOptions } from './lut';
import { OutputLutPass } from './output-lut-pass';
import { HalfResSSAOPass } from './ssao-pass';
import { AnimeCompositePass } from './anime-composite-pass';
import { DualFilterBloomPass } from './dual-filter-bloom-pass';

const log = createLogger('engine.post');

/**
 * `UnrealBloomPass` derives its internal resolution from whatever `setSize`
 * receives, and `EffectComposer` always hands it the full frame size. This
 * subclass intercepts that so the bloom chain can run at a fraction of the
 * frame — the single biggest saving available on the mid tier.
 */
class ScaledBloomPass extends UnrealBloomPass {
  private renderScale = 0.25;

  setRenderScale(scale: number): void {
    this.renderScale = Math.min(1, Math.max(0.05, scale));
  }

  override setSize(width: number, height: number): void {
    // The base class halves what it is given, so pass 2x the target scale.
    super.setSize(
      Math.max(2, Math.round(width * this.renderScale * 2)),
      Math.max(2, Math.round(height * this.renderScale * 2))
    );
  }
}

const ANIME_EFFECTS = ['motionBlur', 'chromaticAberration', 'speedLines'] as const;
type AnimeEffect = (typeof ANIME_EFFECTS)[number];

/**
 * Everything a caller tuned at runtime that `build()` cannot reproduce.
 *
 * `build()` reads the tier profile and nothing else, so a tier change would
 * otherwise revert every live adjustment — permanently, for the rest of the
 * session. The composition root deliberately overrides the bloom threshold and
 * strength at boot (the profile's threshold of 1.0 is measured against a
 * different light scale and makes every sunlit white surface bloom), and it
 * does so through the documented `effectComposer` escape hatch, which never
 * passes through this class. So the state is read back off the LIVE passes
 * rather than mirrored into fields.
 *
 * `undefined` means "the old chain had nothing to say about this" — either the
 * pass did not exist on that tier, or the profile never enabled it — and the
 * newly built chain keeps its own default.
 */
interface ITunedPostState {
  bloomEnabled: boolean | undefined;
  bloomStrength: number | undefined;
  bloomThreshold: number | undefined;
  ssaoEnabled: boolean | undefined;
  ssaoIntensity: number | undefined;
  aaEnabled: boolean | undefined;
  vignette: number | undefined;
  vignetteSoftness: number | undefined;
  lutIntensity: number | undefined;
  animeEnabled: Record<AnimeEffect, boolean> | undefined;
  animeIntensity: Record<AnimeEffect, number> | undefined;
  focal: THREE.Vector2 | undefined;
}

export interface IPostProcessingOptions {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly profile: PostTierProfile;
  /** Colour-grading table baked into the output pass. */
  readonly grade?: IGradeOptions;
  /** Initial ACES exposure. Normally driven by `ILightingState`. */
  readonly exposure?: number;
}

/** What the chain currently costs, for the debug HUD and verification. */
export interface IPostProcessingStats {
  readonly mode: PostTierProfile['mode'];
  readonly passCount: number;
  readonly passNames: readonly string[];
  /** True when no composer exists and rendering is direct-to-framebuffer. */
  readonly direct: boolean;
  readonly bloomScale: number;
  /** Which bloom implementation is live, or 'none'. */
  readonly bloomKind: 'none' | 'dual' | 'unreal';
  /** Bytes held by the dual-filter pyramid. 0 for the Unreal path. */
  readonly bloomBytes: number;
  readonly msaaSamples: number;
}

export class PostProcessing implements IPostProcessing {
  enabled = true;

  private readonly renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private profile: PostTierProfile;

  private composer: EffectComposer | undefined;
  private composerTarget: THREE.WebGLRenderTarget | undefined;
  private renderPass: RenderPass | undefined;
  private bloomPass: ScaledBloomPass | DualFilterBloomPass | undefined;
  private outputPass: OutputLutPass | undefined;
  private ssaoPass: HalfResSSAOPass | undefined;
  private animePass: AnimeCompositePass | undefined;
  private aaPass: FXAAPass | SMAAPass | undefined;

  /**
   * Stable, build-independent labels for the chain. `constructor.name` is
   * mangled by the production minifier and three's own pass materials are
   * mostly unnamed, so diagnostics built from either report gibberish like
   * "Xc -> on" in a release build.
   */
  private readonly passLabels: string[] = [];
  private lut: THREE.DataTexture | undefined;
  private readonly grade: IGradeOptions;
  private exposure: number;
  private width = 1;
  private height = 1;
  private disposed = false;
  /**
   * Guards against double-advancing time-based effects. `IPostProcessing`
   * extends `IUpdatable`, so a game loop may legitimately call `update(dt)`
   * AND `render(dt)` in the same frame; without this the speed lines animate at
   * double speed for anyone who wires it up the documented way.
   */
  private advancedThisFrame = false;

  constructor(options: IPostProcessingOptions) {
    this.renderer = options.renderer;
    this.scene = options.scene;
    this.camera = options.camera;
    this.profile = options.profile;
    this.grade = options.grade ?? ANIME_GRADE;
    this.exposure = options.exposure ?? 1;

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width = Math.max(1, size.x);
    this.height = Math.max(1, size.y);

    this.build();
  }

  /** True when there is no composer and the scene draws straight to screen. */
  get isDirect(): boolean {
    return this.composer === undefined;
  }

  /** Escape hatch for systems that need to insert their own pass. */
  get effectComposer(): EffectComposer | undefined {
    return this.composer;
  }

  /* ---------------------------------------------------------------------- */
  /* Construction                                                           */
  /* ---------------------------------------------------------------------- */

  private build(): void {
    const profile = this.profile;

    if (profile.mode === 'off') {
      log.info('post chain: DIRECT (no composer, context MSAA, in-material tone mapping)');
      return;
    }

    // Half-float so bloom has real HDR values to threshold against. An LDR
    // target would clip every highlight to 1.0 before the bloom pass sees it,
    // and a threshold of 1.0 would then match nothing.
    this.composerTarget = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      samples: profile.msaaSamples,
      depthBuffer: true,
    });
    this.composerTarget.texture.name = 'post.hdr';

    this.composer = new EffectComposer(this.renderer, this.composerTarget);
    // Sizes handed to the composer are already in drawing-buffer pixels, so
    // its own pixel-ratio multiplier must be neutral.
    this.composer.setPixelRatio(1);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.addPass(this.renderPass, 'RenderPass');

    if (profile.ssao) {
      this.ssaoPass = new HalfResSSAOPass(this.scene, this.camera, {
        samples: profile.ssaoSamples,
        scale: profile.ssaoScale,
        radius: profile.ssaoRadius,
        intensity: profile.ssaoIntensity,
      });
      this.addPass(
        this.ssaoPass,
        `SSAO(${Math.round(profile.ssaoScale * 100)}%, ${profile.ssaoSamples} samples)`
      );
    }

    if (profile.bloom) {
      if (profile.bloomKind === 'unreal') {
        const unreal = new ScaledBloomPass(
          new THREE.Vector2(this.width, this.height),
          profile.bloomStrength,
          profile.bloomRadius,
          profile.bloomThreshold
        );
        unreal.setRenderScale(profile.bloomScale);
        this.bloomPass = unreal;
        this.addPass(unreal, `UnrealBloom(${Math.round(profile.bloomScale * 100)}%)`);
      } else {
        const dual = new DualFilterBloomPass({
          strength: profile.bloomStrength,
          threshold: profile.bloomThreshold,
          knee: profile.bloomKnee,
          scale: profile.bloomScale,
          iterations: profile.bloomIterations,
        });
        this.bloomPass = dual;
        this.addPass(
          dual,
          `DualFilterBloom(${Math.round(profile.bloomScale * 100)}%, ${profile.bloomIterations} levels)`
        );
      }
    }

    if (profile.lut) this.lut = bakeLutStrip(this.grade);
    this.outputPass = new OutputLutPass({
      lut: this.lut ?? null,
      lutIntensity: 1,
      vignette: profile.vignette ? 0.32 : 0,
      exposure: this.exposure,
    });
    this.addPass(this.outputPass, profile.lut ? 'Output+LUT+Vignette' : 'Output');

    if (profile.motionBlur || profile.chromaticAberration || profile.speedLines) {
      this.animePass = new AnimeCompositePass({
        motionBlur: profile.motionBlur,
        chromaticAberration: profile.chromaticAberration,
        speedLines: profile.speedLines,
      });
      this.addPass(this.animePass, 'AnimeComposite');
    }

    if (profile.antialias === 'fxaa') {
      this.aaPass = new FXAAPass();
      this.addPass(this.aaPass, 'FXAA');
    } else if (profile.antialias === 'smaa') {
      this.aaPass = new SMAAPass();
      this.addPass(this.aaPass, 'SMAA');
    }

    this.composer.setSize(this.width, this.height);
    log.info(`post chain: ${this.getStats().passNames.join(' -> ')}`);
  }

  private addPass(pass: Pass, label: string): void {
    this.composer?.addPass(pass);
    this.passLabels.push(label);
  }

  private teardown(): void {
    this.passLabels.length = 0;
    this.composer?.dispose();
    this.composer = undefined;
    this.composerTarget?.dispose();
    this.composerTarget = undefined;
    this.renderPass?.dispose();
    this.renderPass = undefined;
    this.bloomPass?.dispose();
    this.bloomPass = undefined;
    this.outputPass?.dispose();
    this.outputPass = undefined;
    this.ssaoPass?.dispose();
    this.ssaoPass = undefined;
    this.animePass?.dispose();
    this.animePass = undefined;
    this.aaPass?.dispose();
    this.aaPass = undefined;
    this.lut?.dispose();
    this.lut = undefined;
  }

  /* ---------------------------------------------------------------------- */
  /* IPostProcessing                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Draw the frame.
   *
   * @param dt UNSCALED seconds. The anime effects must keep animating while
   *           the game clock is frozen by an impact — a hit-stop with frozen
   *           speed lines reads as a dropped frame, not as impact.
   */
  render(dt: number): void {
    if (this.disposed) return;
    if (!this.enabled || !this.composer) {
      this.advancedThisFrame = false;
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (!this.advancedThisFrame) this.animePass?.update(dt);
    this.advancedThisFrame = false;
    this.composer.render(dt);
  }

  /** Advance time-based effects without drawing. Part of `IUpdatable`. */
  update(dt: number): void {
    this.animePass?.update(dt);
    this.advancedThisFrame = true;
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.composer?.setSize(this.width, this.height);
  }

  /**
   * One log line when an effect the current tier never built is addressed.
   *
   * Six of the eleven `PostEffectName`s resolve to a guarded no-op on the
   * MEDIUM (phone) tier, and `IPostProcessing` gives callers no way to discover
   * which are live — so a settings toggle that does nothing is otherwise
   * indistinguishable from a broken pass. Debug level, not warn: this is a
   * legitimate tier outcome, unlike the two genuinely unimplemented effects.
   */
  private reportNotOnTier(effect: PostEffectName): void {
    log.debug(`post effect "${effect}" is not built on the "${this.profile.mode}" chain; ignored`);
  }

  setEffectEnabled(effect: PostEffectName, enabled: boolean): void {
    switch (effect) {
      case 'bloom':
        if (this.bloomPass) this.bloomPass.enabled = enabled;
        else this.reportNotOnTier(effect);
        break;
      case 'ssao':
        if (this.ssaoPass) this.ssaoPass.enabled = enabled;
        else this.reportNotOnTier(effect);
        break;
      case 'fxaa':
      case 'smaa':
        if (this.aaPass) this.aaPass.enabled = enabled;
        else this.reportNotOnTier(effect);
        break;
      case 'vignette':
        if (this.outputPass) this.outputPass.setVignette(enabled ? 0.32 : 0);
        else this.reportNotOnTier(effect);
        break;
      case 'colorGrading':
        if (this.outputPass) this.outputPass.setLut(enabled ? (this.lut ?? null) : null);
        else this.reportNotOnTier(effect);
        break;
      case 'motionBlur':
      case 'chromaticAberration':
      case 'speedLines':
        if (this.animePass) this.animePass.setEffectEnabled(effect, enabled);
        else this.reportNotOnTier(effect);
        break;
      case 'filmGrain':
      case 'depthOfField':
        // Deliberately unimplemented: both are per-pixel passes whose cost is
        // real and whose benefit on a 5-inch screen is not. Named in the
        // contract so they can be added later without a type change.
        log.warn(`post effect "${effect}" is not implemented in this renderer`);
        break;
    }
  }

  setEffectIntensity(effect: PostEffectName, intensity: number): void {
    const value = Math.min(1, Math.max(0, intensity));
    switch (effect) {
      case 'bloom':
        if (this.bloomPass) this.bloomPass.strength = value;
        else this.reportNotOnTier(effect);
        break;
      case 'ssao':
        if (this.ssaoPass) this.ssaoPass.setIntensity(value);
        else this.reportNotOnTier(effect);
        break;
      case 'vignette':
        if (this.outputPass) this.outputPass.setVignette(value);
        else this.reportNotOnTier(effect);
        break;
      case 'colorGrading':
        if (this.outputPass) this.outputPass.setLut(this.lut ?? null, value);
        else this.reportNotOnTier(effect);
        break;
      case 'motionBlur':
      case 'chromaticAberration':
      case 'speedLines':
        if (this.animePass) this.animePass.setIntensity(effect, value);
        else this.reportNotOnTier(effect);
        break;
      case 'fxaa':
      case 'smaa':
        // Antialiasing has no intensity knob; `setEffectEnabled` is the whole
        // control surface. Say so rather than swallowing the call.
        log.debug(`post effect "${effect}" has no intensity; use setEffectEnabled`);
        break;
      case 'filmGrain':
      case 'depthOfField':
        // Mirrors `setEffectEnabled`: the two methods must not disagree about
        // which names this renderer honours.
        log.warn(`post effect "${effect}" is not implemented in this renderer`);
        break;
    }
  }

  /** Rebuild for a new tier. The whole chain is torn down and reconstructed. */
  applyQuality(settings: IQualitySettings): void {
    this.applyProfile(renderProfileFor(settings.tier).post);
  }

  /** Rebuild from a renderer-private profile. */
  applyProfile(profile: PostTierProfile): void {
    if (this.disposed || profile === this.profile) return;
    // Carry the runtime-tuned state across the rebuild. Without this round
    // trip the most ordinary possible action — nudging the quality slider —
    // silently reverts the composition root's bloom tuning and every effect
    // toggle the player set, with no way back short of restarting the app.
    const tuned = this.captureTunedState();
    this.profile = profile;
    this.teardown();
    this.build();
    this.restoreTunedState(tuned);
  }

  /** Read the overridable state off the live passes, before they are torn down. */
  private captureTunedState(): ITunedPostState {
    const anime = this.animePass;
    const profile = this.profile;
    return {
      bloomEnabled: this.bloomPass?.enabled,
      bloomStrength: this.bloomPass?.strength,
      bloomThreshold: this.bloomPass?.threshold,
      ssaoEnabled: this.ssaoPass?.enabled,
      ssaoIntensity: this.ssaoPass?.intensity,
      aaEnabled: this.aaPass?.enabled,
      // Only meaningful if the outgoing tier actually ran them: a zero read
      // back off a tier that never had a vignette or a LUT would otherwise
      // switch them off on the tier being moved TO.
      vignette: profile.vignette ? this.outputPass?.vignette : undefined,
      vignetteSoftness: profile.vignette ? this.outputPass?.vignetteSoftness : undefined,
      lutIntensity: this.lut ? this.outputPass?.lutIntensity : undefined,
      animeEnabled: anime
        ? {
            motionBlur: anime.isEffectEnabled('motionBlur'),
            chromaticAberration: anime.isEffectEnabled('chromaticAberration'),
            speedLines: anime.isEffectEnabled('speedLines'),
          }
        : undefined,
      animeIntensity: anime
        ? {
            motionBlur: anime.getIntensity('motionBlur'),
            chromaticAberration: anime.getIntensity('chromaticAberration'),
            speedLines: anime.getIntensity('speedLines'),
          }
        : undefined,
      focal: anime ? anime.focalPoint.clone() : undefined,
    };
  }

  /** Re-apply captured state onto the freshly built chain, skipping what it lacks. */
  private restoreTunedState(state: ITunedPostState): void {
    if (this.bloomPass) {
      if (state.bloomEnabled !== undefined) this.bloomPass.enabled = state.bloomEnabled;
      if (state.bloomStrength !== undefined) this.bloomPass.strength = state.bloomStrength;
      if (state.bloomThreshold !== undefined) this.bloomPass.threshold = state.bloomThreshold;
    }
    if (this.ssaoPass) {
      if (state.ssaoEnabled !== undefined) this.ssaoPass.enabled = state.ssaoEnabled;
      if (state.ssaoIntensity !== undefined) this.ssaoPass.setIntensity(state.ssaoIntensity);
    }
    if (this.aaPass && state.aaEnabled !== undefined) this.aaPass.enabled = state.aaEnabled;
    if (this.outputPass) {
      if (state.vignette !== undefined) {
        this.outputPass.setVignette(state.vignette, state.vignetteSoftness);
      }
      if (state.lutIntensity !== undefined && this.lut) {
        this.outputPass.setLut(this.lut, state.lutIntensity);
      }
    }
    const anime = this.animePass;
    if (!anime) return;
    for (const effect of ANIME_EFFECTS) {
      // Order matters: `setEffectEnabled` resets the sustained intensity.
      const enabled = state.animeEnabled?.[effect];
      if (enabled !== undefined) anime.setEffectEnabled(effect, enabled);
      const intensity = state.animeIntensity?.[effect];
      if (intensity !== undefined) anime.setIntensity(effect, intensity);
    }
    if (state.focal) anime.setFocalPoint(state.focal.x, state.focal.y);
  }

  /* ---------------------------------------------------------------------- */
  /* Renderer-facing extras                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Re-point the chain at a different scene or camera.
   *
   * `RenderPass` and the SSAO prepass both capture their scene and camera at
   * construction. Without this, calling `IRenderer.render()` with a different
   * scene silently keeps drawing the old one — a failure mode that looks like
   * "the new scene is invisible" rather than like a bug in the composer.
   */
  setSceneAndCamera(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.scene = scene;
    this.camera = camera;
    if (this.renderPass) {
      this.renderPass.scene = scene;
      this.renderPass.camera = camera;
    }
    this.ssaoPass?.setSceneAndCamera(scene, camera);
  }

  /** ACES exposure, normally mirrored from `ILightingState.exposure`. */
  setExposure(exposure: number): void {
    this.exposure = exposure;
    this.outputPass?.setExposure(exposure);
  }

  /**
   * Fire the impact cue: speed lines, zoom smear and colour fringing.
   * No-op on tiers without the anime pass.
   *
   * @param intensity 0..1, already saturated from the punch's unbounded power.
   * @param focal     Screen-space impact point, 0..1. Defaults to the centre.
   */
  triggerImpact(intensity: number, focal?: THREE.Vector2): void {
    this.animePass?.trigger(intensity, focal);
  }

  /**
   * Compile every program in the chain by rendering one composed frame.
   *
   * Called during loading. Post-processing programs are compiled on first use
   * exactly like material programs, and the bloom chain alone is eight of them;
   * paying for that on the first frame of gameplay is a guaranteed hitch.
   */
  warmup(): void {
    if (!this.composer) return;
    const previousToScreen = this.composer.renderToScreen;
    this.composer.renderToScreen = false;
    this.composer.render(0);
    this.composer.renderToScreen = previousToScreen;
  }

  getStats(): IPostProcessingStats {
    return {
      mode: this.profile.mode,
      passCount: this.composer?.passes.length ?? 0,
      passNames: [...this.passLabels],
      direct: this.composer === undefined,
      bloomScale: this.profile.bloom ? this.profile.bloomScale : 0,
      bloomKind: this.profile.bloom ? this.profile.bloomKind : 'none',
      bloomBytes: this.bloomPass instanceof DualFilterBloomPass ? this.bloomPass.gpuBytes : 0,
      msaaSamples: this.profile.msaaSamples,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
  }
}
