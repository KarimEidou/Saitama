/**
 * VARIANT COVERAGE — every voice class, no exemptions.
 *
 * `registry.test.ts` already checks that a catalogued key names a variant its
 * voice class knows, but its lookup table is partial and it silently skips any
 * class missing from it. Seven of the sixteen classes were missing, so a typo
 * such as `variant: 'daemon'` on `monster.roar` passed the suite and was then
 * resolved at runtime by `resolveTier`'s fallback to `'demon'`: a wrong-sized
 * creature, with no failure reported anywhere.
 *
 * This file holds the COMPLETE table, the test that keeps it complete as new
 * voice classes are added, and the same guarantee for the materials the
 * destruction system can emit.
 */

import { describe, expect, it } from 'vitest';
import type { StructureMaterial } from '@/types';
import { SOUND_KEYS, SOUND_SPECS, VOICE_CLASSES } from '../voices/registry';
import { PUNCH_VARIANTS } from '../voices/punch';
import { SHOCKWAVE_VARIANTS } from '../voices/shockwave';
import { CONSECUTIVE_VARIANTS } from '../voices/consecutive';
import { COLLAPSE_VARIANTS } from '../voices/collapse';
import { DEBRIS_MATERIALS, resolveMaterial } from '../voices/debris';
import { FOOTSTEP_SURFACES, LANDING_VARIANTS, WHOOSH_VARIANTS } from '../voices/locomotion';
import { CROWD_REACTIONS } from '../voices/crowd';
import { UI_VARIANTS } from '../voices/ui';
import { THREAT_TIERS } from '../voices/monster';

/**
 * The only legal variant for a voice that ignores the field.
 *
 * `wind` and `crowdBed` never read `variant`, so nothing at runtime would ever
 * notice a misspelling — which is exactly why the registry has to spell it
 * `'default'` exactly, and why they are listed here rather than exempted.
 */
const DEFAULT_ONLY: readonly string[] = ['default'];

/** Which variant list each voice class draws from. Every class, no gaps. */
const VARIANT_SOURCES: Record<string, readonly string[]> = {
  punch: PUNCH_VARIANTS,
  consecutive: CONSECUTIVE_VARIANTS,
  shockwave: SHOCKWAVE_VARIANTS,
  debris: DEBRIS_MATERIALS,
  collapse: COLLAPSE_VARIANTS,
  monsterRoar: THREAT_TIERS,
  monsterScreech: THREAT_TIERS,
  monsterHurt: THREAT_TIERS,
  monsterDeath: THREAT_TIERS,
  footstep: FOOTSTEP_SURFACES,
  landing: LANDING_VARIANTS,
  whoosh: WHOOSH_VARIANTS,
  wind: DEFAULT_ONLY,
  crowdBed: DEFAULT_ONLY,
  crowdReaction: CROWD_REACTIONS,
  ui: UI_VARIANTS,
};

describe('variant coverage', () => {
  it('has a variant source for every voice class', () => {
    // The test that keeps the table honest: a new voice class fails here rather
    // than quietly joining the set whose variants nothing checks.
    for (const id of Object.keys(VOICE_CLASSES)) {
      expect(VARIANT_SOURCES[id], `${id} has no variant source`).toBeDefined();
    }
  });

  it('names a variant the voice class actually knows, with nothing skipped', () => {
    for (const key of SOUND_KEYS) {
      const spec = SOUND_SPECS[key];
      const known = VARIANT_SOURCES[spec.voiceClass];
      expect(known, `${key}: ${spec.voiceClass} has no variant source`).toBeDefined();
      expect(known, `${key} uses unknown variant "${spec.variant}"`).toContain(spec.variant);
    }
  });

  it('gives every material the destruction system can emit its own grain character', () => {
    // `StructureMaterial` is what `ChunkDetached` carries, and `brick` and
    // `asphalt` had no entry in the debris table: both fell through
    // `resolveMaterial`'s unknown-material path, so a brick wall and an asphalt
    // road produced the identical generic rubble cloud.
    //
    // A `Record` over the union: a new `StructureMaterial` fails to compile
    // until it is listed here, and then fails below until the debris table has a
    // matching entry.
    const emitted: Record<StructureMaterial, true> = {
      concrete: true,
      glass: true,
      metal: true,
      wood: true,
      brick: true,
      asphalt: true,
    };
    for (const material of Object.keys(emitted)) {
      expect(DEBRIS_MATERIALS, `${material} has no grain character`).toContain(material);
      expect(resolveMaterial(material), `${material} resolves to something else`).toBe(material);
    }
  });
});
