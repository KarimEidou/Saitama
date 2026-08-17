/**
 * THE VFX SYSTEM — `IVFXSystem` from the contract.
 *
 * Owns three shader programs, four draw calls and every particle, shell and
 * decal in the game. Subscribes to the event bus and NEVER imports combat,
 * destruction or physics: those systems emit, this one reacts, which is the
 * architectural rule that lets all of them be written at the same time.
 *
 * ── AN EFFECT IS A COMPOSITE, NOT A PARTICLE SYSTEM ────────────────────────
 * `IQualitySettings.maxParticleSystems` is 4 on the LOW tier. If a serious
 * punch spent one of those on the shell, one on the dust, one on the flash and
 * one on the cracks, the next event in the same second would be dropped. So a
 * punch is ONE effect that emits all of those, and the budget counts dramatic
 * beats rather than emitters. That is also why bursts of `ChunkDetached` — a
 * collapse produces dozens in a frame — are coalesced into a single effect per
 * frame instead of competing for slots.
 *
 * ── EVERY EFFECT RUNS ON SCALED TIME ───────────────────────────────────────
 * The renderer freezes the clock to 4% for 90 ms on a lethal hit. Feeding this
 * system the scaled delta makes the entire frame hold — dust, shell, sparks,
 * speedlines and shake all stop together — which is the beat the freeze exists
 * to create. The one thing that must NOT hold is nothing: there is no
 * real-time channel here on purpose.
 */

import * as THREE from 'three';
import type {
  GameEventOf,
  ICameraShake,
  IDecalOptions,
  IEventBus,
  IQualitySettings,
  IQualityTier,
  IVFXHandle,
  IVFXSpawnOptions,
  IVFXSystem,
  LethalIntent,
  VFXEffectName,
} from '@/types';
import { clamp01, createLogger, createRng, type IRandom } from '@/util';
import { createCrackAtlas, createParticleAtlas } from './atlas';
import { CameraShake } from './camera-shake';
import {
  CrackTile,
  INTENT_POWER,
  SHOCK_COLOR,
  effectCapacityFor,
  vfxProfileFor,
  type IVFXTierProfile,
} from './constants';
import { DecalLayer, createDecalParams } from './decal-layer';
import { EffectEmitters } from './effects';
import { createArcGridGeometry, createQuadGeometry } from './geometry';
import {
  createDecalMaterial,
  createShockwaveMaterial,
  createSharedUniforms,
  createSpriteMaterial,
  type IVFXSharedUniforms,
} from './materials';
import { ShockwaveLayer, createShockwaveParams } from './shockwave-layer';
import { SpriteLayer } from './sprite-layer';
import { Speedlines } from './speedlines';

const log = createLogger('vfx');

export interface IVFXSystemOptions {
  /** Render tier. Sizes every pool and picks the shader complexity. */
  readonly tier?: IQualityTier;
  /** The public quality contract. Supplies the concurrent-effect ceiling. */
  readonly quality?: IQualitySettings;
  /** Event bus to subscribe to. Omit to drive the system by hand. */
  readonly bus?: IEventBus;
  /** Deterministic seed. Never `Math.random()`. */
  readonly seed?: number | string;
  /** Camera used for billboarding, depth sorting and the speedline focus. */
  readonly camera?: THREE.Camera;
  /** Altitude above the impact at which cloud parting happens, in metres. */
  readonly cloudAltitude?: number;
  /** Skip texture generation. Tests that never render use this. */
  readonly generateTextures?: boolean;
}

/** One live composite effect. Preallocated; never created at runtime. */
interface EffectSlot {
  active: boolean;
  generation: number;
  name: VFXEffectName;
  priority: number;
  age: number;
  lifetime: number;
  /** Continuous emission stops at this age. */
  emitUntil: number;
  /** Particles per second while emitting. */
  rate: number;
  /** Fractional emission carried between frames. */
  carry: number;
  power: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
  radius: number;
  /** Shell slot driving the dust front, and its generation stamp. */
  shell: number;
  shellGeneration: number;
  /** Lofted fronts throw dust much higher — used by omnidirectional blasts. */
  lofted: boolean;
  /** Nominal metres per second of the leading edge. Drives the dust front. */
  frontSpeed: number;
  attach: THREE.Object3D | undefined;
}

/** One tracked motion trail. */
interface TrailSlot {
  active: boolean;
  generation: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  size: number;
  power: number;
  carry: number;
  /** When set, position is read from the object and velocity is differenced. */
  attach: THREE.Object3D | undefined;
  hasLast: boolean;
}

/**
 * A handle is a fresh object per spawn, and that is deliberate.
 *
 * Recycling one handle object per slot looks tempting — it is the same
 * allocation-avoidance discipline used everywhere else here — but it is
 * unsound: the caller's reference IS the recycled object, so when the slot is
 * reused the caller's stale handle silently starts describing somebody else's
 * effect. A generation stamp cannot fix that, because the stamp lives on the
 * very object being aliased.
 *
 * The cost is one small object per SPAWN, not per frame, and every internal
 * event reaction takes `spawnSlot` instead, which allocates nothing. A
 * collapse dropping forty chunks in a frame produces zero handles.
 */
class VFXHandle implements IVFXHandle {
  readonly id: number;
  readonly effect: VFXEffectName;

  constructor(
    private readonly system: VFXSystem,
    private readonly slot: number,
    private readonly generation: number,
    private readonly kind: 'effect' | 'trail',
    id: number,
    effect: VFXEffectName
  ) {
    this.id = id;
    this.effect = effect;
  }

  get alive(): boolean {
    return this.kind === 'effect'
      ? this.system.isEffectAlive(this.slot, this.generation)
      : this.system.isTrailAlive(this.slot, this.generation);
  }

  stop(): void {
    if (this.kind === 'effect') this.system.stopEffect(this.slot, this.generation);
    else this.system.stopTrail(this.slot, this.generation);
  }

  kill(): void {
    if (this.kind === 'effect') this.system.killEffect(this.slot, this.generation);
    else this.system.stopTrail(this.slot, this.generation);
  }

