/**
 * THE RUNTIME LOADER — a missing bake is a steady state, not a retry loop
 *
 * A fresh clone that has never run `tools/build-characters.ts` must still boot,
 * so `load()` resolving `false` is normal and callers poll it on every spawn
 * (`if (!isResident(id)) void load(id)`). That makes two things load-bearing:
 * a failure has to be REMEMBERED, or every monster spawn re-issues the same
 * 404s for the whole session, and whatever did decode before the failure has to
 * be RELEASED, or each attempt strands an ImageBitmap.
 *
 * Around that sit the decisions nothing else in the unit covers: which map
 * roles a given entry asks for, the `ultra -> high` tier downgrade, load
 * de-duplication, "a missing face is survivable but a missing ORM is not", and
 * the LOD0 plan/rect cache that foreign civilian bodies are prepared against.
 * None of it needs WebGL — only `fetch` and `createImageBitmap`.
 */

import * as THREE from 'three';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QualityTier } from '@/types';
import { muteNamespace, unmuteNamespace } from '@/util';
import { prepareRosterGeometry } from '../geometry';
import { buildRosterMesh, rosterEntry } from '../roster';
import { RosterRuntime, type IBakedAssetSource } from '../runtime';

/** Face rectangle stand-in; the loader never inspects its values. */
const RECT = { u0: 0.4, v0: 0.8, u1: 0.6, v1: 0.9 };

function sourceAt(tier: QualityTier): IBakedAssetSource {
  return {
    resolveFile: (file) => `https://roster.test/${file}`,
    selectTier: (): QualityTier => tier,
  };
}

const source = sourceAt('mobile');

interface Stubs {
  readonly fetched: string[];
  /** Bitmaps handed out by `createImageBitmap` that were closed again. */
  readonly closed: string[];
}

const originalFetch = globalThis.fetch;
const originalCreateImageBitmap = globalThis.createImageBitmap;

/** Install `fetch`/`createImageBitmap` stubs driven by a per-URL predicate. */
function install(serves: (url: string) => boolean, size: number): Stubs {
  const fetched: string[] = [];
  const closed: string[] = [];
  let current = '';

  globalThis.fetch = ((url: string) => {
    fetched.push(url);
    current = url;
    const ok = serves(url);
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      blob: () => Promise.resolve({}),
    });
  }) as unknown as typeof fetch;

  globalThis.createImageBitmap = (() => {
    const name = current;
    return Promise.resolve({ width: size, height: size, close: () => closed.push(name) });
  }) as unknown as typeof createImageBitmap;

  return { fetched, closed };
}

/** Serve only the files in `available`; everything else 404s. */
function stubNetwork(available: readonly string[], size = 4): Stubs {
  return install((url) => available.some((name) => url.endsWith(name)), size);
}

/**
 * Serve everything except the files in `missing`.
 *
 * Names are matched against the END of the URL, not `includes`: `normal` ends
 * in the three letters `orm`, so a substring test for a missing ORM map would
 * silently take the normal map down with it.
 */
function stubNetworkExcept(missing: readonly string[] = [], size = 4): Stubs {
  return install((url) => !missing.some((name) => url.endsWith(name)), size);
}

/** URLs a character's maps are fetched from, as `<role>.<tier>.png`. */
function urlsFor(dir: string, tier: string, roles: readonly string[]): string[] {
  return roles.map((role) => `https://roster.test/chr/${dir}/${role}.${tier}.png`);
}

// `load()` narrates every attempt at info/warn, and half these cases are
// deliberate failures.
beforeAll(() => muteNamespace('roster:runtime'));
afterAll(() => unmuteNamespace('roster:runtime'));

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.createImageBitmap = originalCreateImageBitmap;
  vi.restoreAllMocks();
});

