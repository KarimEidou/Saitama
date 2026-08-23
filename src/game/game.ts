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
  SafeAreaInsets,
  ThreatTier,
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

import { createCharacterParts, type HumanoidBuild } from '@/characters/mesh';
import { ProceduralAnimator } from '@/characters/anim';
import {
  RosterRuntime,
  attachSoloCrowdColors,
  crowdColors,
  expressionForBoredom,
  setExpression,
  setProximityFade,
  type FaceRect,
  type IRosterBody,
} from '@/characters/roster';

import { PlayerRig, createPhysicsCameraProbe } from '@/entities/player';
import { CrowdSystem } from '@/entities/npc';
import { MonsterSystem, monsterArchetype, type IMonsterTarget } from '@/entities/monster';

import { createCombatSystem, type CombatSystem } from '@/gameplay/combat';
import { DestructionSystem } from '@/gameplay/destruction';
import { ProgressionCoordinator, indexForPoints, pointsForIndex } from '@/gameplay/progression';

import { VFXSystem } from '@/vfx';
import { AudioSystem, type ReverbPreset } from '@/audio';
import { createInputManager, type IInputManager } from '@/ui/input';
import {
  HudManager,
  LOADING_LINES,
  MarkerLayer,
  type IHudSettings,
  type IWorldMarker,
  type MarkerKind,
} from '@/ui/hud';

