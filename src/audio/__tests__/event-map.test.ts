/**
 * EVENT → SOUND MAPPING COVERAGE
 *
 * The audio system's only input is the event bus, so the mapping is the
 * contract. These tests assert three things:
 *
 *  1. EXHAUSTIVENESS — every member of the `GameEvent` union has a rule, and
 *     every rule produces either a sound or a documented non-cue effect. The
 *     type system already enforces this at compile time; this re-checks it at
 *     runtime so the guarantee survives any future loosening of the types.
 *  2. VALIDITY — every key a rule can emit is a real, playable sound key.
 *  3. BEHAVIOUR — the interesting branches actually branch: a serious punch
 *     sounds different from a normal one and ducks the music, a player-caused
 *     civilian death is treated differently from an accidental one, and an
 *     unbounded power value is scaled sanely.
 */

import { describe, expect, it } from 'vitest';
import type { GameEvent, GameEventType, ThreatTier } from '@/types';
import {
  ALL_GAME_EVENT_TYPES,
  EVENT_AUDIO_MAP,
  eventAudioRule,
  normaliseMass,
  normalisePower,
  normaliseSpeed,
  resolveEventAudio,
  tierScalar,
} from '../event-map';
import { isSoundKey, SOUND_KEYS } from '../voices/registry';
import { MUSIC_STATES } from '../music/patterns';

/** Minimal but valid instances of every event, for exercising the rules. */
const SAMPLES: { [T in GameEventType]: Extract<GameEvent, { type: T }> } = {
  ShockwaveFired: {
    type: 'ShockwaveFired',
    time: 1,
    frame: 60,
    origin: { x: 1, y: 2, z: 3 },
    direction: { x: 0, y: 0, z: 1 },
    power: 5000,
    range: 80,
    angle: Math.PI / 4,
    intent: 'normal',
    punchKind: 'normal',
  },
  EntityDamaged: {
    type: 'EntityDamaged',
    time: 1,
    frame: 60,
    entityId: 7 as never,
    entityType: 'monster',
    faction: 'monster',
    amount: 40,
    damageType: 'blunt',
    intent: 'normal',
    healthRemaining: 60,
    maxHealth: 100,
    point: { x: 0, y: 1, z: 0 },
    critical: false,
  },
  EntityKilled: {
    type: 'EntityKilled',
    time: 1,
    frame: 60,
    entityId: 7 as never,
    entityType: 'monster',
    faction: 'monster',
    position: { x: 0, y: 0, z: 0 },
    threatTier: 'demon',
    intent: 'serious',
    rewardPoints: 10,
  },
  ImpulseApplied: {
    type: 'ImpulseApplied',
    time: 1,
    frame: 60,
    targetId: 3 as never,
    impulse: { x: 100, y: 20, z: 0 },
    point: { x: 0, y: 1, z: 0 },
  },
  ChunkDetached: {
    type: 'ChunkDetached',
    time: 1,
    frame: 60,
    structureId: 'tower-4',
    chunkIndex: 12,
    position: { x: 5, y: 20, z: 5 },
    mass: 400,
    impulse: { x: 0, y: -10, z: 0 },
    material: 'concrete',
    collateralCost: 30,
  },
  CivilianSaved: {
    type: 'CivilianSaved',
    time: 1,
    frame: 60,
    entityId: 9 as never,
    position: { x: 2, y: 0, z: 2 },
    byPlayer: true,
    reputationDelta: 5,
  },
  CivilianLost: {
    type: 'CivilianLost',
    time: 1,
    frame: 60,
    entityId: 9 as never,
    position: { x: 2, y: 0, z: 2 },
    causedByPlayer: true,
    reputationDelta: -20,
  },
  AllyDowned: {
    type: 'AllyDowned',
    time: 1,
    frame: 60,
    entityId: 11 as never,
    displayName: 'Mumen Rider',
    position: { x: 0, y: 0, z: 0 },
  },
  EncounterStarted: {
    type: 'EncounterStarted',
    time: 1,
    frame: 60,
    encounterId: 'e1',
    threatTier: 'dragon',
    position: { x: 0, y: 0, z: 0 },
    radius: 60,
    participantIds: [],
    isBoss: true,
  },
  EncounterEnded: {
    type: 'EncounterEnded',
    time: 1,
    frame: 60,
    encounterId: 'e1',
    outcome: 'victory',
    duration: 40,
    civiliansLost: 0,
    collateralCost: 0,
  },
  BossPhaseChanged: {
    type: 'BossPhaseChanged',
    time: 1,
    frame: 60,
    entityId: 13 as never,
    specId: 'boros',
    previousPhase: 1,
    phase: 2,
    healthFraction: 0.4,
    isFinalPhase: false,
  },
  QuestStateChanged: {
    type: 'QuestStateChanged',
    time: 1,
    frame: 60,
    questId: 'q1',
    previous: 'available',
    state: 'active',
    title: 'Groceries',
  },
  RankChanged: {
    type: 'RankChanged',
    time: 1,
    frame: 60,
    previousClass: 'C',
    heroClass: 'B',
    previousRank: 388,
    rank: 122,
    points: 900,
    promoted: true,
  },
  BoredomChanged: {
    type: 'BoredomChanged',
    time: 1,
    frame: 60,
    value: 0.5,
    previous: 0.4,
    reason: 'trivialVictory',
  },
  ChunkStreamedIn: {
    type: 'ChunkStreamedIn',
    time: 1,
    frame: 60,
    key: '0,0' as never,
    coord: { x: 0, z: 0 } as never,
    loadTimeMs: 12,
    memoryBytes: 1024,
  },
  ChunkStreamedOut: {
    type: 'ChunkStreamedOut',
    time: 1,
    frame: 60,
    key: '0,0' as never,
    coord: { x: 0, z: 0 } as never,
    evictedForMemory: false,
  },
  TimeOfDayChanged: {
    type: 'TimeOfDayChanged',
    time: 1,
    frame: 60,
    timeOfDay: 0.5,
    phase: 'noon',
    previousPhase: 'morning',
    dayCount: 3,
  },
  PlayerLanded: {
    type: 'PlayerLanded',
    time: 1,
    frame: 60,
    position: { x: 0, y: 0, z: 0 },
    impactSpeed: 30,
    fallHeight: 45,
    createsCrater: false,
    intent: 'normal',
  },
};