  setPosition(position: THREE.Vector3): void {
    if (this.kind === 'effect') this.system.moveEffect(this.slot, this.generation, position);
  }
}

/** Diagnostics for the debug HUD and the verification harness. */
export interface IVFXDiagnostics {
  readonly tier: IQualityTier;
  readonly effects: number;
  readonly effectCapacity: number;
  readonly sprites: number;
  readonly spriteCapacity: number;
  readonly spritesDropped: number;
  readonly shockwaves: number;
  readonly shockwaveCapacity: number;
  readonly decals: number;
  readonly decalCapacity: number;
  readonly trails: number;
  readonly trailCapacity: number;
  readonly speedlineIntensity: number;
  readonly trauma: number;
  readonly drawCallsSubmitted: number;
  readonly programCount: number;
}

export class VFXSystem implements IVFXSystem {
  /** Add this to the scene. Holds every VFX draw. */
  readonly root = new THREE.Group();
  readonly shake: ICameraShake & { listenerPosition: THREE.Vector3; roll: number };
  readonly profile: IVFXTierProfile;
  readonly speedlines: Speedlines;

  private readonly sprites: SpriteLayer;
  private readonly decals: DecalLayer;
  private readonly shockwaves: ShockwaveLayer;
  private readonly emitters: EffectEmitters;
  private readonly shared: IVFXSharedUniforms;
  private readonly particleAtlas: THREE.DataTexture | undefined;
  private readonly crackAtlas: THREE.DataTexture | undefined;
  private readonly materials: THREE.ShaderMaterial[] = [];

  private readonly slots: EffectSlot[] = [];
  private readonly trails: TrailSlot[] = [];

  private readonly rng: IRandom;
  private readonly unsubscribes: (() => void)[] = [];
  private readonly quality: IQualitySettings | undefined;

  private camera: THREE.Camera | undefined;
  private readonly cameraPosition = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3(0, 0, -1);
  private readonly sunDirection = new THREE.Vector3(-0.62, -0.52, -0.59).normalize();
  private readonly scratchVector = new THREE.Vector3();
  private readonly scratchVectorB = new THREE.Vector3();
  private readonly decalScratch = createDecalParams();

  private readonly cloudAltitude: number;
  private nextId = 1;
  private disposed = false;

  /* Per-frame coalescing of event bursts. */
  private chunkCount = 0;
  private chunkX = 0;
  private chunkY = 0;
  private chunkZ = 0;
  private chunkSpread = 0;
  private chunkPower = 0;
  private impulseCount = 0;
  private impulseX = 0;
  private impulseY = 0;
  private impulseZ = 0;
  private impulsePower = 0;