import {
  AUTOSAVE_INTERVAL,
  BOOT_RADIUS,
  FIXED_STEP,
  MARKER_LABEL_CHARS,
  MARKER_RANGE,
  MAX_DELTA,
  QUEST_CLOCK_INTERVAL,
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
  StructureBridge,
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

/**
 * Consecutive throwing frames between console reports.
 *
 * Sixty, so a frame loop that is failing every time says so about once a second
 * instead of sixty times. The diagnostics array de-duplicates separately, in
 * `recordError`.
 */
const FRAME_FAILURE_LOG_INTERVAL = 60;

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
  // Assigned from `parts` in the constructor, NOT built here: a field
  // initialiser runs before the constructor body, so `= new EventBus()` built a
  // second bus per `Game` that was overwritten one statement later — a bus with
  // no subscribers, no emitters and no way to reach it.
  readonly bus: EventBus;
  readonly clock: GameClock;
  /** Same as `bus`: assigned from `parts`, so an initialiser here is thrown away. */
  readonly scene: THREE.Scene;
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
  /**
   * The world-space pin layer.
   *
   * Built HERE and not by `HudManager`, for the same reason the harness builds
   * its own: `MarkerLayer` is the one HUD module allowed to import `three`, it
   * projects against the game's camera, and handing the HUD a camera would make
   * a display layer a build dependency of the renderer. The composition root
   * owns both ends already.
   */
  readonly markers: MarkerLayer;
  readonly freeze: ImpactFreeze;

  /**
   * The baked character atlases, and the loader that brings them in.
   *
   * Held because loading is progressive: Saitama's set is awaited during boot
   * and everyone else's arrives behind `start()`, at which point the bodies
   * already on screen have to be re-skinned.
   */
  readonly roster: RosterRuntime;

  /** The player's material, when he has a baked one. Drives face and dither. */
  private playerSkin: THREE.Material | undefined;
  private readonly deferredSkins: IDeferredSkin[];

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
  readonly combatStructures: StructureBridge;

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
  private started = false;
  private frameFailures = 0;
  private frameIndex = 0;
  private lastRawDelta = FIXED_STEP;
  private witnessTimer = 0;
  private autosaveTimer = 0;
  private auditTimer = 0;
  private questClockTimer = 0;
  /** True while at least one pushed quest row carries a running clock. */
  private questClocksRunning = false;
  /** Last standing pushed to the HUD, so the push happens on change only. */
  private rankPoints = Number.NaN;
  private rankReputation = Number.NaN;
  /** Marker ids this frame and the ids currently published, reused per frame. */
  private readonly markerSeen = new Set<string>();
  private readonly markerIds = new Set<string>();
  private modalPaused = false;
  /** Last district handed to the audio system, so the reverb only glides on a change. */
  private audioDistrict: DistrictType | undefined;
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
    this.markers = parts.markers;
    this.freeze = parts.freeze;
    this.roster = parts.roster;
    this.playerSkin = parts.playerSkin;
    this.deferredSkins = parts.deferredSkins;
    this.scene = parts.scene;
    this.bus = parts.bus;

    this.combatTargets = new CombatTargetBridge(this.monsters, this.combat);
    this.threats = new ThreatBridge(this.monsters, this.crowd);
    this.witnesses = new WitnessBridge(this.crowd, this.progression);
    this.combatStructures = new StructureBridge(this.destruction, this.combat, (x, z) =>
      this.cityStreamer.districtAt(x, z)
    );

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
      // ══════════════════════════════════════════════════════════════════════
      //  SIX LOADING LINES, ONE OF WHICH THE PLAYER HAD EVER SEEN
      // ══════════════════════════════════════════════════════════════════════
      // `LOADING_LINES` holds six rules-of-the-world lines and `LoadingScreen`
      // resolves `lineIndex ?? 0`, so every launch of the shipped game showed
      // the first one and the other five existed only in the harness. They are
      // the one place the game explains that credit needs a witness and that
      // boredom throttles rank gain — a player who reads the same sentence
      // every boot learns one sixth of what the screen was written to teach.
      // Random per launch rather than cycled: nothing persists across a cold
      // start on a phone that was killed in the background, so a stored cursor
      // would show line 0 forever anyway.
      loadingLineIndex: Math.floor(Math.random() * LOADING_LINES.length),
    });
    hud.store.setPhase('loading');
    hud.show('boot');
    // ══════════════════════════════════════════════════════════════════════
    //  THE PINS, WHICH THE SHIPPED GAME HAS NEVER DRAWN
    // ══════════════════════════════════════════════════════════════════════
    // `MarkerLayer` is 228 lines of finished, tested, screenshotted code that
    // nothing in `src/` had ever instantiated, and `HudStore.setMarker` had no
    // caller either — so a resting frame gave the player no direction at all: no
    // waypoint on the tracked request, no diamond over the thing that is about
    // to hit them, and a committed screenshot of a feature the build did not
    // have. Constructed here rather than inside `HudManager` (see the field),
    // and inserted UNDER every screen so a pause sheet covers the pins rather
    // than being covered by them.
    const markers = new MarkerLayer(document, { labelRange: 140, maxRange: MARKER_RANGE });
    hud.root.insertBefore(markers.element, hud.root.firstChild);
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
    // The manifest fetch and the registry open are ASSET time, and charged here
    // rather than left to run into the next mark. `PhaseTimer.mark` measures
    // from the previous mark, so without this the whole asset phase landed in
    // `boot.physics` — which then reported manifest + registry + KTX2 transcoder
    // setup + the Rapier wasm as one number, and a boot regression on a cold
    // mobile cache read as "physics: 4200 ms". The rest of the phase (the tail
    // of `preloadCore`, adoption and the sky wait) is ADDED to this below.
    t.mark(diagnostics.boot, 'assets');

    // ══════════════════════════════════════════════════════════════════════
    //  THE PROTAGONIST'S FACE, STARTED NOW AND AWAITED LATER
    // ══════════════════════════════════════════════════════════════════════
    // `tools/build-characters.ts` bakes every character's albedo/ORM/normal
    // atlas, a four-tile expression strip and a crowd tint mask into
    // `public/assets/chr/`. That bake is seconds per character and must never
    // run in a frame — but LOADING it is three PNG fetches, and not doing so is
    // what left Saitama a blank-faced flat-yellow mannequin with no weave on
    // the jumpsuit.
    //
    // His set is ~1.2 MB and is started HERE, unawaited, so the decode overlaps
    // the sky's HDRIs, Rapier's wasm and the city generator. It is awaited at
    // the point the body is actually built, by which time it has almost always
    // landed for free. Everyone else loads after `start()` — the full cast is
    // 251 MB of texture at `high` and does not belong on the boot path.
    const roster = new RosterRuntime({
      source: provider,
      anisotropy: Math.min(4, capabilities.maxAnisotropy),
    });
    const saitamaSkin = roster.load('chr.saitama');

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
    // ══════════════════════════════════════════════════════════════════════
    //  THE BAR AND THE LABEL NOW COUNT THE SAME THING
    // ══════════════════════════════════════════════════════════════════════
    // The fraction handed to `step` is BOOT progress — this phase occupies
    // 0.14..0.50 of it — while the label used to read `Loading assets N/M`,
    // which is ASSET progress. So the screen opened this phase showing 14%
    // against `0/34` and closed it showing 50% against `34/34`: two counters,
    // two scales, one of them always wrong. The label is the half that goes,
    // because the number the player watches is the one on the bar and the bar
    // has to keep meaning "how much of the boot is left". The file counts are
    // not lost — they are what MOVES the bar through this phase.
    const corePreload = registry.preloadCore((progress) => {
      step(0.14 + clamp01(progress.fraction) * 0.36, 'Loading core assets');
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

    // Hoisted out of the `try` so the boot report can tell "the pass is running"
    // from "the pass was asked for and threw". `systems.online` is read by
    // somebody trying to find out why a boot went wrong, and a subsystem that
    // appears there AND in `systems.failed` is the report lying at the one
    // moment it matters.
    let postOnline = false;
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
        postOnline = true;
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

    // Held in a local rather than inlined into the option bag: an INJECTED
    // material makes `DebrisPool.ownsMaterial` false, so the pool deliberately
    // leaves it alone at teardown and this is the only place that can free it.
    // See the disposer registered next to `game` below.
    const debrisMaterial = new THREE.MeshStandardMaterial({
      color: 0x9a938a,
      roughness: 0.95,
      metalness: 0,
    });
    const debris = new DebrisPool(physics, {
      container: debrisGroup,
      rng: createRng(`${WORLD_SEED_KEY}:debris`),
      groundY: 0,
      material: debrisMaterial,
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
      // ══════════════════════════════════════════════════════════════════════
      //  THE ONE CHARACTER MATERIAL THE LOWER TIERS DO NOT GET
      // ══════════════════════════════════════════════════════════════════════
      // Shader PROGRAMS are the scarce resource, not materials. The baked cast
      // adds three variants — `F-D` for the player, `F--` for allies and
      // monsters, `FC-` for the crowd-tinted civilians — and `medium` has only
      // about five programs of headroom in total.
      //
      // `FC-` is the one to shed, because it is the one whose absence costs
      // least: near-tier civilians are extras, `medium` caps them at ten
      // bodies against `high`'s full set, and the crowd already degrades along
      // exactly this axis. They fall back to the generator's vertex colours,
      // which is what every tier shipped before the bake was wired in.
      //
      // The hook is always INSTALLED and asks the renderer for the live tier
      // when a body is promoted, rather than being decided once from the probed
      // one. `CrowdSystem` takes it as a constructor option with no setter, so a
      // hook chosen at boot is frozen for the session — and the probe never
      // returns `high` on mobile, which left a player who raised quality to
      // `high` with untextured near civilians for the rest of the session, and a
      // player who dropped to `low` still binding the variant the drop was meant
      // to shed. Below `high` this costs one enum comparison per promotion.
      skinNearCivilian: (build, seed) =>
        renderer.tier === 'high' ? skinCivilian(roster, build, seed) : undefined,
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
    // ADDED, not assigned: the phase started back at the manifest and was marked
    // there, and the two halves are the same phase interleaved with the world.
    t.add(diagnostics.boot, 'assets');

    /* ---- 6. SYSTEMS ---------------------------------------------------- */
    step(0.76, 'Waking Saitama');

    // Started back at the provider; by now it has usually landed and this costs
    // nothing. If the bake was never run the promise resolves `false` and he is
    // built against the generator's vertex colours instead of failing to boot.
    if (!(await saitamaSkin)) {
      recordError(
        diagnostics,
        'roster',
        'chr.saitama has no baked atlas — run `npx tsx tools/build-characters.ts`'
      );
    }
    const saitama = buildSaitama(roster);
    scene.add(saitama.parts.root);

    // Bodies built before their atlas landed. Each is re-skinned by
    // `upgradeCharacterSkins()` behind `start()`; a body whose material was
    // already real is not listed and is never touched again.
    const deferredSkins: IDeferredSkin[] = [];
    // Filled in once the Game exists. A closure created during boot must NOT
    // reach for the `const game` below it: optional chaining does not save a
    // temporal-dead-zone access, it throws just the same. A holder object is
    // in scope from the moment it is declared, which a `let` binding is not.
    const onAtlasArrived: { run?: () => void } = {};
    const deferIfUnskinned = (
      body: IRosterBody,
      root: THREE.Object3D,
      options: { proximityFade?: boolean } = {}
    ): void => {
      if (body.material !== undefined) return;
      // NOT filtered against `roster.failed`, tempting as it looks: `load()`
      // records a failure but does not memoise it, and `loadRemainingCharacters`
      // deliberately re-asks for `chr.saitama` precisely so a boot-time fetch
      // that failed gets a second chance. A body dropped from this list here
      // would keep its stand-in even when that retry succeeds. What keeps the
      // list bounded is the despawn sweep in `upgradeCharacterSkins()`.
      deferredSkins.push({ id: body.entry.id, root, faceRect: body.faceRect, options });
    };
    deferIfUnskinned(saitama.body, saitama.parts.root, { proximityFade: true });

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
          const key = monster.archetype.assetKey;
          const built = buildMonsterBody(
            roster,
            key,
            monster.archetype.bodyHeightMetres,
            monster.id
          );
          monster.attach(built.instance);
          deferIfUnskinned(built.body, built.instance.root);
          // Pull this archetype's atlas in behind the spawn. The body is
          // already on screen with the generator's vertex colours; it is
          // re-skinned as soon as the set lands, and the next one of its kind
          // is textured from birth.
          if (!roster.isResident(key)) {
            void roster.load(key).then(() => onAtlasArrived.run?.());
          }
        } catch (error) {
          recordError(diagnostics, 'monster-body', error);
        }
      },
    });

    // The allies. Genos kites, Mumen Rider does not, and both can lose — which
    // is the only stake this game has, because the protagonist has none.
    crowd.setPlayer(SPAWN_POSITION.x, SPAWN_POSITION.z);
    crowd.setObstacles(cityStreamer.obstacleRects());
    const genosBody = buildHeroBody(roster, 'genos');
    const mumenBody = buildHeroBody(roster, 'mumenRider');
    deferIfUnskinned(genosBody.body, genosBody.parts.root);
    deferIfUnskinned(mumenBody.body, mumenBody.parts.root);
    crowd.addHero('genos', SPAWN_POSITION.x - 9, SPAWN_POSITION.z - 12, genosBody);
    crowd.addHero('mumenRider', SPAWN_POSITION.x + 5, SPAWN_POSITION.z - 6, mumenBody);

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
    let primaryAudio: AudioSystem | undefined;
    // An audio system that is online in the sense of ticking, and silent, is
    // not the same fact as an audio system that came up. The boot report has to
    // say which one it got.
    let audioBypassed = false;
    try {
      primaryAudio = new AudioSystem({ seed: WORLD_SEED });
      primaryAudio.attach(bus);
      audio = primaryAudio;
    } catch (error) {
      recordError(diagnostics, 'audio', error);
      // Either statement above can throw. If it was `attach`, the failed system
      // is fully built and still holding an AudioContext and every node in it,
      // so it goes before its replacement is made.
      primaryAudio?.dispose();
      // The retry drops the limiter and the soft clipper — `createDynamicsCompressor`
      // and `createWaveShaper` are the two nodes in the master chain a minimal
      // WebAudio implementation may not provide.
      audio = new AudioSystem({ seed: WORLD_SEED, bypassMaster: true });
      audioBypassed = true;
      try {
        // ATTACHED, exactly like the system it replaces. Without this the
        // fallback subscribes to nothing: not degraded audio, a silent game
        // with a working mixer in it and no diagnostic to say so.
        audio.attach(bus);
      } catch (fallbackError) {
        recordError(diagnostics, 'audio-fallback', fallbackError);
      }
    }

    const clock = new GameClock({ maxDelta: MAX_DELTA, fixedStep: FIXED_STEP });
    const freeze = new ImpactFreeze(clock, camera, bus, {
      // `onImpact` is documented as driving "VFX/post/audio" and only ever drove
      // the shake. `PostProcessing.triggerImpact` had no caller anywhere, so the
      // anime composite — the speed lines, the zoom smear and the chromatic
      // burst that are the entire reason that pass exists on mid and high — could
      // never fire in the shipped game. No-op on tiers without the pass, and this
      // is the one moment it is for: the hit-stop on a lethal punch.
      onImpact: (intensity) => {
        vfx.shake.add(0.25 + intensity * 0.4);
        renderer.postProcessing?.triggerImpact(intensity);
      },
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
    // ══════════════════════════════════════════════════════════════════════
    //  AND THE POST CHAIN, WHICH IS THE OTHER HALF OF THE FIRST FRAME
    // ══════════════════════════════════════════════════════════════════════
    // `ShaderWarmup` compiles MATERIAL programs. The composer's own passes are
    // compiled on first use exactly like them — the bloom chain alone is eight
    // programs — and `PostProcessing.warmup()` says in its docstring that it is
    // "called during loading", which nothing did. The result was a hitch on the
    // first composed frame of every session, in the one place a hitch is most
    // visible: the moment the loading screen clears. Its own try/catch, so a
    // failure here cannot mask the material warmup or vice versa.
    try {
      renderer.postProcessing?.warmup();
    } catch (error) {
      recordError(diagnostics, 'post-warmup', error);
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
      markers,
      freeze,
      roster,
      playerSkin: saitama.body.material,
      deferredSkins,
    });
    // The one GPU resource this bootstrap owns that no system it built will
    // free — `DebrisPool` skips a material it did not create.
    game.disposers.push(() => debrisMaterial.dispose());
    onAtlasArrived.run = (): void => game.upgradeCharacterSkins();
    hudHooks.onModal = (modal): void => game.setModalPaused(modal);
    hudHooks.onSettings = (settings): void => game.applySettings(settings);

    diagnostics.systems.online = [
      'engine.renderer',
      'engine.shadows',
      profile.post.mode === 'off'
        ? 'engine.post(off)'
        : postOnline
          ? 'engine.post'
          : 'engine.post(failed)',
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
      'characters.roster',
      'entities.player',
      'entities.monster',
      'entities.npc',
      'gameplay.combat',
      'gameplay.destruction',
      'gameplay.progression',
      'vfx',
      audioBypassed ? 'audio(bypass)' : 'audio',
      'ui.input',
      'ui.hud',
    ];
    diagnostics.systems.skipped['world.streaming'] =
      'chunk residency is driven by CityStreamer: the streaming worker protocol ' +
      'emits IGeometryBuffers with no UVs, no material groups and no aDestroyed ' +
      'attribute, so its chunks cannot be registered with DestructionSystem. ' +
      'ChunkDamageState and the chunkIndex convention ARE used.';
    // The roster's ATLAS BAKE still never runs at runtime — it is seconds per
    // character — but its OUTPUT is now loaded from `public/assets/chr/`, which
    // is three PNG fetches. Saitama is awaited during boot; the rest arrive
    // behind `start()` and are swapped onto the live bodies.
    if (roster.failed.size > 0) {
      diagnostics.systems.skipped['characters.roster'] =
        `${roster.failed.size} baked atlas set(s) could not be loaded; those bodies ` +
        "fall back to the mesh generator's vertex colours. Run " +
        '`npx tsx tools/build-characters.ts`.';
    }

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

    // Everything below is ONCE PER GAME, not once per start: `stop()` only
    // parks the loop, and a `stop()`/`start()` pair that re-ran this block would
    // leave two Escape handlers popping two HUD screens per press, two back
    // buttons, and two background load chains racing each other over the same
    // registry. Resuming the loop is all a restart has to do.
    if (!this.started) {
      this.started = true;
      this.registerWindowListeners();
      void this.bindNativeBackButton();
      // The rest of the cast BEFORE the city's 51 MB of KTX2: an ally standing
      // four metres away with no face is more obviously wrong than a wall with a
      // stand-in albedo, and the civilian sheet is needed the moment the first
      // pedestrian is promoted to the near tier.
      void this.loadRemainingCharacters().then(() => this.loadRemainingMaterials());
    }

    this.onResize();
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  /** The window-level wiring, and the removers that make `dispose()` complete. */
  private registerWindowListeners(): void {
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('orientationchange', this.onResize, { passive: true });
    this.disposers.push(() => {
      window.removeEventListener('resize', this.onResize);
      window.removeEventListener('orientationchange', this.onResize);
    });

    // The Web Audio context cannot start without a gesture, and asking for one
    // that never comes must not stop the game from running.
    //
    // ── DISARMED ON SUCCESS, NOT ON THE FIRST GESTURE ──────────────────────
    // `AudioSystem.unlock()` RESOLVES when `AudioContext.resume()` rejects; it
    // reports the outcome through `unlocked` instead. Firing once and removing
    // both listeners therefore turned a single rejected resume — the gesture
    // Safari decided was not activating, the tap that landed during a page
    // transition — into a permanently silent session with no way back. They
    // stay armed until the context really is running, so the next tap retries.
    //
    // Removal is by hand (no `{ once: true }`): the listener that never fires
    // would otherwise outlive `dispose()`, holding this `Game`, its scene and
    // every system it owns reachable through the closure.
    let unlocking = false;
    const unlock = (): void => {
      if (unlocking || this.audio.unlocked) return;
      unlocking = true;
      void this.audio
        .unlock()
        .catch((error: unknown) => recordError(this.diagnostics, 'audio-unlock', error))
        .finally(() => {
          unlocking = false;
          if (this.audio.unlocked) removeUnlock();
        });
    };
    const removeUnlock = (): void => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock, { passive: true });
    this.disposers.push(removeUnlock);

    // The Android back button. `handleBack` pops one HUD screen and returns
    // false when there is nothing left to pop, which is the point at which the
    // shell should be allowed to background the app.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') this.hud.handleBack();
    };
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));

    // ══════════════════════════════════════════════════════════════════════
    //  SILENCE THE APP WHEN IT LEAVES THE SCREEN
    // ══════════════════════════════════════════════════════════════════════
    // `IAudioSystem.setSuspended` is documented for exactly this and had no
    // caller anywhere: a backgrounded phone kept an AudioContext running, kept
    // the music director scheduling into it, and — because rAF stops but the
    // context clock does not — came back with a flushed backlog of debris cues
    // for a building that finished falling a minute ago. `visibilitychange` is
    // the event Android actually delivers; `pagehide`/`pageshow` cover the
    // bfcache path Safari takes instead.
    const onVisibility = (): void => this.audio.setSuspended(document.hidden);
    const onPageHide = (): void => this.audio.setSuspended(true);
    const onPageShow = (): void => this.audio.setSuspended(false);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    this.disposers.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    });
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

  /**
   * The cast, after the player is already walking around.
   *
   * Ordered by how close the player gets to each: the allies stand beside him,
   * the civilian sheet dresses everyone the crowd promotes to the near tier,
   * and the monsters are loaded on spawn by the monster system rather than
   * speculatively — there are nine of them and only a couple are ever resident.
   *
   * Sequential with a frame between each, because three 1024² PNG decodes and
   * ~17 MB of texture upload landing in one frame is a visible hitch.
   */
  private async loadRemainingCharacters(): Promise<void> {
    try {
      // CIVILIAN FIRST, and not for looks. The allies are re-skinned in place
      // by `upgradeCharacterSkins`, so a late atlas costs them nothing. A near-
      // tier civilian is built by the crowd on promotion and then RECYCLED for
      // the rest of the session — whatever material it was born with, it keeps.
      // Loading the shared sheet first is what stops the first few pedestrians
      // being permanently flatter than the ones behind them.
      // `chr.saitama` is listed even though boot already loaded him: `load` is
      // idempotent and returns immediately when the set is resident, so in the
      // normal case this is a no-op — and in the case that matters, a boot-time
      // fetch that failed, it is the retry that gets the protagonist his face.
      const wanted = ['chr.saitama', 'chr.genos', 'chr.mumenRider'];
      // The shared civilian sheet is 18 MB and only `high` binds it — the lower
      // tiers shed its shader variant (see `skinNearCivilian` above), so
      // fetching it there would spend the bandwidth and the GPU memory on a
      // texture nothing samples.
      if (this.diagnostics.quality === 'high') wanted.splice(1, 0, 'chr.civilian');
      await this.roster.loadSequential(wanted, async () => {
        this.upgradeCharacterSkins();
        await nextFrame();
      });
      this.upgradeCharacterSkins();
      log.info(
        `roster resident: ${this.roster.residentIds.length} characters, ` +
          `${(this.roster.residentBytes / 1048576).toFixed(1)} MB`
      );
    } catch (error) {
      recordError(this.diagnostics, 'roster-background', error);
    }
  }

  /**
   * Swap real materials onto bodies that were built before their atlas landed.
   *
   * Idempotent and cheap: the list only ever shrinks, and an entry whose atlas
   * is still absent is left alone for the next pass. Newly-skinned materials
   * are handed to the shadow system immediately — the once-a-second audit would
   * get there eventually, but a character rendering three times too bright for
   * up to a second is exactly the artefact that audit exists to prevent.
   */
  private upgradeCharacterSkins(): void {
    for (let i = this.deferredSkins.length - 1; i >= 0; i--) {
      const pending = this.deferredSkins[i]!;
      // A body that has left the scene graph is a despawned monster:
      // `Monster.dispose()` detaches its instance, and nothing else in this
      // list is ever unparented. Dropping it here is what keeps the list bounded
      // by the LIVE cast rather than by total spawns — every entry holds a whole
      // character subtree alive, and every pass traverses all of them.
      if (pending.root.parent === null) {
        this.deferredSkins.splice(i, 1);
        continue;
      }
      const replaced = new Set<THREE.Material>();
      pending.root.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh !== true) return;
        if (Array.isArray(mesh.material)) for (const item of mesh.material) replaced.add(item);
        else if (mesh.material) replaced.add(mesh.material);
      });

      const material = this.roster.reskin(
        pending.root,
        pending.id,
        pending.faceRect,
        pending.options
      );
      if (material === undefined) continue;

      this.shadows.registerMaterial(material);
      if (pending.id === 'chr.saitama') this.playerSkin = material;
      // The stand-in is this file's own object and nothing else references it.
      // Anything else that happened to be bound is left alone.
      for (const old of replaced) {
        if (old.name === STAND_IN_NAME) old.dispose();
      }
      this.deferredSkins.splice(i, 1);
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
        // The shared civilian sheet is only fetched at boot when the PROBED tier
        // was `high` — and on mobile the probe never says `high`. A player who
        // raises quality here is asking for the near-tier civilians the crowd's
        // `skinNearCivilian` hook now agrees to dress, so the 18 MB it needs is
        // pulled in behind the running game. Idempotent, and never on the boot
        // path.
        if (tier === 'high' && !this.roster.isResident('chr.civilian')) {
          void this.roster.load('chr.civilian');
        }
      }
      // ══════════════════════════════════════════════════════════════════════
      //  THE PLAYER'S SCALE GOES UNDERNEATH THE TIER CAP, NOT OVER IT
      // ══════════════════════════════════════════════════════════════════════
      // `Renderer.setPixelRatio` stores this as its BASE ratio and then clamps
      // it to `maxPixelRatio` (1 / 1.5 / 2 by tier) before the governor scales
      // it. Handing it `devicePixelRatio * scale` therefore does nothing at all
      // on any device whose DPR already exceeds the cap — which is every phone
      // this ships to: at DPR 3 on `medium`, 1.0 and 0.5 both clamp to 1.5, and
      // the player drags the slider to half and watches the frame rate not
      // move. Clamping FIRST and scaling after makes the knob mean what it says.
      // Read back off the renderer, so this is the SAME number `applyResolution`
      // clamps with — including after the tier change just above.
      const maxRatio = this.renderer.qualitySettings.maxPixelRatio;
      this.renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, maxRatio) * Math.max(0.5, settings.resolutionScale)
      );
      this.input.setTuning({
        // `lookSensitivity` is the GAIN. `lookFullRateDegPerSec` is the
        // denominator that normalises degrees/second into the -1..1 look rate
        // AND a shared contract constant that `IPlayerTuning.camera` mirrors at
        // 220 — so scaling it here divided the touch turn rate by the setting
        // (2.0x turned the camera at HALF speed) and did nothing whatsoever for
        // keyboard and gamepad, which emit a normalised rate and never see it.
        lookSensitivity: settings.lookSensitivity,
        invertLookY: settings.invertLookY,
        // Haptics were never written at all, so they stayed on after the player
        // turned them off.
        hapticsEnabled: settings.hapticsEnabled,
        // ══════════════════════════════════════════════════════════════════
        //  THE TWO STICK KNOBS NOW MOVE THE STICK
        // ══════════════════════════════════════════════════════════════════
        // `floatingStick` used to be ADVISORY — the touch stick always floated,
        // and this line recorded a preference the input layer then ignored. It
        // is the real switch now, and the default is FIXED, so the control the
        // player finds without looking is the one they get unless they ask for
        // the other. `stickHand` was never forwarded at all: the settings screen
        // offered a left/right choice, wrote it into the model, moved the HUD's
        // own reserve to the other corner — and left the actual stick in the
        // left one. A left-handed player got a mirrored HUD around an
        // unmirrored control.
        floatingStick: settings.stickLayout === 'floating',
        stickHand: settings.stickHand,
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

    this.markers.dispose();
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
    // Not an `IDisposable`, and its two bus subscriptions are the only thing it
    // holds. `bus.clear()` below would drop them anyway, but only because this
    // game happens to own the bus it was attached to.
    this.impulses.detach();
    this.cityStreamer.dispose();
    this.materials.dispose();
    this.sky?.dispose();
    this.shadows.dispose();
    this.debris.dispose();
    this.ragdolls.dispose();
    this.physics.dispose();
    this.spatial.dispose();
    this.roster.dispose();
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
      this.frameFailures = 0;
    } catch (error) {
      recordError(this.diagnostics, 'frame', error);
      // One bad frame must not take the loop down: the next one may be fine and
      // a dead rAF is a black screen with no way back. But a DETERMINISTIC
      // per-frame throw is sixty console lines a second, and the console is the
      // one place the first occurrence could still be read — so the loop keeps
      // running and the log thins out to roughly once a second.
      if (this.frameFailures % FRAME_FAILURE_LOG_INTERVAL === 0) {
        log.error(`frame failed (${this.frameFailures + 1} in a row)`, error);
      }
      this.frameFailures++;
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
    // ══════════════════════════════════════════════════════════════════════
    //  STAMP THE BUS BEFORE ANYTHING CAN EMIT
    // ══════════════════════════════════════════════════════════════════════
    // `IEventBase.frame`/`time` are filled in by the bus from these two
    // numbers, and nothing but the tests and the harness ever set them — so
    // every event the shipped game emitted carried `frame: 0, time: 0`. That
    // breaks the ordering any consumer reconstructs from an event log, and it
    // is silent: the fields are present and plausible. Set here, at the top of
    // the frame, so the first system to emit is already stamped.
    this.bus.setFrame(this.frameIndex, time);

    /* ---- INPUT --------------------------------------------------------- */
    let mark = performance.now();
    const input: InputState = this.input.poll(this.frameIndex, this.clock.unscaledElapsed);
    timings.input = performance.now() - mark;

    /* ---- SIMULATION ---------------------------------------------------- */
    mark = performance.now();
    if (dt > 0) {
      this.dayNight.update(dt);
      this.sky?.update(this.dayNight.blend);
      const lighting = this.dayNight.lighting;
      this.shadows.applyLightingState(lighting);
      // The VFX suite shades its own particles: without these it lit every
      // dust plume and every debris puff with the hard-coded noon key it was
      // constructed with, so smoke at dusk read as soot against an orange
      // skyline and no effect ever picked up the fog. The intensities go with
      // the colours — `setSun` multiplies them in, and `ILightingState` carries
      // a sun intensity around 3.
      this.vfx.setSun(
        lighting.sunDirection,
        lighting.sunColor,
        lighting.ambientColor,
        lighting.sunIntensity,
        lighting.ambientIntensity
      );
      this.vfx.setFog(lighting.fogColor, lighting.fogDensity);
      this.nightUniforms.update(
        this.dayNight.derived.nightFactor,
        this.dayNight.derived.windowLitFraction,
        this.clock.unscaledElapsed
      );
      this.renderer.setLightingState(lighting);

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
      // WITH the player's position. `QuestSystem` has no other source for it,
      // and without it every `reach` objective is evaluated at the world origin
      // forever — which is six of the authored quests, each of which opens with
      // one, none of them completable.
      this.progression.update(dt, this.player.controller.position);

      this.witnessTimer -= dt;
      if (this.witnessTimer <= 0) {
        this.witnessTimer = WITNESS_SYNC_INTERVAL;
        this.witnesses.sync(this.player.controller.position);
      }

      // ════════════════════════════════════════════════════════════════════
      //  A QUEST CLOCK ONLY MOVES IF SOMEBODY RE-PUSHES IT
      // ════════════════════════════════════════════════════════════════════
      // The rows the log and the tracker draw are SNAPSHOTS, so `timeRemaining`
      // is whatever it was at the last push — an evacuation accepted with 150
      // seconds on it reads 2:30 until the moment it fails. `QuestStateChanged`
      // fires at the two ends of that window and never inside it, so the clock
      // needs its own cadence.
      //
      // On SCALED time, deliberately: the clock this mirrors is decremented by
      // `quests.update(dt)` with exactly this delta, so a hit-stop that slows
      // the countdown slows the re-push with it. Gated on the flag the push
      // itself sets, so a session with no timed quest accepted pays one
      // comparison a frame and never allocates.
      if (this.questClocksRunning) {
        this.questClockTimer -= dt;
        if (this.questClockTimer <= 0) {
          this.questClockTimer = QUEST_CLOCK_INTERVAL;
          this.pushQuests();
        }
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
    this.applyCameraShake(dt);
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
    // The structure mirror, in the same section and immediately after the build
    // and eviction that changes it. `CityStreamer` publishes into
    // `DestructionSystem` — what BREAKS — and combat's own index, which is what
    // `chargeForecast()` sweeps for the charge ring's price tag, had no feed at
    // all. See `StructureBridge`.
    this.combatStructures.sync();
    timings.streaming = performance.now() - mark;

    /* ---- AUDIO --------------------------------------------------------- */
    this.camera.getWorldDirection(this.scratchForward);
    this.audio.setListener(this.camera.position, this.scratchForward, this.scratchUp);
    // The CONTINUOUS parameters, documented as per-frame and both without a
    // caller anywhere in `src/`: the wind bed ignored a 40 m/s dive off a tower
    // and the reverb stayed on `openStreet` in the middle of a park. Each glides
    // internally, so feeding them every frame is the intended use, not a zipper.
    //
    // `setCrowdDensity` is deliberately NOT driven from here even though the
    // crowd publishes `lastStats.density` and `farPopulation` for it. Wind
    // COMPOSES — the voice takes `max(ambientWind, speedWind)`, so the
    // time-of-day rule in `event-map.ts` and this per-frame feed coexist — but
    // density does not: a per-frame write would overwrite that rule's
    // phase-by-phase population (0.08 at midnight, 1.0 at noon) on the very
    // next frame and silently retire it. Reconciling the two is an audio design
    // call, not a wiring one.
    this.audio.setPlayerSpeed(this.player.controller.velocity.length());
    const district = this.cityStreamer.districtAt(
      this.player.controller.position.x,
      this.player.controller.position.z
    );
    if (district !== this.audioDistrict) {
      this.audioDistrict = district;
      this.audio.setEnvironment(reverbForDistrict(district));
    }
    // ══════════════════════════════════════════════════════════════════════
    //  AUDIO RUNS ON REAL TIME, ALWAYS
    // ══════════════════════════════════════════════════════════════════════
    // `dt` is zero while a modal sheet is open and while `ImpactFreeze` holds
    // the world at `timeScale` 0 — and `update()` is what flushes the debris
    // accumulator and advances the music director. Gating it on `dt > 0` stalled
    // both for the whole of a 90 ms hit-stop (the loudest moment in the game)
    // and for as long as the pause menu stayed open, then flushed the backlog
    // in one frame on resume. The AudioContext's own clock never paused for
    // either, so the only correct feed is the unscaled delta. Backgrounding is
    // handled properly, by `setSuspended` — see `registerWindowListeners`.
    this.audio.update(rawDt);

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
    // ══════════════════════════════════════════════════════════════════════
    //  NEVER AUTOSAVE IN MID-AIR
    // ══════════════════════════════════════════════════════════════════════
    // The save carries the raw capsule `y`, and `CharacterController.setPosition`
    // seeds `apexY` from the restored height — so a save taken at the top of a
    // 28 m leap reloads into a free fall that lands over `GROUND_SLAM_FALL_HEIGHT`
    // and opens the session with a crater, a shockwave and a `PlayerLanded` the
    // player did not cause. The timer is NOT reset here, so the save happens on
    // the first grounded frame after it comes due rather than a minute later.
    this.autosaveTimer += rawDt;
    if (this.autosaveTimer >= AUTOSAVE_INTERVAL && this.player.controller.isGrounded) {
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
      // Same cadence, same reason: it only changes when an asset loads, and
      // asking every frame allocates for nothing. See the method.
      this.sampleRegistryDiagnostics();
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
    /**
     * Every time the monster changed its mind about who it was fighting.
     *
     * The original failure was invisible in a final-frame reading: one target
     * id, held for sixty seconds, looks exactly like a monster that re-engaged
     * ten times and happened to end where it started. Read-only instrumentation
     * — it samples `brain.currentTargetId`, it does not steer anything.
     */
    targetTimeline: { at: number; id: string; harmable: boolean }[];
    /** Times the monster abandoned a target it could not hurt. */
    retargets: number;
  } {
    const genos = this.crowd.allies.find((a) => a.heroId === 'genos');
    const mumen = this.crowd.allies.find((a) => a.heroId === 'mumenRider');
    const before = { genos: genos?.health ?? 0, mumen: mumen?.health ?? 0 };

    let downedEvents = 0;
    let waves = 0;
    const sampledOrigins: { x: number; z: number; range: number; power: number; intent: string }[] =
      [];

    // A Harbinger: `crush` carries 120 000 units of pressure, which is `full`
    // intent, which is 1.7x lethality — one hit ends Mumen Rider and three end
    // Genos. The table refuses to spawn one downtown on its own, and that is
    // the correct table; this is a scripted proof, not a spawn rule.
    //
    // SPAWNED BEFORE THE SUBSCRIPTIONS. `monsterArchetype` throws on an unknown
    // id and `MonsterSystem.spawn` can refuse a spawn; taken first, either throw
    // would propagate past the `finally` below — which has not been entered yet
    // — and leave two permanent handlers on a bus only `dispose()` ever clears,
    // one of them calling `monsters.get()` on every shockwave for the rest of
    // the session. Neither event can fire during the spawn itself.
    const anchor = mumen?.transform.position ?? this.player.controller.position;
    const monster = this.monsters.spawn(
      monsterArchetype('mob.god.harbinger'),
      { x: anchor.x + 5, y: 0, z: anchor.z + 2 },
      Math.PI,
      { scripted: true }
    );

    const offDowned = this.bus.on('AllyDowned', () => {
      downedEvents++;
    });
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

    const distanceOf = (
      hero: { transform: { position: { x: number; z: number } } } | undefined
    ): number => {
      if (hero === undefined) return -1;
      const dx = hero.transform.position.x - monster.brain.position.x;
      const dz = hero.transform.position.z - monster.brain.position.z;
      return Math.round(Math.hypot(dx, dz) * 10) / 10;
    };

    const step = 1 / 30;
    let elapsed = 0;
    const targetTimeline: { at: number; id: string; harmable: boolean }[] = [];
    let lastSeenTarget: string | undefined;
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
        const current = String(monster.brain.currentTargetId ?? 'none');
        if (current !== lastSeenTarget) {
          lastSeenTarget = current;
          if (targetTimeline.length < 24) {
            targetTimeline.push({
              at: Math.round(elapsed * 100) / 100,
              id: current,
              harmable: monster.brain.isTargetHarmable,
            });
          }
        }
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
      targetTimeline,
      retargets: monster.brain.retargets,
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
      // The CAMERA's yaw as well, exactly as the two scripted `faceNearest*`
      // helpers do it. The rig seeds its yaw once, at construction, and nothing
      // re-syncs it — and that yaw is also the movement basis (`move` arrives in
      // camera space), so a body turned east behind a camera still facing the
      // spawn direction both looks wrong and walks the wrong way on the first
      // stick push, which immediately overwrites the restored value.
      this.player.camera.yaw = save.playerYaw;
      // The clock, the calendar and the moon are restored by the progression
      // coordinator (it holds `dayNight` as its `time` port and calls
      // `setDayCount` / `setLunarAgeDays` / `setTimeOfDay`). Re-applying the
      // time of day here is the belt to that braces: the coordinator's port is
      // optional, this one is not, and `setTimeOfDay` is idempotent.
      this.dayNight.setTimeOfDay(save.timeOfDay);
      // ══════════════════════════════════════════════════════════════════════
      //  TELL EVERYONE ELSE THE BOREDOM CAME BACK
      // ══════════════════════════════════════════════════════════════════════
      // `BoredomModel.restore()` deliberately does not publish — replaying a
      // restore as a delta would double-count the deeds behind it — but the
      // combat meter and the HUD only ever learn a value from `BoredomChanged`.
      // Without this the restored number lived in exactly one of the three
      // places that hold it: the HUD kept showing the boot baseline, and the
      // first kill of the session emitted from combat's stale meter, throwing
      // the save's value away with it.
      const boredom = this.progression.boredom.boredom;
      this.bus.emit('BoredomChanged', {
        value: boredom,
        previous: this.combat.boredomMeter.value,
        reason: 'restored',
      });
      // ══════════════════════════════════════════════════════════════════════
      //  AND THE QUESTS, FOR EXACTLY THE SAME REASON
      // ══════════════════════════════════════════════════════════════════════
      // `QuestSystem.restoreState()` assigns `quest.state` directly rather than
      // going through `setState`, so a restore publishes no `QuestStateChanged`
      // — correctly, since replaying ten of them would toast a save load as ten
      // fresh requests. But the subscription above is the only other thing that
      // pushes rows, so without this the log opens on the boot snapshot: the
      // restored active quest missing, its objectives at zero and its clock
      // back at the full limit.
      this.pushQuests();
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
      // `pushRank` as well, and for a different reason than the rivals: a seat
      // change moves the two thresholds the progress fraction is measured
      // between, so the bar has to be recomputed even when the point total the
      // event carries has already been applied by the store.
      bus.on('RankChanged', () => {
        this.pushRank();
        this.pushRivals();
      }),
      bus.on('EncounterEnded', () => this.pushRivals()),
      // Same gap, one storey louder: `QuestStateChangedEvent` carries an id and
      // two states and nothing a log can draw — no title, tier, objectives,
      // reward or clock — so the store's own header calls the rows out as a
      // bootstrap push. Nothing called `setQuests`, and the quest log read "No
      // requests on file" for the whole session with ten authored requests
      // sitting in the catalogue.
      bus.on('QuestStateChanged', () => this.pushQuests())
    );
    this.pushRank();
    this.pushRivals();
    this.pushQuests();
  }

  /**
   * Publish the player's whole standing, including the two numbers the bus
   * cannot carry.
   *
   * ── WHY THE CHIP'S PROGRESS BAR WAS ALWAYS EMPTY ───────────────────────────
   * `HudStore.setRank()` had no caller in `src/` at all — only its unit test and
   * the harness — so the only thing that ever wrote the rank block was the
   * store's own `RankChanged` handler, which sets `heroClass`, `rank` and
   * `points` and cannot set the rest. `rankProgress` therefore stayed at its
   * constructed 0 for the whole session and the 64 px sliver under CAPED BALDY
   * was a decorative grey line: the one place the game shows a C-class hero that
   * the next seat is close, permanently reading "no progress at all".
   *
   * It cannot be derived inside the HUD, and `IRankState.rankProgress`'s own
   * comment says why: the denominator is the ladder's step cost, which lives in
   * progression's constants and which the HUD may not import. It CAN be derived
   * here — the composition root is the one layer allowed to hold both sides —
   * so it is, from the two thresholds either side of the seat the points buy.
   *
   * `rankGainMultiplier` is deliberately NOT pushed: the store derives it from
   * `BoredomChanged`, which arrives far more often than this does, and pushing a
   * second opinion would race it. `setRank` copies only the keys present.
   */
  private pushRank(): void {
    const state = this.progression.progression.state;
    const rank = state.rank;
    // The seat the point total buys, and the cumulative cost of that seat and of
    // the one above it. At the top of the ladder `seatIndex` clamps, so the two
    // thresholds are equal and the bar reads full — which is the honest answer
    // for a hero with nowhere left to climb.
    const seat = indexForPoints(rank.points);
    const floor = pointsForIndex(seat);
    const span = pointsForIndex(seat + 1) - floor;
    this.rankPoints = rank.points;
    this.rankReputation = state.reputation;
    this.hud.store.setRank({
      heroName: rank.heroName,
      heroClass: rank.heroClass,
      rank: rank.rank,
      points: rank.points,
      pointsToNextRank: rank.pointsToNextRank,
      reputation: state.reputation,
      rankProgress: span > 0 ? clamp01((rank.points - floor) / span) : 1,
    });
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

  /**
   * Publish the quest log.
   *
   * EVERY runtime quest, including the locked ones. Two screens need them: the
   * log draws a locked row as "LOCKED · <description>", which is how a player
   * learns a request exists before it unlocks, and `conflictTitles` resolves a
   * `conflictsWith` id to a TITLE by looking it up in the pushed list — so
   * filtering the list down to what is currently offerable would turn the
   * supermarket warning, the one choice the screen exists to make the player
   * feel, back into a raw quest id.
   *
   * The rows are a snapshot; `questClocksRunning` is what tells `frame` whether
   * any clock on them is still moving. See `QUEST_CLOCK_INTERVAL`.
   */
  private pushQuests(): void {
    const quests = this.progression.quests;
    // ONE call to the getter: `runtimeQuests` copies the map into a new array
    // on every read, and this runs on a timer as well as on every state change.
    const runtime = quests.runtimeQuests;
    let running = false;
    for (const quest of runtime) {
      // `complete()` and `fail()` both clear `timeRemaining` before they
      // publish, so a resolved quest stops the cadence on its own.
      if (Number.isFinite(quest.timeRemaining)) {
        running = true;
        break;
      }
    }
    this.questClocksRunning = running;
    this.hud.store.setQuests(
      runtime.map((quest) => ({
        id: quest.id,
        title: quest.title,
        description: quest.description,
        state: quest.state,
        tier: quest.threatTier,
        objectives: quest.objectives.map((objective) => ({
          id: objective.id,
          description: objective.description,
          current: objective.current,
          required: objective.required,
          complete: objective.complete,
          hidden: objective.hidden,
        })),
        timeRemaining: quest.timeRemaining,
        timeLimitSeconds: quest.timeLimitSeconds,
        errand: quest.rules.errand === true,
        conflictsWith: quest.rules.conflictsWith,
        rewardPoints: quest.rewardPoints,
      })),
      quests.trackedQuestId
    );
  }

  private updateHud(rawDt: number): void {
    // ══════════════════════════════════════════════════════════════════════
    //  POINTS MOVE INSIDE A SEAT, AND `RankChanged` DOES NOT FIRE FOR THAT
    // ══════════════════════════════════════════════════════════════════════
    // `ProgressionSystem.publishRank` returns early unless the CLASS or the RANK
    // changed, which is correct for an event called `RankChanged` and useless
    // for a progress bar: every award between two seats is silent, so a bar fed
    // only from the bus would sit at whatever the last promotion left it at and
    // jump a whole seat at a time. Two number comparisons a frame, and a push
    // only when the standing actually moved — which is a few times a minute, the
    // cadence the HUD's render path is built for.
    const progression = this.progression.progression;
    if (
      progression.points !== this.rankPoints ||
      progression.state.reputation !== this.rankReputation
    ) {
      this.pushRank();
    }
    const combat = this.combat.diagnostics();
    this.hud.store.setCharge(
      combat.charge,
      combat.charging,
      combat.charge >= 0.85 ? 'serious' : combat.charge > 0.2 ? 'normal' : 'restrained',
      combat.chargeForecastYen
    );
    this.hud.store.setWitnesses(this.progression.witnesses.size);
    this.syncMarkers();
    this.hud.update(rawDt);
    // Unconditional, and after the store has settled: `MarkerLayer.update` is
    // the ONLY thing that reconciles the marker DOM against the model, so a
    // gated call would leave the pins of a cleared model parented in
    // `.hud-markers` for the rest of the run. It projects with the camera's
    // world matrix, which the frame updated before the HUD phase.
    this.markers.update(this.hud.store.model, this.camera);
  }

  /**
   * Reconcile the world markers against what is actually out there.
   *
   * ── WHAT THE PLAYER GOT WITHOUT THIS ───────────────────────────────────────
   * Nothing. No waypoint, no compass, no off-screen threat pip: a player who
   * accepted an evacuation two districts away was told the objective's
   * DESCRIPTION and left to find it. The quest data has carried a `location` and
   * a `radius` the whole time and nothing had ever drawn one.
   *
   * ── THE FRAME CONTRACT ─────────────────────────────────────────────────────
   * Positions are mutated IN PLACE on the marker objects the store already
   * holds, which is why this can run every frame: the model's map is only
   * touched when a marker appears or disappears, so `markDirty` — and the HUD's
   * arbitrary-DOM render pass behind it — fires when a monster arrives, not when
   * one walks. `MarkerLayer` reads the positions each frame either way.
   */
  private syncMarkers(): void {
    const seen = this.markerSeen;
    seen.clear();
    const focus = this.player.controller.position;
    const rangeSq = MARKER_RANGE * MARKER_RANGE;

    for (const monster of this.monsters.all()) {
      if (monster.isDead) continue;
      const position = monster.transform.position;
      const dx = position.x - focus.x;
      const dz = position.z - focus.z;
      if (dx * dx + dz * dz > rangeSq) continue;
      const id = `threat:${monster.id}`;
      seen.add(id);
      const marker = this.publishMarker(
        id,
        'threat',
        monster.displayName,
        monster.archetype.threatTier
      );
      marker.x = position.x;
      // Above the head, not at the feet: a pin at ground level is behind
      // whatever the monster is standing in front of.
      marker.y = position.y + monster.archetype.bodyHeightMetres + 0.6;
      marker.z = position.z;
    }

    // THE TRACKED request only. Every active quest's objectives at once is a
    // screen of rings, and the tracker chip already names the one the player
    // said they were doing.
    const tracked = this.progression.quests.trackedQuestId;
    const quest = tracked === undefined ? undefined : this.progression.quests.quests.get(tracked);
    if (quest?.state === 'active') {
      for (const objective of quest.objectives) {
        const at = objective.location;
        if (at === undefined || objective.complete || objective.hidden === true) continue;
        const id = `objective:${quest.id}:${objective.id}`;
        seen.add(id);
        const marker = this.publishMarker(id, 'objective', markerLabel(objective.description));
        marker.x = at.x;
        marker.y = at.y + 2.2;
        marker.z = at.z;
      }
    }

    for (const id of this.markerIds) {
      if (seen.has(id)) continue;
      this.markerIds.delete(id);
      this.hud.store.removeMarker(id);
    }
  }

  /** Get or publish one marker. The object is the store's; this holds no copy. */
  private publishMarker(
    id: string,
    kind: MarkerKind,
    label: string,
    tier?: ThreatTier
  ): IWorldMarker {
    const existing = this.hud.store.model.markers.get(id);
    if (existing !== undefined) return existing;
    const marker: IWorldMarker = { id, kind, label, x: 0, y: 0, z: 0, tier };
    this.markerIds.add(id);
    this.hud.store.setMarker(marker);
    return marker;
  }

  /**
   * Advance every animator the entity systems do not advance themselves.
   *
   * The player's gait is driven from the SOLVED transform — speed and root
   * position after the physics step — which is why this runs in the camera
   * phase and not in simulation. Feeding it the commanded velocity instead
   * makes the feet slide every time a wall stops the character.
   *
   * ── NO `dt <= 0` GUARD, AND THAT IS THE POINT ──────────────────────────────
   * This used to return immediately on a zero delta, which made "the world is
   * paused" and "nothing writes this character's bones" the same condition. The
   * failure mode is not subtle and this file already describes it (see
   * `playerAnimator`): a skeleton nobody writes holds its BIND POSE — arms
   * straight out, elbows locked, cape a rigid cone — and no amount of staring at
   * the clip table explains it, because the clips are fine and were never
   * applied. One stuck flag anywhere upstream and the protagonist is a
   * mannequin for the rest of the session.
   *
   * So the pose is applied on EVERY frame and the clock only decides how far
   * the clips advance. `ProceduralAnimator.update(0)` does no integration —
   * `step` is zero, phases do not move, no footfall is emitted — and still ends
   * with `applyPose`, so a paused frame re-asserts the pose it already had and a
   * character can never be left in the bind pose by a delta.
   *
   * The delta stays SCALED, deliberately, unlike audio's. `ImpactFreeze` drops
   * `timeScale` to 0.04 for 90 ms and the whole beat is that the CHARACTER stops
   * with the world; feeding this the unscaled delta would keep the punch
   * swinging at full speed through the freeze frame the freeze exists to make.
   */
  private tickAnimators(dt: number): void {
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

    // ══════════════════════════════════════════════════════════════════════
    //  THE FACE
    // ══════════════════════════════════════════════════════════════════════
    // Two uniform writes, no material swap and no extra draw call — which is
    // the entire reason the roster bakes four expression tiles into one strip
    // instead of four materials.
    //
    // The expression is the same boredom value the posture uses, so the meter
    // reads on his face and in his shoulders at once. The dither is the camera
    // arm collapsing in an alley; it is on the player's material ALONE because
    // the `discard` it compiles to disables early-Z.
    const skin = this.playerSkin;
    if (skin !== undefined) {
      setExpression(skin, expressionForBoredom(this.progression.boredom.boredom));
      setProximityFade(skin, this.player.camera.diagnostics().armCollapseRatio);
    }

    for (const monster of this.monsters.all()) {
      monster.character?.animator.update(dt);
    }
  }

  /**
   * Add the shake on top of the transform the camera rig just authored.
   *
   * ADDITIVE, and therefore only correct on a frame the rig actually ran.
   * `CameraRig.update` returns immediately at `dt <= 0` and so does the shake's
   * own decay, so on a modal-paused frame — `dt` is forced to 0 while a screen
   * is open — nothing re-bases the camera and nothing shrinks the offset: the
   * same half-metre vector would be added sixty times a second, translating the
   * camera at ~30 m/s and rolling it at ~3 rad/s for as long as the pause menu
   * is up (and dragging the audio listener along with it). The rig's own guard
   * is the right one to mirror.
   */
  private applyCameraShake(dt: number): void {
    if (dt <= 0) return;
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
    // The distant skyline. Constant after boot except `impostorDrift`, which
    // only moves when a chunk becomes resident and disagrees with its
    // silhouette — see `bakeSkyline` in `city-streamer.ts`.
    const impostor = this.cityStreamer.impostorStats;
    w.impostorBuildings = impostor.buildings;
    w.impostorTriangles = impostor.triangles;
    w.impostorBakeMs = impostor.generationTimeMs;
    w.impostorUploadMs = impostor.uploadTimeMs;
    w.impostorDrift = this.cityStreamer.impostorDrift;
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
    // The one number the character pipeline adds to the boot path, reported on
    // its own: a boot total measured on a contended machine cannot be
    // differenced against a baseline measured on a quiet one, but this can.
    w.rosterLoadMs = this.roster.loadMs;
    w.rosterResident = this.roster.residentIds.length;
    w.rosterBytes = this.roster.residentBytes;
    w.resolutionScale = this.renderer.governor.scale;
    w.timeScale = this.clock.timeScale;
  }

  /**
   * Sample the asset registry's report.
   *
   * NOT per frame. `AssetRegistry.diagnostics()` is not a getter over cached
   * state: it builds a fresh sixteen-field object, reduces over every resident
   * environment, and spreads one NEW object per recorded tier miss — and the
   * asset layer demotes per asset, so that list is not short on a desktop
   * `high` run. Three numbers that only move when an asset loads were costing
   * `3 + M` allocations every frame, on the main thread, in the loop whose
   * budget this whole file is organised around.
   *
   * Seeded during boot, so the values are right from the first frame; only the
   * refresh rate changes. `impostorStats` above is deliberately left alone —
   * `ImpostorRing.getStats()` returns a stored object and allocates nothing.
   */
  private sampleRegistryDiagnostics(): void {
    const registry = this.registry.diagnostics();
    const w = this.diagnostics.world;
    w.assetsMissing = registry.missing.length;
    w.assetTierMisses = registry.tierMisses.length;
    w.assetTiersUnavailable = [...registry.unavailableTiers];
  }

  /**
   * Viewport changed: aspect, buffers, cascades, screen-space effects — and the
   * two layers that lay themselves out against the notch.
   *
   * Also the ONE place the safe area is applied, which is why `start()` calls
   * this before the first frame rather than seeding the insets separately.
   */
  private readonly onResize = (): void => {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // `IRenderer.setSize` takes CSS pixels and forwards its own DRAWING-BUFFER
    // size to the post chain. Calling `postProcessing.setSize(width, height)`
    // here as well re-sized the composer to the CSS figure — a third of the
    // scene's resolution on a DPR-3 phone — right after the renderer had set
    // it correctly.
    this.renderer.setSize(width, height);
    // ══════════════════════════════════════════════════════════════════════
    //  THE CASCADES ARE FITTED TO A FRUSTUM THAT JUST CHANGED
    // ══════════════════════════════════════════════════════════════════════
    // `ShadowSystem.update()` (per frame) only REPOSITIONS the cascade lights;
    // the splits come from the camera's near/far and aspect and are recomputed
    // only here. Without this call the shadow cascades stayed fitted to the
    // boot aspect for the rest of the session, so rotating a phone from
    // portrait to landscape left the near cascade covering a slice of the wider
    // view and the rest of the screen taking the coarsest one.
    this.shadows.onCameraChanged();
    // Speed lines are drawn in normalised screen space and scaled by the
    // viewport aspect, which they otherwise keep from construction: after a
    // rotation every streak was stretched along the wrong axis.
    this.vfx.setViewport(width, height);
    // `CSS2DRenderer` never reads layout — the viewport it projects into comes
    // from here and nowhere else, so without this every pin stays projected
    // into the 1x1 box the layer is constructed with (see `MarkerLayer`).
    this.markers.setSize(width, height);
    // ══════════════════════════════════════════════════════════════════════
    //  THE NOTCH MOVES WHEN THE PHONE TURNS; THE INSETS DID NOT
    // ══════════════════════════════════════════════════════════════════════
    // `IInputManager.setSafeArea` and `HudManager.refreshSafeArea` both existed
    // with ZERO callers in `src/`. Both layers were therefore holding the
    // override they were constructed with — nothing — for the whole session,
    // and a player who turned the phone got a HUD and a control overlay laid out
    // against the boot orientation's cutout. It matters more now than it did:
    // the fixed stick anchors off the safe-area CORNER, so a stale inset does
    // not merely crowd a label, it puts the stick somewhere the thumb is not.
    //
    // Called on every resize AND on `orientationchange`, both of which land
    // here, and once from `start()` before the first frame.
    const insets = readSafeAreaInsets(document);
    this.input.setSafeArea(insets);
    this.hud.refreshSafeArea(insets);
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
  markers: MarkerLayer;
  freeze: ImpactFreeze;
  roster: RosterRuntime;
  /** Saitama's baked material, when his atlas landed during boot. */
  playerSkin: THREE.Material | undefined;
  /** Bodies built before their atlas landed, to be re-skinned in the background. */
  deferredSkins: IDeferredSkin[];
}

/** A body whose baked material has to be swapped on once its atlas loads. */
interface IDeferredSkin {
  readonly id: string;
  readonly root: THREE.Object3D;
  readonly faceRect: FaceRect;
  readonly options: { readonly proximityFade?: boolean };
}

/** Millisecond stopwatch that writes straight into the boot report. */
class PhaseTimer {
  private last = performance.now();
  mark(into: IBootTimings, key: keyof IBootTimings): void {
    const now = performance.now();
    into[key] = Math.round(now - this.last);
    this.last = now;
  }

  /**
   * Charge this span to a phase that was already marked.
   *
   * The asset phase is the one that is not contiguous: the manifest and the
   * registry open happen before physics and the world, and the tail of
   * `preloadCore` after them. Both are assets, so both are added to the same
   * number rather than one of them overwriting the other.
   */
  add(into: IBootTimings, key: keyof IBootTimings): void {
    const now = performance.now();
    into[key] += Math.round(now - this.last);
    this.last = now;
  }
}

/**
 * The acoustic environment a district sounds like.
 *
 * Deliberately COARSE. A district is the only spatial classification the world
 * publishes per position, and `arcade` / `alley` / `indoor` / `crater` describe
 * enclosures a district cannot tell you about — a park has alleys in it and
 * downtown has open plazas. Mapping the districts that are open BY DEFINITION
 * onto `openField` and everything else onto the city default is the whole of
 * what this signal can honestly support; anything finer needs geometry, not a
 * district id, and inventing it here would be worse than the flat `openStreet`
 * this replaces.
 */
function reverbForDistrict(district: DistrictType): ReverbPreset {
  switch (district) {
    case 'park':
    case 'waterfront':
    case 'wasteland':
      return 'openField';
    default:
      return 'openStreet';
  }
}

/**
 * Trim an objective's sentence down to something that fits over a pin.
 *
 * Objective descriptions are authored for the quest log, where they have a full
 * row — "Buy: ground beef, cabbage, eggs, a punnet of strawberries" is 55
 * characters. A marker label is `white-space: nowrap` inside an `overflow:
 * hidden` host, so an untrimmed one is a bar of text across the sky.
 */
function markerLabel(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MARKER_LABEL_CHARS
    ? trimmed
    : `${trimmed.slice(0, MARKER_LABEL_CHARS - 1)}…`;
}

/**
 * The device's safe-area insets, in CSS pixels.
 *
 * ── WHY THIS READS CSS RATHER THAN A PLATFORM ADAPTER ──────────────────────
 * `IPlatformAdapter.safeArea` is the documented source (see the precedence list
 * in `src/ui/hud/safe-area.ts`) and this repository contains no implementation
 * of that interface — only the contract. So the browser's own `env()` is the
 * only source that exists, and it is read the one way that is reliable across
 * WebViews: a probe element whose PADDING is the four `env()` values, resolved
 * by `getComputedStyle`. Reading a custom property back instead returns
 * whatever the author wrote, `env()` call and all, on more than one engine.
 *
 * When a native adapter does arrive it replaces the body of this function and
 * nothing else: both consumers already come through here.
 *
 * Not free — it appends a node and forces a style resolve — and therefore
 * called only from `onResize`, which is a rotation-rate path, never a frame one.
 * Zeros are a perfectly good answer: the HUD and the touch overlay both compose
 * `max(env(), override, floor)`, so an override of 0 changes nothing.
 */
function readSafeAreaInsets(doc: Document): SafeAreaInsets {
  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
    'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
  doc.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (value: string): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
  };
  const insets: SafeAreaInsets = {
    top: px(style.paddingTop),
    right: px(style.paddingRight),
    bottom: px(style.paddingBottom),
    left: px(style.paddingLeft),
  };
  probe.remove();
  return insets;
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

/**
 * The stand-in a body wears until its baked atlas lands.
 *
 * The mesh generator paints costume colours into vertex colours, so this is a
 * recognisable character rather than a grey blank — but it is flat: no weave, no
 * pores, no per-texel roughness, and NO FACE, because a face is texture. It is
 * what the whole cast looked like before the bake was wired in, and it exists
 * now only to cover the second between spawn and atlas.
 */
const STAND_IN_NAME = 'character.stand-in';

function standInMaterial(roughness: number, metalness: number, color?: number): THREE.Material {
  const parameters: THREE.MeshStandardMaterialParameters = {
    name: STAND_IN_NAME,
    vertexColors: true,
    roughness,
    metalness,
  };
  if (color !== undefined) parameters.color = new THREE.Color(color);
  return new THREE.MeshStandardMaterial(parameters);
}

/**
 * Dress ONE near-tier civilian from the shared crowd sheet.
 *
 * Two hundred people cannot each have an atlas, so `chr.civilian` is baked
 * NEUTRAL — greys carrying weave, wear and occlusion — and a single-channel
 * tint mask says which texel is skin, cloth, accent or hair. The crowd
 * injection then multiplies in four colours read from vertex attributes.
 *
 * On an `InstancedMesh` those attributes are instanced. A near-tier civilian is
 * a plain `SkinnedMesh`, where an ABSENT attribute reads as (0,0,0) and
 * multiplies the whole person to solid black — which is why the roster ships
 * `attachSoloCrowdColors` and why calling it is not optional.
 */
function skinCivilian(
  roster: RosterRuntime,
  build: HumanoidBuild,
  seed: number
): THREE.Material | undefined {
  if (!roster.isResident('chr.civilian')) return undefined;
  const faceRect = roster.prepareForeign('chr.civilian', build);
  attachSoloCrowdColors(build.geometry, crowdColors(seed));
  return roster.createMaterial('chr.civilian', faceRect, { crowdTint: true });
}

/**
 * Saitama: the bored slouch is a clip variant, not a separate rig.
 *
 * Built through the roster so the UVs match the baked atlas, and skinned with
 * the real material when it is resident. The face is the entire point — the
 * character is a deadpan and two dots — so his atlas is the ONE the boot path
 * waits for.
 */
function buildSaitama(roster: RosterRuntime): {
  parts: ReturnType<typeof createCharacterParts>;
  animator: ProceduralAnimator;
  body: IRosterBody;
} {
  const body = roster.buildBody('chr.saitama', 0, {
    // Only the player carries the screen-door dither: it costs a `discard`,
    // which disables early-Z, and it solves a problem (the camera arm
    // collapsing into the body in an alley) that nobody else has.
    proximityFade: true,
  });
  const parts = createCharacterParts(body.build, body.material ?? standInMaterial(0.68, 0.04));
  parts.root.name = 'saitama';
  parts.root.castShadow = true;
  const animator = new ProceduralAnimator(parts, parts.root, {
    variants: { idle: 'bored' },
    initial: 'idle',
  });
  return { parts, animator, body };
}

/** A body for one of the allies. Same generator, different recipe. */
function buildHeroBody(
  roster: RosterRuntime,
  id: 'genos' | 'mumenRider'
): {
  parts: ReturnType<typeof createCharacterParts>;
  animator: ProceduralAnimator;
  body: IRosterBody;
} {
  const body = roster.buildBody(`chr.${id}`, 1);
  const parts = createCharacterParts(body.build, body.material ?? standInMaterial(0.6, 0.15));
  parts.root.name = `hero-${id}`;
  const animator = new ProceduralAnimator(parts, parts.root, { seed: id === 'genos' ? 3 : 7 });
  return { parts, animator, body };
}

/**
 * A body for a monster.
 *
 * Its OWN roster recipe, not a recoloured Genos: a Mosquito Girl and a Deep Sea
 * King are different silhouettes, and the archetype already names which one it
 * is (`assetKey`). The atlas is loaded in the background per archetype, so the
 * first of a kind wears the generator's vertex colours for a moment and every
 * one after it is textured on arrival — no bake ever happens in a frame, which
 * is the constraint that made the earlier build skip this path entirely.
 */
function buildMonsterBody(
  roster: RosterRuntime,
  assetKey: string,
  heightMetres: number,
  id: string
): { instance: ICharacterInstance; body: IRosterBody } {
  const body = roster.buildBody(assetKey, 1);
  const parts = createCharacterParts(
    body.build,
    body.material ?? standInMaterial(0.82, 0.05, 0x7d5240)
  );
  parts.root.name = `monster:${id}`;
  // The generator's build is 1.75 m; scale to whatever the archetype says it
  // is, so a 3.4 m Deep Sea King towers and a street pest does not.
  parts.root.scale.setScalar(Math.max(0.6, heightMetres / body.entry.recipe.profile.height));
  const animator = new ProceduralAnimator(parts, parts.root, { seed: 11, initial: 'idle' });
  return { instance: { ...parts, animator }, body };
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