describe('event coverage', () => {
  it('has a rule for every GameEvent member', () => {
    for (const type of ALL_GAME_EVENT_TYPES) {
      expect(EVENT_AUDIO_MAP[type], `no audio rule for "${type}"`).toBeDefined();
      expect(EVENT_AUDIO_MAP[type].type).toBe(type);
    }
    expect(Object.keys(EVENT_AUDIO_MAP).sort()).toEqual([...ALL_GAME_EVENT_TYPES].sort());
  });

  it('covers 18 event types with no duplicates', () => {
    expect(new Set(ALL_GAME_EVENT_TYPES).size).toBe(ALL_GAME_EVENT_TYPES.length);
    expect(ALL_GAME_EVENT_TYPES.length).toBe(18);
  });

  it('gives every rule either a sound or a declared non-cue effect', () => {
    for (const type of ALL_GAME_EVENT_TYPES) {
      const rule = eventAudioRule(type);
      expect(
        rule.sounds.length > 0 || rule.effects.length > 0,
        `"${type}" reacts to nothing at all`
      ).toBe(true);
      expect(rule.summary.length, `"${type}" has no summary`).toBeGreaterThan(20);
    }
  });

  it('only ever names real sound keys', () => {
    for (const type of ALL_GAME_EVENT_TYPES) {
      for (const key of eventAudioRule(type).sounds) {
        expect(isSoundKey(key), `"${type}" declares unknown key "${key}"`).toBe(true);
      }
    }
  });

  it('produces cues whose keys are declared by the rule', () => {
    for (const type of ALL_GAME_EVENT_TYPES) {
      const rule = eventAudioRule(type);
      const response = resolveEventAudio(SAMPLES[type]);
      for (const cue of response.cues) {
        expect(isSoundKey(cue.key)).toBe(true);
        expect(rule.sounds, `"${type}" emitted undeclared key "${cue.key}"`).toContain(cue.key);
        if (cue.intensity !== undefined) {
          expect(cue.intensity).toBeGreaterThanOrEqual(0);
          expect(cue.intensity).toBeLessThanOrEqual(1);
        }
        if (cue.delay !== undefined) expect(cue.delay).toBeGreaterThanOrEqual(0);
      }
      if (response.music) expect(MUSIC_STATES).toContain(response.music);
      if (response.duck) {
        expect(response.duck.to).toBeGreaterThanOrEqual(0);
        expect(response.duck.to).toBeLessThan(1);
      }
    }
  });

  it('makes every playable key reachable from at least one event or the ambience beds', () => {
    const reachable = new Set<string>();
    for (const type of ALL_GAME_EVENT_TYPES) {
      for (const key of eventAudioRule(type).sounds) reachable.add(key);
    }
    // Continuous beds and the traversal set are driven by per-frame parameter
    // calls rather than by discrete events; they have no event to map from.
    const parameterDriven = new Set([
      'ambience.crowd',
      'move.wind',
      'move.footstep',
      'move.jump',
      'move.dash',
      'move.leap',
      'punch.flurry',
      'collapse.building',
      'collapse.tower',
      'collapse.facade',
      'monster.screech',
      'monster.death',
      'shockwave.blast',
      'crowd.panic',
      'crowd.cheer',
      'ui.tap',
    ]);
    const orphans = SOUND_KEYS.filter((k) => !reachable.has(k) && !parameterDriven.has(k));
    expect(orphans, `unreachable sound keys: ${orphans.join(', ')}`).toEqual([]);
  });
});

