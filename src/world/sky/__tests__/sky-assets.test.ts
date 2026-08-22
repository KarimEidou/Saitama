/**
 * SKY ASSET PROVIDER / REGISTRY TESTS
 *
 * This module is a SECOND implementation of `IAssetProvider` alongside
 * `src/assets/provider.ts`, so most of what is asserted here is that it does
 * not quietly disagree with the contract the canonical one implements: tiers
 * degrade rather than upgrade, one manifest load is one request, and a
 * registry that is torn down mid-load settles the promises it handed out
 * instead of leaving its callers waiting for a worker that will never answer.
 */

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IAssetManifest, IAssetProvider, QualityTier } from '@/types';
import { HttpAssetProvider, SkyEnvironmentRegistry } from '../sky-assets';

/* -------------------------------------------------------------------------- */
/* Provider                                                                   */
/* -------------------------------------------------------------------------- */

interface IStubOutput {
  tier: QualityTier;
  file: string;
}

function manifestWith(outputs: Record<string, IStubOutput[]>): unknown {
  return {
    version: 3,
    generatedAt: '2026-01-01T00:00:00.000Z',
    generator: 'test',
    generatedRoot: 'generated',
    entries: Object.entries(outputs).map(([id, list]) => ({
      id,
      kind: 'hdri',
      tags: [],
      outputs: list,
    })),
  };
}

/** A `fetch` that answers with one JSON body and counts its calls. */
function stubFetch(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 404,
    json: async () => body,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpAssetProvider.resolveUrl', () => {
  const outputs = {
    'hdri.sky.day': [
      { tier: 'mobile' as const, file: 'sky-day-mobile.ktx2' },
      { tier: 'ultra' as const, file: 'sky-day-ultra.ktx2' },
    ],
    'hdri.sky.night': [{ tier: 'high' as const, file: 'sky-night-high.ktx2' }],
  };

  async function openProvider(): Promise<HttpAssetProvider> {
    vi.stubGlobal('fetch', stubFetch(manifestWith(outputs)));
    const provider = new HttpAssetProvider({ baseUrl: '/assets' });
    await provider.loadManifest();
    return provider;
  }

  it('DOWNGRADES when the requested tier was not built', async () => {
    const provider = await openProvider();
    // Only `mobile` and `ultra` exist. A device the tier logic judged below
    // `ultra` must not be handed the 4K equirect just because its own tier is
    // missing — several times the download and the VRAM on hardware already
    // known not to afford it.
    expect(provider.resolveUrl('hdri.sky.day', 'high')).toContain('sky-day-mobile.ktx2');
    expect(provider.resolveUrl('hdri.sky.day', 'mobile')).toContain('sky-day-mobile.ktx2');
    expect(provider.resolveUrl('hdri.sky.day', 'ultra')).toContain('sky-day-ultra.ktx2');
  });

  it('still looks upward as a last resort, rather than serving nothing', async () => {
    const provider = await openProvider();
    // Nothing at or below `mobile`, so the sky is better than a black screen.
    expect(provider.resolveUrl('hdri.sky.night', 'mobile')).toContain('sky-night-high.ktx2');
    expect(provider.resolveUrl('missing.id', 'high')).toBeUndefined();
  });
});

