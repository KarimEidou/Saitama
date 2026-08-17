/**
 * TEST FIXTURES
 *
 * A miniature of the real `assets.runtime.json`, reproducing the two shapes
 * that matter:
 *
 *   - most assets exist at `mobile` ONLY, while `tiersBuilt` claims all three
 *     (in the shipped manifest, 153 of 166 outputs are mobile-only);
 *   - a handful exist at all three tiers, and those are exactly the files the
 *     Android package leaves out.
 *
 * `fakeFetch` serves that tree and can be told to withhold a tier, which is
 * what the APK does.
 */

import type { AnyAssetEntry, QualityTier } from '@/types';

export const ALL_TIERS: readonly QualityTier[] = ['mobile', 'high', 'ultra'];

function textureEntry(id: string, tiers: readonly QualityTier[], role: string): AnyAssetEntry {
  const dims: Record<QualityTier, number> = { mobile: 1024, high: 2048, ultra: 4096 };
  return {
    id,
    kind: 'texture',
    name: id,
    attribution: { license: 'CC0-1.0', author: 'test', sourceUrl: 'https://example.invalid' },
    sourceUrl: 'https://example.invalid',
    sha256: 'x',
    targetFormat: 'ktx2',
    role: role as 'albedo',
    colorSpace: role === 'albedo' ? 'srgb' : 'linear',
    compression: {},
    tileable: true,
    preload: false,
    outputs: tiers.map((tier) => ({
      tier,
      file: `tex/${id.replace(/\.[^.]+$/, '')}/${role}.${tier}.ktx2`,
      format: 'ktx2' as const,
      bytes: dims[tier] * 64,
      sha256: 'y',
      width: dims[tier],
      height: dims[tier],
      codec: 'etc1s' as const,
    })),
  } as AnyAssetEntry;
}

function materialEntry(id: string): AnyAssetEntry {
  return {
    id,
    kind: 'material',
    name: id,
    attribution: { license: 'CC0-1.0', author: 'test', sourceUrl: 'https://example.invalid' },
    sourceUrl: 'https://example.invalid',
    sha256: 'x',
    targetFormat: 'json',
    outputs: [],
    preload: true,
    spec: {
      id,
      kind: 'standard',
      color: 0xffffff,
      roughness: 1,
      metalness: 1,
      mapKey: `${id}.albedo`,
      normalMapKey: `${id}.normal`,
      ormMapKey: `${id}.orm`,
    },
    textureKeys: {
      albedo: `${id}.albedo`,
      normal: `${id}.normal`,
      orm: `${id}.orm`,
    },
    tileSizeMeters: 3,
  } as AnyAssetEntry;
}

function hdriEntry(id: string, tiers: readonly QualityTier[]): AnyAssetEntry {
  return {
    id,
    kind: 'hdri',
    name: id,
    attribution: { license: 'CC0-1.0', author: 'test', sourceUrl: 'https://example.invalid' },
    sourceUrl: 'https://example.invalid',
    sha256: 'x',
    targetFormat: 'ktx2',
    resolution: 4096,
    preload: false,
    outputs: tiers.map((tier) => ({
      tier,
      file: `env/${id}.${tier}.ktx2`,
      format: 'ktx2' as const,
      bytes: 2_500_000,
      sha256: 'y',
    })),
  } as AnyAssetEntry;
}

/**
 * The shipped manifest in miniature.
 *
 * `mat.road.asphalt.worn` is built at every tier (as in reality);
 * `mat.wall.plaster.beige` is mobile-only (as 153 of the real outputs are).
 */