describe('combat mapping', () => {
  it('sends a serious punch to the shockwave voice and ducks the music', () => {
    const r = resolveEventAudio({
      ...SAMPLES.ShockwaveFired,
      punchKind: 'serious',
      intent: 'serious',
      power: 1e6,
    });
    expect(r.cues.map((c) => c.key)).toContain('shockwave.serious');
    expect(r.duck?.category).toBe('music');
    expect(r.duck!.to).toBeLessThan(0.4);
  });

  it('sends a table flip to the biggest voice with the hardest duck', () => {
    const serious = resolveEventAudio({ ...SAMPLES.ShockwaveFired, punchKind: 'serious' });
    const flip = resolveEventAudio({ ...SAMPLES.ShockwaveFired, punchKind: 'seriousTableflip' });
    expect(flip.cues[0]!.key).toBe('shockwave.tableflip');
    expect(flip.duck!.to).toBeLessThan(serious.duck!.to);
    expect(flip.duck!.hold).toBeGreaterThan(serious.duck!.hold);
  });

  it('distinguishes a restrained punch from a normal one', () => {
    const restrained = resolveEventAudio({ ...SAMPLES.ShockwaveFired, intent: 'restrained' });
    const normal = resolveEventAudio({ ...SAMPLES.ShockwaveFired, intent: 'normal' });
    expect(restrained.cues[0]!.key).toBe('punch.restrained');
    expect(normal.cues[0]!.key).toBe('punch.normal');
  });

  it('escalates a consecutive chain to a barrage at high power', () => {
    const light = resolveEventAudio({
      ...SAMPLES.ShockwaveFired,
      punchKind: 'consecutive',
      power: 100,
    });
    const heavy = resolveEventAudio({
      ...SAMPLES.ShockwaveFired,
      punchKind: 'consecutive',
      power: 5e5,
    });
    expect(light.cues[0]!.key).toBe('punch.consecutive');
    expect(heavy.cues[0]!.key).toBe('punch.barrage');
  });

  it('adds a blast wake only to a big heavy strike', () => {
    const small = resolveEventAudio({ ...SAMPLES.ShockwaveFired, punchKind: 'heavy', power: 50 });
    const big = resolveEventAudio({ ...SAMPLES.ShockwaveFired, punchKind: 'heavy', power: 1e5 });
    expect(small.cues.map((c) => c.key)).not.toContain('shockwave.blast');
    expect(big.cues.map((c) => c.key)).toContain('shockwave.blast');
  });

  it('adds a hurt vocalisation only for monsters', () => {
    const monster = resolveEventAudio(SAMPLES.EntityDamaged);
    const civilian = resolveEventAudio({
      ...SAMPLES.EntityDamaged,
      entityType: 'npc',
      faction: 'civilian',
    });
    expect(monster.cues.map((c) => c.key)).toContain('monster.hurt');
    expect(civilian.cues.map((c) => c.key)).not.toContain('monster.hurt');
  });

  it('scales a monster death cry with its threat tier', () => {
    const tiers: ThreatTier[] = ['wolf', 'tiger', 'demon', 'dragon', 'god'];
    const intensities = tiers.map((threatTier) => {
      const r = resolveEventAudio({ ...SAMPLES.EntityKilled, threatTier });
      return r.cues.find((c) => c.key === 'monster.death')!.intensity!;
    });
    for (let i = 1; i < intensities.length; i++) {
      expect(intensities[i]!).toBeGreaterThan(intensities[i - 1]!);
    }
  });
});

