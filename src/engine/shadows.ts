/**
 * SHADOWS — cascaded shadow maps near, instanced blob decals far.
 *
 * ── WHY CASCADES ───────────────────────────────────────────────────────────
 * One shadow map stretched over an open-world draw distance gives roughly one
 * shadow texel per half-metre: the player's own shadow becomes a blocky smear,
 * which is the single most visible rendering failure in a third-person game.
 * Cascades spend most of the resolution on the first ~15 metres, where the
 * camera actually is, and progressively less further out.
 *
 *   desktop     3 x 2048 over 200 m
 *   mobile-high 2 x 1024 over  90 m
 *   mobile-low  1 x 1024 over  45 m
 *
 * Each cascade is a full extra shadow-map RENDER of everything inside it, so
 * cascade count is a draw-call multiplier, not just memory. That is why the low
 * tier gets one.
 *
 * ── WHY BLOBS BEYOND THE RANGE ─────────────────────────────────────────────
 * A crowd fleeing a monster is dozens of characters, most of them past 45 m. A
 * fourth cascade to cover them would cost another full scene traversal; without
 * one their shadows vanish and they read as floating. `BlobShadowField` draws
 * all of them as one instanced quad batch — one draw call, one program.
 *
 * ── THE TRAP EVERY CSM INTEGRATION HITS ────────────────────────────────────
 * `CSM` patches the global `lights_fragment_begin` chunk. Materials that have
 * been through `csm.setupMaterial()` get `USE_CSM` and take the cascade branch,
 * which accumulates the sun ONCE. Materials that have NOT take the ordinary
 * branch and accumulate ALL N cascade lights — a 3-cascade scene renders those
 * materials three times too bright.
 *
 * So every lit material in the scene must be registered. `MaterialLib` is
 * observed automatically; anything created outside it must be passed to
 * `registerMaterial()` or `registerSceneMaterials()`. `unlitProgramCount` is
 * not a thing you can check for — the symptom is a blown-out object.
 *
 * CSM also ASSIGNS `material.onBeforeCompile`, destroying any injection already
 * there, and its `dispose()` deletes the property outright. Both are handled
 * here via the hook-composition helpers rather than by living with it.
 */

import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import type { IDisposable, ILightingState } from '@/types';
import { createLogger } from '@/util';
import type { ShadowTierProfile } from './quality';
import { BlobShadowField } from './blob-shadows';
import { adoptAssignedHook, removeShaderHooks } from './shader-hooks';

const log = createLogger('engine.shadows');

/**
 * `CSM` overwrites two global `ShaderChunk` entries in its constructor and
 * never restores them. Snapshot them the first time so `dispose()` can put the
 * originals back — otherwise a tier change to "shadows off" leaves every
 * material compiling the cascade branch of a system that no longer exists.
 */
let originalLightsFragmentBegin: string | undefined;
let originalLightsParsBegin: string | undefined;

export interface IShadowSystemOptions {
  readonly profile: ShadowTierProfile;
  /** Sun colour/direction source. Read every `update()`. */
  readonly lighting?: ILightingState;
  /** Override the blob-shadow decal sprite. */
  readonly blobTexture?: THREE.Texture;
}

export interface IShadowStats {
  readonly cascades: number;
  readonly mapSize: number;
  readonly maxDistance: number;
  /** Shadow-map VRAM, all cascades. Depth-only, so 4 bytes per texel. */
  readonly shadowMapBytes: number;
  readonly blobShadows: number;
  readonly registeredMaterials: number;
}

export class ShadowSystem implements IDisposable {
  /** Blob decals for characters beyond the cascade range. */
  readonly blobShadows: BlobShadowField;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private profile: ShadowTierProfile;

  private csm: CSM | undefined;
  /** Used when cascades are disabled: a single non-shadowing sun. */
  private plainSun: THREE.DirectionalLight | undefined;
  private readonly registered = new Set<THREE.Material>();
  private hookKey: string;
  private disposed = false;

