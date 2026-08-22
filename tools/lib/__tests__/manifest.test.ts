/**
 * SOURCE-MANIFEST VALIDATION AND COMPILATION
 *
 * `manifest.ts` promises to "VALIDATE every field, hard, before a single byte
 * is downloaded". These cover the four places it did not:
 *
 *   1. A MISSING manifest file loaded silently. `models.json` lost to a bad
 *      merge meant 45 entries instead of 84, which is not a subset run — so
 *      the committed lockfile was rewritten without the 39 model entries and
 *      ~200 sha256 anchors, reported as success.
 *   2. `codec` was never checked, so a typo'd `"uastch"` cost a full 1.774 GB
 *      fetch before the KTX2 encoder rejected it, and `targetFormat` was only
 *      checked for truthiness, never against the entry's kind.
 *   3. Duplicate file paths were rejected within one entry but not across
 *      entries, where two entries fight over one materialised file.
 *   4. `buildAssetManifest` rebuilt a material's `textureKeys` purely from its
 *      downloaded files, silently dropping the keys a PROCEDURAL material
 *      declares — which validation explicitly permits it to declare.
 *
 * Plus the subset-run protection `manifest.resolved.json` was missing: it is
 * the only input `assets:process` reads, so a `--only` run used to overwrite
 * it with the handful of entries it touched.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAssetManifest, loadSourceManifests, mergeAssetManifests } from '../manifest.ts';
import type {
  IFetchedEntry,
  IMaterialSourceEntry,
  ISourceFile,
  ISourceManifest,
} from '../types.ts';

const MD5 = 'a'.repeat(32);
const ATTRIBUTION = {
  license: 'CC0-1.0',
  author: 'nobody',
  sourceUrl: 'https://example.test/asset',
} as const;

function textureFile(role: 'albedo' | 'normal', filePath: string): ISourceFile {
  return {
    key: role,
    role,
    colorSpace: role === 'albedo' ? 'srgb' : 'linear',
    path: filePath,
    url: `https://example.test/${filePath}`,
    md5: MD5,
    bytes: 1024,
    format: 'jpg',
  };
}

function material(id: string, files: readonly ISourceFile[]): IMaterialSourceEntry {
  return {
    id,
    kind: 'material',
    name: id,
    provider: 'polyhaven',
    providerAssetId: id.replaceAll('.', '_'),
    targetFormat: 'json',
    attribution: ATTRIBUTION,
    sourceUrl: ATTRIBUTION.sourceUrl,
    tags: [],
    tiers: { mobile: { maxDimension: 1024, codec: 'etc1s', quality: 80 } },
    files,
    spec: { id, kind: 'standard' },
    textureKeys: Object.fromEntries(files.map((f) => [f.role, `${id}.${String(f.role)}`])),
  };
}

const TEXTURES: ISourceManifest = {
  version: 1,
  kind: 'material',
  generator: 'test',
  entries: [material('mat.test', [textureFile('albedo', 'textures/test/albedo.jpg')])],
};

const MODELS: ISourceManifest = {
  version: 1,
  kind: 'model',
  generator: 'test',
  entries: [
    {
      id: 'model.test',
      kind: 'model',
      name: 'model.test',
      provider: 'polyhaven',
      providerAssetId: 'model_test',
      targetFormat: 'glb',
      attribution: ATTRIBUTION,
      sourceUrl: ATTRIBUTION.sourceUrl,
      tags: [],
      tiers: {},
      files: [
        {
          key: 'gltf',
          path: 'models/test/test.gltf',
          url: 'https://example.test/test.gltf',
          md5: MD5,
          bytes: 512,
          format: 'gltf',
          root: true,
        },
      ],
    },
  ],
};

const HDRIS: ISourceManifest = {
  version: 1,
  kind: 'hdri',
  generator: 'test',
  entries: [
    {
      id: 'hdri.test',
      kind: 'hdri',
      name: 'hdri.test',
      provider: 'polyhaven',
      providerAssetId: 'hdri_test',
      targetFormat: 'hdr',
      attribution: ATTRIBUTION,
      sourceUrl: ATTRIBUTION.sourceUrl,
      tags: [],
      tiers: {},
      resolution: 4096,
      files: [
        {
          key: 'hdr',
          path: 'hdris/test_4k.hdr',
          url: 'https://example.test/test_4k.hdr',
          md5: MD5,
          bytes: 2048,
          format: 'hdr',
          root: true,
        },
      ],
    },
  ],
};

const dirs: string[] = [];

/** Write a manifest directory; omit a key to leave that file out entirely. */
async function manifestDir(files: Partial<Record<string, unknown>>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-test-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue;
    await writeFile(path.join(dir, name), JSON.stringify(content, null, 2));
  }
  return dir;
}