describe('consequence mapping', () => {
  it('punishes a player-caused civilian death and not an accidental one', () => {
    const byPlayer = resolveEventAudio({ ...SAMPLES.CivilianLost, causedByPlayer: true });
    const other = resolveEventAudio({ ...SAMPLES.CivilianLost, causedByPlayer: false });
    expect(byPlayer.cues.map((c) => c.key)).toContain('ui.dark');
    expect(byPlayer.duck).toBeDefined();
    expect(other.cues.map((c) => c.key)).not.toContain('ui.dark');
    expect(other.duck).toBeUndefined();
  });

  it('withholds the crowd cheer from a costly victory', () => {
    const clean = resolveEventAudio({ ...SAMPLES.EncounterEnded, civiliansLost: 0 });
    const costly = resolveEventAudio({ ...SAMPLES.EncounterEnded, civiliansLost: 3 });
    expect(clean.cues.map((c) => c.key)).toContain('crowd.cheer');
    expect(costly.cues.map((c) => c.key)).not.toContain('crowd.cheer');
  });

  it('separates promotion from demotion', () => {
    expect(resolveEventAudio({ ...SAMPLES.RankChanged, promoted: true }).cues[0]!.key).toBe(
      'ui.rankUp'
    );
    expect(resolveEventAudio({ ...SAMPLES.RankChanged, promoted: false }).cues[0]!.key).toBe(
      'ui.deny'
    );
  });

  it('maps every quest state to a distinct acknowledgement', () => {
    const keys = (['available', 'active', 'completed', 'failed', 'locked'] as const).map(
      (state) => resolveEventAudio({ ...SAMPLES.QuestStateChanged, state }).cues[0]!.key
    );
    expect(keys).toEqual(['ui.tap', 'ui.confirm', 'ui.victory', 'ui.deny', 'ui.tap']);
  });
});