  constructor(options: IVFXSystemOptions = {}) {
    const tier = options.tier ?? options.quality?.tier ?? 'medium';
    this.profile = vfxProfileFor(tier);
    this.quality = options.quality;
    this.rng = createRng(options.seed ?? 'vfx');
    this.cloudAltitude = options.cloudAltitude ?? 175;
    this.camera = options.camera;

    this.root.name = 'vfx.root';
    this.root.matrixAutoUpdate = false;

    const generate = options.generateTextures ?? true;
    this.particleAtlas = generate ? createParticleAtlas(this.profile.atlasSize) : undefined;
    this.crackAtlas = generate ? createCrackAtlas(this.profile.crackAtlasSize) : undefined;

    this.shared = createSharedUniforms();
    const spriteMaterial = createSpriteMaterial(
      this.particleAtlas ?? new THREE.Texture(),
      this.shared,
      this.profile
    );
    const decalMaterial = createDecalMaterial(
      this.crackAtlas ?? new THREE.Texture(),
      this.shared,
      this.profile
    );
    const shockwaveMaterial = createShockwaveMaterial(this.shared, this.profile);
    this.materials.push(spriteMaterial, decalMaterial, shockwaveMaterial);

    this.sprites = new SpriteLayer(createQuadGeometry(), spriteMaterial, this.profile);
    this.decals = new DecalLayer(createQuadGeometry(), decalMaterial, this.profile);
    this.shockwaves = new ShockwaveLayer(
      createArcGridGeometry(this.profile.shockwaveArcSegments, this.profile.shockwaveRadialSegments),
      shockwaveMaterial,
      this.profile
    );
    this.speedlines = new Speedlines(this.profile);
    this.shake = new CameraShake({ seed: 0x5a17a });
    this.emitters = new EffectEmitters(this.sprites, this.decals, this.shockwaves, this.profile);

    this.root.add(this.decals.mesh, this.shockwaves.mesh, this.sprites.mesh, this.speedlines.mesh);

    const effectCapacity = this.quality ? effectCapacityFor(this.quality) : tierEffectCapacity(tier);
    for (let i = 0; i < effectCapacity; i++) this.slots.push(emptySlot());
    for (let i = 0; i < this.profile.trailCapacity; i++) this.trails.push(emptyTrail());

    if (options.bus) this.subscribe(options.bus);

    log.info(
      `vfx ${tier}: ${effectCapacity} effects, ${this.profile.spriteCapacity} sprites, ` +
        `${this.profile.shockwaveCapacity} shells, ${this.profile.decalCapacity} decals, ` +
        `3 programs, 4 draw calls`
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Wiring                                                                 */
  /* ---------------------------------------------------------------------- */

  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }

  /**
   * Match the scene's key light.
   *
   * The INTENSITIES matter as much as the colours. `ILightingState` carries a
   * sun intensity of around 3 and a separate ambient intensity, and a lit
   * surface in the scene is multiplied by both. Dust shaded with the raw
   * unit-scale colours lands two stops under everything around it and reads as
   * soot — which is exactly what it looked like before this took the
   * multipliers.
   */
  setSun(
    direction: THREE.Vector3,
    color?: THREE.ColorRepresentation,
    ambient?: THREE.ColorRepresentation,
    sunIntensity = 1,
    ambientIntensity = 1
  ): void {
    this.sunDirection.copy(direction).normalize();
    if (color !== undefined) this.shared.uSunColor.value.set(color).multiplyScalar(sunIntensity);
    if (ambient !== undefined) {
      this.shared.uAmbientColor.value.set(ambient).multiplyScalar(ambientIntensity);
    }
  }

  /** Match the scene's exponential-squared fog. */
  setFog(color: THREE.ColorRepresentation, density: number): void {
    this.shared.uFogColor.value.set(color);
    this.shared.uFogDensity.value = density;
  }

  /** Master fade for the whole suite, 0..1. */
  setIntensity(value: number): void {
    this.shared.uIntensity.value = clamp01(value);
  }

  setViewport(width: number, height: number): void {
    this.speedlines.setViewport(width, height);
  }

  /** Meshes this system submits. The harness counts draw calls against these. */
  get meshes(): readonly THREE.Mesh[] {
    return [this.decals.mesh, this.shockwaves.mesh, this.sprites.mesh, this.speedlines.mesh];
  }

  /* ---------------------------------------------------------------------- */
  /* IVFXSystem                                                             */
  /* ---------------------------------------------------------------------- */

  get activeCount(): number {
    let n = 0;
    for (const slot of this.slots) if (slot.active) n++;
    return n;
  }

  get capacity(): number {
    return this.slots.length;
  }

  /**
   * Spawn a composite effect.
   *
   * Under budget pressure the LOWEST-PRIORITY live effect is killed to make
   * room, and only when the newcomer outranks it. A serious-punch shockwave
   * arrives at priority 1 and always wins; ambient debris dust arrives at 0.2
   * and correctly loses.
   */
  spawn(effect: VFXEffectName, options: IVFXSpawnOptions): IVFXHandle | undefined {
    const index = this.spawnSlot(effect, options);
    if (index < 0) return undefined;
    return new VFXHandle(
      this,
      index,
      this.slots[index]!.generation,
      'effect',
      this.nextId++,
      effect
    );
  }

  /**
   * The allocation-free spawn path. Returns the slot index, or -1.
   *
   * Every internal event reaction uses this: a building collapse must not mint
   * forty handle objects nobody asked for.
   */
  private spawnSlot(effect: VFXEffectName, options: IVFXSpawnOptions): number {
    if (this.disposed) return -1;
    const priority = options.priority ?? defaultPriority(effect);
    const index = this.acquireSlot(priority);
    if (index < 0) return -1;

    const slot = this.slots[index]!;
    const intensity = options.intensity ?? 1;
    const intentPower = options.intent ? (INTENT_POWER[options.intent] ?? 0.4) : 0.5;
    const power = clamp01(intensity * 0.55 + intentPower * 0.7);
    const scale = options.scale ?? 1;

    slot.active = true;
    slot.generation = (slot.generation + 1) & 0x3fffff;
    slot.name = effect;
    slot.priority = priority;
    slot.age = 0;
    slot.carry = 0;
    slot.rate = 0;
    slot.emitUntil = 0;
    slot.power = power;
    slot.radius = scale;
    slot.shell = -1;
    slot.shellGeneration = -1;
    slot.lofted = false;
    slot.frontSpeed = 0;
    slot.attach = options.attachTo;
    slot.x = options.position.x;
    slot.y = options.position.y;
    slot.z = options.position.z;
    if (options.direction) {
      slot.dx = options.direction.x;
      slot.dy = options.direction.y;
      slot.dz = options.direction.z;
    } else {
      slot.dx = 0;
      slot.dy = 1;
      slot.dz = 0;
    }
    slot.lifetime = options.lifetime ?? 1;

    this.build(slot, options, power, scale);
    return index;
  }

  /**
   * Project a persistent decal.
   *
   * `materialKey` selects the fracture pattern rather than a material: there
   * is exactly one decal material in this system and adding a second would
   * cost a draw call for no visual gain.
   */
  addDecal(options: IDecalOptions): boolean {
    const params = this.decalScratch;
    params.x = options.position.x;
    params.y = options.position.y;
    params.z = options.position.z;
    params.nx = options.normal.x;
    params.ny = options.normal.y;
    params.nz = options.normal.z;
    params.size = options.size;
    params.rotation = options.rotation ?? this.rng.range(0, Math.PI * 2);
    params.tile = crackTileFor(options.materialKey);
    params.aspect = params.tile === CrackTile.BranchA || params.tile === CrackTile.BranchB ? 2.6 : 1;
    params.lifetime = options.lifetime ?? 0;
    params.r = 0.055;
    params.g = 0.052;
    params.b = 0.05;
    params.alpha = 1;
    return this.decals.emit(params);
  }

  /**
   * Attach a motion trail to a live object — a fist mid-punch, a flying chunk.
   *
   * Velocity is DIFFERENCED from the object's own motion rather than supplied,
   * so a trail works identically on a physics body, an animated bone and a
   * tweened prop without any of them knowing this system exists.
   */
  addTrail(target: THREE.Object3D, _materialKey: string, lifetime: number): IVFXHandle | undefined {
    const index = this.acquireTrail();
    if (index < 0) return undefined;
    const trail = this.trails[index]!;
    trail.active = true;
    trail.generation = (trail.generation + 1) & 0x3fffff;
    trail.age = 0;
    trail.life = lifetime;
    trail.size = 1.2;
    trail.power = 0.6;
    trail.carry = 0;
    trail.attach = target;
    trail.hasLast = false;
    trail.vx = 0;
    trail.vy = 0;
    trail.vz = 0;
    target.getWorldPosition(this.scratchVector);
    trail.x = this.scratchVector.x;
    trail.y = this.scratchVector.y;
    trail.z = this.scratchVector.z;

    return new VFXHandle(this, index, trail.generation, 'trail', this.nextId++, 'debrisBurst');
  }

  stopAll(effect?: VFXEffectName): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      if (effect === undefined || slot.name === effect) {
        slot.emitUntil = 0;
        slot.rate = 0;
      }
    }
  }

  /** Wipe everything, including persistent decals. Used on fast travel. */
  clear(): void {
    for (const slot of this.slots) slot.active = false;
    for (const trail of this.trails) {
      trail.active = false;
      trail.attach = undefined;
    }
    this.sprites.clear();
    this.shockwaves.clear();
    this.decals.clear();
    this.speedlines.clear();
    this.shake.reset();
  }

  /**
   * Pre-warm.
   *
   * The pools are already fully allocated by the constructor, so there is no
   * lazy growth to force. What this exists for is the SHADER side: call
   * `compile()` with a live renderer during loading, never during a fight.
   */
  async preload(_effects: readonly VFXEffectName[]): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Compile the VFX programs now.
   *
   * Must be handed the REAL scene and camera. Programs are keyed partly on
   * light counts and on whether the draw goes to a render target, so compiling
   * against a stand-in scene produces variants the game will never use — and
   * then compiles the real ones mid-punch anyway.
   */
  compile(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const restore: boolean[] = [];
    for (const mesh of this.meshes) {
      restore.push(mesh.visible);
      mesh.visible = true;
    }
    renderer.compile(scene, camera);
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i]!.visible = restore[i]!;
  }

  /**
   * Advance and upload.
   *
   * @param dt SCALED seconds. See the class header — everything freezing
   *           together is the point.
   */
  update(dt: number): void {
    if (this.disposed) return;

    this.flushCoalesced();

    if (this.camera) {
      this.camera.getWorldPosition(this.cameraPosition);
      this.cameraForward.set(0, 0, -1).applyQuaternion(this.camera.getWorldQuaternion(_quaternion));
      this.shake.listenerPosition.copy(this.cameraPosition);
      // The sprite shader needs the sun in VIEW space; doing the rotation once
      // on the CPU beats a matrix multiply in every dust fragment.
      this.shared.uSunView.value
        .copy(this.sunDirection)
        .transformDirection(this.camera.matrixWorldInverse);
    }

    this.updateEffects(dt);
    this.updateTrails(dt);

    this.sprites.update(dt);
    this.shockwaves.update(dt);
    this.decals.update(dt);
    this.speedlines.update(dt);
    this.shake.update(dt);

    this.sprites.prepare(this.cameraPosition, this.cameraForward);
    this.shockwaves.prepare();
    this.decals.prepare();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
    this.clear();
    this.sprites.dispose();
    this.decals.dispose();
    this.shockwaves.dispose();
    this.speedlines.dispose();
    for (const material of this.materials) material.dispose();
    this.particleAtlas?.dispose();
    this.crackAtlas?.dispose();
    this.root.clear();
  }

  diagnostics(): IVFXDiagnostics {
    let trails = 0;
    for (const trail of this.trails) if (trail.active) trails++;
    let submitted = 0;
    for (const mesh of this.meshes) if (mesh.visible) submitted++;
    return {
      tier: this.profile.tier,
      effects: this.activeCount,
      effectCapacity: this.slots.length,
      sprites: this.sprites.activeCount,
      spriteCapacity: this.sprites.capacity,
      spritesDropped: this.sprites.dropped,
      shockwaves: this.shockwaves.activeCount,
      shockwaveCapacity: this.shockwaves.capacity,
      decals: this.decals.activeCount,
      decalCapacity: this.decals.capacity,
      trails,
      trailCapacity: this.trails.length,
      speedlineIntensity: this.speedlines.intensity,
      trauma: this.shake.trauma,
      drawCallsSubmitted: submitted,
      programCount: 3,
    };
  }

  /** Live particle state hash, for determinism tests. */
  checksum(): number {
    return this.sprites.checksum();
  }

  /* ---------------------------------------------------------------------- */
  /* Handle callbacks                                                       */
  /* ---------------------------------------------------------------------- */

  isEffectAlive(index: number, generation: number): boolean {
    const slot = this.slots[index];
    return slot !== undefined && slot.active && slot.generation === generation;
  }

  isTrailAlive(index: number, generation: number): boolean {
    const trail = this.trails[index];
    return trail !== undefined && trail.active && trail.generation === generation;
  }

  stopEffect(index: number, generation: number): void {
    if (!this.isEffectAlive(index, generation)) return;
    const slot = this.slots[index]!;
    slot.emitUntil = 0;
    slot.rate = 0;
  }

  killEffect(index: number, generation: number): void {
    if (!this.isEffectAlive(index, generation)) return;
    this.slots[index]!.active = false;
    this.slots[index]!.attach = undefined;
  }

  stopTrail(index: number, generation: number): void {
    if (!this.isTrailAlive(index, generation)) return;
    this.trails[index]!.active = false;
    this.trails[index]!.attach = undefined;
  }

  moveEffect(index: number, generation: number, position: THREE.Vector3): void {
    if (!this.isEffectAlive(index, generation)) return;
    const slot = this.slots[index]!;
    slot.x = position.x;
    slot.y = position.y;
    slot.z = position.z;
  }

  /* ---------------------------------------------------------------------- */
  /* Event bus                                                              */
  /* ---------------------------------------------------------------------- */

  private subscribe(bus: IEventBus): void {
    this.unsubscribes.push(
      bus.on('ShockwaveFired', (event) => this.onShockwaveFired(event)),
      bus.on('EntityKilled', (event) => this.onEntityKilled(event)),
      bus.on('ChunkDetached', (event) => this.onChunkDetached(event)),
      bus.on('ImpulseApplied', (event) => this.onImpulseApplied(event)),
      bus.on('PlayerLanded', (event) => this.onPlayerLanded(event)),
      bus.on('EncounterEnded', (event) => this.onEncounterEnded(event))
    );
  }

  private onShockwaveFired(event: GameEventOf<'ShockwaveFired'>): void {
    // `power` is unbounded — a serious punch may exceed 1e6 — so it is folded
    // logarithmically rather than divided by a magic ceiling.
    const magnitude = clamp01(Math.log10(Math.max(1, event.power)) / 6);
    const intent = INTENT_POWER[event.intent] ?? 0.4;
    const power = clamp01(intent * 0.62 + magnitude * 0.52);

    const omnidirectional = event.angle >= 2.6;
    this.scratchVector.set(event.origin.x, event.origin.y, event.origin.z);
    this.scratchVectorB.set(event.direction.x, event.direction.y, event.direction.z);

    const index = this.spawnSlot(omnidirectional ? 'shockwaveRing' : 'shockwaveCone', {
      position: this.scratchVector,
      direction: this.scratchVectorB,
      intensity: power,
      intent: event.intent,
      scale: event.range,
      priority: 1,
    });
    if (index < 0) return;

    // The half-angle travels straight into the shell, so the wave matches the
    // combat cone exactly rather than approximately.
    this.slots[index]!.radius = event.range;
    this.configureShockwave(index, event.angle, event.range, power, event.intent);
  }

  private onEntityKilled(event: GameEventOf<'EntityKilled'>): void {
    this.scratchVector.set(event.position.x, event.position.y, event.position.z);
    const tierWeight = event.threatTier ? (THREAT_WEIGHT[event.threatTier] ?? 0.5) : 0.4;
    this.spawnSlot('monsterDeath', {
      position: this.scratchVector,
      intensity: tierWeight,
      intent: event.intent,
      priority: 0.9,
      scale: 1 + tierWeight * 2.5,
    });
  }

  private onChunkDetached(event: GameEventOf<'ChunkDetached'>): void {
    // Coalesce: a collapse emits dozens of these per frame and one dust
    // aggregate reads better than forty competing puffs.
    this.chunkCount++;
    this.chunkX += event.position.x;
    this.chunkY += event.position.y;
    this.chunkZ += event.position.z;
    const speed = Math.hypot(event.impulse.x, event.impulse.y, event.impulse.z) /
      Math.max(1, event.mass);
    this.chunkPower = Math.max(this.chunkPower, clamp01(speed / 45));
    this.chunkSpread = Math.max(this.chunkSpread, Math.min(28, Math.cbrt(event.mass) * 0.6));

    // Each piece still gets its own streak, up to the trail budget — the trail
    // is what makes a collapse read as pieces flying rather than as fog.
    const index = this.acquireTrail();
    if (index < 0) return;
    const trail = this.trails[index]!;
    trail.active = true;
    trail.generation = (trail.generation + 1) & 0x3fffff;
    trail.x = event.position.x;
    trail.y = event.position.y;
    trail.z = event.position.z;
    const inverseMass = 1 / Math.max(1, event.mass);
    trail.vx = event.impulse.x * inverseMass;
    trail.vy = event.impulse.y * inverseMass;
    trail.vz = event.impulse.z * inverseMass;
    trail.age = 0;
    trail.life = 1.6 + Math.min(2, Math.cbrt(event.mass) * 0.2);
    trail.size = Math.max(0.4, Math.min(3.5, Math.cbrt(event.mass) * 0.32));
    trail.power = clamp01(speed / 40);
    trail.carry = 0;
    trail.attach = undefined;
    trail.hasLast = false;
  }

  private onImpulseApplied(event: GameEventOf<'ImpulseApplied'>): void {
    this.impulseCount++;
    this.impulseX += event.point.x;
    this.impulseY += event.point.y;
    this.impulseZ += event.point.z;
    const magnitude = Math.hypot(event.impulse.x, event.impulse.y, event.impulse.z);
    this.impulsePower = Math.max(this.impulsePower, clamp01(magnitude / 4e4));
  }

  private onPlayerLanded(event: GameEventOf<'PlayerLanded'>): void {
    const power = clamp01(event.impactSpeed / 55);
    if (power < 0.06) return;
    this.scratchVector.set(event.position.x, event.position.y, event.position.z);
    this.spawnSlot(event.createsCrater ? 'crater' : 'landingDust', {
      position: this.scratchVector,
      intensity: power,
      intent: event.intent,
      priority: event.createsCrater ? 0.8 : 0.45,
      scale: 2 + power * 9,
    });
  }

  private onEncounterEnded(event: GameEventOf<'EncounterEnded'>): void {
    // An aborted encounter is a teleport or a reload, not a resolution: the
    // dust hanging in the air belongs to a fight that no longer happened.
    if (event.outcome === 'aborted') this.clear();
    else this.stopAll();
  }

  /** Emit the coalesced aggregates that events accumulated last frame. */
  private flushCoalesced(): void {
    if (this.chunkCount > 0) {
      const inverse = 1 / this.chunkCount;
      this.scratchVector.set(
        this.chunkX * inverse,
        this.chunkY * inverse,
        this.chunkZ * inverse
      );
      this.spawnSlot('debrisBurst', {
        position: this.scratchVector,
        intensity: this.chunkPower,
        priority: 0.35,
        scale: this.chunkSpread + Math.min(20, this.chunkCount * 0.8),
      });
      this.chunkCount = 0;
      this.chunkX = 0;
      this.chunkY = 0;
      this.chunkZ = 0;
      this.chunkPower = 0;
      this.chunkSpread = 0;
    }
    if (this.impulseCount > 0) {
      const inverse = 1 / this.impulseCount;
      this.scratchVector.set(
        this.impulseX * inverse,
        this.impulseY * inverse,
        this.impulseZ * inverse
      );
      if (this.impulsePower > 0.08) {
        this.spawnSlot('dustCloud', {
          position: this.scratchVector,
          intensity: this.impulsePower,
          priority: 0.2,
          scale: 1.5 + this.impulsePower * 4,
        });
      }
      this.impulseCount = 0;
      this.impulseX = 0;
      this.impulseY = 0;
      this.impulseZ = 0;
      this.impulsePower = 0;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Effect construction                                                    */
  /* ---------------------------------------------------------------------- */

  /** The one-shot content of an effect, emitted at spawn. */
  private build(slot: EffectSlot, options: IVFXSpawnOptions, power: number, scale: number): void {
    const rng = this.rng;
    const { x, y, z } = slot;

    switch (slot.name) {
      case 'shockwaveRing':
      case 'shockwaveCone':
      case 'airDistortion':
        // Shells and the dust front are configured by `configureShockwave`,
        // which needs the cone half-angle the event carried.
        slot.lifetime = 2.2 + power * 2.4;
        break;

      case 'punchImpact':
      case 'monsterDeath': {
        this.emitters.impactFlash(rng, x, y + 0.4, z, power);
        this.emitters.hitSparks(rng, x, y + 0.4, z, slot.dx, slot.dy, slot.dz, power, 14 + power * 26);
        this.emitters.debrisChips(rng, x, y + 0.3, z, slot.dx, slot.dy, slot.dz, power, 5 + power * 10);
        this.emitters.dustPlume(rng, x, y + 0.3, z, 1.2 + scale * 0.6, power, 14 + power * 22, 1.3);
        this.speedlines.burst(0.18 + power * 0.24, 3.6);
        if (this.camera) this.speedlines.setFocusWorld(x, y, z, this.camera);
        this.shake.addAtPosition(0.35 + power * 0.5, this.scratchVectorB.set(x, y, z), 55);
        slot.lifetime = 1.6 + power;
        break;
      }

      case 'explosion': {
        this.emitters.impactFlash(rng, x, y + 1, z, power);
        this.emitters.hitSparks(rng, x, y + 1, z, 0, 1, 0, power, 22 + power * 30);
        this.emitters.debrisChips(rng, x, y + 1, z, 0, 1, 0, power, 10 + power * 16);
        this.emitters.dustPlume(rng, x, y + 0.6, z, 2 + scale, power, 26 + power * 40, 2.4);
        this.spawnShell(x, y, z, 0, 1, 0, Math.PI, 8 + scale * 6, power, 0, true);
        this.speedlines.burst(0.45 * power + 0.15, 3);
        this.shake.addAtPosition(0.5 + power * 0.5, this.scratchVectorB.set(x, y, z), 80);
        slot.lifetime = 2.6 + power;
        break;
      }

      case 'crater': {
        this.emitters.groundCracks(rng, x, y + 0.02, z, 0, 1, 0, 1.6 + scale * 0.6, power, 6 + power * 8);
        this.emitters.dustPlume(rng, x, y + 0.2, z, 1.5 + scale * 0.7, power, 22 + power * 34, 0.7);
        this.emitters.debrisChips(rng, x, y + 0.2, z, 0, 1, 0, power, 6 + power * 12);
        this.spawnShell(x, y + 0.15, z, 0, 1, 0, Math.PI, 6 + scale * 3.2, power * 0.85, 0, false);
        this.shake.addAtPosition(0.4 + power * 0.5, this.scratchVectorB.set(x, y, z), 70);
        this.speedlines.burst(0.22 + power * 0.26, 4.2);
        slot.lifetime = 2.6 + power;
        break;
      }

      case 'landingDust': {
        this.emitters.dustPlume(rng, x, y + 0.15, z, 1 + scale * 0.5, power * 0.7, 10 + power * 20, 0.55);
        this.spawnShell(x, y + 0.1, z, 0, 1, 0, Math.PI, 3 + scale * 1.8, power * 0.55, 0, false);
        this.shake.addAtPosition(0.15 + power * 0.25, this.scratchVectorB.set(x, y, z), 40);
        slot.lifetime = 2 + power;
        break;
      }

      case 'dustCloud':
        this.emitters.dustPlume(rng, x, y, z, 1 + scale * 0.5, power * 0.6, 8 + power * 14, 1);
        slot.lifetime = 2.4 + power;
        break;

      case 'debrisBurst': {
        this.emitters.dustPlume(rng, x, y, z, 1.5 + scale * 0.5, power * 0.8, 10 + power * 22, 1.1);
        this.emitters.debrisChips(rng, x, y, z, 0, 1, 0, power * 0.8, 4 + power * 8);
        slot.lifetime = 2.4 + power;
        break;
      }

      case 'groundCrack':
        this.emitters.groundCracks(rng, x, y + 0.02, z, slot.dx, slot.dy, slot.dz, 1 + scale, power, 4 + power * 8);
        slot.lifetime = 0.2;
        break;

      case 'sparks':
        this.emitters.hitSparks(rng, x, y, z, slot.dx, slot.dy, slot.dz, power, 10 + power * 20);
        slot.lifetime = 1.2;
        break;

      case 'bloodSpray':
        this.emitters.hitSparks(rng, x, y, z, slot.dx, slot.dy, slot.dz, power, 12 + power * 18);
        slot.lifetime = 1.2;
        break;

      case 'speedLines':
        this.speedlines.burst(0.35 + power * 0.35, 2.6);
        slot.lifetime = 0.8;
        break;

      case 'healPulse':
      case 'rankUpBurst': {
        this.emitters.impactFlash(rng, x, y + 1, z, power * 0.5);
        this.emitters.hitSparks(rng, x, y + 0.5, z, 0, 1, 0, power * 0.5, 12);
        slot.lifetime = 1.4;
        break;
      }
    }

    if (options.lifetime !== undefined) slot.lifetime = options.lifetime;
  }

  /**
   * Build the shells for a punch and arm the dust front.
   *
   * THREE shells, not one:
   *
   *   1. an AXIAL CONE matching the combat cone's half-angle exactly — the air
   *      the fist is pushing;
   *   2. a wide GROUND SKIRT — the blast running along the road, which is what
   *      gives the wave a scale reference against the city;
   *   3. a faster, dimmer inner skirt, so the front reads as a shock followed
   *      by a rarefaction rather than as a single expanding decal.
   *
   * Shell 2 is the one the dust front rides, and the one the slot keeps.
   */
  private configureShockwave(
    index: number,
    halfAngle: number,
    range: number,
    power: number,
    intent: LethalIntent
  ): void {
    if (index < 0) return;
    const slot = this.slots[index]!;
    const rng = this.rng;
    const { x, y, z } = slot;
    const omnidirectional = halfAngle >= 2.6;
    // Faster waves for stronger punches. Deliberately SUBSONIC-looking: a
    // genuinely instantaneous wave is one frame of white and then nothing, and
    // the whole payoff of the game is the player getting to watch it travel.
    const speed = 120 + power * 190;
    const life = Math.min(2.2, Math.max(0.34, range / speed));

    if (!omnidirectional) {
      this.spawnShell(x, y + 1.1, z, slot.dx, slot.dy, slot.dz, halfAngle, range, power, 1, false, life);
    } else {
      // Straight up: the vertical column of a ground-zero detonation.
      this.spawnShell(x, y + 0.6, z, 0, 1, 0, 1.15, range * 0.55, power * 0.85, 1, false, life * 1.15);
    }

    const skirtAngle = omnidirectional ? Math.PI : Math.min(Math.PI, halfAngle * 1.5 + 0.30);
    const shell = this.spawnShell(
      x,
      y + 0.25,
      z,
      slot.dx,
      slot.dy,
      slot.dz,
      skirtAngle,
      range * (omnidirectional ? 1 : 0.86),
      power,
      0,
      true,
      life * 1.25
    );
    this.spawnShell(
      x,
      y + 0.15,
      z,
      slot.dx,
      slot.dy,
      slot.dz,
      skirtAngle,
      range * 0.52,
      power * 0.55,
      0,
      false,
      life * 0.72
    );

    slot.shell = shell;
    slot.shellGeneration = this.shockwaves.generationOf(shell);
    slot.lofted = omnidirectional;
    slot.frontSpeed = range / Math.max(0.05, life);
    slot.emitUntil = life * 1.25;
    slot.rate = (150 + power * 420) * this.profile.particleScale;
    slot.lifetime = Math.max(slot.lifetime, life * 1.25 + 4);

    /* --- the one-shot content that has to be there in frame one --------- */

    this.emitters.impactFlash(rng, x, y + 1.1, z, power);
    this.emitters.dustPlume(rng, x, y + 0.4, z, 3 + power * 6, power, 30 + power * 42, 2.0);
    this.emitters.dustColumn(rng, x, y, z, 2.5 + power * 4.5, power, 12 + power * 20, 16 + power * 40);
    this.emitters.debrisChips(rng, x, y + 0.5, z, slot.dx, slot.dy, slot.dz, power, 8 + power * 18);
    this.emitters.hitSparks(rng, x, y + 1.1, z, slot.dx, slot.dy, slot.dz, power, 10 + power * 22);

    // A pre-formed dust front, so the wave is already a WALL on the frame the
    // impact freeze holds — not a ring that has yet to grow one.
    if (shell >= 0) {
      this.emitters.dustFront(rng, shell, slot.frontSpeed, power, 34 + power * 54, omnidirectional);
    }

    // Ground damage: a star under the fist, plus fractures further along the
    // cone so the road records where the wave went.
    this.emitters.groundCracks(rng, x, y + 0.02, z, 0, 1, 0, 2 + power * 6, power, 7 + power * 7);
    const crackSteps = power > 0.45 ? 3 : 1;
    const flat = Math.hypot(slot.dx, slot.dz) || 1;
    for (let i = 1; i <= crackSteps; i++) {
      const distance = (range * 0.28 * i) / crackSteps;
      this.emitters.groundCracks(
        rng,
        x + (slot.dx / flat) * distance,
        y + 0.02,
        z + (slot.dz / flat) * distance,
        0,
        1,
        0,
        1.2 + power * 3.4,
        power * 0.8,
        3 + power * 4
      );
    }

    this.speedlines.burst(0.20 + power * 0.26, 3.0);
    if (this.camera) this.speedlines.setFocusWorld(x, y + 1, z, this.camera);
    this.shake.addAtPosition(0.45 + power * 0.55, this.scratchVectorB.set(x, y, z), 40 + range * 0.6);

    // CLOUD PARTING. Reserved for a genuine serious punch: it is the one beat
    // in the game that says the sky noticed.
    if ((intent === 'serious' || intent === 'full') && power >= 0.62) {
      this.emitters.cloudParting(
        rng,
        x,
        y,
        z,
        this.cloudAltitude,
        Math.max(120, range * 1.5),
        power
      );
    }
  }

  private spawnShell(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    halfAngle: number,
    range: number,
    power: number,
    kind: number,
    primary: boolean,
    life?: number
  ): number {
    const params = _shellParams;
    params.x = x;
    params.y = y;
    params.z = z;
    params.dx = dx;
    params.dy = dy;
    params.dz = dz;
    params.halfAngle = halfAngle;
    params.range = range;
    params.life = life ?? Math.min(1.6, Math.max(0.3, range / (150 + power * 220)));
        // The axial cone covers a huge screen area at 180 metres; the ground
    // skirt is the shape the eye should follow. Weighting them equally turns
    // the punch into a white blob.
    params.intensity = (primary ? 0.9 : kind === 1 ? 0.34 : 0.45) + power * 0.4;
    params.kind = kind;
    params.sharpness = 1.05 + power * 0.45;
    params.chroma = this.profile.shaderQuality > 0 ? 0.022 + power * 0.014 : 0;
    params.loft = kind === 0 ? 0.30 + power * 0.20 : 0;
    params.start = kind === 0 ? 0.1 : 0.14;
    params.seed = this.rng.next();
    _shellColor.setHex(SHOCK_COLOR);
    params.r = _shellColor.r;
    params.g = _shellColor.g;
    params.b = _shellColor.b;
    return this.shockwaves.emit(params);
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                              */
  /* ---------------------------------------------------------------------- */

  private updateEffects(dt: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.age += dt;

      if (slot.attach) {
        slot.attach.getWorldPosition(this.scratchVector);
        slot.x = this.scratchVector.x;
        slot.y = this.scratchVector.y;
        slot.z = this.scratchVector.z;
      }

      if (slot.rate > 0 && slot.age < slot.emitUntil) {
        const alive =
          slot.shell >= 0 && this.shockwaves.isAlive(slot.shell, slot.shellGeneration);
        if (alive) {
          slot.carry += slot.rate * dt;
          const whole = Math.floor(slot.carry);
          if (whole > 0) {
            slot.carry -= whole;
            const progress = this.shockwaves.progressOf(slot.shell);
            // NOMINAL front speed, not `radius / age`.
            //
            // The expansion curve starts at a tenth of the range and is
            // front-loaded, so `radius / age` on the first frame reports
            // thousands of metres per second and the dust it sheds leaves the
            // city before it has drawn. Dust does not travel at the shock's
            // speed anyway — it is entrained air, which is why this is a
            // fraction of the average front speed and decays as the wave
            // gives up its energy.
            const edgeSpeed = Math.min(240, slot.frontSpeed) * (1 - progress * 0.6);
            this.emitters.dustFront(
              this.rng,
              slot.shell,
              edgeSpeed,
              slot.power,
              whole,
              slot.lofted
            );
          }
        } else {
          slot.rate = 0;
        }
      }

      if (slot.age >= slot.lifetime) {
        slot.active = false;
        slot.attach = undefined;
      }
    }
  }

  private updateTrails(dt: number): void {
    for (const trail of this.trails) {
      if (!trail.active) continue;
      trail.age += dt;
      if (trail.age >= trail.life) {
        trail.active = false;
        trail.attach = undefined;
        continue;
      }

      if (trail.attach) {
        trail.attach.getWorldPosition(this.scratchVector);
        if (trail.hasLast && dt > 0) {
          const inverse = 1 / dt;
          trail.vx = (this.scratchVector.x - trail.x) * inverse;
          trail.vy = (this.scratchVector.y - trail.y) * inverse;
          trail.vz = (this.scratchVector.z - trail.z) * inverse;
        }
        trail.x = this.scratchVector.x;
        trail.y = this.scratchVector.y;
        trail.z = this.scratchVector.z;
        trail.hasLast = true;
      } else {
        // Unattached trails integrate their own ballistic arc. This is a VFX
        // approximation of the chunk's flight, not a physics result — the
        // destruction system owns the real body and can call `addTrail` to
        // drive this exactly instead.
        trail.vy -= 9.81 * dt;
        const damping = 1 / (1 + 0.06 * dt);
        trail.vx *= damping;
        trail.vy *= damping;
        trail.vz *= damping;
        trail.x += trail.vx * dt;
        trail.y += trail.vy * dt;
        trail.z += trail.vz * dt;
        if (trail.y < 0) {
          trail.active = false;
          continue;
        }
      }

      const speed = Math.hypot(trail.vx, trail.vy, trail.vz);
      if (speed < 3) continue;
      // Emission proportional to distance travelled, so a fast chunk lays a
      // continuous streak and a slow one does not stutter out puffs.
      trail.carry += speed * dt * 1.4;
      while (trail.carry >= 1) {
        trail.carry -= 1;
        if (
          !this.emitters.trailStep(
            this.rng,
            trail.x,
            trail.y,
            trail.z,
            trail.vx,
            trail.vy,
            trail.vz,
            trail.size,
            trail.power
          )
        ) {
          trail.carry = 0;
          break;
        }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Slot management                                                        */
  /* ---------------------------------------------------------------------- */

  private acquireSlot(priority: number): number {
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]!.active) return i;
    }
    // Full: evict the weakest, and only if this request outranks it.
    let weakest = -1;
    let weakestPriority = priority;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (slot.priority < weakestPriority) {
        weakestPriority = slot.priority;
        weakest = i;
      }
    }
    if (weakest >= 0) this.slots[weakest]!.active = false;
    return weakest;
  }

  private acquireTrail(): number {
    for (let i = 0; i < this.trails.length; i++) {
      if (!this.trails[i]!.active) return i;
    }
    return -1;
  }
}

