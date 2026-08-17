/**
 * SHARED TEST SUPPORT
 *
 * Event payload builders and a deterministic scripted-run driver. Everything
 * uses `createRng` from `@/util` — `Math.random()` is banned, and a
 * progression test that could not be replayed exactly would be worthless as a
 * regression net.
 */

import type { IEventBus, ThreatTier, Vec3 } from '@/types';
import { EventBus, createRng, type IRandom } from '@/util';
import { ProgressionCoordinator } from '../coordinator';
import { MemorySaveBackend } from '../save-game';
import type { IQuestDef } from '../quest-defs';

export const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

export function at(x: number, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/** Deterministic stream for every test in this directory. */
export function rng(label = 'progression-tests'): IRandom {
  return createRng(label);
}

export interface IHarnessOptions {
  readonly defs?: readonly IQuestDef[];
  readonly heroName?: string;
}

export interface ITestHarness {
  readonly bus: IEventBus;
  readonly coordinator: ProgressionCoordinator;
  /** Advance every system by `seconds`, in `steps` slices. */
  tick(seconds: number, steps?: number): void;
  /** Register `count` civilian witnesses in a ring around `position`. */
  crowd(position: Vec3, count: number, radius?: number): void;
  killMonster(options?: Partial<KillOptions>): void;
  saveCivilian(position?: Vec3, byPlayer?: boolean): void;
  loseCivilian(position?: Vec3, causedByPlayer?: boolean): void;
  wreck(position: Vec3, cost: number): void;
  startEncounter(id: string, options?: Partial<EncounterOptions>): void;
  endEncounter(id: string, options?: Partial<EncounterEndOptions>): void;
  dispose(): void;
}

interface KillOptions {
  position: Vec3;
  threatTier: ThreatTier;
  specId: string;
  rewardPoints: number;
}

interface EncounterOptions {
  threatTier: ThreatTier;
  position: Vec3;
  isBoss: boolean;
  participantIds: string[];
}

interface EncounterEndOptions {
  outcome: 'victory' | 'defeat' | 'fled' | 'aborted';
  duration: number;
  civiliansLost: number;
  collateralCost: number;
}

let nextEntity = 0;

export function makeHarness(options: IHarnessOptions = {}): ITestHarness {
  const bus = new EventBus();
  const coordinator = new ProgressionCoordinator({
    bus,
    defs: options.defs,
    heroName: options.heroName,
    saveBackend: new MemorySaveBackend(),
  });

  let frame = 0;
  let time = 0;

  return {
    bus,
    coordinator,

    tick(seconds: number, steps = Math.max(1, Math.round(seconds * 30))): void {
      const dt = seconds / steps;
      for (let i = 0; i < steps; i++) {
        time += dt;
        bus.setFrame(++frame, time);
        coordinator.update(dt);
      }
    },

    crowd(position: Vec3, count: number, radius = 12): void {
      const stream = createRng(`crowd:${position.x},${position.z},${count}`);
      for (let i = 0; i < count; i++) {
        const [dx, dz] = stream.insideCircle(radius);
        coordinator.witnesses.register(`civ.${nextEntity++}`, 'civilian', {
          x: position.x + dx,
          y: position.y,
          z: position.z + dz,
        });
      }
    },

    killMonster(o: Partial<KillOptions> = {}): void {
      bus.emit('EntityKilled', {
        entityId: `monster.${nextEntity++}`,
        entityType: 'monster',
        faction: 'monster',
        position: o.position ?? ORIGIN,
        threatTier: o.threatTier ?? 'wolf',
        specId: o.specId ?? 'monster.generic',
        intent: 'normal',
        rewardPoints: o.rewardPoints ?? 25,
      });
    },

    saveCivilian(position: Vec3 = ORIGIN, byPlayer = true): void {
      bus.emit('CivilianSaved', {
        entityId: `civ.saved.${nextEntity++}`,
        position,
        byPlayer,
        reputationDelta: 1,
      });
    },

    loseCivilian(position: Vec3 = ORIGIN, causedByPlayer = false): void {
      bus.emit('CivilianLost', {
        entityId: `civ.lost.${nextEntity++}`,
        position,
        causedByPlayer,
        reputationDelta: causedByPlayer ? -6 : -2,
      });
    },

    wreck(position: Vec3, cost: number): void {
      bus.emit('ChunkDetached', {
        structureId: `building.${nextEntity++}`,
        chunkIndex: 0,
        position,
        mass: 2400,
        impulse: ORIGIN,
        material: 'concrete',
        collateralCost: cost,
      });
    },

    startEncounter(id: string, o: Partial<EncounterOptions> = {}): void {
      bus.emit('EncounterStarted', {
        encounterId: id,
        threatTier: o.threatTier ?? 'tiger',
        position: o.position ?? ORIGIN,
        radius: 45,
        participantIds: o.participantIds ?? [],
        isBoss: o.isBoss ?? false,
      });
    },

    endEncounter(id: string, o: Partial<EncounterEndOptions> = {}): void {
      bus.emit('EncounterEnded', {
        encounterId: id,
        outcome: o.outcome ?? 'victory',
        duration: o.duration ?? 12,
        civiliansLost: o.civiliansLost ?? 0,
        collateralCost: o.collateralCost ?? 0,
      });
    },

    dispose(): void {
      coordinator.dispose();
    },
  };
}
