/**
 * SHARED TEST FIXTURES
 *
 * Everything the combat tests need to build a fight: a recording bus, a
 * scriptable attacker, and a City Z street corner populated with a monster, a
 * crowd, an ally and a row of buildings.
 */

import type { EntityId, GameEvent, GameEventType, Vec3 } from '@/types';
import { EventBus } from '@/util';
import { aabbFromCentre } from '../cone';
import { CombatSystem, type ICombatSystemOptions } from '../combat-system';
import type { IAttackerSource, IMutableVec3 } from '../types';

/* -------------------------------------------------------------------------- */
/* Recording bus                                                              */
/* -------------------------------------------------------------------------- */

/** An `EventBus` that keeps every event, in order, for sequence assertions. */
export class RecordingBus extends EventBus {
  readonly events: GameEvent[] = [];

  constructor() {
    super();
    this.onAny((event) => this.events.push(event));
  }

  /** Just the `type` strings, in emission order. */
  types(): GameEventType[] {
    return this.events.map((event) => event.type);
  }

  /** Every event of one type, narrowed. */
  ofType<T extends GameEventType>(type: T): Extract<GameEvent, { type: T }>[] {
    return this.events.filter((event): event is Extract<GameEvent, { type: T }> => {
      return event.type === type;
    });
  }

  /** A stable, comparable transcript — the determinism assertion's subject. */
  transcript(): string {
    return JSON.stringify(this.events);
  }

  reset(): void {
    this.events.length = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Attacker                                                                   */
/* -------------------------------------------------------------------------- */

/** A punch origin and facing a test can move around by hand. */
export class ScriptedAttacker implements IAttackerSource {
  readonly id: EntityId;
  origin: Vec3 = { x: 0, y: 1.4, z: 0 };
  facing: Vec3 = { x: 0, y: 0, z: -1 };

  constructor(id: EntityId = 'saitama') {
    this.id = id;
  }

  getOrigin(out: IMutableVec3): void {
    out.x = this.origin.x;
    out.y = this.origin.y;
    out.z = this.origin.z;
  }

  getFacing(out: IMutableVec3): void {
    out.x = this.facing.x;
    out.y = this.facing.y;
    out.z = this.facing.z;
  }

  moveTo(x: number, y: number, z: number): void {
    this.origin = { x, y, z };
  }

  faceTowards(x: number, y: number, z: number): void {
    const dx = x - this.origin.x;
    const dy = y - this.origin.y;
    const dz = z - this.origin.z;
    const length = Math.hypot(dx, dy, dz) || 1;
    this.facing = { x: dx / length, y: dy / length, z: dz / length };
  }
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

/** A combat system plus the bus and attacker it was built on. */
export interface ITestScene {
  readonly bus: RecordingBus;
  readonly attacker: ScriptedAttacker;
  readonly combat: CombatSystem;
}

/** A combat system with nothing registered. */
export function createScene(options: Partial<ICombatSystemOptions> = {}): ITestScene {
  const bus = new RecordingBus();
  const attacker = new ScriptedAttacker();
  const combat = new CombatSystem({ bus, attacker, seed: 'test-seed', ...options });
  return { bus, attacker, combat };
}

/**
 * A street corner in City Z.
 *
 *   monster    a demon-tier threat 8 m north of the player
 *   boss       a dragon-tier boss 30 m north, phase UNRESOLVED
 *   crowd      six civilians strung along the pavement out to 45 m
 *   ally       Mumen Rider, 6 m east, with real hit points
 *   buildings  three blocks of frontage along the north side
 *
 * The geometry is chosen so a normal punch reaches only the monster, and a
 * half-charged serious punch reaches the boss, the buildings and most of the
 * crowd — i.e. so the two verbs produce visibly different scorecards.
 */
export function populateStreet(scene: ITestScene): void {
  const { combat } = scene;

  combat.addTarget({
    id: 'monster-01',
    type: 'monster',
    faction: 'monster',
    position: { x: 0, y: 1, z: -8 },
    radius: 1.1,
    massKg: 400,
    maxHealth: 4000,
    threatTier: 'demon',
    specId: 'mosquito-girl',
    rewardPoints: 120,
    displayName: 'Mosquito Girl',
  });

  combat.addTarget({
    id: 'boss-01',
    type: 'monster',
    faction: 'monster',
    position: { x: 0, y: 2, z: -30 },
    radius: 2.4,
    massKg: 2600,
    maxHealth: 100_000,
    threatTier: 'dragon',
    specId: 'deep-sea-king',
    isBoss: true,
    phaseResolved: false,
    rewardPoints: 4000,
    displayName: 'Deep Sea King',
  });

  for (let i = 0; i < 6; i++) {
    combat.addTarget({
      id: `civ-${i}`,
      type: 'npc',
      faction: 'civilian',
      position: { x: (i % 2 === 0 ? 1 : -1) * 2.5, y: 1, z: -6 - i * 7 },
      radius: 0.42,
      massKg: 68,
      maxHealth: 30,
      displayName: `Citizen ${i}`,
    });
  }

  combat.addTarget({
    id: 'mumen-rider',
    type: 'hero',
    faction: 'hero',
    position: { x: 6, y: 1, z: -2 },
    radius: 0.5,
    massKg: 72,
    maxHealth: 90,
    displayName: 'Mumen Rider',
  });

  for (let i = 0; i < 3; i++) {
    combat.addStructure({
      id: `block-${i}`,
      bounds: aabbFromCentre(0, 12, -24 - i * 40, 18, 12, 14),
      massKg: 900_000,
      district: 'downtown',
    });
  }
}

/** Every id currently registered as a hostile in the street scene. */
export const STREET_HOSTILES: readonly EntityId[] = Object.freeze(['monster-01', 'boss-01']);