/* -------------------------------------------------------------------------- */
/* Module-level scratch — allocated once, never per frame                     */
/* -------------------------------------------------------------------------- */

const _quaternion = new THREE.Quaternion();
const _shellParams = createShockwaveParams();
const _shellColor = new THREE.Color();

const THREAT_WEIGHT: Readonly<Record<string, number>> = {
  wolf: 0.4,
  tiger: 0.58,
  demon: 0.78,
  dragon: 1,
  god: 1,
};

function tierEffectCapacity(tier: IQualityTier): number {
  return tier === 'low' ? 4 : tier === 'medium' ? 8 : 16;
}

/**
 * Default priorities.
 *
 * The shockwave is 1.0 and never loses a slot: it is the payoff the entire
 * game is built around, and dropping it because forty pieces of rubble arrived
 * first would be the worst possible budget decision.
 */
function defaultPriority(effect: VFXEffectName): number {
  switch (effect) {
    case 'shockwaveRing':
    case 'shockwaveCone':
      return 1;
    case 'punchImpact':
    case 'monsterDeath':
    case 'explosion':
      return 0.9;
    case 'crater':
      return 0.8;
    case 'groundCrack':
    case 'landingDust':
      return 0.5;
    case 'sparks':
    case 'bloodSpray':
    case 'speedLines':
      return 0.4;
    case 'debrisBurst':
      return 0.35;
    default:
      return 0.25;
  }
}

/** Map a decal material key onto a fracture pattern. */
function crackTileFor(materialKey: string): number {
  const key = materialKey.toLowerCase();
  if (key.includes('star') || key.includes('impact') || key.includes('crater')) return CrackTile.Star;
  if (key.includes('scorch') || key.includes('smear') || key.includes('dust')) return CrackTile.Smear;
  if (key.includes('b')) return CrackTile.BranchB;
  return CrackTile.BranchA;
}

function emptySlot(): EffectSlot {
  return {
    active: false,
    generation: 0,
    name: 'punchImpact',
    priority: 0,
    age: 0,
    lifetime: 0,
    emitUntil: 0,
    rate: 0,
    carry: 0,
    power: 0,
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dy: 1,
    dz: 0,
    radius: 1,
    shell: -1,
    shellGeneration: -1,
    lofted: false,
    frontSpeed: 0,
    attach: undefined,
  };
}

function emptyTrail(): TrailSlot {
  return {
    active: false,
    generation: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    age: 0,
    life: 0,
    size: 1,
    power: 0.5,
    carry: 0,
    attach: undefined,
    hasLast: false,
  };
}
