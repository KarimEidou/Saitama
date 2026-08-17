/**
 * VOICE REGISTRY INVARIANTS
 *
 * The registry is the catalogue every other part of the system indexes into,
 * so its internal consistency is worth asserting directly: a key pointing at a
 * missing voice class, or a priority that lets a footstep outrank a serious
 * punch, would be a silent failure at runtime rather than a crash.
 */

import { describe, expect, it } from 'vitest';
import {
  isSoundKey,
  SOUND_KEYS,
  SOUND_SPECS,
  soundSpec,
  VOICE_CLASSES,
  type SoundKey,
} from '../voices/registry';
import { AUDIO_CATEGORIES } from '../mixer';
import { PUNCH_VARIANTS } from '../voices/punch';
import { SHOCKWAVE_VARIANTS } from '../voices/shockwave';
import { CONSECUTIVE_VARIANTS } from '../voices/consecutive';
import { COLLAPSE_VARIANTS } from '../voices/collapse';
import { DEBRIS_MATERIALS, resolveMaterial } from '../voices/debris';
import { FOOTSTEP_SURFACES, WHOOSH_VARIANTS } from '../voices/locomotion';
import { CROWD_REACTIONS } from '../voices/crowd';
import { UI_VARIANTS } from '../voices/ui';
import { MONSTER_UTTERANCES, resolveTier, THREAT_TIERS } from '../voices/monster';

/** Which variant list each voice class draws from. */
const VARIANT_SOURCES: Partial<Record<string, readonly string[]>> = {
  punch: PUNCH_VARIANTS,
  shockwave: SHOCKWAVE_VARIANTS,
  consecutive: CONSECUTIVE_VARIANTS,
  collapse: COLLAPSE_VARIANTS,
  debris: DEBRIS_MATERIALS,
  footstep: FOOTSTEP_SURFACES,
  whoosh: WHOOSH_VARIANTS,
  crowdReaction: CROWD_REACTIONS,
  ui: UI_VARIANTS,
};

describe('registry structure', () => {
  it('catalogues every key exactly once', () => {
    expect(SOUND_KEYS.length).toBe(new Set(SOUND_KEYS).size);
    expect(SOUND_KEYS.length).toBe(38);
    for (const key of SOUND_KEYS) expect(SOUND_SPECS[key].key).toBe(key);
  });

  it('points every key at a real voice class', () => {
    for (const key of SOUND_KEYS) {
      const spec = SOUND_SPECS[key];
      expect(VOICE_CLASSES[spec.voiceClass], `${key} -> ${spec.voiceClass}`).toBeDefined();
      expect(AUDIO_CATEGORIES).toContain(VOICE_CLASSES[spec.voiceClass].category);
    }
  });

  it('names a variant the voice class actually knows', () => {
    for (const key of SOUND_KEYS) {
      const spec = SOUND_SPECS[key];
      const known = VARIANT_SOURCES[spec.voiceClass];
      if (!known) continue;
      expect(known, `${key} uses unknown variant "${spec.variant}"`).toContain(spec.variant);
    }
  });

  it('keeps every level, priority and pool size in range', () => {
    for (const key of SOUND_KEYS) {
      const spec = SOUND_SPECS[key];
      expect(spec.gain).toBeGreaterThan(0);
      expect(spec.gain).toBeLessThanOrEqual(1);
      expect(spec.intensity).toBeGreaterThanOrEqual(0);
      expect(spec.intensity).toBeLessThanOrEqual(1);
      expect(spec.priority).toBeGreaterThanOrEqual(0);
      expect(spec.priority).toBeLessThanOrEqual(1);
      expect(spec.maxSeconds).toBeGreaterThan(0);
      expect(spec.pitchVariation).toBeGreaterThanOrEqual(0);
      expect(spec.pitchVariation).toBeLessThan(0.5);
      expect(spec.description.length).toBeGreaterThan(15);
    }
    for (const cls of Object.values(VOICE_CLASSES)) {
      expect(cls.poolSize).toBeGreaterThan(0);
      expect(cls.poolSize).toBeLessThanOrEqual(8);
      if (cls.sustained) expect(cls.poolSize).toBe(1);
    }
  });

  it('orders priorities so nothing important can be stolen by something trivial', () => {
    const p = (k: SoundKey): number => SOUND_SPECS[k].priority;
    expect(p('shockwave.serious')).toBe(1);
    expect(p('shockwave.serious')).toBeGreaterThan(p('punch.normal'));
    expect(p('punch.normal')).toBeGreaterThan(p('move.footstep'));
    expect(p('collapse.tower')).toBeGreaterThan(p('debris.impact'));
    expect(p('monster.roar')).toBeGreaterThan(p('monster.hurt'));
    expect(p('impact.body')).toBeLessThan(p('punch.normal'));
  });

  it('sizes distance profiles so a bigger sound carries further', () => {
    const reach = (k: SoundKey): number => SOUND_SPECS[k].spatial?.maxDistance ?? 0;
    expect(reach('shockwave.serious')).toBeGreaterThan(reach('punch.normal'));
    expect(reach('punch.normal')).toBeGreaterThan(reach('move.footstep'));
    expect(reach('collapse.tower')).toBeGreaterThan(reach('debris.impact'));
    // UI and music are 2D: no distance model at all.
    expect(SOUND_SPECS['ui.tap'].spatial).toBeUndefined();
  });

  it('resolves and rejects keys', () => {
    expect(isSoundKey('punch.normal')).toBe(true);
    expect(isSoundKey('punch.nonexistent')).toBe(false);
    expect(soundSpec('punch.normal')?.key).toBe('punch.normal');
    expect(soundSpec('nope')).toBeUndefined();
    // A prototype-chain key must not resolve.
    expect(isSoundKey('toString')).toBe(false);
    expect(isSoundKey('constructor')).toBe(false);
  });
});

describe('variant resolution', () => {
  it('maps every known debris material to itself', () => {
    for (const material of DEBRIS_MATERIALS) expect(resolveMaterial(material)).toBe(material);
  });

  it('falls back rather than going silent on an unknown material', () => {
    expect(resolveMaterial(undefined)).toBe('concrete');
    expect(resolveMaterial('')).toBe('concrete');
    expect(resolveMaterial('unobtainium')).toBe('rubble');
    // Case-insensitive: the destruction system spells materials its own way.
    expect(resolveMaterial('GLASS')).toBe('glass');
    expect(resolveMaterial('Metal')).toBe('metal');
  });

  it('maps every threat tier to itself and defaults sensibly', () => {
    for (const tier of THREAT_TIERS) expect(resolveTier(tier)).toBe(tier);
    expect(resolveTier(undefined)).toBe('demon');
    expect(resolveTier('archangel')).toBe('demon');
  });

  it('covers all four monster utterances with their own pools', () => {
    expect(MONSTER_UTTERANCES).toHaveLength(4);
    for (const utterance of MONSTER_UTTERANCES) {
      expect(SOUND_KEYS).toContain(`monster.${utterance}` as SoundKey);
    }
    // Each utterance gets its own pool, so a death cry can never steal the
    // voice a roar is using.
    const classes = MONSTER_UTTERANCES.map(
      (u) => SOUND_SPECS[`monster.${u}` as SoundKey].voiceClass
    );
    expect(new Set(classes).size).toBe(4);
  });
});