describe('roster runtime loading', () => {
  it('remembers a missing bake instead of re-fetching it on every spawn', async () => {
    const stubs = stubNetwork([]);
    const runtime = new RosterRuntime({ source });

    expect(await runtime.load('chr.saitama')).toBe(false);
    const firstAttempt = stubs.fetched.length;
    expect(firstAttempt).toBeGreaterThan(0);
    expect(runtime.failed.has('chr.saitama')).toBe(true);
    expect(runtime.isResident('chr.saitama')).toBe(false);

    // Five more spawns of the same character: not one more request.
    for (let i = 0; i < 5; i++) expect(await runtime.load('chr.saitama')).toBe(false);
    expect(stubs.fetched.length).toBe(firstAttempt);

    // `retry` is the deliberate escape hatch for the transient case.
    expect(await runtime.retry('chr.saitama')).toBe(false);
    expect(stubs.fetched.length).toBeGreaterThan(firstAttempt);
    runtime.dispose();
  });

  it('releases the maps that did decode when a structural map fails', async () => {
    // Albedo lands, the normal map 404s. The albedo texture is now unreachable
    // and its ImageBitmap is not reclaimed by `dispose()` alone.
    const stubs = stubNetwork(['albedo.mobile.png']);
    const runtime = new RosterRuntime({ source });

    expect(await runtime.load('chr.saitama')).toBe(false);
    expect(stubs.closed).toEqual(['https://roster.test/chr/saitama/albedo.mobile.png']);
    runtime.dispose();
  });

  it('binds the crowd tint mask with point sampling', async () => {
    // The mask holds class ids that the shader decodes with band tests, so any
    // filtering — including a mip's box filter — decodes a different tint slot.
    const stubs = stubNetwork([
      'albedo.mobile.png',
      'normal.mobile.png',
      'orm.mobile.png',
      'face.mobile.png',
      'mask.mobile.png',
    ]);
    const runtime = new RosterRuntime({ source });

    expect(await runtime.load('chr.civilian')).toBe(true);
    expect(stubs.fetched.some((url) => url.endsWith('mask.mobile.png'))).toBe(true);

    const material = runtime.createMaterial('chr.civilian', { u0: 0, v0: 0, u1: 1, v1: 1 });
    const mask = material?.userData.roster.crowdMask.value as THREE.Texture;
    expect(mask.generateMipmaps).toBe(false);
    expect(mask.minFilter).toBe(THREE.NearestFilter);
    expect(mask.magFilter).toBe(THREE.NearestFilter);
    expect(mask.anisotropy).toBe(1);
    // Everything else is a colour map and keeps its mip chain.
    expect(material?.map?.generateMipmaps).toBe(true);
    expect(material?.map?.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    runtime.dispose();
  });

  it('asks for exactly the map roles an entry declares', async () => {
    // Three PBR maps plus a face for everyone; an emissive only when the entry
    // glows, a tint mask only for the crowd sheet.
    const plain = stubNetworkExcept();
    const runtime = new RosterRuntime({ source: sourceAt('high') });
    expect(await runtime.load('chr.saitama')).toBe(true);
    expect(plain.fetched).toEqual(urlsFor('saitama', 'high', ['albedo', 'normal', 'orm', 'face']));
    runtime.dispose();

    const glowing = stubNetworkExcept();
    const withGlow = new RosterRuntime({ source: sourceAt('high') });
    // Genos' eyes carry `face.glow`, so an emissive map is baked for him.
    expect(await withGlow.load('chr.genos')).toBe(true);
    expect(glowing.fetched).toEqual(
      urlsFor('genos', 'high', ['albedo', 'normal', 'orm', 'emissive', 'face'])
    );
    withGlow.dispose();

    const crowd = stubNetworkExcept();
    const withMask = new RosterRuntime({ source: sourceAt('high') });
    expect(await withMask.load('chr.civilian')).toBe(true);
    expect(crowd.fetched).toEqual(
      urlsFor('civilian', 'high', ['albedo', 'normal', 'orm', 'face', 'mask'])
    );
    withMask.dispose();
  });

  it('downgrades ultra to high, and lets an explicit tier win outright', async () => {
    // Character atlases are baked at `mobile` and `high` only.
    const ultra = stubNetworkExcept();
    const downgraded = new RosterRuntime({ source: sourceAt('ultra') });
    expect(await downgraded.load('chr.saitama')).toBe(true);
    expect(ultra.fetched.length).toBe(4);
    for (const url of ultra.fetched) expect(url.endsWith('.high.png')).toBe(true);
    downgraded.dispose();

    const forced = stubNetworkExcept();
    const overridden = new RosterRuntime({ source: sourceAt('high'), tier: 'mobile' });
    expect(await overridden.load('chr.saitama')).toBe(true);
    expect(forced.fetched.length).toBe(4);
    for (const url of forced.fetched) expect(url.endsWith('.mobile.png')).toBe(true);
    overridden.dispose();
  });

  it('survives a missing face but not a missing ORM', async () => {
    // A character minus one feature beats no character at all; a character
    // with no roughness/metalness is not a character, it is a plastic doll.
    stubNetworkExcept(['face.mobile.png']);
    const faceless = new RosterRuntime({ source });
    expect(await faceless.load('chr.saitama')).toBe(true);
    expect(faceless.isResident('chr.saitama')).toBe(true);
    expect(faceless.createMaterial('chr.saitama', RECT)!.userData.roster.faceMap.value).toBe(null);
    faceless.dispose();

    stubNetworkExcept(['orm.mobile.png']);
    const structural = new RosterRuntime({ source });
    expect(await structural.load('chr.saitama')).toBe(false);
    expect(structural.isResident('chr.saitama')).toBe(false);
    expect(structural.failed.get('chr.saitama')).toBeDefined();
    expect(structural.failed.get('chr.saitama')).toContain('404');
    structural.dispose();
  });

  it('de-duplicates concurrent loads of the same character', async () => {
    const stubs = stubNetworkExcept();
    const runtime = new RosterRuntime({ source });

    // Two spawns in the same frame must not issue two sets of requests.
    const both = [runtime.load('chr.saitama'), runtime.load('chr.saitama')];
    expect(await Promise.all(both)).toEqual([true, true]);
    expect(stubs.fetched.length).toBe(4);

    // And once resident, nothing at all.
    expect(await runtime.load('chr.saitama')).toBe(true);
    expect(stubs.fetched.length).toBe(4);
    runtime.dispose();
  });

  it('refuses an unknown id without touching the network', async () => {
    const stubs = stubNetworkExcept();
    const runtime = new RosterRuntime({ source });
    expect(await runtime.load('chr.nope')).toBe(false);
    expect(stubs.fetched).toEqual([]);
    runtime.dispose();
  });

  it('accounts for what it decoded', async () => {
    const stubs = stubNetworkExcept([], 1024);
    const runtime = new RosterRuntime({ source });
    expect(await runtime.load('chr.saitama')).toBe(true);

    expect(runtime.residentIds).toEqual(['chr.saitama']);
    // Four maps at the stubbed bitmap size, mip chain included.
    expect(runtime.residentBytes).toBe(Math.round(1024 * 1024 * 4 * 1.34) * 4);
    expect(runtime.loadMs).toBeGreaterThanOrEqual(0);
    expect(stubs.fetched.length).toBe(4);
    runtime.dispose();
  });

  it('releases every decoded map on dispose and then stays shut', async () => {
    const stubs = stubNetworkExcept();
    const runtime = new RosterRuntime({ source });
    expect(await runtime.load('chr.saitama')).toBe(true);

    const disposed = vi.spyOn(THREE.Texture.prototype, 'dispose');
    runtime.dispose();
    expect(disposed).toHaveBeenCalledTimes(4);
    expect(runtime.residentIds).toEqual([]);

    // A disposed runtime is inert, not a fresh one.
    const after = stubs.fetched.length;
    expect(await runtime.load('chr.saitama')).toBe(false);
    expect(stubs.fetched.length).toBe(after);
  });
});

describe('roster runtime geometry', () => {
  it('prepares a foreign body with the character’s LOD0 plan', () => {
    // Every near-tier civilian is its own seed and its own LOD, but they all
    // sample ONE baked sheet, so the plan and the face rect must come from the
    // canonical LOD0 build rather than from the body in hand.
    const runtime = new RosterRuntime({ source });
    const canonical = runtime.buildGeometry('chr.civilian', 0);

    const foreign = buildRosterMesh(rosterEntry('chr.civilian'), 2);
    const faceRect = runtime.prepareForeign('chr.civilian', foreign);
    expect(faceRect).toBe(canonical.faceRect);

    const planned = prepareRosterGeometry(foreign);
    expect([...planned.plan.moves.entries()]).toEqual([
      ...prepareRosterGeometry(canonical.build).plan.moves.entries(),
    ]);
    expect(planned.unplanned).toEqual([]);

    foreign.geometry.dispose();
    canonical.build.geometry.dispose();
    runtime.dispose();
  });

  it('hands out one shared entry object per id', () => {
    // `rosterEntry` rebuilds the whole cast per call and `buildBody` asks four
    // times; entries are immutable, so the runtime memoises them.
    const runtime = new RosterRuntime({ source });
    const first = runtime.buildBody('chr.saitama', 2);
    const second = runtime.buildBody('chr.saitama', 2);
    expect(first.entry).toBe(second.entry);
    // No atlas is resident, so the caller gets a stand-in slot to fill later.
    expect(first.material).toBeUndefined();

    first.build.geometry.dispose();
    second.build.geometry.dispose();
    expect(() => runtime.buildBody('chr.nope', 2)).toThrow();
    runtime.dispose();
  });
});

describe('roster runtime materials', () => {
  it('builds a fresh material per call, with the injections the entry earns', async () => {
    stubNetworkExcept();
    const runtime = new RosterRuntime({ source });

    // Nothing to bind before the atlas lands.
    expect(runtime.createMaterial('chr.civilian', RECT)).toBeUndefined();

    expect(await runtime.load('chr.civilian')).toBe(true);
    const civilian = runtime.createMaterial('chr.civilian', RECT)!;
    // Crowd tint defaults on from `entry.crowd`; the dither is player-only.
    expect(civilian.userData.features).toContain('C');
    expect(civilian.userData.features).not.toContain('D');

    expect(await runtime.load('chr.saitama')).toBe(true);
    const player = runtime.createMaterial('chr.saitama', RECT, { proximityFade: true })!;
    expect(player.userData.features).toContain('D');

    // Expression is a per-material uniform: one shared material would make
    // every copy of a character blink at once.
    expect(runtime.createMaterial('chr.saitama', RECT)).not.toBe(
      runtime.createMaterial('chr.saitama', RECT)
    );
    runtime.dispose();
  });
});
