/**
 * PROVIDER: URL RESOLUTION AND THE APK 404
 *
 * `fakeFetch({ packagedTiers: ['mobile'] })` reproduces the Android package
 * exactly: the manifest claims three tiers, the tree contains one. The tests
 * below assert both halves of the fix — that a native shell never asks for the
 * absent tiers at all, and that a forced high tier recovers instead of
 * throwing when it does.
 */

import { describe, it, expect } from 'vitest';
import { HttpAssetProvider } from '../provider';
import { fakeFetch, testManifest } from './fixtures';

const NATIVE = { isNative: true, platform: 'android' as const };
const DESKTOP = {
  isNative: false,
  platform: 'web' as const,
  deviceMemoryGB: 16,
  cpuCores: 16,
  maxTextureSize: 16384,
  saveData: false,
  devicePixelRatio: 2,
};

describe('HttpAssetProvider', () => {
  it('loads the manifest and its pipeline extension blocks', async () => {
    const { fetchImpl } = fakeFetch();
    const provider = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl });
    await provider.loadManifest();

    expect(provider.runtimeManifest.entries).toHaveLength(10);
    expect(provider.runtimeManifest.tiersBuilt).toEqual(['mobile', 'high', 'ultra']);
    // meanLuminance must survive parsing: the sky normalises by it.
    expect(provider.runtimeManifest.environments['hdri.sky.day']?.meanLuminance).toBeCloseTo(
      0.73268945997054,
      9
    );
    expect(provider.runtimeManifest.environments['hdri.sky.day']?.sh9).toHaveLength(27);
    expect(provider.runtimeManifest.pipeline?.flipY).toBe(false);
  });

  it('prefixes generatedRoot exactly once', async () => {
    const { fetchImpl } = fakeFetch();
    const provider = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl, tier: 'mobile' });
    await provider.loadManifest();
    expect(provider.resolveUrl('hdri.sky.day', 'mobile')).toBe(
      '/assets/env/hdri.sky.day.mobile.ktx2'
    );
  });

  it('resolves per asset, not globally, at a tier most assets lack', async () => {
    const { fetchImpl } = fakeFetch();
    const provider = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl, signals: DESKTOP });
    await provider.loadManifest();
    expect(provider.selectTier()).toBe('ultra');
    expect(provider.effectiveTier('mat.road.asphalt.worn.albedo', 'ultra')).toBe('ultra');
    expect(provider.effectiveTier('mat.wall.plaster.beige.albedo', 'ultra')).toBe('mobile');
  });

  it('selects mobile and requests NOTHING outside the package on Android', async () => {
    const { fetchImpl, log } = fakeFetch({ packagedTiers: ['mobile'] });
    const provider = new HttpAssetProvider({
      baseUrl: '/assets',
      fetchImpl,
      signals: NATIVE,
    });
    await provider.loadManifest();
    expect(provider.selectTier()).toBe('mobile');

    for (const key of [
      'hdri.sky.day',
      'hdri.sky.night',
      'mat.road.asphalt.worn.albedo',
      'mat.road.asphalt.worn.normal',
      'mat.road.asphalt.worn.orm',
      'mat.wall.plaster.beige.albedo',
    ]) {
      await provider.fetchAsset(key, provider.selectTier());
    }

    expect(log.notFound).toEqual([]);
    expect(log.requests.filter((url) => /\.(high|ultra)\./.test(url))).toEqual([]);
  });

  it('recovers to a lower tier instead of throwing when a file is absent', async () => {
    const { fetchImpl, log } = fakeFetch({ packagedTiers: ['mobile'] });
    // A debug override that asks for a tier the package does not contain.
    const provider = new HttpAssetProvider({
      baseUrl: '/assets',
      fetchImpl,
      tier: 'ultra',
      signals: DESKTOP,
    });
    await provider.loadManifest();

    const result = await provider.fetchAsset('hdri.sky.day', 'ultra');
    expect(result.tier).toBe('mobile');
    expect(result.url).toBe('/assets/env/hdri.sky.day.mobile.ktx2');
    // It cost two 404s to discover that, and they were survived, not thrown.
    expect(log.notFound).toHaveLength(2);
    expect(provider.availability.recordedMisses.map((miss) => miss.tier)).toEqual([
      'ultra',
      'high',
    ]);
  });

  it('writes off a broken tier so later assets stop probing it', async () => {
    const { fetchImpl, log } = fakeFetch({ packagedTiers: ['mobile'] });
    const provider = new HttpAssetProvider({
      baseUrl: '/assets',
      fetchImpl,
      tier: 'high',
      signals: DESKTOP,
    });
    await provider.loadManifest();

    for (const key of [
      'hdri.sky.day',
      'hdri.sky.night',
      'mat.road.asphalt.worn.albedo',
      'mat.road.asphalt.worn.normal',
      'mat.road.asphalt.worn.orm',
    ]) {
      const result = await provider.fetchAsset(key, 'high');
      expect(result.tier).toBe('mobile');
    }

    // Three misses write 'high' off; the remaining assets go straight to
    // mobile. Without that, the real manifest costs 26 404s at boot.
    expect(provider.availability.isTierUsable('high')).toBe(false);
    expect(log.notFound).toHaveLength(3);
  });

  it('rejects only when the asset exists nowhere, and never for an unknown id silently', async () => {
    const { fetchImpl } = fakeFetch({ packagedTiers: [] });
    const provider = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl, tier: 'mobile' });
    await provider.loadManifest();
    await expect(provider.fetchAsset('hdri.sky.day', 'mobile')).rejects.toThrow(/unavailable/);
    await expect(provider.fetchAsset('nope', 'mobile')).rejects.toThrow(/not in the manifest/);
  });

  it('survives a manifest that cannot be fetched at all', async () => {
    const failing = (async () => ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch;
    const provider = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl: failing });
    const manifest = await provider.loadManifest();
    expect(manifest.entries).toEqual([]);
    expect(provider.selectTier()).toBe('mobile');
    expect(provider.resolveUrl('anything', 'mobile')).toBeUndefined();
  });

  it('loads the character index and tolerates its absence', async () => {
    const present = fakeFetch();
    const withIndex = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl: present.fetchImpl });
    await withIndex.loadManifest();
    expect(withIndex.characters.size).toBe(1);
    expect(withIndex.characters.get('chr.saitama')?.modelFile).toBe('chr/saitama/model.glb');

    const absent = fakeFetch({ characters: null });
    const withoutIndex = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl: absent.fetchImpl });
    await withoutIndex.loadManifest();
    expect(withoutIndex.characters.size).toBe(0);
  });

  it('reports offline availability honestly', async () => {
    const { fetchImpl } = fakeFetch({ packagedTiers: ['mobile'] });
    const web = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl, signals: DESKTOP });
    await web.loadManifest();
    expect(web.isAvailableOffline('hdri.sky.day')).toBe(false);

    const native = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl, signals: NATIVE });
    await native.loadManifest();
    expect(native.isAvailableOffline('hdri.sky.day')).toBe(true);
    expect(native.isAvailableOffline('not.an.asset')).toBe(false);
  });

  it('de-duplicates concurrent manifest loads', async () => {
    const { fetchImpl, log } = fakeFetch();
    const provider = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl });
    await Promise.all([provider.loadManifest(), provider.loadManifest(), provider.loadManifest()]);
    expect(log.requests.filter((url) => url.endsWith('assets.runtime.json'))).toHaveLength(1);
  });

  it('counts the exact shape of the shipped bug in the fixture', async () => {
    // 13 high + 13 ultra outputs are declared-but-absent in the real package.
    // The fixture keeps the same proportions: some assets tiered, most not.
    const manifest = testManifest();
    const entries = manifest.entries as { outputs: { tier: string }[] }[];
    const declaredHigh = entries.filter((entry) =>
      entry.outputs.some((output) => output.tier === 'high')
    ).length;
    const mobileOnly = entries.filter(
      (entry) => entry.outputs.length > 0 && entry.outputs.every((output) => output.tier === 'mobile')
    ).length;
    expect(declaredHigh).toBeGreaterThan(0);
    expect(mobileOnly).toBeGreaterThan(0);
  });
});