const complete = (
  overrides: Partial<Record<'textures.json' | 'models.json' | 'hdris.json', unknown>> = {}
): Partial<Record<string, unknown>> => ({
  'textures.json': TEXTURES,
  'models.json': MODELS,
  'hdris.json': HDRIS,
  ...overrides,
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadSourceManifests', () => {
  it('loads a complete manifest set', async () => {
    const loaded = await loadSourceManifests(await manifestDir(complete()));
    expect(loaded.entries.map((entry) => entry.id).sort()).toEqual([
      'hdri.test',
      'mat.test',
      'model.test',
    ]);
    expect(loaded.totalFiles).toBe(3);
  });

  it('fails when a required manifest is absent instead of loading a subset', async () => {
    const dir = await manifestDir({ 'textures.json': TEXTURES, 'hdris.json': HDRIS });
    await expect(loadSourceManifests(dir)).rejects.toThrow(/models\.json: required manifest/);
  });

  it('rejects an unknown texture codec before anything downloads', async () => {
    const broken = {
      ...TEXTURES,
      entries: [
        {
          ...TEXTURES.entries[0],
          tiers: { mobile: { maxDimension: 1024, codec: 'uastch', quality: 80 } },
        },
      ],
    };
    const dir = await manifestDir(complete({ 'textures.json': broken }));
    await expect(loadSourceManifests(dir)).rejects.toThrow(/codec must be one of/);
  });

  it('rejects a zstdLevel outside 1..22', async () => {
    const broken = {
      ...TEXTURES,
      entries: [
        {
          ...TEXTURES.entries[0],
          tiers: { mobile: { maxDimension: 1024, codec: 'etc1s', quality: 80, zstdLevel: 30 } },
        },
      ],
    };
    const dir = await manifestDir(complete({ 'textures.json': broken }));
    await expect(loadSourceManifests(dir)).rejects.toThrow(/zstdLevel must be an integer 1\.\.22/);
  });

  it('rejects a targetFormat that does not belong to the kind', async () => {
    const broken = {
      ...MODELS,
      entries: [{ ...MODELS.entries[0], targetFormat: 'json' }],
    };
    const dir = await manifestDir(complete({ 'models.json': broken }));
    await expect(loadSourceManifests(dir)).rejects.toThrow(/is not valid for a model entry/);
  });

  it('rejects two entries claiming the same materialised path', async () => {
    const clash = {
      ...TEXTURES,
      entries: [
        TEXTURES.entries[0],
        material('mat.other', [textureFile('albedo', 'textures/test/albedo.jpg')]),
      ],
    };
    const dir = await manifestDir(complete({ 'textures.json': clash }));
    await expect(loadSourceManifests(dir)).rejects.toThrow(/is already claimed by mat\.test/);
  });
});

/* -------------------------------------------------------------------------- */
/* Compilation                                                                */
/* -------------------------------------------------------------------------- */

function fetchedMaterial(entry: IMaterialSourceEntry): IFetchedEntry {
  return {
    entry,
    files: entry.files.map((file) => ({
      file,
      sha256: `sha-${file.path}`,
      md5: file.md5,
      bytes: file.bytes,
      cached: true,
      transferred: 0,
    })),
    digest: `digest-${entry.id}`,
    bytes: entry.files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

describe('buildAssetManifest', () => {
  it('keeps the textureKeys a procedural material declares', () => {
    const procedural: IMaterialSourceEntry = {
      ...material('mat.proc', []),
      provider: 'procedural',
      textureKeys: { alpha: 'mat.proc.alpha' },
    };
    const manifest = buildAssetManifest([fetchedMaterial(procedural)]);
    const compiled = manifest.entries.find((entry) => entry.id === 'mat.proc');

    expect(compiled?.kind).toBe('material');
    expect(compiled?.kind === 'material' ? compiled.textureKeys : undefined).toEqual({
      alpha: 'mat.proc.alpha',
    });
  });

  it('still derives textureKeys from the files a downloaded material ships', () => {
    const downloaded = material('mat.test', [
      textureFile('albedo', 'textures/test/albedo.jpg'),
      textureFile('normal', 'textures/test/normal.jpg'),
    ]);
    const manifest = buildAssetManifest([fetchedMaterial(downloaded)]);
    const compiled = manifest.entries.find((entry) => entry.id === 'mat.test');

    expect(compiled?.kind === 'material' ? compiled.textureKeys : undefined).toEqual({
      albedo: 'mat.test.albedo',
      normal: 'mat.test.normal',
    });
    expect(manifest.entries.map((entry) => entry.id).sort()).toEqual([
      'mat.test',
      'mat.test.albedo',
      'mat.test.normal',
    ]);
  });
});

describe('mergeAssetManifests', () => {
  const twoMaps = material('mat.test', [
    textureFile('albedo', 'textures/test/albedo.jpg'),
    textureFile('normal', 'textures/test/normal.jpg'),
  ]);
  const otherMaterial = material('mat.other', [textureFile('albedo', 'textures/other/albedo.jpg')]);

  it('carries entries a subset run did not rebuild forward', () => {
    const previous = buildAssetManifest([fetchedMaterial(twoMaps), fetchedMaterial(otherMaterial)]);
    const subset = buildAssetManifest([fetchedMaterial(twoMaps)]);

    const merged = mergeAssetManifests(previous, subset);

    expect(merged.entries.map((entry) => entry.id).sort()).toEqual(
      previous.entries.map((entry) => entry.id).sort()
    );
  });

  it('does not resurrect a texture row the rebuilt material dropped', () => {
    const previous = buildAssetManifest([fetchedMaterial(twoMaps)]);
    const oneMap = material('mat.test', [textureFile('albedo', 'textures/test/albedo.jpg')]);

    const merged = mergeAssetManifests(previous, buildAssetManifest([fetchedMaterial(oneMap)]));

    expect(merged.entries.map((entry) => entry.id).sort()).toEqual(['mat.test', 'mat.test.albedo']);
  });

  it('is a no-op without a previous manifest', () => {
    const next = buildAssetManifest([fetchedMaterial(twoMaps)]);
    expect(mergeAssetManifests(undefined, next)).toBe(next);
  });
});