export function testManifest(): Record<string, unknown> {
  const entries: AnyAssetEntry[] = [
    materialEntry('mat.road.asphalt.worn'),
    textureEntry('mat.road.asphalt.worn.albedo', ALL_TIERS, 'albedo'),
    textureEntry('mat.road.asphalt.worn.normal', ALL_TIERS, 'normal'),
    textureEntry('mat.road.asphalt.worn.orm', ALL_TIERS, 'orm'),
    materialEntry('mat.wall.plaster.beige'),
    textureEntry('mat.wall.plaster.beige.albedo', ['mobile'], 'albedo'),
    textureEntry('mat.wall.plaster.beige.normal', ['mobile'], 'normal'),
    textureEntry('mat.wall.plaster.beige.orm', ['mobile'], 'orm'),
    hdriEntry('hdri.sky.day', ALL_TIERS),
    hdriEntry('hdri.sky.night', ALL_TIERS),
  ];

  return {
    version: 1,
    generatedAt: '2026-08-17T07:32:33.207Z',
    generator: 'tools/process-assets.ts@1.0.0',
    generatedRoot: 'assets',
    // The live bug: all three claimed, only mobile packaged.
    tiersBuilt: ['mobile', 'high', 'ultra'],
    pipeline: { textureOrigin: 'bottom-left', flipY: false },
    environments: {
      'hdri.sky.day': {
        sh9: Array.from({ length: 27 }, (_unused, index) => index * 0.1),
        meanLuminance: 0.73268945997054,
        maxLuminance: 136998.2976,
      },
      'hdri.sky.night': {
        sh9: Array.from({ length: 27 }, () => 0.05),
        meanLuminance: 0.712214196645703,
        maxLuminance: 554.8064,
      },
    },
    entries,
  };
}

export function testCharacterIndex(): Record<string, unknown> {
  return {
    generatedRoot: 'chr',
    characters: [
      {
        id: 'chr.saitama',
        name: 'Saitama',
        kind: 'hero',
        height: 1.75,
        triangles: { lod0: 3456 },
        gpuBytes: { mobile: 4362097, high: 17448388 },
        files: [
          {
            key: 'chr.saitama.albedo',
            role: 'albedo',
            tier: 'mobile',
            file: 'chr/saitama/albedo.mobile.png',
            bytes: 109602,
            width: 512,
            height: 512,
          },
          {
            key: 'chr.saitama.albedo',
            role: 'albedo',
            tier: 'high',
            file: 'chr/saitama/albedo.high.png',
            bytes: 368970,
            width: 1024,
            height: 1024,
          },
          // No declared tier: must be recovered from the filename token.
          { key: 'chr.saitama.normal', role: 'normal', file: 'chr/saitama/normal.mobile.png' },
          // Tier-less source art: skipped rather than guessed.
          { key: 'chr.saitama.face', role: 'face', file: 'chr/saitama/face.png' },
        ],
      },
    ],
  };
}

/** Records every URL requested, so a test can assert nothing 404s. */
export interface IFakeFetchLog {
  readonly requests: string[];
  readonly notFound: string[];
}

export interface IFakeFetchOptions {
  /** Tiers the "package" actually contains. Others answer 404, like the APK. */
  readonly packagedTiers?: readonly QualityTier[];
  readonly manifest?: Record<string, unknown>;
  readonly characters?: Record<string, unknown> | null;
}

/**
 * A `fetch` over an in-memory asset tree.
 *
 * Binary bodies are 64 bytes of filler: nothing in these tests decodes a real
 * KTX2 (that is the browser harness's job), they only assert which URLs are
 * asked for and what happens when one is absent.
 */
export function fakeFetch(options: IFakeFetchOptions = {}): {
  fetchImpl: typeof fetch;
  log: IFakeFetchLog;
} {
  const packaged = options.packagedTiers ?? ALL_TIERS;
  const manifest = options.manifest ?? testManifest();
  const characters = options.characters === undefined ? testCharacterIndex() : options.characters;
  const log: IFakeFetchLog = { requests: [], notFound: [] };

  const respond = (body: unknown, status = 200): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      arrayBuffer: async () => new ArrayBuffer(64),
    }) as unknown as Response;

  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    log.requests.push(url);

    if (url.endsWith('assets.runtime.json')) return respond(manifest);
    if (url.endsWith('characters.runtime.json')) {
      if (characters === null) {
        log.notFound.push(url);
        return respond(undefined, 404);
      }
      return respond(characters);
    }

    const tier = ALL_TIERS.find((candidate) => url.includes(`.${candidate}.`));
    if (tier !== undefined && !packaged.includes(tier)) {
      log.notFound.push(url);
      return respond(undefined, 404);
    }
    return respond(undefined, 200);
  }) as unknown as typeof fetch;

  return { fetchImpl, log };
}
