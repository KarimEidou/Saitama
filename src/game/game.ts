/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE COMPOSITION ROOT                                                    ║
 * ║                                                                          ║
 * ║  Twenty-six systems were built against `@/types` and `@/util` and an     ║
 * ║  event bus, and not one of them imports another. This is the only file   ║
 * ║  in the repository that imports CONCRETE implementations, and the        ║
 * ║  privilege exists so that the rule holds everywhere else. Do not relax   ║
 * ║  it by importing `@/game` from a system — the dependency would be a      ║
 * ║  cycle, and the reason every one of those systems has its own harness is ║
 * ║  that none of them needs this file to run.                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── BOOT ORDER, AND WHY IT IS THIS ORDER ───────────────────────────────────
 *   1. PROBE      device signals decide both tiers before anything allocates.
 *   2. RENDERER   the GL context. `MAX_TEXTURE_SIZE` is a tier signal, so the
 *                 asset tier is finalised only after this exists.
 *   3. ASSETS     manifest, then the tier decision, then `preloadCore`. The
 *                 loading bar is driven from this and from nothing else.
 *   4. PHYSICS    one wasm instantiation. Awaited before the world, because
 *                 chunk colliders are created as chunks are built.
 *   5. WORLD      sky, city ring, spatial index.
 *   6. SYSTEMS    player, combat, monsters, crowd, destruction, progression,
 *                 vfx, audio, hud, input.
 *   7. WARMUP     every shader compiled while a loading screen is up, never
 *                 during a fight.
 *
 * ── FRAME ORDER, AND WHY IT IS THIS ORDER ──────────────────────────────────
 *   input -> sim -> physics -> camera -> render
 *
 * The two orderings that are NOT obvious and that break subtly when wrong:
 *
 *   • `PlayerRig.update()` decides and COMMANDS a move; the move is APPLIED by
 *     `physics.update()`; `PlayerRig.postPhysics()` re-reads the solved
 *     transform and only then frames the camera. Doing the camera before the
 *     step chases a position that has already been invalidated, and the
 *     character drifts off-centre at speed.
 *
 *   • The HUD is updated with UNSCALED time. Everything else uses scaled time,
 *     so during a 90 ms impact freeze at timeScale 0.04 the world stops and the
 *     interface does not — which is the entire point of the freeze.
 */

import * as THREE from 'three';
import rawPlan from '../../assets/district/cityz.plan.json';

import type {
  DistrictType,
  EntityId,
  ICharacterInstance,
  IQualityTier,
  InputState,
  Vec3,
} from '@/types';
import { EventBus, clamp01, createLogger, createRng } from '@/util';

import {
  GameClock,
  ImpactFreeze,
  Renderer,
  ShaderWarmup,
  ShadowSystem,
  PostProcessing,
  renderProfileFor,
  qualitySettingsFor,
} from '@/engine';

import {
  AssetRegistry,
  HttpAssetProvider,
  detectPlatform,
  detectTierSignals,
  isCapacitorNative,
} from '@/assets';

import { SpatialIndex } from '@/spatial';
import { ChunkDamageState } from '@/world/streaming';
import { CityGenerator, collapsingFloors, type ICityPlan } from '@/world/city';
import {
  DayNightSystem,
  NightUniforms,
  SkyEnvironment,
  parseEnvironmentMeasurements,
} from '@/world/sky';

import {
  DebrisPool,
  PhysicsWorld,
  RagdollManager,
  ImpulsePropagator,
  initPhysics,
  physicsInitDurationMs,
} from '@/physics';

import { buildCharacter, createCharacterParts } from '@/characters/mesh';
import { ProceduralAnimator } from '@/characters/anim';

import { PlayerRig, createPhysicsCameraProbe } from '@/entities/player';
import { CrowdSystem } from '@/entities/npc';
import {
  MonsterSystem,
  monsterArchetype,
  type IMonsterTarget,
} from '@/entities/monster';

import { createCombatSystem, type CombatSystem } from '@/gameplay/combat';
import { DestructionSystem } from '@/gameplay/destruction';
import { ProgressionCoordinator } from '@/gameplay/progression';

import { VFXSystem } from '@/vfx';
import { AudioSystem } from '@/audio';
import { DEFAULT_INPUT_TUNING, createInputManager, type IInputManager } from '@/ui/input';
import { HudManager, type IHudSettings } from '@/ui/hud';

import {
  AUTOSAVE_INTERVAL,
  BOOT_RADIUS,
  FIXED_STEP,
  MAX_DELTA,
  SPAWN_POSITION,
  SPAWN_YAW,
  START_TIME_OF_DAY,
  WITNESS_SYNC_INTERVAL,
  WORLD_SEED,
  WORLD_SEED_KEY,
} from './config';
import { CityMaterialLibrary } from './city-materials';
import { CityStreamer } from './city-streamer';
import {
  CombatTargetBridge,
  ThreatBridge,
  WitnessBridge,
  auditAimPoints,
  perceivableTargets,
} from './bridges';
import {
  createDiagnostics,
  recordError,
  type IBootTimings,
  type IIntegrationDiagnostics,
} from './diagnostics';

const log = createLogger('game');

/** Player capsule. Matches `PLAYER_HEIGHT` / `PLAYER_RADIUS` in `src/physics`. */
const PLAYER_HEIGHT = 1.75;
const PLAYER_RADIUS = 0.3;

/** Fist socket height above the capsule centre, metres. Punch origin. */
const FIST_HEIGHT = 0.45;

/** Additive bloom strength. See the note where it is applied. */
const BLOOM_STRENGTH = 0.3;

/**
 * Linear radiance above which a surface blooms.
 *
 * 1.5x a white surface in direct sun at this world's light scale — see the note
 * where it is applied for the arithmetic.
 */
const BLOOM_THRESHOLD = 2.2;

export interface IBootOptions {
  readonly canvas: HTMLCanvasElement;
  readonly uiRoot: HTMLElement;
  /** Progress sink for the pre-HUD boot screen in `index.html`. */
  readonly onProgress?: (fraction: number, label: string) => void;
  /** Force a render tier, bypassing the device probe. `?tier=` does this. */
  readonly forceRenderTier?: IQualityTier;
  /** Pretend to be a native shell, to prove the mobile asset pin. `?native=1`. */
  readonly forceNative?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Game                                                                       */
/* -------------------------------------------------------------------------- */

export class Game {
  readonly bus = new EventBus();
  readonly clock: GameClock;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  readonly diagnostics: IIntegrationDiagnostics;

  readonly renderer: Renderer;
  readonly registry: AssetRegistry;
  readonly provider: HttpAssetProvider;
  readonly physics: PhysicsWorld;
  readonly spatial: SpatialIndex;
  readonly dayNight: DayNightSystem;
  readonly sky: SkyEnvironment | undefined;
  readonly nightUniforms: NightUniforms;
  readonly shadows: ShadowSystem;
  readonly materials: CityMaterialLibrary;
  readonly cityGenerator: CityGenerator;
  readonly cityStreamer: CityStreamer;
  readonly damage: ChunkDamageState;
  readonly destruction: DestructionSystem;
  readonly debris: DebrisPool;
  readonly ragdolls: RagdollManager;
  readonly impulses: ImpulsePropagator;
  readonly player: PlayerRig;
  readonly combat: CombatSystem;
  readonly monsters: MonsterSystem;
  readonly crowd: CrowdSystem;
  readonly progression: ProgressionCoordinator;
  readonly vfx: VFXSystem;
  readonly audio: AudioSystem;
  readonly input: IInputManager;
  readonly hud: HudManager;
  readonly freeze: ImpactFreeze;

  /**
   * Saitama's animator.
   *
   * Held here because NOBODY ELSE TICKS IT. `IAnimator.update` is documented as
   * "called by the animation system", and there is no animation system — there
   * is a library that builds animators and a set of entities that ask them to
   * play clips. `HeroNpc` happens to tick its own; `PlayerController` and
   * `Monster` do not, by design, because neither owns a frame. So the
   * composition root advances every animator that has no other owner, and a
   * character that is never ticked stands in its bind pose forever, which is
   * exactly what the first assembled build did.
   */
  readonly playerAnimator: ProceduralAnimator;

  readonly combatTargets: CombatTargetBridge;
  readonly threats: ThreatBridge;
  readonly witnesses: WitnessBridge;

