/**
 * THE THREAT POOL IS BOUNDED BY THE LIVE MONSTERS, NOT BY THE SESSION
 *
 * `ThreatBridge` owns one `THREE.Vector3` per monster so a 60 Hz republish of
 * twenty threats allocates nothing — the crowd reads the position every frame
 * and `IThreatSource.position` is documented as live, not copied.
 *
 * Monster ids are unique per spawn, so a pool keyed by id with no removal path
 * grew with EVERY monster the session ever produced: a couple of thousand
 * spawns is a couple of thousand vectors describing nothing. `sync()` publishes
 * exactly the live set, so the same pass knows precisely which entries are dead.
 *
 * Pooling and pruning are opposite sides of one assertion here: a monster that
 * is still around keeps its vector across syncs, and one that is gone loses it.
 */

import { describe, expect, it } from 'vitest';
import type { EntityId, ThreatTier } from '@/types';
import type { CrowdSystem, IThreatSource } from '@/entities/npc';
import type { MonsterSystem } from '@/entities/monster';
import { ThreatBridge } from '../bridges';

interface IStubSnapshot {
  id: EntityId;
  state: string;
  tier: ThreatTier;
  position: { x: number; y: number; z: number };
}

function snapshot(id: string, x: number, state = 'pursue'): IStubSnapshot {
  return { id, state, tier: 'tiger', position: { x, y: 0, z: 0 } };
}

/** A monster system and a crowd that do nothing but hand over the two lists. */
function harness(): {
  bridge: ThreatBridge;
  setMonsters: (snapshots: IStubSnapshot[]) => void;
  published: () => readonly IThreatSource[];
} {
  let live: IStubSnapshot[] = [];
  let last: readonly IThreatSource[] = [];
  const monsters = { snapshots: () => live } as unknown as MonsterSystem;
  const crowd = {
    setThreats: (threats: readonly IThreatSource[]) => {
      last = threats;
    },
  } as unknown as CrowdSystem;
  return {
    bridge: new ThreatBridge(monsters, crowd),
    setMonsters: (snapshots) => {
      live = snapshots;
    },
    published: () => last,
  };
}

describe('ThreatBridge.sync', () => {
  it('reuses one vector per live monster and releases it when the monster goes', () => {
    const { bridge, setMonsters, published } = harness();

    setMonsters([snapshot('mob.a', 10), snapshot('mob.b', 20)]);
    bridge.sync();
    expect(published().map((t) => t.id)).toEqual(['mob.a', 'mob.b']);
    const vectorA = published()[0]!.position;
    expect(vectorA.x).toBe(10);

    // Same monster, next frame: the pooled vector is rewritten, not replaced.
    setMonsters([snapshot('mob.a', 11), snapshot('mob.b', 20)]);
    bridge.sync();
    expect(published()[0]!.position).toBe(vectorA);
    expect(vectorA.x).toBe(11);

    // `mob.a` despawns. Its entry has to go with it — the pool is keyed by an id
    // that is never issued again.
    setMonsters([snapshot('mob.b', 20)]);
    bridge.sync();
    expect(published().map((t) => t.id)).toEqual(['mob.b']);

    setMonsters([snapshot('mob.a', 30), snapshot('mob.b', 20)]);
    bridge.sync();
    expect(published()[0]!.position).not.toBe(vectorA);
  });

  it('does not hold a vector for a monster that is only ever seen dead', () => {
    const { bridge, setMonsters, published } = harness();

    setMonsters([snapshot('mob.a', 5, 'dead'), snapshot('mob.b', 6)]);
    bridge.sync();
    expect(published().map((t) => t.id)).toEqual(['mob.b']);

    // Corpses stay in `snapshots()` until the system sweeps them, so a pool that
    // kept the ones it skipped would be no more bounded than one that kept them
    // all: the entry must not exist to be reused.
    setMonsters([snapshot('mob.a', 5), snapshot('mob.b', 6)]);
    bridge.sync();
    expect(published().map((t) => t.id)).toEqual(['mob.a', 'mob.b']);
  });
});
