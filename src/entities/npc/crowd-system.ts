/**
 * CROWD SYSTEM — the city's health bar
 *
 * Owns the three tiers, the two fields, the ledger and the allies, and wires
 * them to the event bus. Everything else in this directory is a component of
 * this.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER
 *
 *   1. EVENTS      drain what the bus delivered since the last frame. Alarm
 *                  impulses have to be seeded before the field ticks or a
 *                  shockwave's panic arrives a frame late, which is visible
 *                  when the shockwave itself is instantaneous.
 *   2. ALARM       10 Hz internally. Reads threats, writes the scalar field.
 *   3. FLOW        4 Hz internally. Reads threats and obstacles, writes the
 *                  three direction fields.
 *   4. POPULATION  spawn into the band, despawn out of it, promote and demote
 *                  between tiers. Before steering, so a promoted agent steers
 *                  with its near-tier avoidance on the frame it arrives.
 *   5. THINK       near-tier behaviour trees. They VETO the field, so they
 *                  must run before the field is integrated.
 *   6. STEER       one pass over every agent: mood, preference, avoidance,
 *                  integration, separation, containment.
 *   7. RESOLVE     saves, losses, corpses. After steering, because "did they
 *                  reach safety" is a question about where they ended up.
 *   8. PRESENT     bones for the near tier, instance buffers for the mid tier.
 *                  Last, and purely a readout — nothing here changes state.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── WHAT THIS SYSTEM REFUSES TO IMPORT ────────────────────────────────────
 * Monsters, combat, VFX, the city, the roster. Threats arrive as injected
 * `IThreatSource` records; everything else arrives as events. That is not
 * fastidiousness — it is what let this system be written, tested and
 * screenshotted while `src/entities/monster/` was an empty directory.
 */

import * as THREE from 'three';
import type {
  EntityId,
  IEventBus,
  IQualityTier,
  Vec3,
} from '@/types';
import type { ICrowdSink, ICrowdSlot, CrowdMode } from '@/world/streaming';
import { clamp01, createRng, type IRandom } from '@/util';
import { CHUNK_SIZE } from '@/spatial/constants';
import { ProceduralAnimator } from '@/characters/anim';
import { buildHumanoid, civilianOptions, civilianProfile, createCharacterParts } from '@/characters/mesh';
import { AlarmField } from './alarm-field';
import {
  CrowdAgents,
  MOOD_COWER,
  MOOD_DOWN,
  MOOD_FLEE,
  MOOD_GAWK,
  MOOD_NAMES,
  TIER_MID,
  TIER_NEAR,
} from './crowd-agents';
import { CrowdRenderer } from './crowd-renderer';
import { CrowdSteering, LAYER_HERO, LAYER_PLAYER, LAYER_THREAT, type IAvoidBody } from './steering';
import { FlowField } from './flow-field';
import { HeroNpc, type IHeroWorld } from './hero-npc';
import { NearCivilian, type ICivilianHost } from './near-civilian';
import { ObstacleField, cellCentreX, cellCentreZ, cellX, cellZ } from './obstacles';
import { CrowdLedger, gatherWitnesses } from './witness';
import {
  ENDANGERED_ALARM,
  FIELD_DIM,
  MID_CAP,
  MID_RADIUS,
  NEAR_CAP,
  NEAR_RADIUS,
  RESCUE_RADIUS,
  SAFE_ALARM,
  SIGHT_RANGE,
  TIER_HYSTERESIS,
} from './constants';
import type {
  CivilianMood,
  ICivilianOutcome,
  ICrowdStats,
  IHeroCallout,
  IHeroStatus,
  IObstacleRect,
  IThreatSource,
  HeroNpcId,
} from './types';

/** Seconds a body stays on the pavement before it is recycled. */
const CORPSE_SECONDS = 22;

/** Seconds an agent must stay calm before the save is credited. */
const SAFE_DWELL = 0.6;

/**
 * Seconds after a player shockwave during which collateral is blamed on them.
 *
 * Debris does not carry an attacker id — `ChunkDetachedEvent` has a structure
 * and an impulse and nothing about who swung. Without a window, every building
 * that ever falls is nobody's fault, and the central pressure of the game (do
 * not fight at full intent in a populated district) evaporates.
 */
const COLLATERAL_WINDOW = 4;

/** Metres beyond which nothing is simulated. Feeds the audio bed only. */
const FAR_RADIUS = 420;

/** Fallback world seed. Any fixed value works; it only has to be stable. */
const DEFAULT_CROWD_SEED = 0xc17ce7;

/** People per open 12 m cell, for the far-tier population estimate. */
const FAR_PEOPLE_PER_CELL = 0.55;

/** Seconds between far-tier headcounts. It feeds an ambience bed, not a hit test. */
const FAR_POPULATION_INTERVAL = 1;

/**
 * Peak damage a full-power hostile shockwave does to an ally.
 *
 * Tuned against `GENOS_HEALTH`: a dragon-level monster's wave at point blank
 * takes about a third of him, so he loses a protracted fight rather than an
 * instant one. Mumen Rider, on 95, is knocked down by a glancing one and can
 * be killed by two — which is the correct answer for Mumen Rider.
 */
const ALLY_SHOCKWAVE_DAMAGE = 150;

/**
 * How lethal each intent is to a bystander.
 *
 * `restrained` is nearly harmless by design: it is the setting where the
 * player is deliberately holding back around people, and if it still killed
 * them the restraint mechanic would be a lie. `full` is worse than serious by
 * more than the power number alone, because at full intent the player is not
 * aiming at anything.
 */