  private readonly sunTarget = new THREE.Vector3();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, options: IShadowSystemOptions) {
    this.scene = scene;
    this.camera = camera;
    this.profile = options.profile;
    this.hookKey = `csm${options.profile.cascades}`;

    this.blobShadows = new BlobShadowField({
      capacity: options.profile.blobShadowCapacity,
      texture: options.blobTexture,
    });
    this.scene.add(this.blobShadows.mesh);

    this.build();
    if (options.lighting) this.applyLightingState(options.lighting);
  }

  /** Distance in metres the cascades cover. Beyond this, use blob shadows. */
  get cascadeRange(): number {
    return this.profile.enabled ? this.profile.maxDistance : 0;
  }

  get cascadeCount(): number {
    return this.csm?.cascades ?? 0;
  }

  /** The directional lights acting as the sun. One per cascade, or one plain. */
  get sunLights(): readonly THREE.DirectionalLight[] {
    if (this.csm) return this.csm.lights;
    return this.plainSun ? [this.plainSun] : [];
  }

  /* ---------------------------------------------------------------------- */
  /* Material registration                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Make one material cascade-aware. Idempotent.
   *
   * MUST be called for every lit material in the scene while cascades are
   * active — see the header note about N-times-too-bright materials.
   */
  registerMaterial(material: THREE.Material): void {
    if (this.disposed || this.registered.has(material)) return;
    this.registered.add(material);
    if (!this.csm) return;
    this.attachCsm(material);
  }

  /** Register every material reachable from an object graph. */
  registerSceneMaterials(root: THREE.Object3D): void {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const material = mesh.material;
      if (!material) return;
      if (Array.isArray(material)) {
        for (const entry of material) this.registerMaterial(entry);
      } else {
        this.registerMaterial(material);
      }
    });
  }

  /**
   * Attach CSM to a material without losing whatever was already hooked.
   *
   * `CSM.setupMaterial()` assigns straight onto `material.onBeforeCompile`, so
   * the composed dispatcher installed by `MaterialLib` is captured first and
   * restored immediately afterwards, with CSM's callback folded in as another
   * hook. The hook key carries the cascade count because a 2-cascade and a
   * 3-cascade build of the same material are genuinely different programs.
   */
  private attachCsm(material: THREE.Material): void {
    const csm = this.csm;
    if (!csm) return;
    const previous = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile')
      ? material.onBeforeCompile
      : undefined;
    csm.setupMaterial(material);
    adoptAssignedHook(material, this.hookKey, previous);
  }

  private detachCsm(material: THREE.Material): void {
    removeShaderHooks(material, this.hookKey);
    if (material.defines) {
      delete material.defines.USE_CSM;
      delete material.defines.CSM_CASCADES;
      delete material.defines.CSM_FADE;
    }
    material.needsUpdate = true;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  private build(): void {
    const profile = this.profile;
    if (!profile.enabled || profile.cascades < 1) {
      this.plainSun = new THREE.DirectionalLight(0xffffff, 3);
      this.plainSun.name = 'sun.plain';
      this.plainSun.castShadow = false;
      this.scene.add(this.plainSun);
      this.scene.add(this.plainSun.target);
      return;
    }

    originalLightsFragmentBegin ??= THREE.ShaderChunk.lights_fragment_begin;
    originalLightsParsBegin ??= THREE.ShaderChunk.lights_pars_begin;

    this.csm = new CSM({
      camera: this.camera,
      parent: this.scene,
      cascades: profile.cascades,
      maxFar: profile.maxDistance,
      // 'practical' is the Zhang et al. blend of uniform and logarithmic
      // splits. Pure logarithmic wastes the first cascade on the 10cm in front
      // of the near plane; pure uniform wastes the last on the horizon.
      mode: 'practical',
      shadowMapSize: profile.mapSize,
      shadowBias: profile.bias,
      lightIntensity: 3,
      lightMargin: Math.max(60, profile.maxDistance * 0.5),
      lightNear: 1,
      lightFar: Math.max(400, profile.maxDistance * 3),
    });
    this.csm.fade = profile.fade;
    this.hookKey = `csm${profile.cascades}${profile.fade ? 'f' : ''}`;

    for (const material of this.registered) this.attachCsm(material);
    log.info(
      `cascades: ${profile.cascades} x ${profile.mapSize} over ${profile.maxDistance}m ` +
        `(${(this.shadowMapBytes() / 1024 / 1024).toFixed(1)} MB)`
    );
  }

  private teardown(): void {
    for (const material of this.registered) this.detachCsm(material);
    if (this.csm) {
      // Deliberately NOT `csm.dispose()`: it does `delete
      // material.onBeforeCompile`, which would take the MaterialLib injections
      // with it. `detachCsm` above already removed the CSM hook and defines.
      this.csm.shaders.clear();
      this.csm.remove();
      this.csm = undefined;
    }
    if (this.plainSun) {
      this.scene.remove(this.plainSun.target);
      this.scene.remove(this.plainSun);
      this.plainSun.dispose();
      this.plainSun = undefined;
    }
  }

  /** Rebuild for a new tier. Materials stay registered and are re-attached. */
  setProfile(profile: ShadowTierProfile): void {
    if (this.disposed) return;
    this.profile = profile;
    this.teardown();
    this.build();
    this.blobShadows.setStrength(profile.enabled ? 0.55 : 0.7);
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                              */
  /* ---------------------------------------------------------------------- */

  /** Push sun direction, colour and intensity from the lighting state. */
  applyLightingState(state: ILightingState): void {
    const direction = state.sunDirection;

    if (this.csm) {
      this.csm.lightDirection.copy(direction).normalize();
      for (const light of this.csm.lights) {
        light.color.copy(state.sunColor);
        light.intensity = state.sunIntensity;
        light.shadow.intensity = state.sunIntensity > 0.02 ? 1 : 0;
      }
      this.csm.lightIntensity = state.sunIntensity;
    } else if (this.plainSun) {
      this.plainSun.color.copy(state.sunColor);
      this.plainSun.intensity = state.sunIntensity;
      // A directional light's POSITION only sets its direction; place it far
      // enough out that it reads as parallel from anywhere in the scene.
      this.sunTarget.copy(direction).normalize().multiplyScalar(-500);
      this.plainSun.position.copy(this.sunTarget);
      this.plainSun.target.position.set(0, 0, 0);
      this.plainSun.target.updateMatrixWorld();
    }
  }

  /**
   * Re-fit the cascades to the camera. Call once per frame BEFORE rendering.
   *
   * `CSM.update()` only repositions the cascade lights; it does not recompute
   * the splits. Those depend on camera near/far, so `updateFrustums()` is
   * called separately from `onCameraChanged()`.
   */
  update(): void {
    this.csm?.update();
  }

  /** Recompute cascade splits. Call after changing camera near/far or aspect. */
  onCameraChanged(): void {
    this.csm?.updateFrustums();
  }

  getStats(): IShadowStats {
    return {
      cascades: this.cascadeCount,
      mapSize: this.profile.mapSize,
      maxDistance: this.cascadeRange,
      shadowMapBytes: this.shadowMapBytes(),
      blobShadows: this.blobShadows.count,
      registeredMaterials: this.registered.size,
    };
  }

  private shadowMapBytes(): number {
    if (!this.csm) return 0;
    // Depth-only target: 4 bytes per texel (DEPTH_COMPONENT24 padded).
    return this.profile.cascades * this.profile.mapSize * this.profile.mapSize * 4;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.teardown();
    this.registered.clear();
    this.blobShadows.dispose();
    // Put the stock lighting chunks back so a renderer created afterwards
    // without cascades does not compile the CSM branch.
    if (originalLightsFragmentBegin !== undefined) {
      THREE.ShaderChunk.lights_fragment_begin = originalLightsFragmentBegin;
    }
    if (originalLightsParsBegin !== undefined) {
      THREE.ShaderChunk.lights_pars_begin = originalLightsParsBegin;
    }
  }
}

/**
 * Convenience: submit blob shadows for a list of world positions, fading each
 * by distance from the camera so the transition out of the cascade range is a
 * dissolve rather than a pop.
 *
 * @param field       Target field. `begin()`/`end()` are called for you.
 * @param camera      Used for the distance fade.
 * @param entries     Feet positions, ground heights and radii.
 * @param cascadeEnd  Distance where cascades stop. Blobs fade IN over the last
 *                    15% of that range so both are briefly present.
 * @param maxDistance Distance beyond which blobs fade out entirely.
 */
export function submitCrowdBlobShadows(
  field: BlobShadowField,
  camera: THREE.Camera,
  entries: readonly { x: number; groundY: number; z: number; radius: number; airborne?: number }[],
  cascadeEnd: number,
  maxDistance: number
): void {
  field.begin();
  const cameraPosition = camera.position;
  const fadeInStart = cascadeEnd * 0.85;
  for (const entry of entries) {
    const dx = entry.x - cameraPosition.x;
    const dy = entry.groundY - cameraPosition.y;
    const dz = entry.z - cameraPosition.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > maxDistance) continue;

    // Cross-fade with the cascade range, then fade out at the far limit.
    const fadeIn =
      cascadeEnd <= 0 ? 1 : Math.min(1, Math.max(0, (distance - fadeInStart) / (cascadeEnd - fadeInStart)));
    const fadeOut = Math.min(1, Math.max(0, (maxDistance - distance) / (maxDistance * 0.25)));
    // A character in mid-air casts a bigger, weaker blob.
    const airborne = entry.airborne ?? 0;
    const alpha = fadeIn * fadeOut * (1 - Math.min(0.85, airborne * 0.12));
    const radius = entry.radius * (1 + Math.min(1.5, airborne * 0.2));
    field.add(entry.x, entry.groundY, entry.z, radius, alpha);
  }
  field.end();
}
