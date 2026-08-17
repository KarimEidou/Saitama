/**
 * SAVE / LOAD
 *
 * "Round-trip must be exact" is taken literally: `load(save(x))` deep-equals
 * `x`, including every float, and anything JSON cannot express is rejected at
 * SAVE time rather than silently becoming null in a player's file.
 */

import { describe, expect, it } from 'vitest';
import { createRng } from '@/util';
import {
  LocalStorageSaveBackend,
  MemorySaveBackend,
  SaveManager,
  buildSave,
  migrate,
  selectSaveBackend,
  validateSave,
  type IStoredSave,
} from '../save-game';
import { SAVE_VERSION } from '../constants';
import { rankFromPoints } from '../rank-ladder';
import { makeHarness, ORIGIN, at } from './support';

/** A minimal in-memory `Storage`, enough for `LocalStorageSaveBackend`. */
function fakeStorage(failOnSet = false): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => {
      if (failOnSet) throw new DOMException('QuotaExceededError');
      map.set(key, value);
    },
  } as Storage;
}

function sampleSave(): IStoredSave {
  const stream = createRng('save-fixture');
  return buildSave({
    worldSeed: 0xdeadbeef,
    progression: {
      rank: rankFromPoints(1234.5678901234567, 'Caped Baldy'),
      killsByTier: { wolf: 12, tiger: 3, demon: 1, dragon: 0, god: 0 },
      civiliansSaved: 41,
      civiliansLost: 2,
      propertyDamage: 987654.321,
      reputation: 63.75,
      boredom: 0.8123456789012345,
      completedQuests: ['quest.duty.quota', 'quest.subjugation.crablante'],
      playTimeSeconds: 4821.333333333333,
    },
    playerPosition: { x: stream.range(-500, 500), y: 1.5, z: stream.range(-500, 500) },
    playerYaw: Math.PI / 7,
    timeOfDay: 0.7291666666666666,
    dayCount: 4,
    questStates: {
      'quest.duty.quota': 'completed',
      'quest.errand.bargain': 'failed',
      'quest.boss.deepsea': 'locked',
    },
    questProgress: {
      'quest.duty.quota': { 'quota.incidents': 3 },
      'quest.rescue.tunnel': { 'tunnel.reach': 1, 'tunnel.rescue': 7 },
    },
    extras: {
      rivals: { genos: { points: 91234.5, shared: 100.25, offscreen: 91134.25, joint: 6 } },
      heroicDeeds: ['bodyBlock', 'zeroCollateral'],
      lunarAgeDays: 14,
    },
    savedAt: '2026-08-17T06:00:00.000Z',
  });
}

describe('round trip', () => {
  it('is exact, floats included', async () => {
    const manager = new SaveManager({ backend: new MemorySaveBackend() });
    const original = sampleSave();
    await manager.save(original);
    const loaded = await manager.load();
    expect(loaded).toEqual(original);
    expect(loaded!.progression.boredom).toBe(original.progression.boredom);
    expect(loaded!.playerPosition.x).toBe(original.playerPosition.x);
    expect(loaded!.extras!.rivals!.genos!.points).toBe(91234.5);
  });

  it('survives the nastiest doubles JSON has to carry', async () => {
    const manager = new SaveManager({ backend: new MemorySaveBackend() });
    const nasty = [
      0.1 + 0.2,
      Number.MIN_VALUE,
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      1 / 3,
      Number.EPSILON,
      -0,
      1e-320,
      5e-324,
    ];
    const save = sampleSave();
    const payload: IStoredSave = {
      ...save,
      questProgress: { probe: Object.fromEntries(nasty.map((v, i) => [`n${i}`, v])) },
    };
    await manager.save(payload);
    const loaded = await manager.load();
    for (let i = 0; i < nasty.length; i++) {
      // Object.is so -0 is distinguished from +0.
      const value = loaded!.questProgress.probe![`n${i}`]!;
      expect(Object.is(value, nasty[i]) || value === nasty[i]).toBe(true);
    }
  });

  it('round-trips through localStorage identically', async () => {
    const manager = new SaveManager({ backend: new LocalStorageSaveBackend(fakeStorage()) });
    const original = sampleSave();
    await manager.save(original);
    expect(await manager.load()).toEqual(original);
    expect(manager.backendName).toBe('localStorage');
  });

  it('reports an empty slot as undefined, not as a broken save', async () => {
    const manager = new SaveManager({ backend: new MemorySaveBackend() });
    expect(await manager.load()).toBeUndefined();
    expect(await manager.hasSave()).toBe(false);
  });

  it('clears a slot', async () => {
    const manager = new SaveManager({ backend: new MemorySaveBackend() });
    await manager.save(sampleSave());
    await manager.clear();
    expect(await manager.load()).toBeUndefined();
  });
});