const INTENT_LETHALITY: Readonly<Record<string, number>> = {
  restrained: 0.04,
  normal: 0.4,
  serious: 1,
  full: 1.7,
};

/** Metres the player may move before the band-local spawn list is rebuilt. */
const SPAWN_ANCHOR_DRIFT = 28;

/** Metres inside the band edge that new civilians appear. */
const SPAWN_MARGIN = 6;

export interface ICrowdSystemOptions {
  /** Scene the instanced crowd and near bodies are added to. */
  readonly scene?: THREE.Object3D;
  readonly bus?: IEventBus;
  /** World seed. Same seed and same inputs produce the same crowd. */
  readonly seed?: number;
  /** Entity id of the player, so collateral can be attributed. */
  readonly playerId?: EntityId;
  /** Starting quality tier. Scales the population caps. */
  readonly quality?: IQualityTier;
  /** Skip building meshes. Tests and headless simulation. */
  readonly headless?: boolean;
}

/** Population caps by render tier. The crowd is the first thing to shed. */
const CAP_BY_TIER: Readonly<Record<IQualityTier, { near: number; mid: number }>> = {
  low: { near: 6, mid: 90 },
  medium: { near: 10, mid: 160 },
  high: { near: NEAR_CAP, mid: MID_CAP },
};

export class CrowdSystem implements ICrowdSink {
  readonly agents = new CrowdAgents();
  readonly alarm = new AlarmField();
  readonly flow = new FlowField();
  readonly obstacles = new ObstacleField();
  readonly steering = new CrowdSteering();
  readonly ledger = new CrowdLedger();
  readonly renderer: CrowdRenderer | undefined;
  /** Parent this to the scene; holds the instanced crowd and the near bodies. */
  readonly group = new THREE.Group();

  private readonly bus: IEventBus | undefined;
  private readonly seed: number;
  private readonly playerId: EntityId | undefined;
  private readonly headless: boolean;
  private readonly spawnRng: IRandom;

  private readonly threats: IThreatSource[] = [];
  private readonly heroes: HeroNpc[] = [];
  private readonly callouts: IHeroCallout[] = [];
  private readonly debris: { x: number; y: number; z: number; mass: number }[] = [];
  private readonly avoidBodies: IAvoidBody[] = [];

  /** Crowd slots published by the streaming system, keyed by chunk index. */
  private readonly chunkSlots = new Map<number, readonly ICrowdSlot[]>();
  /**
   * Spawn points inside the simulated band, shuffled.
   *
   * BAND-LOCAL, not world-wide, and that is the whole trick. A world-wide list
   * is 16,000 entries in raster order starting at the far south-west corner of
   * the map, so a cursor walking it rejects every candidate for being 900 m
   * from the player and the crowd never populates at all. Rebuilt when the
   * player moves `SPAWN_ANCHOR_DRIFT`, which at walking pace is a few seconds.
   */
  private readonly spawnPoints: { x: number; z: number; yaw: number }[] = [];
  private spawnCursor = 0;
  private spawnPointsDirty = true;
  private readonly spawnAnchor = { x: Infinity, z: Infinity };

  /** Bodies attached to agents, keyed by agent index. */
  private readonly nearBodies = new Map<number, NearCivilian>();
  /** Bodies with no agent, waiting to be reused. */
  private readonly freeBodies: NearCivilian[] = [];
  private readonly nearSkip = new Set<number>();
  private bodiesBuilt = 0;

  /** Per-agent bookkeeping the SoA does not need to expose. */
  private readonly safeTimer = new Float32Array(MID_CAP + NEAR_CAP);
  private readonly deadTimer = new Float32Array(MID_CAP + NEAR_CAP);
  private readonly rescuedByPlayer = new Uint8Array(MID_CAP + NEAR_CAP);
  private readonly killedByPlayer = new Uint8Array(MID_CAP + NEAR_CAP);

  private readonly player = { x: 0, z: 0 };
  private playerRegistered = false;
  /** Cached far-tier headcount, and the countdown to recomputing it. */
  private farCache = -1;
  private farTimer = 0;
  private collateralTimer = 0;
  private elapsed = 0;
  private simMs = 0;
  private caps = CAP_BY_TIER.high;
  private unsubscribes: (() => void)[] = [];
  private disposed = false;

  private stats: ICrowdStats = emptyStats();

  constructor(options: ICrowdSystemOptions = {}) {
    this.bus = options.bus;
    this.seed = options.seed ?? DEFAULT_CROWD_SEED;
    this.playerId = options.playerId;
    this.headless = options.headless ?? false;
    this.spawnRng = createRng(this.seed).derive('crowd-spawn');
    this.caps = CAP_BY_TIER[options.quality ?? 'high'];
    this.group.name = 'crowd';

    if (!this.headless) {
      this.renderer = new CrowdRenderer(this.seed);
      this.group.add(this.renderer.group);
    }
    options.scene?.add(this.group);
    this.subscribe();
  }

  /* ------------------------------------------------------------------ */
  /* Configuration                                                      */
  /* ------------------------------------------------------------------ */

  /** Where the player is. Drives tiering, rescue credit and witnessing. */
  setPlayer(x: number, z: number): void {
    this.player.x = x;
    this.player.z = z;
    this.playerRegistered = true;
    // Force a recount on the next frame: a player who teleported across the
    // city is standing somewhere with a different population.
    this.farCache = -1;
  }

