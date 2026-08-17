/**
 * TEST FIXTURES
 *
 * A recording bus, a bodiless monster, and — the important one — a faithful
 * MIRROR of the combat resolver's kill branch.
 *
 * ── WHY MIRROR IT INSTEAD OF IMPORTING IT ─────────────────────────────────
 * `src/entities/monster` may not import `@/gameplay/combat`; that rule is
 * enforced by `imports.test.ts` and it is the reason both workstreams could be
 * built at the same time. So the unit tests check the gate against a copy of
 * the branch, transcribed below, and `harness/monster.ts` checks the SAME
 * assertions against the REAL `HitResolver` — which the harness is allowed to
 * import because it is not part of either module.
 *
 * If the two ever disagree, the harness is right and this file is stale.
 */

import { EventBus } from '@/util';
import type { GameEvent, GameEventOf, GameEventType, IEventBus, LethalIntent } from '@/types';
import { MonsterBrain } from '../brain';
import { monsterArchetype } from '../archetypes';
import { createRng } from '@/util';
import type { IMonsterTarget, Vec3 } from '../types';

/* -------------------------------------------------------------------------- */
/* Recording bus                                                              */
/* -------------------------------------------------------------------------- */

export interface IRecordingBus {
  readonly bus: IEventBus;
  readonly events: GameEvent[];
  ofType<T extends GameEventType>(type: T): GameEventOf<T>[];
  clear(): void;
}

export function recordingBus(): IRecordingBus {
  const bus = new EventBus();
  const events: GameEvent[] = [];
  bus.onAny((event) => events.push(event));
  return {
    bus,
    events,
    ofType<T extends GameEventType>(type: T): GameEventOf<T>[] {
      return events.filter((e): e is GameEventOf<T> => e.type === type);
    },
    clear(): void {
      events.length = 0;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Brains                                                                     */
/* -------------------------------------------------------------------------- */

export function makeBrain(
  archetypeId: string,
  bus: IEventBus,
  position: Vec3 = { x: 0, y: 0, z: 0 },
  id = `${archetypeId}#test`
): MonsterBrain {
  return new MonsterBrain({
    id,
    archetype: monsterArchetype(archetypeId),
    bus,
    rng: createRng(id),
    position,
  });
}

/** A perceivable target the brain can chase. Position is mutable. */
export function makeTarget(
  id: string,
  x: number,
  z: number,
  overrides: Partial<Omit<IMonsterTarget, 'id' | 'position'>> = {}
): IMonsterTarget & { position: { x: number; y: number; z: number } } {
  return {
    id,
    faction: overrides.faction ?? 'hero',
    position: { x, y: 0, z },
    alive: overrides.alive ?? true,
    priority: overrides.priority ?? 1,
  };
}

/* -------------------------------------------------------------------------- */
/* The mirrored kill branch                                                   */
/* -------------------------------------------------------------------------- */

/** The minimum a target needs for the gate branch. Mirrors `ICombatTarget`. */
export interface IMirrorTarget {
  readonly isBoss: boolean;
  phaseResolved: boolean;
  health: number;
  dead: boolean;
}

/** What a mirrored punch did. Mirrors `ICombatHit`'s three relevant fields. */
export interface IMirrorHit {
  readonly killed: boolean;
  readonly instantKill: boolean;
  readonly phaseGated: boolean;
  readonly damage: number;
}

/**
 * A transcription of `HitResolver.resolveOne`'s kill branch, verbatim:
 *
 *     const lethal = isLethalIntent(punch.intent);   // intent !== 'restrained'
 *     const gated  = target.isBoss && !target.phaseResolved;
 *
 *     if (gated)       → chip damage, floored at 1 health, NOT killed
 *     else if (lethal) → health = 0, dead = true, INSTANT KILL
 *     else             → restrained: a real, small, survivable number
 *
 * `bossPhaseChipDamage` ships at 0, so a gated boss loses nothing at all.
 */
export function mirrorPunch(
  target: IMirrorTarget,
  intent: LethalIntent = 'normal',
  chipDamage = 0,
  restrainedDamage = 8
): IMirrorHit {
  const lethal = intent !== 'restrained';
  const gated = target.isBoss && !target.phaseResolved;

  if (gated) {
    const damage = Math.min(chipDamage, Math.max(0, target.health - 1));
    target.health -= damage;
    return { killed: false, instantKill: false, phaseGated: true, damage };
  }
  if (lethal) {
    target.health = 0;
    target.dead = true;
    return { killed: true, instantKill: true, phaseGated: false, damage: 0 };
  }
  target.health = Math.max(0, target.health - restrainedDamage);
  const killed = target.health <= 0;
  if (killed) target.dead = true;
  return { killed, instantKill: false, phaseGated: false, damage: restrainedDamage };
}

/** A mirror target built from a brain, so the two stay in step. */
export function mirrorOf(brain: MonsterBrain): IMirrorTarget {
  return {
    isBoss: brain.archetype.isBoss,
    get phaseResolved(): boolean {
      return brain.phaseResolved;
    },
    set phaseResolved(value: boolean) {
      brain.phaseResolved = value;
    },
    get health(): number {
      return brain.health;
    },
    set health(value: number) {
      brain.health = value;
    },
    dead: false,
  };
}
