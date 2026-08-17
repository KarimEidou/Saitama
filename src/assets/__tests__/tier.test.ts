/**
 * TIER SELECTION AND FALLBACK
 *
 * The regression these tests exist for: the shipped manifest declares
 * `tiersBuilt: ['mobile','high','ultra']` while the Android package contains
 * the mobile files only. Twenty-six declared files are absent — 13 at `high`
 * and 13 at `ultra`, four HDRIs and nine textures at each. Believing the
 * manifest 404s on an environment map during boot.
 *
 * The fix is two-layered and both layers are asserted here: a native shell
 * selects `mobile` outright, and any miss demotes per asset (then per tier)
 * without throwing.
 */

import { describe, it, expect } from 'vitest';
import type { AnyAssetEntry, QualityTier } from '@/types';
import { clampTier, selectQualityTier, TierAvailability, type ITierSignals } from '../tier';
import { ALL_TIERS, testManifest } from './fixtures';
import { parseRuntimeManifest } from '../manifest';

const DESKTOP: ITierSignals = {
  isNative: false,
  platform: 'web',
  deviceMemoryGB: 16,
  cpuCores: 16,
  maxTextureSize: 16384,
  saveData: false,
  devicePixelRatio: 2,
};

function entryFor(id: string): AnyAssetEntry {
  const manifest = parseRuntimeManifest(testManifest());
  const entry = manifest.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`fixture is missing ${id}`);
  return entry;
}

describe('selectQualityTier', () => {
  it('picks mobile inside a native shell no matter how fast the device is', () => {
    const decision = selectQualityTier(
      { ...DESKTOP, isNative: true, platform: 'android' },
      { builtTiers: ALL_TIERS }
    );
    expect(decision.tier).toBe('mobile');
    expect(decision.reason).toMatch(/packaged/i);
  });

  it('picks mobile for an Android browser', () => {
    expect(
      selectQualityTier({ ...DESKTOP, platform: 'android' }, { builtTiers: ALL_TIERS }).tier
    ).toBe('mobile');
  });

  it('respects Save-Data', () => {
    expect(
      selectQualityTier({ ...DESKTOP, saveData: true }, { builtTiers: ALL_TIERS }).tier
    ).toBe('mobile');
  });

  it('drops to mobile on a low-memory machine', () => {
    expect(
      selectQualityTier({ ...DESKTOP, deviceMemoryGB: 4 }, { builtTiers: ALL_TIERS }).tier
    ).toBe('mobile');
  });

  it('uses ultra only on a roomy desktop with big textures', () => {
    expect(selectQualityTier(DESKTOP, { builtTiers: ALL_TIERS }).tier).toBe('ultra');
    expect(
      selectQualityTier({ ...DESKTOP, cpuCores: 8 }, { builtTiers: ALL_TIERS }).tier
    ).toBe('high');
  });

  it('clamps down to the tiers that were actually built', () => {
    const decision = selectQualityTier(DESKTOP, { builtTiers: ['mobile'] });
    expect(decision.requested).toBe('ultra');
    expect(decision.tier).toBe('mobile');
    expect(decision.reason).toMatch(/clamped/);
  });

  it('treats a manifest with no declared tiers as mobile-only', () => {
    expect(selectQualityTier(DESKTOP, { builtTiers: [] }).tier).toBe('mobile');
  });

  it('still clamps a forced tier, so a debug override cannot 404 the boot', () => {
    const decision = selectQualityTier(DESKTOP, { forced: 'ultra', builtTiers: ['mobile'] });
    expect(decision.tier).toBe('mobile');
  });
});

describe('clampTier', () => {
  it('takes the best tier at or below the request', () => {
    expect(clampTier('ultra', ['mobile', 'high'])).toBe('high');
    expect(clampTier('high', ['mobile'])).toBe('mobile');
    expect(clampTier('mobile', ['mobile', 'high', 'ultra'])).toBe('mobile');
  });

  it('takes the cheapest available when nothing is at or below', () => {
    expect(clampTier('mobile', ['high', 'ultra'])).toBe('high');
  });

  it('reports undefined when nothing exists at all', () => {
    expect(clampTier('high', [])).toBeUndefined();
  });
});

describe('TierAvailability', () => {
  const built = ALL_TIERS;

  it('resolves an asset that has no output at the requested tier', () => {
    // 153 of the 166 real outputs are mobile-only; asking for high must not
    // invent a high file for them.
    const availability = new TierAvailability(built);
    const mobileOnly = entryFor('mat.wall.plaster.beige.albedo');
    expect(availability.bestTierFor(mobileOnly, 'ultra')).toBe('mobile');
    expect(availability.chainFor(mobileOnly, 'ultra')).toEqual(['mobile']);
  });

  it('walks down the chain as each tier is found missing', () => {
    const availability = new TierAvailability(built);
    const entry = entryFor('mat.road.asphalt.worn.albedo');
    expect(availability.bestTierFor(entry, 'ultra')).toBe('ultra');

    const afterUltra = availability.markMissing(entry.id, 'ultra', entry, '404');
    expect(afterUltra).toBe('high');
    const afterHigh = availability.markMissing(entry.id, 'high', entry, '404');
    expect(afterHigh).toBe('mobile');
    expect(availability.bestTierFor(entry, 'ultra')).toBe('mobile');
  });

  it('never returns undefined while a lower tier remains', () => {
    const availability = new TierAvailability(built);
    const entry = entryFor('hdri.sky.day');
    let tier: QualityTier | undefined = 'ultra';
    const seen: QualityTier[] = [];
    while (tier !== undefined) {
      seen.push(tier);
      tier = availability.markMissing(entry.id, tier, entry, '404');
    }
    expect(seen).toEqual(['ultra', 'high', 'mobile']);
  });

  it('writes off a whole tier after repeated misses, sparing later assets', () => {
    const availability = new TierAvailability(built, 3);
    for (const id of [
      'hdri.sky.day',
      'hdri.sky.night',
      'mat.road.asphalt.worn.albedo',
    ]) {
      const entry = entryFor(id);
      availability.markMissing(entry.id, 'ultra', entry, '404');
    }
    expect(availability.isTierUsable('ultra')).toBe(false);
    expect(availability.unavailableTiers).toContain('ultra');

    // An asset that has never been asked for now skips 'ultra' entirely — this
    // is what turns 26 separate 404s into 3.
    const untouched = entryFor('mat.road.asphalt.worn.normal');
    expect(availability.bestTierFor(untouched, 'ultra')).toBe('high');
  });

  it('ignores tiers the manifest never claimed to build', () => {
    const availability = new TierAvailability(['mobile']);
    const entry = entryFor('mat.road.asphalt.worn.albedo');
    expect(availability.chainFor(entry, 'ultra')).toEqual(['mobile']);
  });

  it('records every miss for diagnostics', () => {
    const availability = new TierAvailability(built);
    const entry = entryFor('hdri.sky.day');
    availability.markMissing(entry.id, 'high', entry, 'HTTP 404');
    expect(availability.recordedMisses).toEqual([
      { key: 'hdri.sky.day', tier: 'high', reason: 'HTTP 404' },
    ]);
  });
});