  /**
   * Replace the live threat list.
   *
   * Called by the bootstrap with monster positions each frame. This is the one
   * seam that cannot be an event: the alarm field needs CURRENT positions, and
   * an event stream of "monster moved" would be one message per monster per
   * frame for information that is already sitting in an array.
   */
  setThreats(threats: readonly IThreatSource[]): void {
    this.threats.length = 0;
    for (const threat of threats) this.threats.push(threat);
  }

  /** Replace the building footprints used for navigation and line of sight. */
  setObstacles(rects: readonly IObstacleRect[]): void {
    this.obstacles.rebuild(rects);
    this.spawnPointsDirty = true;
  }

  /** Scale the population caps to the render tier. */
  setQuality(quality: IQualityTier): void {
    this.caps = CAP_BY_TIER[quality];
  }

  /** Add an ally. The caller supplies the body, or omits it for headless runs. */
  addHero(
    heroId: HeroNpcId,
    x: number,
    z: number,
    body?: { parts: ReturnType<typeof createCharacterParts>; animator: ProceduralAnimator }
  ): HeroNpc {
    const hero = new HeroNpc(`hero-${heroId}`, heroId, this.heroWorld(), body);
    hero.transform.set(x, 0, z, 0);
    this.heroes.push(hero);
    if (body !== undefined) this.group.add(hero.root);
    return hero;
  }

  /** Live allies. */
  get allies(): readonly HeroNpc[] {
    return this.heroes;
  }

  /** Dialogue published by allies since the last `drainCallouts`. */
  drainCallouts(): IHeroCallout[] {
    const out = this.callouts.slice();
    this.callouts.length = 0;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* ICrowdSink — the streaming system's population feed                */
  /* ------------------------------------------------------------------ */

  setChunkCrowd(chunk: number, mode: CrowdMode, slots: readonly ICrowdSlot[]): void {
    if (mode === 'none' || slots.length === 0) this.chunkSlots.delete(chunk);
    else this.chunkSlots.set(chunk, slots);
    this.spawnPointsDirty = true;
  }

  clearChunkCrowd(chunk: number): void {
    this.chunkSlots.delete(chunk);
    this.spawnPointsDirty = true;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                             */
  /* ------------------------------------------------------------------ */

  private subscribe(): void {
    const bus = this.bus;
    if (bus === undefined) return;

    this.unsubscribes.push(
      // A shockwave is the single loudest thing that happens in this game. It
      // scares people, it hurts people, and when the player fired it, it is
      // their fault.
      bus.on('ShockwaveFired', (event) => {
        const byPlayer = this.playerId !== undefined && event.sourceId === this.playerId;
        if (byPlayer) this.collateralTimer = COLLATERAL_WINDOW;
        const power = clamp01(event.power / 40000);
        this.alarm.addImpulse(
          event.origin.x,
          event.origin.z,
          Math.max(0.35, power),
          Math.max(30, event.range * 1.6)
        );
        this.applyShockwave(
          event.origin,
          event.direction,
          event.range,
          event.angle,
          power,
          INTENT_LETHALITY[event.intent] ?? 1,
          byPlayer,
          event.sourceId
        );
      }),

      // A piece of a building came off. It is falling on somebody.
      bus.on('ChunkDetached', (event) => {
        this.debris.push({
          x: event.position.x,
          y: event.position.y,
          z: event.position.z,
          mass: event.mass,
        });
        if (this.debris.length > 64) this.debris.shift();
        const severity = clamp01(event.mass / 6000);
        this.alarm.addImpulse(event.position.x, event.position.z, 0.25 + severity * 0.5, 22 + severity * 40);
        this.applyRadialDamage(
          event.position,
          4 + severity * 7,
          6 + severity * 30,
          this.collateralTimer > 0
        );
      }),

      bus.on('PlayerLanded', (event) => {
        if (!event.createsCrater) return;
        this.collateralTimer = COLLATERAL_WINDOW;
        const severity = clamp01(event.impactSpeed / 90);
        this.alarm.addImpulse(event.position.x, event.position.z, 0.4 + severity * 0.5, 30 + severity * 60);
      }),

      // An encounter is a threat with a position but no live entity yet. Seed
      // the field from it so a district starts emptying before the monster has
      // finished its entrance.
      bus.on('EncounterStarted', (event) => {
        this.alarm.addImpulse(event.position.x, event.position.z, tierIntensity(event.threatTier), event.radius);
      }),

      // Something died. If it was a monster and the player did it, everyone
      // still frightened nearby is about to be credited as a rescue.
      bus.on('EntityKilled', (event) => {
        if (event.faction !== 'monster') return;
        const byPlayer = this.playerId !== undefined && event.killerId === this.playerId;
        if (!byPlayer) return;
        this.creditRescueNear(event.position, SIGHT_RANGE);
      })
    );
  }

  /* ------------------------------------------------------------------ */
  /* Damage                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve a cone against the crowd.
   *
   * The crowd damages ITSELF from the event rather than waiting to be told,
   * because the combat system has no handle on these agents — they are typed
   * arrays, not entities it can look up. This is what the bus is for: combat
   * says what happened, and every system decides what that means for the
   * things it owns.
   */
  private applyShockwave(
    origin: Vec3,
    direction: Vec3,
    range: number,
    angle: number,
    power01: number,
    lethality: number,
    byPlayer: boolean,
    sourceId: EntityId | undefined
  ): void {
    const cos = Math.cos(Math.min(angle, Math.PI));
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0 || this.agents.health[i]! <= 0) continue;
      const dx = this.agents.posX[i]! - origin.x;
      const dz = this.agents.posZ[i]! - origin.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > range) continue;
      if (distance > 1e-3 && angle < Math.PI) {
        const dot = (dx * direction.x + dz * direction.z) / distance;
        if (dot < cos) continue;
      }
      // The edge of a cone bruises and the middle of one is not survivable.
      // A civilian has twelve hit points, so at `full` intent this reaches
      // lethal well past forty metres — which is the entire point. Restraint
      // is the resource this game is actually about, and it only reads as one
      // if the alternative is a street full of bodies.
      const falloff = 1 - distance / range;
      const damage = power01 * 120 * lethality * Math.pow(falloff, 1.6);
      if (damage < 0.5) continue;
      this.damageAgent(i, damage, byPlayer, sourceId);
    }