describe('escalation mapping', () => {
  it('picks the music layer from the threat tier and boss flag', () => {
    const wolf = resolveEventAudio({
      ...SAMPLES.EncounterStarted,
      threatTier: 'wolf',
      isBoss: false,
    });
    const demon = resolveEventAudio({
      ...SAMPLES.EncounterStarted,
      threatTier: 'demon',
      isBoss: false,
    });
    const boss = resolveEventAudio({ ...SAMPLES.EncounterStarted, isBoss: true });
    expect(wolf.music).toBe('alert');
    expect(demon.music).toBe('combat');
    expect(boss.music).toBe('boss');
  });

  it('sends the street running only for a serious threat', () => {
    const wolf = resolveEventAudio({ ...SAMPLES.EncounterStarted, threatTier: 'wolf' });
    const dragon = resolveEventAudio({ ...SAMPLES.EncounterStarted, threatTier: 'dragon' });
    expect(wolf.cues.map((c) => c.key)).not.toContain('crowd.panic');
    expect(dragon.cues.map((c) => c.key)).toContain('crowd.panic');
  });

  it('collapses the score to the drone at the top of the boredom range', () => {
    expect(resolveEventAudio({ ...SAMPLES.BoredomChanged, value: 0.5 }).music).toBeUndefined();
    expect(resolveEventAudio({ ...SAMPLES.BoredomChanged, value: 0.5 }).boredom).toBe(0.5);
    expect(resolveEventAudio({ ...SAMPLES.BoredomChanged, value: 0.9 }).music).toBe('bored');
  });

  it('empties the street at night and raises the wind', () => {
    const noon = resolveEventAudio({ ...SAMPLES.TimeOfDayChanged, phase: 'noon' });
    const midnight = resolveEventAudio({ ...SAMPLES.TimeOfDayChanged, phase: 'midnight' });
    expect(noon.ambience!.crowdDensity!).toBeGreaterThan(0.9);
    expect(midnight.ambience!.crowdDensity!).toBeLessThan(0.15);
    expect(midnight.ambience!.wind!).toBeGreaterThan(noon.ambience!.wind!);
  });

  it('keeps chunk streaming silent but still updates the ambience', () => {
    for (const type of ['ChunkStreamedIn', 'ChunkStreamedOut'] as const) {
      const r = resolveEventAudio(SAMPLES[type]);
      expect(r.cues).toHaveLength(0);
      expect(r.ambience?.recomputeDensity).toBe(true);
    }
  });

  it('turns a crater landing into a landing plus debris', () => {
    const soft = resolveEventAudio({
      ...SAMPLES.PlayerLanded,
      impactSpeed: 6,
      createsCrater: false,
    });
    const crater = resolveEventAudio({
      ...SAMPLES.PlayerLanded,
      impactSpeed: 55,
      createsCrater: true,
    });
    expect(soft.cues.map((c) => c.key)).toEqual(['move.landing']);
    expect(crater.cues.map((c) => c.key)).toEqual(['move.landing', 'debris.impact']);
    expect(crater.cues[0]!.variant).toBe('crater');
    expect(crater.cues[0]!.intensity!).toBeGreaterThan(soft.cues[0]!.intensity!);
  });

  it('routes each debris material to its own grain character', () => {
    const material = (m: string): string =>
      resolveEventAudio({ ...SAMPLES.ChunkDetached, material: m }).cues[0]!.key;
    expect(material('glass')).toBe('debris.glass');
    expect(material('metal')).toBe('debris.metal');
    expect(material('wood')).toBe('debris.wood');
    expect(material('concrete')).toBe('debris.impact');
    // An unknown material must still make a sound.
    expect(material('unobtainium')).toBe('debris.impact');
  });
});

describe('scaling helpers', () => {
  it('spreads six decades of unbounded power across the dial', () => {
    expect(normalisePower(0)).toBe(0);
    expect(normalisePower(1)).toBe(0);
    expect(normalisePower(-5)).toBe(0);
    expect(normalisePower(Number.NaN)).toBe(0);
    expect(normalisePower(1e6)).toBeCloseTo(1, 5);
    expect(normalisePower(1e9)).toBe(1);
    // The point of the log scale: an ordinary hit is NOT rounded to zero.
    expect(normalisePower(100)).toBeGreaterThan(0.3);
    expect(normalisePower(100)).toBeLessThan(0.4);
    // And it stays monotonic across the whole range.
    let previous = -1;
    for (const p of [10, 100, 1e3, 1e4, 1e5, 1e6]) {
      const v = normalisePower(p);
      expect(v).toBeGreaterThan(previous);
      previous = v;
    }
  });

  it('normalises speed and mass into 0..1', () => {
    expect(normaliseSpeed(0)).toBe(0);
    expect(normaliseSpeed(30)).toBeCloseTo(0.5, 5);
    expect(normaliseSpeed(1000)).toBe(1);
    expect(normaliseMass(0)).toBe(0);
    expect(normaliseMass(1e6)).toBe(1);
    expect(normaliseMass(100)).toBeGreaterThan(normaliseMass(10));
  });

  it('orders the threat tiers', () => {
    const tiers: ThreatTier[] = ['wolf', 'tiger', 'demon', 'dragon', 'god'];
    const values = tiers.map(tierScalar);
    expect(values[0]).toBe(0);
    expect(values[4]).toBe(1);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    expect(tierScalar(undefined)).toBeGreaterThan(0);
  });
});