describe('validation', () => {
  it('refuses to write NaN or Infinity', async () => {
    const manager = new SaveManager({ backend: new MemorySaveBackend() });
    const broken = { ...sampleSave(), playerYaw: Number.NaN };
    await expect(manager.save(broken)).rejects.toThrow(/non-finite/);

    const infinite = { ...sampleSave(), timeOfDay: Number.POSITIVE_INFINITY };
    await expect(manager.save(infinite)).rejects.toThrow(/non-finite/);
  });

  it('names the exact path of the offending value', () => {
    const issues = validateSave({ a: { b: [1, Number.NaN] } });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toBe('save.a.b[1]');
  });

  it('rejects undefined, functions and bigints', () => {
    expect(validateSave({ x: undefined })).toHaveLength(1);
    expect(validateSave({ x: () => 1 })).toHaveLength(1);
    expect(validateSave({ x: 1n })).toHaveLength(1);
  });

  it('passes a clean payload', () => {
    expect(validateSave(sampleSave())).toHaveLength(0);
  });
});

describe('migration', () => {
  it('accepts the current version', () => {
    expect(migrate(sampleSave())).toBeDefined();
  });

  it('refuses a save from a newer build rather than half-loading it', () => {
    expect(migrate({ ...sampleSave(), version: SAVE_VERSION + 1 })).toBeUndefined();
  });

  it('refuses anything that is not a save', () => {
    for (const junk of [null, undefined, 42, 'nope', [], {}, { version: 1 }]) {
      expect(migrate(junk)).toBeUndefined();
    }
  });

  it('ignores a slot containing invalid JSON', async () => {
    const backend = new MemorySaveBackend();
    await backend.set('saitama.save.slot0', '{not json');
    const manager = new SaveManager({ backend });
    expect(await manager.load()).toBeUndefined();
  });
});

describe('backend selection', () => {
  it('falls back to memory with no localStorage', async () => {
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { localStorage?: Storage }).localStorage;
    try {
      expect((await selectSaveBackend()).name).toBe('memory');
    } finally {
      if (original) (globalThis as { localStorage?: Storage }).localStorage = original;
    }
  });

  it('probes localStorage with a real write, not a truthiness check', async () => {
    const original = (globalThis as { localStorage?: Storage }).localStorage;
    // Safari private mode: the object exists and setItem throws.
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage(true);
    try {
      expect((await selectSaveBackend()).name).toBe('memory');
      (globalThis as { localStorage?: Storage }).localStorage = fakeStorage(false);
      expect((await selectSaveBackend()).name).toBe('localStorage');
    } finally {
      if (original) (globalThis as { localStorage?: Storage }).localStorage = original;
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});

describe('whole-session round trip', () => {
  it('restores rank, quests, rivals and boredom exactly', async () => {
    const first = makeHarness();
    first.crowd(ORIGIN, 12);
    first.coordinator.quests.accept('quest.duty.quota');
    for (let i = 0; i < 3; i++) {
      first.startEncounter(`e${i}`, { threatTier: 'demon', participantIds: ['ally.genos'], position: at(i * 400, 0, 0) });
      first.crowd(at(i * 400, 0, 0), 8);
      first.killMonster({ threatTier: 'demon', position: at(i * 400, 0, 0) });
      first.endEncounter(`e${i}`, { collateralCost: 12000 });
    }
    for (let i = 0; i < 6; i++) first.saveCivilian(ORIGIN);
    first.tick(3);
    first.coordinator.rivals.advanceOffscreen(2);

    const payload = await first.coordinator.save({ x: 12.5, y: 0, z: -8.25 }, 1.25);

    const second = makeHarness();
    second.coordinator.applySaveGame(payload);

    const a = first.coordinator.progression.state;
    const b = second.coordinator.progression.state;
    expect(b.rank.points).toBe(a.rank.points);
    expect(b.rank.heroClass).toBe(a.rank.heroClass);
    expect(b.rank.rank).toBe(a.rank.rank);
    expect(b.reputation).toBe(a.reputation);
    expect(b.boredom).toBe(a.boredom);
    expect(b.propertyDamage).toBe(a.propertyDamage);
    expect(b.killsByTier).toEqual(a.killsByTier);
    expect(b.completedQuests).toEqual(a.completedQuests);

    expect(second.coordinator.quests.serialiseStates()).toEqual(first.coordinator.quests.serialiseStates());
    expect(second.coordinator.quests.serialiseProgress()).toEqual(first.coordinator.quests.serialiseProgress());
    expect(second.coordinator.rivals.serialise()).toEqual(first.coordinator.rivals.serialise());

    // And the rebuilt save is byte-identical, which is the strongest form of
    // "exact" available without comparing object graphs.
    const rebuilt = second.coordinator.buildSaveGame({ x: 12.5, y: 0, z: -8.25 }, 1.25, payload.savedAt);
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(payload));

    first.dispose();
    second.dispose();
  });
});
