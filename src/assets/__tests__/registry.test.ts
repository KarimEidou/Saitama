/**
 * REGISTRY SCHEDULING, PROGRESS AND TEARDOWN
 *
 * These exercise `AssetRegistry` through its public door with the fixture
 * manifest behind it. Nothing here decodes a real KTX2 — there is no GPU and
 * no Basis transcoder in a unit test, so every texture lands as the marked
 * stand-in, which is exactly the shape the failure paths below care about.
 *
 * The property worth the most: `load()` must always SETTLE. A material awaits
 * its own textures on the same bounded scheduler, and a parent that outranks
 * its children while holding the only slot is a boot screen that stops at 72%
 * forever with no error to report.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { IAssetLoadProgress } from '@/types';
import { AssetRegistry } from '../registry';
import { HttpAssetProvider } from '../provider';
import { TEXTURE_ATTEMPT_LIMIT } from '../constants';
import { fakeFetch, type IFakeFetchLog } from './fixtures';

/**
 * A renderer stand-in.
 *
 * `KTX2Loader.detectSupport` and `describeTranscodeSupport` ask for extensions
 * and `capabilities` and nothing else, so the registry opens without a GL
 * context.
 */
function fakeRenderer(maxTextureSize = 4096): THREE.WebGLRenderer {
  return {
    extensions: { has: (): boolean => false, get: (): null => null },
    capabilities: { maxTextureSize, getMaxAnisotropy: (): number => 1 },
  } as unknown as THREE.WebGLRenderer;
}

async function openRegistry(options: { concurrency?: number } = {}): Promise<{
  registry: AssetRegistry;
  log: IFakeFetchLog;
}> {
  const { fetchImpl, log } = fakeFetch();
  const provider = new HttpAssetProvider({ baseUrl: '/assets', fetchImpl, tier: 'mobile' });
  const registry = await AssetRegistry.open({
    provider,
    renderer: fakeRenderer(),
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });
  return { registry, log };
}

const MATERIAL = 'mat.road.asphalt.worn';
const TEXTURES = [`${MATERIAL}.albedo`, `${MATERIAL}.normal`, `${MATERIAL}.orm`];

describe('AssetRegistry scheduling', () => {
  it('settles a material load on a SINGLE slot', async () => {
    // The material occupies the only slot and awaits three texture tasks. With
    // the wait inside the slot, `pump()` sees no free slot, the children never
    // start, and this promise never settles.
    const { registry } = await openRegistry({ concurrency: 1 });
    await registry.load(MATERIAL);
    expect(registry.getMaterial(MATERIAL)).toBeDefined();
    await registry.idle();
    registry.dispose();
  });

  it('settles preloadCore when every slot holds a material at critical priority', async () => {
    // The boot path: parents at weight 0, their textures at weight 10, so every
    // slot freed by a finishing texture went to another parent until all of
    // them were waiting on work that could not start.
    const { registry } = await openRegistry({ concurrency: 2 });
    await registry.preloadCore();
    expect(registry.getMaterial(MATERIAL)).toBeDefined();
    expect(registry.getMaterial('mat.wall.plaster.beige')).toBeDefined();
    await registry.idle();
    registry.dispose();
  });
});

describe('AssetRegistry progress', () => {
  it('finishes on 100% of bytes when the key set holds a material AND its textures', async () => {
    // `buildAssetManifest` copies a material's `preload` flag onto its texture
    // rows, so both are in the boot set. Counting the textures twice in the
    // total and once in the credit left the bar at roughly half.
    const { registry } = await openRegistry();
    const samples: IAssetLoadProgress[] = [];
    await registry.loadAll([MATERIAL, ...TEXTURES], (progress) => samples.push(progress));

    const last = samples.at(-1)!;
    expect(last.bytesTotal).toBe(3 * 65536);
    expect(last.bytesLoaded).toBe(last.bytesTotal);
    expect(last.fraction).toBe(1);
    registry.dispose();
  });

  it('credits the textures of a material asked for on its own', async () => {
    const { registry } = await openRegistry();
    const samples: IAssetLoadProgress[] = [];
    await registry.preloadCore((progress) => samples.push(progress));
    const last = samples.at(-1)!;
    expect(last.bytesTotal).toBeGreaterThan(0);
    expect(last.bytesLoaded).toBe(last.bytesTotal);
    registry.dispose();
  });
});