describe('HttpAssetProvider.loadManifest', () => {
  it('fetches once however many callers race it', async () => {
    // The documented wiring has the bootstrap load the manifest and
    // `SkyEnvironmentRegistry.open` load it again. The `this.manifest` guard
    // alone only helps after the first fetch has already resolved.
    const fetchImpl = stubFetch(manifestWith({}));
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new HttpAssetProvider({ baseUrl: '/assets' });

    const [a, b] = await Promise.all([provider.loadManifest(), provider.loadManifest()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(provider.rawManifest).toBe(a);
  });

  it('rejects a manifest that is not one, instead of blind-casting it', async () => {
    vi.stubGlobal('fetch', stubFetch({ assets: [] }));
    const provider = new HttpAssetProvider({ baseUrl: '/assets' });
    // Cast, the shape drift surfaces as `Cannot read properties of undefined`
    // inside `resolveUrl`, a long way from what is actually wrong.
    await expect(provider.loadManifest()).rejects.toThrow(/entries/);
  });

  it('lets a failed load be retried', async () => {
    const failing = stubFetch(undefined, false);
    vi.stubGlobal('fetch', failing);
    const provider = new HttpAssetProvider({ baseUrl: '/assets' });
    await expect(provider.loadManifest()).rejects.toThrow(/404/);

    vi.stubGlobal('fetch', stubFetch(manifestWith({})));
    await expect(provider.loadManifest()).resolves.toBeDefined();
  });
});

describe('HttpAssetProvider.selectTier', () => {
  it('does not classify every WebKit device as high', () => {
    // `navigator.deviceMemory` is Chromium-only. Consulting nothing else puts
    // an iPhone SE on the same tier as an iPhone 17 Pro — and every iOS device
    // is a first-class target here.
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      hardwareConcurrency: 6,
    });
    expect(new HttpAssetProvider({ baseUrl: '/assets' }).selectTier()).toBe('mobile');
  });

  it('still honours deviceMemory and an explicit override', () => {
    vi.stubGlobal('navigator', { deviceMemory: 4, hardwareConcurrency: 8, userAgent: 'desktop' });
    expect(new HttpAssetProvider({ baseUrl: '/assets' }).selectTier()).toBe('mobile');

    vi.stubGlobal('navigator', { deviceMemory: 16, hardwareConcurrency: 16, userAgent: 'desktop' });
    expect(new HttpAssetProvider({ baseUrl: '/assets' }).selectTier()).toBe('high');
    expect(new HttpAssetProvider({ baseUrl: '/assets', tier: 'ultra' }).selectTier()).toBe('ultra');
  });

  it('reads the signals every engine reports when deviceMemory is absent', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 2, userAgent: 'desktop' });
    expect(new HttpAssetProvider({ baseUrl: '/assets' }).selectTier()).toBe('mobile');

    vi.stubGlobal('navigator', { hardwareConcurrency: 8, userAgent: 'desktop' });
    expect(new HttpAssetProvider({ baseUrl: '/assets' }).selectTier()).toBe('high');

    vi.stubGlobal('navigator', {
      hardwareConcurrency: 8,
      userAgent: 'desktop',
      connection: { saveData: true },
    });
    expect(new HttpAssetProvider({ baseUrl: '/assets' }).selectTier()).toBe('mobile');
  });
});

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

const REGISTRY_MANIFEST = manifestWith({
  'hdri.sky.day': [{ tier: 'high', file: 'sky-day-high.ktx2' }],
}) as IAssetManifest;

function stubProvider(): IAssetProvider {
  return {
    loadManifest: async () => REGISTRY_MANIFEST,
    resolveUrl: (key: string) => `/assets/generated/${key}.ktx2`,
    fetchBytes: async () => new ArrayBuffer(0),
    isAvailableOffline: () => false,
    selectTier: () => 'high',
  };
}

function stubRenderer(): THREE.WebGLRenderer {
  return {
    extensions: { has: () => false, get: () => undefined },
    capabilities: { isWebGL2: true },
  } as unknown as THREE.WebGLRenderer;
}

/** Replace the transcoder with one the test drives by hand. */
function interceptTranscode(registry: SkyEnvironmentRegistry): {
  settle: (texture: THREE.Texture) => void;
} {
  let settle: (texture: THREE.Texture) => void = () => undefined;
  const internals = registry as unknown as {
    ktx2: { loadAsync: (url: string) => Promise<THREE.Texture> };
  };
  internals.ktx2.loadAsync = async () =>
    new Promise<THREE.Texture>((resolve) => {
      settle = resolve;
    });
  return { settle: (texture) => settle(texture) };
}

describe('SkyEnvironmentRegistry.dispose', () => {
  it('settles in-flight loads instead of leaving them hanging forever', async () => {
    // `KTX2Loader.dispose()` terminates the worker pool, and three's
    // `WorkerPool.dispose()` drops its pending resolvers without calling OR
    // rejecting them: the transcode never answers, so `load()` never settles,
    // the `Promise.all` above it never settles, and the awaiting caller waits
    // for the lifetime of the page.
    const registry = await SkyEnvironmentRegistry.open({
      provider: stubProvider(),
      renderer: stubRenderer(),
    });
    interceptTranscode(registry);

    const pending = registry.load('hdri.sky.day');
    registry.dispose();

    await expect(pending).rejects.toThrow(/disposed/);
  });

  it('drops a transcode that lands after the registry was disposed', async () => {
    // `WorkerPool.postMessage` spins up a BRAND-NEW worker when the pool has
    // been emptied, so the transcode can still succeed — straight into a
    // registry nobody will dispose again.
    const registry = await SkyEnvironmentRegistry.open({
      provider: stubProvider(),
      renderer: stubRenderer(),
    });
    const { settle } = interceptTranscode(registry);

    const pending = registry.load('hdri.sky.day').catch((error: unknown) => error);
    registry.dispose();

    const texture = new THREE.Texture();
    const disposed = vi.spyOn(texture, 'dispose');
    settle(texture);
    await pending;

    expect(registry.getHDRI('hdri.sky.day')).toBeUndefined();
    expect(disposed).toHaveBeenCalled();
  });
});