  readonly playerId: EntityId = 'player';

  private readonly monsterTargets: IMonsterTarget[] = [];
  private readonly scratchVec = new THREE.Vector3();
  private readonly scratchForward = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3(0, 1, 0);
  private readonly disposers: (() => void)[] = [];
  private readonly propCache = new Map<
    string,
    { geometry: THREE.BufferGeometry; material: THREE.Material } | null
  >();
  private propsAttached = 0;

  private rafHandle = 0;
  private running = false;
  private disposed = false;
  private frameIndex = 0;
  private lastRawDelta = FIXED_STEP;
  private witnessTimer = 0;
  private autosaveTimer = 0;
  private auditTimer = 0;
  private modalPaused = false;
  private firstFramePresented = false;
  private civiliansSaved = 0;
  private civiliansLost = 0;
  private chunksDetached = 0;
  private alliesDown = 0;

  private constructor(parts: IGameParts) {
    this.diagnostics = parts.diagnostics;
    this.clock = parts.clock;
    this.camera = parts.camera;
    this.renderer = parts.renderer;
    this.registry = parts.registry;
    this.provider = parts.provider;
    this.physics = parts.physics;
    this.spatial = parts.spatial;
    this.dayNight = parts.dayNight;
    this.sky = parts.sky;
    this.nightUniforms = parts.nightUniforms;
    this.shadows = parts.shadows;
    this.materials = parts.materials;
    this.cityGenerator = parts.cityGenerator;
    this.cityStreamer = parts.cityStreamer;
    this.damage = parts.damage;
    this.destruction = parts.destruction;
    this.debris = parts.debris;
    this.ragdolls = parts.ragdolls;
    this.impulses = parts.impulses;
    this.player = parts.player;
    this.playerAnimator = parts.playerAnimator;
    this.combat = parts.combat;
    this.monsters = parts.monsters;
    this.crowd = parts.crowd;
    this.progression = parts.progression;
    this.vfx = parts.vfx;
    this.audio = parts.audio;
    this.input = parts.input;
    this.hud = parts.hud;
    this.freeze = parts.freeze;
    this.scene = parts.scene;
    this.bus = parts.bus;

    this.combatTargets = new CombatTargetBridge(this.monsters, this.combat);
    this.threats = new ThreatBridge(this.monsters, this.crowd);
    this.witnesses = new WitnessBridge(this.crowd, this.progression);

    this.subscribe();
  }

  /* ---------------------------------------------------------------------- */
  /* Bootstrap                                                              */
  /* ---------------------------------------------------------------------- */