describe('AssetRegistry failure bookkeeping', () => {
  it('records a key that is not in the manifest once, however often it is asked for', async () => {
    // A city material asked for at every chunk transition used to push a row
    // per attempt into the array `diagnostics()` hands the debug HUD, and log
    // a warning with it.
    const { registry } = await openRegistry();
    for (let i = 0; i < 5; i++) await registry.load('mat.does.not.exist');
    expect(
      registry.failures.filter((failure) => failure.key === 'mat.does.not.exist')
    ).toHaveLength(1);
    expect(registry.missing.filter((key) => key === 'mat.does.not.exist')).toHaveLength(1);
    registry.dispose();
  });

  it('re-attempts a texture that fell back, but only so many times', async () => {
    // A stand-in installed under the real key makes `isLoaded` true, so one
    // dropped request during a network handover used to paint that surface
    // magenta for the rest of the session. Retrying without a bound would
    // re-fetch a genuinely absent file once per chunk stream-in instead.
    const { registry, log } = await openRegistry();
    const key = `${MATERIAL}.albedo`;
    for (let i = 0; i < TEXTURE_ATTEMPT_LIMIT + 3; i++) await registry.load(key);

    const requests = log.requests.filter((url) => url.includes('albedo.mobile.ktx2'));
    expect(requests).toHaveLength(TEXTURE_ATTEMPT_LIMIT);
    expect(registry.getTexture(key)).toBeDefined();
    registry.dispose();
  });
});

describe('AssetRegistry diagnostics', () => {
  it('reports the outcome of the LATEST eviction pass, not the last successful one', async () => {
    // `runBudgetProbe` sets a budget and reads `lastEviction` straight after.
    // A pass that could free nothing was not recorded at all, so the probe
    // published someone else's evicted and pinned lists as its own result.
    const { registry } = await openRegistry();
    await registry.load(MATERIAL);
    expect(registry.textureBytes).toBeGreaterThan(0);

    registry.setTextureBudget(1);
    const report = registry.diagnostics().lastEviction;
    expect(report).toBeDefined();
    expect(report?.budgetBytes).toBe(1);
    // Every texture is retained by the material, so nothing can be freed and
    // the registry is over budget — which is precisely what has to be visible.
    expect(report?.evicted).toEqual([]);
    expect(report?.overBudget).toBe(true);
    registry.dispose();
  });
});

describe('AssetRegistry teardown', () => {
  it('does not re-populate itself with a load that lands after dispose()', async () => {
    // The background upgrade wave keeps fetches in flight across teardown.
    // Each one used to install its GPU object into the maps `dispose()` had
    // just cleared, with nothing alive to free it and a second dispose() a
    // no-op.
    const { registry } = await openRegistry();
    const pending = registry.load(`${MATERIAL}.albedo`);
    registry.dispose();
    await pending;

    expect(registry.getTexture(`${MATERIAL}.albedo`)).toBeUndefined();
    expect(registry.diagnostics().residentTextures).toBe(0);
    expect(registry.textureBytes).toBe(0);
  });

  it('drops queued work rather than leaving its callers unsettled', async () => {
    const { registry } = await openRegistry({ concurrency: 1 });
    const queued = Promise.all(TEXTURES.map((key) => registry.load(key)));
    registry.dispose();
    await expect(queued).resolves.toBeDefined();
    expect(registry.diagnostics().residentTextures).toBe(0);
  });
});