    this.applyShockwaveToAllies(origin, direction, range, cos, power01, lethality, sourceId);
  }

  /**
   * The same cone against the allies.
   *
   * They have hundreds of hit points rather than twelve, so the same wave that
   * flattens a street bruises Genos — which is the point. He is supposed to
   * survive the first few and lose anyway, slowly, in front of you.
   *
   * Friendly fire is OFF: a shockwave whose source is the player or another
   * ally passes straight through them. Not because it would be unrealistic,
   * but because the protagonist's whole problem is that he cannot hold back
   * usefully, and a system where walking into a fight kills the person you
   * came to help turns the allies into a hazard to route around instead of
   * people to save.
   */
  private applyShockwaveToAllies(
    origin: Vec3,
    direction: Vec3,
    range: number,
    cos: number,
    power01: number,
    lethality: number,
    sourceId: EntityId | undefined
  ): void {
    if (sourceId !== undefined && sourceId === this.playerId) return;
    for (const hero of this.heroes) {
      if (hero.isDead || hero.id === sourceId) continue;
      const dx = hero.transform.position.x - origin.x;
      const dz = hero.transform.position.z - origin.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > range) continue;
      if (distance > 1e-3 && cos > -1) {
        const dot = (dx * direction.x + dz * direction.z) / distance;
        if (dot < cos) continue;
      }
      const falloff = 1 - distance / range;
      const damage = power01 * ALLY_SHOCKWAVE_DAMAGE * lethality * Math.pow(falloff, 1.4);
      if (damage < 1) continue;
      hero.takeDamage(damage);
    }
  }

  private applyRadialDamage(origin: Vec3, radius: number, peak: number, byPlayer: boolean): void {
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0 || this.agents.health[i]! <= 0) continue;
      const dx = this.agents.posX[i]! - origin.x;
      const dz = this.agents.posZ[i]! - origin.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > radius) continue;
      const falloff = 1 - distance / radius;
      this.damageAgent(i, peak * falloff, byPlayer, undefined);
    }
  }

  /**
   * Hurt one civilian. The single path by which a civilian's health changes.
   *
   * @returns Damage actually applied.
   */
  damageAgent(index: number, amount: number, causedByPlayer: boolean, attacker?: EntityId): number {
    const agents = this.agents;
    if (agents.active[index] === 0 || amount <= 0) return 0;
    const before = agents.health[index]!;
    if (before <= 0) return 0;
    const dealt = Math.min(before, amount);
    agents.health[index] = before - dealt;
    if (causedByPlayer) this.killedByPlayer[index] = 1;

    const position = { x: agents.posX[index]!, y: 0.9, z: agents.posZ[index]! };
    if (agents.health[index]! > 0) {
      this.bus?.emit('EntityDamaged', {
        entityId: agents.idOf(index),
        entityType: 'npc',
        faction: 'civilian',
        amount: dealt,
        damageType: 'blunt',
        intent: causedByPlayer ? 'serious' : 'normal',
        healthRemaining: agents.health[index]!,
        maxHealth: agents.maxHealth[index]!,
        point: position,
        attackerId: attacker,
        critical: false,
      });
      return dealt;
    }

    // Death. Emit the kill and the loss together, and record who watched.
    agents.setMood(index, MOOD_DOWN);
    agents.velX[index] = 0;
    agents.velZ[index] = 0;
    this.deadTimer[index] = 0;
    this.bus?.emit('EntityKilled', {
      entityId: agents.idOf(index),
      entityType: 'npc',
      faction: 'civilian',
      position,
      killerId: attacker,
      intent: causedByPlayer ? 'serious' : 'normal',
      rewardPoints: 0,
    });
    const witness = gatherWitnesses(
      agents,
      this.obstacles,
      position.x,
      position.z,
      this.playerRegistered ? this.player : undefined,
      index
    );
    this.ledger.record(
      this.bus,
      'lost',
      agents.idOf(index),
      position,
      causedByPlayer || this.killedByPlayer[index] === 1,
      witness,
      agents.peakAlarm[index]!,
      this.elapsed
    );
    return dealt;
  }

  /** Mark every frightened civilian near a point as owing their life to the player. */
  private creditRescueNear(position: Vec3, radius: number): void {
    const radiusSq = radius * radius;
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0 || this.agents.health[i]! <= 0) continue;
      if (this.agents.peakAlarm[i]! < ENDANGERED_ALARM) continue;
      const dx = this.agents.posX[i]! - position.x;
      const dz = this.agents.posZ[i]! - position.z;
      if (dx * dx + dz * dz > radiusSq) continue;
      this.rescuedByPlayer[i] = 1;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                              */
  /* ------------------------------------------------------------------ */

  update(dt: number): void {
    if (this.disposed) return;
    const started = performance.now();
    this.elapsed += dt;
    this.collateralTimer = Math.max(0, this.collateralTimer - dt);

    this.alarm.update(dt, this.threats);
    this.flow.update(dt, this.obstacles, this.threats);

    this.updatePopulation();

    for (const body of this.nearBodies.values()) body.think(dt);

    this.avoidBodies.length = 0;
    for (const hero of this.heroes) {
      if (hero.isDead) continue;
      this.avoidBodies.push({
        x: hero.transform.position.x,
        z: hero.transform.position.z,
        radius: hero.radius,
        layer: LAYER_HERO,
      });
    }
    for (const threat of this.threats) {
      this.avoidBodies.push({
        x: threat.position.x,
        z: threat.position.z,
        // Monsters are big and civilians give them a very wide berth. This is
        // avoidance radius, not collision radius: the flee field already points
        // away, and this stops the few who are gawking from standing on its foot.
        radius: 3.5,
        layer: LAYER_THREAT,
      });
    }
    if (this.playerRegistered) {
      this.avoidBodies.push({ x: this.player.x, z: this.player.z, radius: 0.55, layer: LAYER_PLAYER });
    }

    this.steering.update(this.agents, dt, this.alarm, this.flow, this.obstacles, this.avoidBodies);

    for (const hero of this.heroes) hero.update(dt);

    this.resolveOutcomes(dt);

    if (this.renderer !== undefined) {
      this.nearSkip.clear();
      for (const index of this.nearBodies.keys()) this.nearSkip.add(index);
      for (const body of this.nearBodies.values()) body.present(dt);
      this.renderer.update(this.agents, dt, this.nearSkip);
    }

    this.farTimer -= dt;
    if (this.farTimer <= 0 || this.farCache < 0) {
      this.farTimer = FAR_POPULATION_INTERVAL;
      this.farCache = this.playerRegistered ? this.computeFarPopulation() : 0;
    }

    this.simMs = performance.now() - started;
    this.stats = this.buildStats();
  }

  /* ------------------------------------------------------------------ */
  /* Population                                                         */
  /* ------------------------------------------------------------------ */

  private updatePopulation(): void {
    const anchorDx = this.player.x - this.spawnAnchor.x;
    const anchorDz = this.player.z - this.spawnAnchor.z;
    if (anchorDx * anchorDx + anchorDz * anchorDz > SPAWN_ANCHOR_DRIFT * SPAWN_ANCHOR_DRIFT) {
      this.spawnPointsDirty = true;
    }
    if (this.spawnPointsDirty) this.rebuildSpawnPoints();

    const nearIn = NEAR_RADIUS - TIER_HYSTERESIS;
    const nearOut = NEAR_RADIUS + TIER_HYSTERESIS;
    const midOut = MID_RADIUS + TIER_HYSTERESIS * 3;

    // PASS 1: cull out-of-band agents and demote anyone who left the near
    // radius, counting who is left in it.
    let alive = 0;
    let nearCount = 0;
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0) continue;
      const dx = this.agents.posX[i]! - this.player.x;
      const dz = this.agents.posZ[i]! - this.player.z;
      const distance = Math.sqrt(dx * dx + dz * dz);

      if (distance > midOut) {
        // Out of band. A civilian who walked off the edge of the simulation
        // was not saved and was not lost; they simply stopped being our
        // problem, and crediting a save here would let the player farm
        // reputation by walking away.
        this.releaseAgent(i);
        continue;
      }

      alive++;
      if (this.agents.tier[i] === TIER_NEAR) {
        if (distance > nearOut) {
          this.agents.tier[i] = TIER_MID;
          this.detachBody(i);
        } else {
          nearCount++;
        }
      }
    }

    // PASS 2: promote into whatever near budget is left. Two passes and not
    // one, because a single pass makes the promotion decision for agent 3
    // before it knows that agents 200 to 215 are already near — and the cap is
    // a hard budget on skeletons, not a suggestion.
    for (let i = 0; i < this.agents.extent && nearCount < this.caps.near; i++) {
      if (this.agents.active[i] === 0 || this.agents.tier[i] !== TIER_MID) continue;
      const dx = this.agents.posX[i]! - this.player.x;
      const dz = this.agents.posZ[i]! - this.player.z;
      if (dx * dx + dz * dz > nearIn * nearIn) continue;
      this.agents.tier[i] = TIER_NEAR;
      nearCount++;
    }

    // Fill the band back up. One spawn per frame at most when the crowd is
    // nearly full, so a player teleporting across the city does not pay for
    // 250 spawns in one frame.
    const want = this.caps.mid;
    let budget = alive < want * 0.5 ? 24 : 4;
    while (alive < want && budget-- > 0) {
      if (this.spawnOne() < 0) break;
      alive++;
    }

    this.ensureNearBodies();
  }

  /** Give a near-tier agent a real body, at most one build per frame. */
  private ensureNearBodies(): void {
    if (this.headless) return;
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0) continue;
      if (this.agents.tier[i] !== TIER_NEAR) continue;
      if (this.nearBodies.has(i)) continue;
      const body = this.acquireBody(i);
      if (body === undefined) return;
      this.nearBodies.set(i, body);
      // One per frame. Building a civilian mesh is ~10 ms; doing sixteen in the
      // frame the player rounds a corner is a 160 ms stall, which is a far
      // worse artefact than a pedestrian who is instanced for a few more
      // frames than strictly necessary.
      return;
    }
  }

  private acquireBody(index: number): NearCivilian | undefined {
    const recycled = this.freeBodies.pop();
    if (recycled !== undefined) {
      recycled.rebind(this.agents.idOf(index), index);
      this.group.add(recycled.root);
      return recycled;
    }
    if (this.bodiesBuilt >= this.caps.near) return undefined;
    this.bodiesBuilt++;

    // LOD1 for the near tier: LOD0 is a hero budget and these are extras, but
    // at under forty metres LOD2's 452 triangles show their silhouette.
    const seed = this.agents.seed[index]!;
    const profile = civilianProfile(seed);
    const options = civilianOptions(profile, 1);
    const build = buildHumanoid(profile, options);
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.82,
      metalness: 0.02,
    });
    const parts = createCharacterParts(build, material);
    const animator = new ProceduralAnimator(parts, parts.root, {
      seed,
      // Every civilian idle in this game is the civilian variant. The default
      // idle is a combat-ready neutral and reads wrong on somebody carrying
      // shopping.
      variants: { idle: 'civilian' },
    });
    const body = new NearCivilian(this.agents.idOf(index), parts, animator, this.civilianHost(), index);
    this.group.add(body.root);
    return body;
  }

  private detachBody(index: number): void {
    const body = this.nearBodies.get(index);
    if (body === undefined) return;
    this.nearBodies.delete(index);
    body.detach();
    body.root.removeFromParent();
    this.freeBodies.push(body);
  }

  private releaseAgent(index: number): void {
    this.detachBody(index);
    this.safeTimer[index] = 0;
    this.deadTimer[index] = 0;
    this.rescuedByPlayer[index] = 0;
    this.killedByPlayer[index] = 0;
    this.agents.despawn(index);
  }

  /**
   * Spawn one civilian somewhere plausible in the band.
   *
   * Spawn points come from the streaming system when it is running (the layout
   * generator already places actors on pavements) and are derived from the
   * walkable field otherwise, so the crowd works in a bare harness with no
   * streaming at all.
   */
  private spawnOne(): number {
    if (this.spawnPoints.length === 0) return -1;
    // Walk the shuffled list rather than sampling: sampling repeats, and a
    // repeated spawn point puts two civilians inside each other, which the
    // separation pass then has to blow apart in full view.
    for (let attempt = 0; attempt < 24; attempt++) {
      const point = this.spawnPoints[this.spawnCursor % this.spawnPoints.length]!;
      this.spawnCursor++;
      const dx = point.x - this.player.x;
      const dz = point.z - this.player.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance > MID_RADIUS || distance < 2) continue;
      const seed = this.spawnRng.nextUint32();
      const index = this.agents.spawn(seed, point.x, point.z, point.yaw, TIER_MID);
      if (index < 0) return -1;
      this.safeTimer[index] = 0;
      this.deadTimer[index] = 0;
      this.rescuedByPlayer[index] = 0;
      this.killedByPlayer[index] = 0;
      return index;
    }
    return -1;
  }

  /**
   * Rebuild the band-local spawn list from chunk slots, or from open ground.
   *
   * Streaming's `ISpawnLayout` points are preferred when they exist — the
   * layout generator already put them on pavements, facing sensible ways. The
   * open-ground fallback is what lets this system run in a bare harness with no
   * streaming attached at all, which is how it was developed.
   */
  private rebuildSpawnPoints(): void {
    this.spawnPointsDirty = false;
    this.spawnPoints.length = 0;
    this.spawnCursor = 0;
    this.spawnAnchor.x = this.player.x;
    this.spawnAnchor.z = this.player.z;

    const reach = MID_RADIUS - SPAWN_MARGIN;
    const reachSq = reach * reach;
    const inBand = (x: number, z: number): boolean => {
      const dx = x - this.player.x;
      const dz = z - this.player.z;
      const d = dx * dx + dz * dz;
      return d <= reachSq && d > 9;
    };

    for (const slots of this.chunkSlots.values()) {
      for (const slot of slots) {
        if (!inBand(slot.x, slot.z)) continue;
        if (!this.obstacles.isWalkable(slot.x, slot.z, 0.4)) continue;
        this.spawnPoints.push({ x: slot.x, z: slot.z, yaw: slot.rotationY });
      }
    }

    if (this.spawnPoints.length === 0) {
      // One point per open field cell in the band, jittered off the cell
      // centre so a freshly-populated street does not appear on a visible 12 m
      // lattice. The RNG is derived from the ANCHOR, not advanced from a
      // running stream: the same player position must rebuild the same list
      // however many times it is rebuilt.
      const rng = createRng(this.seed).derive(
        `spawn-grid:${Math.round(this.spawnAnchor.x)}:${Math.round(this.spawnAnchor.z)}`
      );
      const gx0 = cellX(this.player.x - reach);
      const gx1 = cellX(this.player.x + reach);
      const gz0 = cellZ(this.player.z - reach);
      const gz1 = cellZ(this.player.z + reach);
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const i = gz * FIELD_DIM + gx;
          if (!this.obstacles.isWalkableCell(i)) continue;
          const x = cellCentreX(gx) + rng.range(-4.5, 4.5);
          const z = cellCentreZ(gz) + rng.range(-4.5, 4.5);
          if (!inBand(x, z)) continue;
          if (!this.obstacles.isWalkable(x, z, 0.5)) continue;
          this.spawnPoints.push({ x, z, yaw: rng.range(-Math.PI, Math.PI) });
        }
      }
    }

    // Shuffle so the cursor does not fill the band in raster order, which
    // would put every new civilian on the northern edge of the simulation.
    const shuffle = createRng(this.seed).derive('spawn-order');
    for (let i = this.spawnPoints.length - 1; i > 0; i--) {
      const j = shuffle.int(0, i);
      const tmp = this.spawnPoints[i]!;
      this.spawnPoints[i] = this.spawnPoints[j]!;
      this.spawnPoints[j] = tmp;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Outcomes                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Decide who got away and who is still lying there.
   *
   * A save requires three things and all three matter:
   *   1. they were ACTUALLY in danger once (`peakAlarm >= ENDANGERED_ALARM`),
   *      so walking a calm pedestrian across a street is not a rescue;
   *   2. they are calm NOW;
   *   3. they have been calm for `SAFE_DWELL`, so a civilian crossing a quiet
   *      cell in the middle of a panic does not bank a save mid-sprint.
   */
  private resolveOutcomes(dt: number): void {
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0) continue;

      if (this.agents.health[i]! <= 0) {
        this.deadTimer[i] = this.deadTimer[i]! + dt;
        if (this.deadTimer[i]! > CORPSE_SECONDS) this.releaseAgent(i);
        continue;
      }

      // The player standing next to a frightened civilian is doing something,
      // even if the game has no verb for it yet: they are between them and it.
      if (
        this.playerRegistered &&
        this.agents.peakAlarm[i]! >= ENDANGERED_ALARM &&
        this.rescuedByPlayer[i] === 0
      ) {
        const dx = this.agents.posX[i]! - this.player.x;
        const dz = this.agents.posZ[i]! - this.player.z;
        if (dx * dx + dz * dz < RESCUE_RADIUS * RESCUE_RADIUS) this.rescuedByPlayer[i] = 1;
      }

      if (this.agents.peakAlarm[i]! < ENDANGERED_ALARM) continue;
      if (this.agents.alarm[i]! > SAFE_ALARM) {
        this.safeTimer[i] = 0;
        continue;
      }
      this.safeTimer[i] = this.safeTimer[i]! + dt;
      if (this.safeTimer[i]! < SAFE_DWELL) continue;

      const position = { x: this.agents.posX[i]!, y: 0.9, z: this.agents.posZ[i]! };
      const witness = gatherWitnesses(
        this.agents,
        this.obstacles,
        position.x,
        position.z,
        this.playerRegistered ? this.player : undefined,
        i
      );
      this.ledger.record(
        this.bus,
        'saved',
        this.agents.idOf(i),
        position,
        this.rescuedByPlayer[i] === 1,
        witness,
        this.agents.peakAlarm[i]!,
        this.elapsed
      );
      // Reset rather than despawn: they are still standing there, and the same
      // person can be endangered and saved again when the next monster turns
      // up. Despawning them would make a rescued civilian vanish in front of
      // the player who just rescued them.
      this.agents.peakAlarm[i] = 0;
      this.safeTimer[i] = 0;
      this.rescuedByPlayer[i] = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Seams                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * The near tier's view of this system.
   *
   * Getters rather than a snapshot: a `NearCivilian` is recycled across many
   * agents and lives for as long as the system does, so anything it captured
   * by value at construction would be stale within a second.
   */
  private civilianHost(): ICivilianHost {
    return {
      agents: this.agents,
      now: () => this.elapsed,
      playerPosition: () => (this.playerRegistered ? this.player : undefined),
      damageAgent: (index, amount, causedByPlayer, attacker) =>
        this.damageAgent(index, amount, causedByPlayer, attacker),
    };
  }

  private heroWorld(): IHeroWorld {
    return {
      bus: this.bus,
      now: () => this.elapsed,
      // Arrays are handed over by REFERENCE and mutated in place, so allies
      // always see the current threat and debris sets without a per-frame
      // copy. Rebuilding these lists each frame would allocate on every tick
      // of a system that is meant to be allocation-free once warm.
      threats: this.threats,
      playerPosition: () => (this.playerRegistered ? this.player : undefined),
      debris: this.debris,
      hasLineOfSight: (ax, az, bx, bz) => this.obstacles.segmentClear(ax, az, bx, bz, 200),
      seedAlarm: (x, z, intensity, radius) => this.alarm.addImpulse(x, z, intensity, radius),
      say: (callout) => {
        this.callouts.push(callout);
        if (this.callouts.length > 32) this.callouts.shift();
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Telemetry                                                          */
  /* ------------------------------------------------------------------ */

  /** Stats from the last `update`. */
  get lastStats(): ICrowdStats {
    return this.stats;
  }

  /** Ally status for the HUD. */
  allyStatus(): IHeroStatus[] {
    return this.heroes.map((hero) => hero.status());
  }

  /** Outcomes recorded so far. */
  get outcomes(): readonly ICivilianOutcome[] {
    return this.ledger.recent;
  }

  /**
   * Estimated population outside the simulated band.
   *
   * Not simulated and never will be — this is the number the crowd ambience
   * bed scales its density by. Derived from open ground rather than invented:
   * a player standing in a park hears fewer people than one standing in a
   * downtown intersection, and that falls out of counting walkable cells.
   *
   * CACHED at 1 Hz. The count walks all 16,384 field cells, and doing that
   * every frame to feed an ambience crossfade was costing more than the entire
   * steering pass for 250 agents. The number it produces changes on the scale
   * of a player walking a block.
   */
  get farPopulation(): number {
    if (!this.playerRegistered) return 0;
    if (this.farCache < 0) this.farCache = this.computeFarPopulation();
    return this.farCache;
  }

  private computeFarPopulation(): number {
    let open = 0;
    const inner = MID_RADIUS * MID_RADIUS;
    const outer = FAR_RADIUS * FAR_RADIUS;
    for (let gz = 0; gz < FIELD_DIM; gz++) {
      const dz = cellCentreZ(gz) - this.player.z;
      for (let gx = 0; gx < FIELD_DIM; gx++) {
        const i = gz * FIELD_DIM + gx;
        if (!this.obstacles.isWalkableCell(i)) continue;
        const dx = cellCentreX(gx) - this.player.x;
        const d = dx * dx + dz * dz;
        if (d < inner || d > outer) continue;
        open++;
      }
    }
    return Math.round(open * FAR_PEOPLE_PER_CELL);
  }

  private buildStats(): ICrowdStats {
    const moods: Record<CivilianMood, number> = {
      commute: 0,
      gawk: 0,
      flee: 0,
      cower: 0,
      down: 0,
    };
    let near = 0;
    let mid = 0;
    let peak = 0;
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0) continue;
      if (this.agents.tier[i] === TIER_NEAR) near++;
      else mid++;
      moods[MOOD_NAMES[this.agents.mood[i]!]!]++;
      if (this.agents.alarm[i]! > peak) peak = this.agents.alarm[i]!;
    }
    const far = this.farPopulation;
    return {
      near,
      mid,
      far,
      total: near + mid,
      moods,
      // Density is what the street SOUNDS like: how many people are within
      // earshot, normalised. Panic is a separate cue and belongs to the audio
      // system's own event mapping, not here.
      density: clamp01((near + mid) / Math.max(1, this.caps.mid)),
      peakAlarm: peak,
      simMs: this.simMs,
      alarmMs: this.alarm.lastTickMs,
      flowMs: this.flow.lastRebuildMs,
      saved: this.ledger.saved,
      lost: this.ledger.lost,
      witnessedSaves: this.ledger.witnessed,
    };
  }

  /** Fraction of simulated civilians currently running or curled up. */
  get panicFraction(): number {
    let panicking = 0;
    let total = 0;
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0) continue;
      total++;
      const mood = this.agents.mood[i]!;
      if (mood === MOOD_FLEE || mood === MOOD_COWER) panicking++;
    }
    return total === 0 ? 0 : panicking / total;
  }

  /** Fraction of simulated civilians standing there filming. */
  get gawkFraction(): number {
    let gawkers = 0;
    let total = 0;
    for (let i = 0; i < this.agents.extent; i++) {
      if (this.agents.active[i] === 0) continue;
      total++;
      if (this.agents.mood[i] === MOOD_GAWK) gawkers++;
    }
    return total === 0 ? 0 : gawkers / total;
  }

  /** Order-independent hash of the whole simulation, for determinism tests. */
  hash(): number {
    let h = this.agents.hash();
    h = Math.imul(h ^ this.alarm.hash(), 0x01000193) >>> 0;
    for (const hero of this.heroes) {
      h = Math.imul(h ^ Math.round(hero.health * 100), 0x01000193) >>> 0;
      h = Math.imul(h ^ Math.round(hero.transform.position.x * 1000), 0x01000193) >>> 0;
      h = Math.imul(h ^ Math.round(hero.transform.position.z * 1000), 0x01000193) >>> 0;
      h = Math.imul(h ^ hero.reEngagements, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    for (const body of this.nearBodies.values()) body.dispose();
    for (const body of this.freeBodies) body.dispose();
    this.nearBodies.clear();
    this.freeBodies.length = 0;
    for (const hero of this.heroes) hero.dispose();
    this.heroes.length = 0;
    this.renderer?.dispose();
    this.group.removeFromParent();
    this.agents.clear();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** How frightening a monster of each tier is, 0..1. */
function tierIntensity(tier: string): number {
  switch (tier) {
    case 'god':
      return 1;
    case 'dragon':
      return 0.95;
    case 'demon':
      return 0.8;
    case 'tiger':
      return 0.6;
    default:
      return 0.42;
  }
}

/** A threat source built from a plain position. Convenience for callers. */
export function makeThreat(
  id: EntityId,
  position: THREE.Vector3,
  intensity: number,
  tier?: IThreatSource['tier']
): IThreatSource {
  return { id, position, intensity, tier };
}

/** Chunk index a world position falls in, matching the streaming convention. */
export function chunkIndexForCrowd(x: number, z: number): number {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  return (cz + 8) * 16 + (cx + 8);
}

function emptyStats(): ICrowdStats {
  return {
    near: 0,
    mid: 0,
    far: 0,
    total: 0,
    moods: { commute: 0, gawk: 0, flee: 0, cower: 0, down: 0 },
    density: 0,
    peakAlarm: 0,
    simMs: 0,
    alarmMs: 0,
    flowMs: 0,
    saved: 0,
    lost: 0,
    witnessedSaves: 0,
  };
}