  static async boot(options: IBootOptions): Promise<Game> {
    const t = new PhaseTimer();
    const report = options.onProgress ?? ((): void => {});

    /* ---- 1. PROBE ------------------------------------------------------ */
    report(0.02, 'Probing device');
    const native = options.forceNative === true || isCapacitorNative();
    const platform = detectPlatform();
    const renderTier = options.forceRenderTier ?? probeRenderTier(native, platform);
    const diagnostics = createDiagnostics(renderTier, import.meta.env?.MODE ?? 'unknown');
    diagnostics.world.isNative = native;
    diagnostics.world.platform = platform;
    t.mark(diagnostics.boot, 'probe');

    /* ---- 2. RENDERER --------------------------------------------------- */
    report(0.06, 'Creating renderer');
    //
    // The bus and the HUD come up FIRST, before anything that takes time. The
    // HUD's `LoadingScreen` is the real loading screen — `index.html`'s inline
    // one exists only to cover the gap before any JavaScript has parsed, and it
    // cannot come back for a later load. Building the HUD here means the bar
    // the player watches for the next five seconds is driven by
    // `AssetRegistry.preloadCore`'s byte-accurate progress rather than by the
    // handful of coarse steps the inline screen can reach.
    const renderer = new Renderer({
      canvas: options.canvas,
      tier: renderTier,
      // The verification harness reads pixels back, and a discarded drawing
      // buffer makes that return whatever the compositor last left behind.
      preserveDrawingBuffer: true,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const capabilities = renderer.getCapabilities();
    diagnostics.renderer = capabilities.renderer;
    diagnostics.vendor = capabilities.vendor;
    diagnostics.isWebGL2 = capabilities.isWebGL2;
    diagnostics.maxTextureSize = capabilities.maxTextureSize;
    diagnostics.maxAnisotropy = capabilities.maxAnisotropy;
    diagnostics.compressedFormats = [...capabilities.compressedFormats];
    renderer.raw.info.autoReset = false;

    const bus = new EventBus();
    // `modalPaused` and `settings` are bound after construction because both
    // callbacks need the finished `Game`, and the HUD has to exist long before.
    const hudHooks: {
      onModal?: (modal: boolean) => void;
      onSettings?: (settings: IHudSettings) => void;
    } = {};
    const hud = new HudManager({
      mount: options.uiRoot,
      bus,
      onModalChange: (modal) => hudHooks.onModal?.(modal),
      onSettingsChange: (settings) => hudHooks.onSettings?.(settings),
    });
    hud.store.setPhase('loading');
    hud.show('boot');
    const step = (fraction: number, label: string): void => {
      hud.store.setLoading(clamp01(fraction), label);
      hud.update(0);
      report(fraction, label);
    };
    t.mark(diagnostics.boot, 'renderer');

    /* ---- 3. ASSETS ----------------------------------------------------- */
    step(0.1, 'Reading manifest');
    //
    // ══════════════════════════════════════════════════════════════════════
    //  FIX 1 — PIN THE MOBILE TIER ON A NATIVE SHELL
    // ══════════════════════════════════════════════════════════════════════
    // `assets.runtime.json` advertises `tiersBuilt: ['mobile','high','ultra']`
    // and the Android package contains the MOBILE tier only: 26 files the
    // manifest names (13 high + 13 ultra, four of them 7 MB HDRIs) are not
    // inside the APK. A runtime that believes the manifest asks for a `high`
    // environment map on the first frame and 404s before anything is drawn.
    //
    // `selectQualityTier` already refuses to pick anything but `mobile` when
    // `signals.isNative` is true — that is not a performance judgement, it is a
    // statement about what shipped. What was missing is the wiring: the probe
    // has to be told, and on a spoofed-native verification run `navigator` says
    // nothing about Capacitor. So the signal is passed EXPLICITLY, and the tier
    // is forced outright when the shell is native, which makes the number of
    // requests for a tier that is not there exactly zero rather than
    // recoverable. `TierAvailability` is still armed underneath as the second
    // defence for the ordinary case: 153 of the 166 outputs exist at `mobile`
    // only, so even a desktop `high` run demotes per asset.
    // Probed from the live context, so `MAX_TEXTURE_SIZE` is a real number
    // rather than an assumption, and then overridden on the two signals the
    // browser cannot tell us about on a spoofed-native verification run.
    const signals = { ...detectTierSignals(renderer.raw), isNative: native, platform };
    const provider = new HttpAssetProvider({
      tier: native ? 'mobile' : undefined,
      signals,
    });
    await provider.loadManifest();
    const decision = provider.tierDecision;
    diagnostics.world.assetTier = decision.tier;
    diagnostics.world.assetTierRequested = decision.requested;
    diagnostics.world.assetTierReason = decision.reason;
    log.info(`asset tier '${decision.tier}' — ${decision.reason}`);

    const registry = await AssetRegistry.open({
      provider,
      renderer: renderer.raw,
      anisotropy: Math.min(4, capabilities.maxAnisotropy),
      // The registry's own PMREM is turned OFF and it is not a quality
      // decision. `SkyEnvironment` blends the four HDRIs into ONE equirect and
      // filters that; letting the registry pre-filter each source as it lands
      // pays for four PMREM chains that are then thrown away, which measured
      // 6.5 s of a 12 s boot on software GL.
      pmrem: false,
    });

    // Everything the world needs a handle on, created before the long waits so
    // the sky's four HDRIs and Rapier's wasm can be in flight WHILE the core
    // asset set streams. Boot was serial before this and the three phases add
    // up to more than the longest one.
    const scene = new THREE.Scene();
    scene.name = 'city-z';
    const camera = new THREE.PerspectiveCamera(
      55,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.25,
      2400
    );
    const measurements = parseEnvironmentMeasurements(provider.rawManifest);
    const profile = renderProfileFor(renderTier);
    const materials = new CityMaterialLibrary(Math.min(4, capabilities.maxAnisotropy));

    let sky: SkyEnvironment | undefined;
    try {
      sky = new SkyEnvironment({
        renderer: renderer.raw,
        scene,
        registry,
        measurements,
        // The manifest's own advice, taken at every tier: the baked SH-9 in
        // `environments` is 27 floats against a ~12 MB cubemap chain, and the
        // visible sky is the blended equirect either way. A PMREM here buys a
        // sharper reflection on wet asphalt for several seconds of boot.
        mode: 'sh9',
        showBackground: true,
      });
    } catch (error) {
      recordError(diagnostics, 'sky', error);
      sky = undefined;
      scene.background = new THREE.Color(0x8fa9c4);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  RAISE THE CITY WHILE THE BYTES ARE STILL IN FLIGHT
    // ══════════════════════════════════════════════════════════════════════
    // `preloadCore` is 17 MB of KTX2 whose transcode happens on the Basis
    // worker, and generating a downtown chunk is ~700 ms of pure main-thread
    // arithmetic. Awaiting the first before starting the second adds those two
    // numbers together for no reason. So the preload is STARTED and not
    // awaited, the world is built against synthesised stand-in materials, and
    // `CityMaterialLibrary.adoptAll()` swaps the real maps onto the same
    // material objects the moment they land — no rebuild, no reallocation, and
    // about a second and a half off the boot.
    const skyReady = sky?.load() ?? Promise.resolve([]);
    const physicsReady = initPhysics();
    step(0.14, 'Loading core assets');
    const corePreload = registry.preloadCore((progress) => {
      step(0.14 + clamp01(progress.fraction) * 0.36, `Loading assets ${progress.loaded}/${progress.total}`);
    });

    /* ---- 4. PHYSICS ---------------------------------------------------- */
    await physicsReady;
    log.info(`rapier ready in ${physicsInitDurationMs().toFixed(0)}ms`);
    const physics = new PhysicsWorld({
      eventBus: bus,
      fixedStep: FIXED_STEP,
      contactEvents: true,
      debrisContactEvents: false,
    });
    t.mark(diagnostics.boot, 'physics');

    /* ---- 5. WORLD ------------------------------------------------------ */
    step(0.56, 'Raising City Z');
    const dayNight = new DayNightSystem({
      bus,
      measurements,
      startTimeOfDay: START_TIME_OF_DAY,
    });
    dayNight.update(0);

    try {
      // NOTE: `SkyEnvironment.setSphericalHarmonics` is deliberately NOT called.
      // In `sh9` mode the sky already PMREMs its blended probe into
      // `scene.environment`, and three serves BOTH diffuse irradiance and
      // specular from that. Adding the measured SH-9 set as a `LightProbe` on
      // top is a second diffuse ambient over the same sky — the module's own
      // header calls it "a stop too bright", and it is: it is what pushed the
      // white cape past the bloom threshold and wrapped every character in a
      // halo. The SH path is the right one when the material layer can cancel
      // the environment's diffuse term (`applySpecularOnlyEnvironment`, which
      // needs `MaterialLib`'s shader hook); this composition does not use
      // MaterialLib for the city, so it takes the environment map as the single
      // source and leaves the probe out.
      void sky;
    } catch (error) {
      recordError(diagnostics, 'sky', error);
      scene.background ??= new THREE.Color(0x8fa9c4);
    }
    t.mark(diagnostics.boot, 'sky');

    const nightUniforms = new NightUniforms();
    const shadows = new ShadowSystem(scene, camera, {
      profile: profile.shadows,
      lighting: dayNight.lighting,
    });
    shadows.applyLightingState(dayNight.lighting);
    renderer.setLightingState(dayNight.lighting);

    if (profile.post.mode !== 'off') {
      try {
        const post = new PostProcessing({
          renderer: renderer.raw,
          scene,
          camera,
          profile: profile.post,
          exposure: dayNight.lighting.exposure,
        });
        // ══════════════════════════════════════════════════════════════════
        //  THE BLOOM THRESHOLD IS RELATIVE TO THE SCENE'S LIGHT SCALE
        // ══════════════════════════════════════════════════════════════════
        // The tier profile ships `bloomThreshold: 1.0`, which is only a
        // meaningful number once you know how bright the world is. Measured
        // here, at 0.34 of a clear day: sun 2.75, environment 0.79, and a white
        // surface with albedo 0.89. A sunlit patch of that surface sits at
        //
        //     0.89 * 2.75 / PI  +  0.89 * 0.79  =  1.48
        //
        // in linear radiance — so EVERY white sunlit thing is over threshold,
        // by half again. Saitama's cape, the lane markings and the kerb lines
        // all bloom, and the captures show exactly that: a white silhouette
        // inside a halo two body-widths across, and lane lines reading as neon.
        //
        // The profile is not wrong; it was measured against a scene lit to a
        // different scale, and `src/engine/quality.ts` belongs to another
        // workstream. The threshold that matches THIS content is set here, on
        // the live pass, because the composition root is the only layer that
        // knows both numbers. Above 2.2 nothing ordinary blooms and the things
        // that are supposed to — the Serious Punch flash, night emissives,
        // Genos's cannon — still do.
        tuneBloomThreshold(post, BLOOM_THRESHOLD);
        post.setEffectIntensity('bloom', BLOOM_STRENGTH);
        renderer.setPostProcessing(post);
      } catch (error) {
        recordError(diagnostics, 'post-processing', error);
      }
    }

    const spatial = new SpatialIndex();
    const damage = new ChunkDamageState();
    const debrisGroup = new THREE.Group();
    debrisGroup.name = 'debris';
    scene.add(debrisGroup);
    const ragdollGroup = new THREE.Group();
    ragdollGroup.name = 'ragdolls';
    scene.add(ragdollGroup);

    const debris = new DebrisPool(physics, {
      container: debrisGroup,
      rng: createRng(`${WORLD_SEED_KEY}:debris`),
      groundY: 0,
      material: new THREE.MeshStandardMaterial({
        color: 0x9a938a,
        roughness: 0.95,
        metalness: 0,
      }),
    });
    const ragdolls = new RagdollManager(physics);
    const impulses = new ImpulsePropagator(physics);
    impulses.attach(bus);

    const destruction = new DestructionSystem({
      bus,
      debris,
      damage,
      collapsingFloors,
      seed: WORLD_SEED_KEY,
    });

    const generator = new CityGenerator(rawPlan as unknown as ICityPlan, {
      defaultDetail: 'full',
      includeProps: false,
    });

    const crowd = new CrowdSystem({
      scene,
      bus,
      seed: WORLD_SEED,
      playerId: 'player',
      quality: renderTier,
    });
    t.mark(diagnostics.boot, 'crowd');

    const cityStreamer = new CityStreamer({
      generator,
      scene,
      resolve: materials.resolve,
      destruction,
      physics,
      spatial,
      bus,
      quality: renderTier,
      registerMaterials: (root) => shadows.registerSceneMaterials(root),
      onResidencyChanged: () => {
        crowd.setObstacles(cityStreamer.obstacleRects());
      },
    });
    cityStreamer.setFocus(SPAWN_POSITION.x, SPAWN_POSITION.z);
    cityStreamer.buildImmediate(BOOT_RADIUS);
    spatial.refit();
    t.mark(diagnostics.boot, 'world');

    // The city is standing. Collect what was fetched underneath it.
    step(0.72, 'Dressing City Z');
    await corePreload;
    const registryDiagnostics = registry.diagnostics();
    diagnostics.world.assetsMissing = registryDiagnostics.missing.length;
    diagnostics.world.assetTierMisses = registryDiagnostics.tierMisses.length;
    diagnostics.world.assetTiersUnavailable = [...registryDiagnostics.unavailableTiers];
    materials.useRegistry(registry);
    materials.adoptAll();
    try {
      await skyReady;
      sky?.update(dayNight.blend, true);
    } catch (error) {
      recordError(diagnostics, 'sky', error);
      scene.background ??= new THREE.Color(0x8fa9c4);
    }
    t.mark(diagnostics.boot, 'assets');

    /* ---- 6. SYSTEMS ---------------------------------------------------- */
    step(0.76, 'Waking Saitama');

    const saitama = buildSaitama();
    scene.add(saitama.parts.root);

    const controller = physics.createCharacterController(
      new THREE.Vector3(SPAWN_POSITION.x, SPAWN_POSITION.y, SPAWN_POSITION.z),
      PLAYER_HEIGHT,
      PLAYER_RADIUS
    );
    const player = new PlayerRig({
      controller,
      camera,
      bus,
      probe: createPhysicsCameraProbe(physics, { exclude: [controller.body.handle] }),
      character: { ...saitama.parts, animator: saitama.animator },
      animator: saitama.animator,
      entityId: 'player',
      yaw: SPAWN_YAW,
      cameraYaw: SPAWN_YAW,
      driveFov: true,
    });

    const districtAt = (position: Vec3): DistrictType =>
      cityStreamer.districtAt(position.x, position.z);

    const combat = createCombatSystem({
      bus,
      seed: WORLD_SEED_KEY,
      districtAt,
      attacker: {
        id: 'player',
        getOrigin(out): void {
          out.x = player.controller.position.x;
          out.y = player.controller.position.y + FIST_HEIGHT;
          out.z = player.controller.position.z;
        },
        // ══════════════════════════════════════════════════════════════════
        //  THE TWO YAW CONVENTIONS IN THIS REPOSITORY
        // ══════════════════════════════════════════════════════════════════
        // `PlayerController` follows three.js: an object's forward is its local
        // -Z, so it computes its own yaw as `atan2(-dx, -dz)` and its forward
        // is `(-sin y, 0, -cos y)`. `MonsterBrain` uses the opposite —
        // `(+sin y, +cos y)`. Each is internally consistent; the seam between
        // them is HERE, and getting it wrong points every punch a hundred and
        // eighty degrees away from the thing the player is looking at.
        //
        // Caught by the playthrough, not by review: the traverse beat pushed
        // the stick forward and the diagnostics reported the player at
        // z = -22 after starting at z = +40.
        getFacing(out): void {
          out.x = -Math.sin(player.controller.yaw);
          out.y = 0;
          out.z = -Math.cos(player.controller.yaw);
        },
      },
    });

    const monsterGroup = new THREE.Group();
    monsterGroup.name = 'monsters';
    scene.add(monsterGroup);
    const monsters = new MonsterSystem({
      bus,
      seed: WORLD_SEED_KEY,
      parent: monsterGroup,
      districtAt,
      groundHeight: () => 0,
      onSpawned: (monster) => {
        try {
          monster.attach(buildMonsterBody(monster.archetype.bodyHeightMetres, monster.id));
        } catch (error) {
          recordError(diagnostics, 'monster-body', error);
        }
      },
    });

    // The allies. Genos kites, Mumen Rider does not, and both can lose — which
    // is the only stake this game has, because the protagonist has none.
    crowd.setPlayer(SPAWN_POSITION.x, SPAWN_POSITION.z);
    crowd.setObstacles(cityStreamer.obstacleRects());
    crowd.addHero('genos', SPAWN_POSITION.x - 9, SPAWN_POSITION.z - 12, buildHeroBody('genos'));
    crowd.addHero(
      'mumenRider',
      SPAWN_POSITION.x + 5,
      SPAWN_POSITION.z - 6,
      buildHeroBody('mumenRider')
    );

    const progression = new ProgressionCoordinator({
      bus,
      time: dayNight,
      worldSeed: WORLD_SEED,
    });

    const vfx = new VFXSystem({
      tier: renderTier,
      quality: qualitySettingsFor(renderTier),
      bus,
      camera,
      seed: WORLD_SEED_KEY,
    });
    scene.add(vfx.root);

    let audio: AudioSystem;
    try {
      audio = new AudioSystem({ seed: WORLD_SEED });
      audio.attach(bus);
    } catch (error) {
      recordError(diagnostics, 'audio', error);
      audio = new AudioSystem({ seed: WORLD_SEED, bypassMaster: true });
    }

    const clock = new GameClock({ maxDelta: MAX_DELTA, fixedStep: FIXED_STEP });
    const freeze = new ImpactFreeze(clock, camera, bus, {
      onImpact: (intensity) => vfx.shake.add(0.25 + intensity * 0.4),
    });

    const input = createInputManager({ mount: document.body });

    t.mark(diagnostics.boot, 'systems');

    /* ---- 7. WARMUP ----------------------------------------------------- */
    // ══════════════════════════════════════════════════════════════════════
    //  EVERY LIT MATERIAL, BEFORE THE WARMUP
    // ══════════════════════════════════════════════════════════════════════
    // A material that has not been through `csm.setupMaterial()` accumulates
    // all three cascade lights instead of one and renders three times too
    // bright. There is no diagnostic for it — the symptom is a white silhouette
    // with a halo, which is what the first assembled build looked like. This
    // has to happen BEFORE the warmup or the warmup compiles the wrong program
    // and every material links a second time on first sight.
    shadows.registerSceneMaterials(scene);

    step(0.9, 'Compiling shaders');
    try {
      const warmup = new ShaderWarmup(renderer.raw, scene, {
        includeOffscreen: profile.post.mode !== 'off',
        includeDirectFramebuffer: profile.post.mode === 'off',
        warmShadows: profile.shadows.cascades > 0,
      });
      // ONLY the materials whose vertex layout this file chose. Warming a
      // material against the wrong layout is worse than not warming it: the
      // crowd's instanced VAT material and the shadow system's blob decals
      // both declare attributes the probe geometry does not have, and the
      // compile fails loudly on the console for a program that was going to be
      // fine. Those two systems own their own warmup; the city's materials and
      // the characters' are this file's to warm because they are this file's to
      // create.
      warmup.addAll(cityMaterialsInScene(materials), ['static', 'vertexColors'], true);
      warmup.addAll(characterMaterialsInScene(scene), ['skinned'], true);
      const warmed = warmup.run();
      warmup.dispose();
      log.info(`warmed ${warmed.compiled} programs in ${warmed.durationMs.toFixed(0)}ms`);
    } catch (error) {
      recordError(diagnostics, 'shader-warmup', error);
    }
    t.mark(diagnostics.boot, 'warmup');

    step(0.97, 'Entering City Z');
    const game = new Game({
      diagnostics,
      clock,
      scene,
      camera,
      bus,
      renderer,
      registry,
      provider,
      physics,
      spatial,
      dayNight,
      sky,
      nightUniforms,
      shadows,
      materials,
      cityGenerator: generator,
      cityStreamer,
      damage,
      destruction,
      debris,
      ragdolls,
      impulses,
      player,
      playerAnimator: saitama.animator,
      combat,
      monsters,
      crowd,
      progression,
      vfx,
      audio,
      input,
      hud,
      freeze,
    });
    hudHooks.onModal = (modal): void => game.setModalPaused(modal);
    hudHooks.onSettings = (settings): void => game.applySettings(settings);

    diagnostics.systems.online = [
      'engine.renderer',
      'engine.shadows',
      profile.post.mode === 'off' ? 'engine.post(off)' : 'engine.post',
      'engine.impact-freeze',
      'assets.registry',
      'spatial.index',
      'world.city',
      sky ? 'world.sky' : 'world.sky(failed)',
      'physics.rapier',
      'physics.debris',
      'physics.ragdolls',
      'characters.mesh',
      'characters.anim',
      'entities.player',
      'entities.monster',
      'entities.npc',
      'gameplay.combat',
      'gameplay.destruction',
      'gameplay.progression',
      'vfx',
      'audio',
      'ui.input',
      'ui.hud',
    ];
    diagnostics.systems.skipped['world.streaming'] =
      'chunk residency is driven by CityStreamer: the streaming worker protocol ' +
      'emits IGeometryBuffers with no UVs, no material groups and no aDestroyed ' +
      'attribute, so its chunks cannot be registered with DestructionSystem. ' +
      'ChunkDamageState and the chunkIndex convention ARE used.';
    diagnostics.systems.skipped['characters.roster'] =
      'runtime atlas baking is seconds per character; bodies ship with vertex ' +
      'colours from the mesh generator instead.';

    return game;
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.hud.store.setPhase('playing');
    this.hud.show('hud');
    this.clock.resync();

    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('orientationchange', this.onResize, { passive: true });
    this.disposers.push(() => {
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('orientationchange', this.onResize);
    });

    // The Web Audio context cannot start without a gesture, and asking for one
    // that never comes must not stop the game from running.
    const unlock = (): void => {
      void this.audio.unlock();
    };
    window.addEventListener('pointerdown', unlock, { once: true, passive: true });
    window.addEventListener('keydown', unlock, { once: true, passive: true });

    // The Android back button. `handleBack` pops one HUD screen and returns
    // false when there is nothing left to pop, which is the point at which the
    // shell should be allowed to background the app.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') this.hud.handleBack();
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
    void this.bindNativeBackButton();

    this.onResize();
    void this.loadRemainingMaterials();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  /**
   * Fetch the city's real materials behind the running game.
   *
   * Deliberately AFTER `start()`, never before it: these are 51 MB of KTX2 and
   * only seven of the forty-one are flagged `preload`, so waiting for them
   * would trade a playable world for a longer progress bar. They arrive in
   * priority order and are swapped onto the live materials by
   * `CityMaterialLibrary.adopt`, which upgrades every block that already binds
   * them without rebuilding a single mesh.
   */
  /**
   * Route the hardware back button through the HUD's own stack.
   *
   * Dynamically imported and wrapped, because `@capacitor/app` resolves to a
   * web shim in a browser and the plugin is simply absent in a plain page. A
   * missing back button must never be a boot failure.
   */
  private async bindNativeBackButton(): Promise<void> {
    try {
      const { App } = await import('@capacitor/app');
      const handle = await App.addListener('backButton', () => {
        if (!this.hud.handleBack()) void App.exitApp();
      });
      this.disposers.push(() => void handle.remove());
    } catch {
      // No native shell. Escape already covers the desktop case.
    }
  }

  private async loadRemainingMaterials(): Promise<void> {
    try {
      // Only what the resident city is actually BINDING, re-asked after each
      // wave because chunks keep streaming in. Walking the manifest's full
      // 41-material, 51 MB list instead would spend a minute of main-thread
      // texture uploads on materials nothing in view uses — which is exactly
      // long enough to make the first minute of play stutter.
      let pending = this.materials.pendingUpgrades();
      const seen = new Set<string>();
      while (pending.length > 0 && !this.disposed) {
        for (const key of pending) {
          if (this.disposed) return;
          seen.add(key);
          await this.registry.load(key, 'low');
          this.materials.adopt([key]);
          await nextFrame();
        }
        pending = this.materials.pendingUpgrades().filter((key) => !seen.has(key));
      }
      log.info(`upgraded ${this.materials.upgraded.size} city materials`);

      // Street furniture. 24 MB of GLB across 39 models, and the reason the
      // first assembled build looked like a town planner's massing model
      // rather than a street: the lamps, hydrants, bins, shop shutters and
      // parked cars are all here, and none of them belong on the boot path.
      //
      // Only what the resident ring actually references, re-asked after each
      // wave so a chunk that streamed in meanwhile is picked up too.
      let props = this.cityStreamer.requiredPropModels();
      const done = new Set<string>();
      while (props.length > 0 && !this.disposed) {
        for (const key of props) {
          if (this.disposed) return;
          done.add(key);
          await this.registry.load(key, 'low');
          await nextFrame();
        }
        this.propsAttached += this.cityStreamer.attachProps(this.resolveProp);
        props = this.cityStreamer.requiredPropModels().filter((key) => !done.has(key));
      }
      log.info(`attached ${this.propsAttached} prop batches from ${done.size} models`);
    } catch (error) {
      recordError(this.diagnostics, 'background-load', error);
    }
  }

  /**
   * Prop asset key -> drawable geometry.
   *
   * The registry serves a whole `Object3D` per model because a GLB can be a
   * hierarchy; an `InstancedMesh` needs one geometry and one material. Props
   * are single-mesh by construction (the pipeline flattens them), so the first
   * mesh found IS the prop — and returning `undefined` for anything else is
   * what makes `attachProps` safely re-runnable while the models stream.
   */
  private readonly resolveProp = (
    assetKey: string
  ): { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined => {
    const cached = this.propCache.get(assetKey);
    if (cached !== undefined) return cached ?? undefined;
    const model = this.registry.getModel(assetKey);
    if (model === undefined) return undefined;
    let found: { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined;
    model.traverse((node) => {
      if (found !== undefined) return;
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      if (material === undefined) return;
      found = { geometry: mesh.geometry, material };
    });
    this.propCache.set(assetKey, found ?? null);
    return found;
  };

  /**
   * A modal screen is open, so the world stops and the interface does not.
   *
   * `timeScale = 0` rather than stopping the loop: the HUD is updated with
   * UNSCALED time, the resolution governor keeps sampling, and unpausing does
   * not need a `resync()` because no wall-clock gap accumulated.
   */
  setModalPaused(modal: boolean): void {
    this.modalPaused = modal;
    this.hud.store.setPhase(modal ? 'paused' : 'playing');
  }

  /**
   * Fan the settings screen out across the systems that own each knob.
   *
   * The HUD deliberately knows none of them — it produces an `IHudSettings` and
   * stops, which is why this lives here and not in `src/ui/hud`.
   */
  applySettings(settings: IHudSettings): void {
    try {
      const tier = settings.qualityTier;
      if (tier !== this.renderer.tier) {
        this.renderer.setQualityTier(tier);
        this.crowd.setQuality(tier);
        this.cityStreamer.setQuality(tier);
        this.diagnostics.quality = tier;
      }
      this.renderer.setPixelRatio(
        (window.devicePixelRatio || 1) * Math.max(0.5, settings.resolutionScale)
      );
      this.input.setTuning({
        lookFullRateDegPerSec: DEFAULT_INPUT_TUNING.lookFullRateDegPerSec * settings.lookSensitivity,
        invertLookY: settings.invertLookY,
      });
    } catch (error) {
      recordError(this.diagnostics, 'settings', error);
    }
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle !== 0) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const off of this.disposers) off();
    this.disposers.length = 0;

    this.hud.dispose();
    this.input.dispose();
    this.audio.dispose();
    this.vfx.dispose();
    this.progression.dispose();
    this.destruction.dispose();
    this.combat.dispose();
    this.monsters.dispose();
    this.crowd.dispose();
    this.player.dispose();
    this.freeze.dispose();
    this.cityStreamer.dispose();
    this.materials.dispose();
    this.sky?.dispose();
    this.shadows.dispose();
    this.debris.dispose();
    this.ragdolls.dispose();
    this.physics.dispose();
    this.spatial.dispose();
    this.registry.dispose();
    this.renderer.dispose();
    this.bus.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Frame                                                                  */
  /* ---------------------------------------------------------------------- */

  private readonly tick = (nowMs: number): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.tick);
    try {
      this.frame(nowMs);
    } catch (error) {
      recordError(this.diagnostics, 'frame', error);
      log.error('frame failed', error);
      // One bad frame must not take the loop down: the next one may be fine and
      // a dead rAF is a black screen with no way back.
    }
  };

  /** One frame. Exposed so a headless test can step without `requestAnimationFrame`. */
  frame(nowMs: number): void {
    const timings = this.diagnostics.timings;
    const frameStart = performance.now();

    // The freeze runs on REAL time and sets `clock.timeScale`, so it is fed the
    // previous frame's raw delta and applied before the clock advances. Doing it
    // after the tick would spend a whole frame of a 90 ms hit-stop at full speed.
    this.freeze.update(this.lastRawDelta);
    this.clock.tick(nowMs);
    const dt = this.modalPaused ? 0 : this.clock.delta;
    const rawDt = this.clock.rawDelta;
    this.lastRawDelta = rawDt;
    const time = this.clock.elapsed;
    this.frameIndex++;

    /* ---- INPUT --------------------------------------------------------- */
    let mark = performance.now();
    const input: InputState = this.input.poll(this.frameIndex, this.clock.unscaledElapsed);
    timings.input = performance.now() - mark;

    /* ---- SIMULATION ---------------------------------------------------- */
    mark = performance.now();
    if (dt > 0) {
      this.dayNight.update(dt);
      this.sky?.update(this.dayNight.blend);
      this.shadows.applyLightingState(this.dayNight.lighting);
      this.nightUniforms.update(
        this.dayNight.derived.nightFactor,
        this.dayNight.derived.windowLitFraction,
        this.clock.unscaledElapsed
      );
      this.renderer.setLightingState(this.dayNight.lighting);

      // 1-2: decide and COMMAND the move. Applied by physics, below.
      this.player.update(input, dt);

      this.combat.update(input, dt, time);

      this.threats.sync();
      this.monsters.update(dt, {
        time,
        focus: this.player.controller.position,
        targets: perceivableTargets(
          this.playerId,
          this.player.controller.position,
          this.crowd,
          this.monsterTargets
        ),
      });
      // The aim-point mirror. Runs AFTER the monsters moved and BEFORE combat
      // could be asked to resolve anything against them next frame.
      this.combatTargets.sync();

      this.crowd.setPlayer(this.player.controller.position.x, this.player.controller.position.z);
      this.crowd.update(dt);
      this.destruction.update(dt);
      this.progression.update(dt);

      this.witnessTimer -= dt;
      if (this.witnessTimer <= 0) {
        this.witnessTimer = WITNESS_SYNC_INTERVAL;
        this.witnesses.sync(this.player.controller.position);
      }
    }
    timings.simulation = performance.now() - mark;

    /* ---- PHYSICS ------------------------------------------------------- */
    mark = performance.now();
    if (dt > 0) {
      // 3: the commanded move is APPLIED here.
      this.physics.update(dt);
      this.debris.update(dt);
      this.ragdolls.update(dt);
    }
    timings.physics = performance.now() - mark;

    /* ---- CAMERA -------------------------------------------------------- */
    mark = performance.now();
    // 4-5: re-read the solved transform, THEN frame it. `postPhysics` calls
    // `controller.postStep()`; skipping it costs a step of camera freshness.
    this.player.postPhysics(input, dt);
    this.tickAnimators(dt);
    this.vfx.update(dt);
    this.applyCameraShake();
    this.camera.updateMatrixWorld();
    this.shadows.update();
    this.spatial.cull(this.camera);
    timings.camera = performance.now() - mark;

    /* ---- STREAMING ----------------------------------------------------- */
    mark = performance.now();
    this.cityStreamer.setFocus(
      this.player.controller.position.x,
      this.player.controller.position.z
    );
    this.cityStreamer.update(rawDt);
    timings.streaming = performance.now() - mark;

    /* ---- AUDIO --------------------------------------------------------- */
    this.camera.getWorldDirection(this.scratchForward);
    this.audio.setListener(this.camera.position, this.scratchForward, this.scratchUp);
    if (dt > 0) this.audio.update(dt);

    /* ---- HUD (UNSCALED) ------------------------------------------------ */
    mark = performance.now();
    this.updateHud(rawDt);
    timings.hud = performance.now() - mark;

    /* ---- RENDER -------------------------------------------------------- */
    mark = performance.now();
    this.renderer.render(this.scene, this.camera);
    timings.render = performance.now() - mark;

    timings.total = performance.now() - frameStart;
    this.updateDiagnostics(rawDt);

    if (!this.firstFramePresented && this.frameIndex >= 2) {
      this.firstFramePresented = true;
      this.diagnostics.boot.firstFrame = Math.round(performance.now());
      (this.diagnostics as { bootTimeMs: number }).bootTimeMs = Math.round(performance.now());
      window.__GAME_READY__ = true;
      log.info(
        `ready in ${this.diagnostics.bootTimeMs}ms — ${this.diagnostics.drawCalls} draws, ` +
          `${this.cityStreamer.residentCount} chunks`
      );
    }

    /* ---- HOUSEKEEPING -------------------------------------------------- */
    this.autosaveTimer += rawDt;
    if (this.autosaveTimer >= AUTOSAVE_INTERVAL) {
      this.autosaveTimer = 0;
      void this.save();
    }
    this.auditTimer += rawDt;
    if (this.auditTimer >= 1) {
      this.auditTimer = 0;
      // Bodies, debris and ragdolls arrive mid-play and bring their own
      // materials. Registration is idempotent — the shadow system keeps a Set —
      // so this only ever costs a traversal, and a material it misses is a
      // three-times-too-bright object nobody can diagnose from a screenshot.
      this.shadows.registerSceneMaterials(this.scene);
      const bad = auditAimPoints(this.monsters, this.combat);
      if (bad.length > 0) {
        recordError(
          this.diagnostics,
          'aim-offset',
          `${bad.length} monsters registered at feet height`
        );
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Scripted beats                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Place one monster in front of the player, right now.
   *
   * The spawn director already populates the district on its own schedule; this
   * is the deterministic door for a scripted sequence or a verification run
   * that needs a specific archetype at a known distance rather than whatever
   * the pacing model decided to do this minute.
   */
  spawnEncounter(archetypeId: string, distanceMetres = 6): EntityId | undefined {
    try {
      const archetype = monsterArchetype(archetypeId);
      const yaw = this.player.controller.yaw;
      // Player forward is `(-sin y, -cos y)` — three's convention. The monster
      // is placed along it and turned to face back, which in the MONSTER's
      // convention `(+sin, +cos)` is the player's own yaw unchanged.
      const position = {
        x: this.player.controller.position.x - Math.sin(yaw) * distanceMetres,
        y: 0,
        z: this.player.controller.position.z - Math.cos(yaw) * distanceMetres,
      };
      const monster = this.monsters.spawn(archetype, position, yaw);
      this.combatTargets.sync();
      return monster.id;
    } catch (error) {
      recordError(this.diagnostics, 'spawn-encounter', error);
      return undefined;
    }
  }

  /** Turn the player towards the nearest live monster. Scripted beats only. */
  faceNearestMonster(): boolean {
    let best: { x: number; z: number; d: number } | undefined;
    const from = this.player.controller.position;
    for (const descriptor of this.monsters.describeForCombat()) {
      const dx = descriptor.position.x - from.x;
      const dz = descriptor.position.z - from.z;
      const d = dx * dx + dz * dz;
      if (best === undefined || d < best.d) {
        best = { x: descriptor.position.x, z: descriptor.position.z, d };
      }
    }
    if (best === undefined) return false;
    // `atan2(-dx, -dz)`, not `atan2(dx, dz)`: three's forward is local -Z.
    this.player.controller.yaw = Math.atan2(from.x - best.x, from.z - best.z);
    this.player.camera.yaw = this.player.controller.yaw;
    return true;
  }

  /** Turn the player towards the nearest registered structure. Scripted beats only. */
  faceNearestStructure(): boolean {
    const from = this.player.controller.position;
    let best: { x: number; z: number; d: number } | undefined;
    for (const structure of this.destruction.orderedStructures) {
      const dx = structure.originX - from.x;
      const dz = structure.originZ - from.z;
      const d = dx * dx + dz * dz;
      if (best === undefined || d < best.d) {
        best = { x: structure.originX, z: structure.originZ, d };
      }
    }
    if (best === undefined) return false;
    this.player.controller.yaw = Math.atan2(from.x - best.x, from.z - best.z);
    this.player.camera.yaw = this.player.controller.yaw;
    return true;
  }

  /**
   * ══════════════════════════════════════════════════════════════════════
   *  CAN THE WORLD ACTUALLY LOSE?
   * ══════════════════════════════════════════════════════════════════════
   * The protagonist cannot be hurt. That is the premise, and a premise like
   * that leaves a game with no stakes unless something else can be lost — so
   * "Genos and Mumen Rider can genuinely go down" is not a nice-to-have, it is
   * the load-bearing claim of the whole design.
   *
   * It is also the claim most likely to be quietly false, because monsters emit
   * PRESSURE and never damage: `MonsterBrain.release` fires `ShockwaveFired`
   * and stops there. Whether that costs an ally anything is decided three
   * systems away in `CrowdSystem.applyShockwaveToAllies`, and nothing in either
   * module fails if the two never meet.
   *
   * This drives the real path end to end and reports what happened:
   *
   *   MonsterBrain picks an attack -> ShockwaveFired on the bus
   *     -> CrowdSystem.applyShockwaveToAllies -> HeroNpc.takeDamage
   *     -> HeroNpc.die -> AllyDowned
   *
   * Nothing is faked. No health is written, no event is synthesised: a
   * god-tier Harbinger is placed next to the allies and the same `update` calls
   * the game loop makes are made in a tight loop until they are down or the
   * clock runs out. It leaves the world in the state it produces.
   */
  proveAlliesCanLose(maxSeconds = 45): {
    genos: { before: number; after: number; dead: boolean };
    mumen: { before: number; after: number; dead: boolean };
    downedEvents: number;
    waves: number;
    elapsedSeconds: number;
    lastTargetId: string;
    waveOrigins: { x: number; z: number; range: number; power: number; intent: string }[];
    geneosDistance: number;
    mumenDistance: number;
  } {
    const genos = this.crowd.allies.find((a) => a.heroId === 'genos');
    const mumen = this.crowd.allies.find((a) => a.heroId === 'mumenRider');
    const before = { genos: genos?.health ?? 0, mumen: mumen?.health ?? 0 };

    let downedEvents = 0;
    let waves = 0;
    const offDowned = this.bus.on('AllyDowned', () => {
      downedEvents++;
    });
    const sampledOrigins: { x: number; z: number; range: number; power: number; intent: string }[] = [];
    const offWave = this.bus.on('ShockwaveFired', (event) => {
      if (event.sourceId === undefined || this.monsters.get(event.sourceId) === undefined) return;
      waves++;
      if (sampledOrigins.length < 8) {
        sampledOrigins.push({
          x: Math.round(event.origin.x * 10) / 10,
          z: Math.round(event.origin.z * 10) / 10,
          range: event.range,
          power: event.power,
          intent: event.intent,
        });
      }
    });

    // A Harbinger: `crush` carries 120 000 units of pressure, which is `full`
    // intent, which is 1.7x lethality — one hit ends Mumen Rider and three end
    // Genos. The table refuses to spawn one downtown on its own, and that is
    // the correct table; this is a scripted proof, not a spawn rule.
    const anchor = mumen?.transform.position ?? this.player.controller.position;
    const monster = this.monsters.spawn(
      monsterArchetype('mob.god.harbinger'),
      { x: anchor.x + 5, y: 0, z: anchor.z + 2 },
      Math.PI,
      { scripted: true }
    );

    const distanceOf = (hero: { transform: { position: { x: number; z: number } } } | undefined): number => {
      if (hero === undefined) return -1;
      const dx = hero.transform.position.x - monster.brain.position.x;
      const dz = hero.transform.position.z - monster.brain.position.z;
      return Math.round(Math.hypot(dx, dz) * 10) / 10;
    };

    const step = 1 / 30;
    let elapsed = 0;
    try {
      while (elapsed < maxSeconds) {
        elapsed += step;
        this.monsters.update(step, {
          time: this.clock.elapsed + elapsed,
          focus: this.player.controller.position,
          targets: perceivableTargets(
            this.playerId,
            this.player.controller.position,
            this.crowd,
            this.monsterTargets
          ),
        });
        this.crowd.update(step);
        if ((genos?.isDead ?? true) && (mumen?.isDead ?? true)) break;
      }
    } finally {
      offDowned();
      offWave();
      this.monsters.despawn(monster.id);
      this.combatTargets.sync();
    }

    return {
      genos: { before: before.genos, after: genos?.health ?? 0, dead: genos?.isDead ?? false },
      mumen: { before: before.mumen, after: mumen?.health ?? 0, dead: mumen?.isDead ?? false },
      downedEvents,
      waves,
      elapsedSeconds: elapsed,
      // WHO the monster spent the fight looking at, and how far each ally was
      // from the shockwave origins. The failure mode this distinguishes: a
      // monster that fixates on the unkillable protagonist never threatens the
      // world, so the allies survive by being irrelevant rather than by being
      // tough — and the damage falloff (`(1 - d/range)^1.4`) is brutal enough
      // that "in the fight but ten metres off-axis" and "not in the fight"
      // produce the same number.
      lastTargetId: String(monster.brain.currentTargetId ?? 'none'),
      waveOrigins: sampledOrigins,
      geneosDistance: distanceOf(genos),
      mumenDistance: distanceOf(mumen),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Save / load                                                            */
  /* ---------------------------------------------------------------------- */

  async save(): Promise<void> {
    try {
      await this.progression.save(
        {
          x: this.player.controller.position.x,
          y: this.player.controller.position.y,
          z: this.player.controller.position.z,
        },
        this.player.controller.yaw
      );
    } catch (error) {
      recordError(this.diagnostics, 'save', error);
    }
  }

  /**
   * Restore a save, if one exists.
   *
   * Position and time are applied here rather than inside the coordinator: the
   * coordinator owns progression state and knows nothing about a character
   * controller or a chunk ring, and teleporting the player is both.
   */
  async load(): Promise<boolean> {
    try {
      const save = await this.progression.load();
      if (save === undefined) return false;
      const at = new THREE.Vector3(
        save.playerPosition.x,
        save.playerPosition.y,
        save.playerPosition.z
      );
      this.player.controller.setPosition(at);
      this.player.controller.yaw = save.playerYaw;
      this.dayNight.setTimeOfDay(save.timeOfDay);
      this.cityStreamer.setFocus(at.x, at.z);
      this.cityStreamer.buildImmediate(0);
      return true;
    } catch (error) {
      recordError(this.diagnostics, 'load', error);
      return false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private subscribe(): void {
    const bus = this.bus;
    this.disposers.push(
      bus.on('CivilianSaved', () => {
        this.civiliansSaved++;
      }),
      bus.on('CivilianLost', () => {
        this.civiliansLost++;
      }),
      bus.on('ChunkDetached', () => {
        this.chunksDetached++;
      }),
      bus.on('AllyDowned', () => {
        this.alliesDown++;
      }),
      // Rival movement is NOT on `RankChanged` — that event is the player's by
      // construction and carries no hero id, which the HUD's own header calls
      // out as the reason the ladder renders empty when nobody wires this. The
      // rows are pushed on every player rank change and on every incident,
      // which is when a rival's standing relative to the player can move.
      bus.on('RankChanged', () => this.pushRivals()),
      bus.on('EncounterEnded', () => this.pushRivals())
    );
    this.pushRivals();
  }

  /** Publish the rival ladder. `seatsAbovePlayer` needs the player's own rank. */
  private pushRivals(): void {
    const playerRank = this.progression.progression.state.rank;
    this.hud.store.setRivals(
      this.progression.rivals.snapshot(playerRank).map((rival) => ({
        id: rival.id,
        displayName: rival.displayName,
        heroClass: rival.rank.heroClass,
        rank: rival.rank.rank,
        seatsAbovePlayer: rival.seatsAbovePlayer,
        sharedCredit: rival.sharedCredit,
        offscreenCredit: rival.offscreenCredit,
        jointIncidents: rival.jointIncidents,
      }))
    );
  }

  private updateHud(rawDt: number): void {
    const combat = this.combat.diagnostics();
    this.hud.store.setCharge(
      combat.charge,
      combat.charging,
      combat.charge >= 0.85 ? 'serious' : combat.charge > 0.2 ? 'normal' : 'restrained',
      combat.chargeForecastYen
    );
    this.hud.store.setWitnesses(this.progression.witnesses.size);
    this.hud.update(rawDt);
  }

  /**
   * Advance every animator the entity systems do not advance themselves.
   *
   * The player's gait is driven from the SOLVED transform — speed and root
   * position after the physics step — which is why this runs in the camera
   * phase and not in simulation. Feeding it the commanded velocity instead
   * makes the feet slide every time a wall stops the character.
   */
  private tickAnimators(dt: number): void {
    if (dt <= 0) return;
    const controller = this.player.controller;
    this.playerAnimator.setLocomotion({
      speed: controller.speed,
      grounded: controller.isGrounded,
      // Boredom is a posture, not a stat readout: the more bored he is the more
      // he slouches, which is the one place the meter is visible without a HUD.
      slouch: clamp01(this.progression.boredom.boredom),
    });
    this.playerAnimator.setRoot(controller.position, controller.yaw);
    this.playerAnimator.update(dt);

    for (const monster of this.monsters.all()) {
      monster.character?.animator.update(dt);
    }
  }

  private applyCameraShake(): void {
    const shake = this.vfx.shake as { offset?: THREE.Vector3; roll?: number };
    if (shake.offset === undefined) return;
    this.camera.position.add(shake.offset);
    this.camera.rotateZ(shake.roll ?? 0);
  }

  private updateDiagnostics(rawDt: number): void {
    const d = this.diagnostics;
    const stats = this.renderer.getStats();
    d.drawCalls = stats.drawCalls;
    d.triangles = stats.triangles;
    d.frameCount = this.frameIndex;
    d.fps = rawDt > 0 ? Math.round(1 / rawDt) : 0;
    d.quality = this.renderer.tier;

    const w = d.world;
    const position = this.player.controller.position;
    w.playerPosition.x = position.x;
    w.playerPosition.y = position.y;
    w.playerPosition.z = position.z;
    w.playerState = this.player.controller.state;
    w.chunkIndex = this.spatial.currentChunk;
    w.residentChunks = this.cityStreamer.residentCount;
    w.pendingChunks = this.cityStreamer.pendingCount;
    w.registeredStructures = this.destruction.structures.size;
    w.chunksDetached = this.chunksDetached;
    w.debrisLive = this.destruction.diagnostics.debrisLive;
    w.monsters = this.monsters.count;
    w.civilians = this.crowd.lastStats.near + this.crowd.lastStats.mid;
    w.civiliansLost = this.civiliansLost;
    w.civiliansSaved = this.civiliansSaved;
    w.allies = this.crowd.allies.length;
    w.alliesDown = this.alliesDown;
    w.witnesses = this.progression.witnesses.size;
    w.timeOfDay = this.dayNight.state.timeOfDay;
    w.dayPhase = this.dayNight.state.phase;
    w.exposure = this.dayNight.lighting.exposure;
    w.sunIntensity = this.dayNight.lighting.sunIntensity;
    w.ambientIntensity = this.dayNight.lighting.ambientIntensity;
    w.envMapIntensity = this.dayNight.lighting.envMapIntensity;
    w.rank = String(this.progression.progression.state.rank.rank);
    w.boredom = this.progression.boredom.boredom;
    w.physicsBodies = this.physics.bodyCount;
    w.vfxEffects = this.vfx.activeCount;
    w.shaderPrograms = this.renderer.programCount;
    w.resolutionScale = this.renderer.governor.scale;
    w.timeScale = this.clock.timeScale;
    const registry = this.registry.diagnostics();
    w.assetsMissing = registry.missing.length;
    w.assetTierMisses = registry.tierMisses.length;
    w.assetTiersUnavailable = [...registry.unavailableTiers];
  }

  private readonly onResize = (): void => {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.postProcessing?.setSize(width, height);
  };
}

/* -------------------------------------------------------------------------- */
/* Assembly helpers                                                           */
/* -------------------------------------------------------------------------- */

interface IGameParts {
  diagnostics: IIntegrationDiagnostics;
  clock: GameClock;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  bus: EventBus;
  renderer: Renderer;
  registry: AssetRegistry;
  provider: HttpAssetProvider;
  physics: PhysicsWorld;
  spatial: SpatialIndex;
  dayNight: DayNightSystem;
  sky: SkyEnvironment | undefined;
  nightUniforms: NightUniforms;
  shadows: ShadowSystem;
  materials: CityMaterialLibrary;
  cityGenerator: CityGenerator;
  cityStreamer: CityStreamer;
  damage: ChunkDamageState;
  destruction: DestructionSystem;
  debris: DebrisPool;
  ragdolls: RagdollManager;
  impulses: ImpulsePropagator;
  player: PlayerRig;
  playerAnimator: ProceduralAnimator;
  combat: CombatSystem;
  monsters: MonsterSystem;
  crowd: CrowdSystem;
  progression: ProgressionCoordinator;
  vfx: VFXSystem;
  audio: AudioSystem;
  input: IInputManager;
  hud: HudManager;
  freeze: ImpactFreeze;
}

/** Millisecond stopwatch that writes straight into the boot report. */
class PhaseTimer {
  private last = performance.now();
  mark(into: IBootTimings, key: keyof IBootTimings): void {
    const now = performance.now();
    into[key] = Math.round(now - this.last);
    this.last = now;
  }
}

/**
 * Pick a render tier from coarse device signals.
 *
 * Deliberately separate from the ASSET tier: one is about how much silicon is
 * available and the other about what shipped inside the package. A flagship
 * Android phone gets `high` rendering and `mobile` assets, and both are right.
 */
function probeRenderTier(native: boolean, platform: string): IQualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 4;
  const mobile = native || platform === 'android' || platform === 'ios';
  if (mobile) return cores >= 8 && memory >= 6 ? 'medium' : 'low';
  if (cores >= 8 && memory >= 8) return 'high';
  if (cores >= 4 && memory >= 4) return 'medium';
  return 'low';
}

/** Saitama: the bored slouch is a clip variant, not a separate rig. */
function buildSaitama(): {
  parts: ReturnType<typeof createCharacterParts>;
  animator: ProceduralAnimator;
} {
  const build = buildCharacter('saitama', 0);
  const parts = createCharacterParts(
    build,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.04 })
  );
  parts.root.name = 'saitama';
  parts.root.castShadow = true;
  const animator = new ProceduralAnimator(parts, parts.root, {
    variants: { idle: 'bored' },
    initial: 'idle',
  });
  return { parts, animator };
}

/** A body for one of the allies. Same generator, different recipe. */
function buildHeroBody(id: 'genos' | 'mumenRider'): {
  parts: ReturnType<typeof createCharacterParts>;
  animator: ProceduralAnimator;
} {
  const build = buildCharacter(id, 1);
  const parts = createCharacterParts(
    build,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 })
  );
  parts.root.name = `hero-${id}`;
  const animator = new ProceduralAnimator(parts, parts.root, { seed: id === 'genos' ? 3 : 7 });
  return { parts, animator };
}

/**
 * A body for a monster.
 *
 * The mesh generator's `monsterHumanoid` showcase profile, scaled to the
 * archetype's own height. Deliberately NOT the roster's atlas path: baking a
 * character atlas is seconds of main-thread work per body, which is fine
 * offline and unacceptable when a spawn director places one mid-fight.
 */
function buildMonsterBody(heightMetres: number, id: string): ICharacterInstance {
  const build = buildCharacter('genos', 1);
  const parts = createCharacterParts(
    build,
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x7d5240),
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.05,
    })
  );
  parts.root.name = `monster:${id}`;
  // The generator's hero build is 1.75 m; scale to whatever the archetype says
  // it is, so a 3.4 m Deep Sea King towers and a street pest does not.
  parts.root.scale.setScalar(Math.max(0.6, heightMetres / 1.75));
  const animator = new ProceduralAnimator(parts, parts.root, { seed: 11, initial: 'idle' });
  return { ...parts, animator };
}

/** The city's materials, which this file created and therefore knows the layout of. */
function cityMaterialsInScene(library: CityMaterialLibrary): THREE.Material[] {
  return library.all();
}

/** Skinned character materials — Saitama, the allies, any monster body. */
function characterMaterialsInScene(scene: THREE.Scene): THREE.Material[] {
  const seen = new Set<THREE.Material>();
  scene.traverse((node) => {
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh !== true) return;
    const material = mesh.material;
    if (Array.isArray(material)) for (const item of material) seen.add(item);
    else if (material) seen.add(material);
  });
  return [...seen];
}

/**
 * Raise the bloom pass's threshold on the live chain.
 *
 * `PostProcessing` exposes strength through `setEffectIntensity` but not the
 * threshold, so the pass is found through the composer — the escape hatch that
 * class documents for exactly this. Both bloom implementations ('unreal' and
 * the dual-filter pyramid) expose a numeric `threshold`, so this works on every
 * tier without naming either of them.
 */
function tuneBloomThreshold(post: PostProcessing, threshold: number): void {
  const composer = post.effectComposer;
  if (composer === undefined) return;
  for (const pass of composer.passes) {
    const candidate = pass as unknown as { threshold?: number };
    if (typeof candidate.threshold === 'number') candidate.threshold = threshold;
  }
}

/**
 * Yield until the next presented frame.
 *
 * Used between background asset loads. `await` on a settled promise resumes on
 * a MICROTASK, which never lets `requestAnimationFrame` run — a chain of them
 * starves the render loop completely, and the symptom is a game that boots fast
 * and then appears to hang while it quietly finishes loading.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}
