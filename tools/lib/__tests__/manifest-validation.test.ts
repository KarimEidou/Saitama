/**
 * MANIFEST VALIDATION — MALFORMED INPUT AND THE LICENCE GATE
 *
 * `manifest.ts` promises to "VALIDATE every field, hard, before a single byte
 * is downloaded" and to report "EVERY problem found, not just the first". Both
 * promises used to break on the one input the module exists to police — a
 * hand-edited JSON file with something structurally missing:
 *
 *   material entry with no `files`  ->  TypeError: … (reading 'map')
 *   entries: [null]                 ->  TypeError: … (reading 'id')
 *
 * Neither is a `ManifestValidationError`, so the top-level handler in
 * `fetch-assets.ts` printed a bare JavaScript message with no manifest name, no
 * entry id and none of the other problems. These pin the narrowed behaviour.
 *
 * The same file pins the licence gate (`ALLOWED_LICENSES` /
 * `FORBIDDEN_LICENSE_PATTERNS`), which is a legal-risk control — a GPL texture
 * in a closed APK is not a bug anyone gets to find in QA — and shipped with no
 * tests at all.
 *
 * Every case writes ALL THREE manifest files: a missing one is itself a hard
 * error, so a fixture that wrote only `textures.json` would fail for the wrong
 * reason.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestValidationError, loadSourceManifests } from '../manifest.ts';

const MD5 = 'a'.repeat(32);
const ATTRIBUTION = { license: 'CC0-1.0', author: 'A', sourceUrl: 'https://example.test/a' };

/** A procedural material that loads cleanly, used as the "valid" baseline. */
const MATERIAL: Record<string, unknown> = {
  id: 'mat.test.one',
  kind: 'material',
  name: 'N',
  provider: 'procedural',
  providerAssetId: 'test',
  targetFormat: 'json',
  attribution: ATTRIBUTION,
  sourceUrl: 'https://example.test/a',
  tags: [],
  tiers: {},
  files: [],
  spec: { id: 'mat.test.one' },
  textureKeys: {},
};

const MODEL: Record<string, unknown> = {
  id: 'model.test.one',
  kind: 'model',
  name: 'N',
  provider: 'polyhaven',
  providerAssetId: 'model_test',
  targetFormat: 'glb',
  attribution: ATTRIBUTION,
  sourceUrl: 'https://example.test/a',
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
};

const HDRI: Record<string, unknown> = {
  id: 'hdri.test.one',
  kind: 'hdri',
  name: 'N',
  provider: 'polyhaven',
  providerAssetId: 'hdri_test',
  targetFormat: 'hdr',
  attribution: ATTRIBUTION,
  sourceUrl: 'https://example.test/a',
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
};

/** A downloaded (non-procedural) material, for the per-file checks. */
function downloadedMaterial(files: readonly unknown[]): Record<string, unknown> {
  return {
    ...MATERIAL,
    provider: 'polyhaven',
    providerAssetId: 'mat_test',
    files,
    textureKeys: {},
  };
}

function textureFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'albedo',
    role: 'albedo',
    colorSpace: 'srgb',
    path: 'textures/test/albedo.jpg',
    url: 'https://example.test/albedo.jpg',
    md5: MD5,
    bytes: 1024,
    format: 'jpg',
    ...overrides,
  };
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Write a complete three-file manifest directory and return its path. */
async function manifestDir(
  textures: readonly unknown[] = [MATERIAL],
  models: readonly unknown[] = [MODEL],
  hdris: readonly unknown[] = [HDRI]
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manifest-validation-'));
  dirs.push(dir);
  const files: readonly [string, string, readonly unknown[]][] = [
    ['textures.json', 'material', textures],
    ['models.json', 'model', models],
    ['hdris.json', 'hdri', hdris],
  ];
  for (const [name, kind, entries] of files) {
    await writeFile(
      path.join(dir, name),
      JSON.stringify({ version: 1, kind, generator: 'test', entries }, null, 2)
    );
  }
  return dir;
}

/** Load and return the error, so a test can assert on its concrete class. */
async function failureOf(dir: string): Promise<unknown> {
  try {
    await loadSourceManifests(dir);
  } catch (error) {
    return error;
  }
  throw new Error('expected loadSourceManifests to reject, but it resolved');
}

describe('malformed entries reach the caller as ManifestValidationError', () => {
  it('reports a material with no files list instead of throwing a TypeError', async () => {
    const broken = { ...MATERIAL };
    delete broken.files;
    const error = await failureOf(await manifestDir([broken]));

    expect(error).toBeInstanceOf(ManifestValidationError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as ManifestValidationError).problems).toContainEqual(
      expect.stringMatching(/files must be an array/)
    );
  });

  it('reports a null entry instead of throwing a TypeError', async () => {
    const error = await failureOf(await manifestDir([null]));

    expect(error).toBeInstanceOf(ManifestValidationError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as ManifestValidationError).problems).toContainEqual(
      expect.stringMatching(/must be an object/)
    );
  });

  it('reports an hdri with no files list instead of throwing a TypeError', async () => {
    const broken = { ...HDRI };
    delete broken.files;
    const error = await failureOf(await manifestDir([MATERIAL], [MODEL], [broken]));

    expect(error).toBeInstanceOf(ManifestValidationError);
    expect(error).not.toBeInstanceOf(TypeError);
    expect((error as ManifestValidationError).problems).toContainEqual(
      expect.stringMatching(/files must be an array/)
    );
  });
});

describe('a valid manifest set', () => {
  it('loads, and its totals are the declared sums', async () => {
    const loaded = await loadSourceManifests(await manifestDir());

    expect(loaded.entries.map((entry) => entry.id).sort()).toEqual([
      'hdri.test.one',
      'mat.test.one',
      'model.test.one',
    ]);
    // The procedural material declares no files, so only the model and the
    // hdri contribute.
    expect(loaded.totalFiles).toBe(2);
    expect(loaded.totalBytes).toBe(512 + 2048);
  });
});

describe('licence gate', () => {
  it.each(['GPL-3.0', 'CC-BY-NC-4.0'])('rejects %s outright', async (license) => {
    const entry = { ...MATERIAL, attribution: { ...ATTRIBUTION, license } };
    await expect(loadSourceManifests(await manifestDir([entry]))).rejects.toThrow(
      /copyleft|share-alike|non-commercial/
    );
  });

  it('demands an attributionUrl for an attribution licence', async () => {
    const entry = { ...MATERIAL, attribution: { ...ATTRIBUTION, license: 'CC-BY-4.0' } };
    await expect(loadSourceManifests(await manifestDir([entry]))).rejects.toThrow(/attributionUrl/);
  });
});

describe('structural checks', () => {
  it('rejects the same id declared in two manifest files', async () => {
    const clash = { ...MODEL, id: MATERIAL.id };
    await expect(loadSourceManifests(await manifestDir([MATERIAL], [clash]))).rejects.toThrow(
      /duplicate id/
    );
  });

  it("rejects an albedo declared 'linear'", async () => {
    const entry = downloadedMaterial([textureFile({ colorSpace: 'linear' })]);
    await expect(loadSourceManifests(await manifestDir([entry]))).rejects.toThrow(/must be 'srgb'/);
  });

  it("rejects a normal map declared 'srgb'", async () => {
    const entry = downloadedMaterial([
      textureFile({ key: 'normal', role: 'normal', colorSpace: 'srgb' }),
    ]);
    await expect(loadSourceManifests(await manifestDir([entry]))).rejects.toThrow(
      /must be 'linear'/
    );
  });

  it('rejects two files in one entry sharing a path', async () => {
    const entry = downloadedMaterial([
      textureFile(),
      textureFile({ key: 'normal', role: 'normal', colorSpace: 'linear' }),
    ]);
    await expect(loadSourceManifests(await manifestDir([entry]))).rejects.toThrow(
      /duplicate file path/
    );
  });

  it('rejects an md5 that is not 32 hex chars', async () => {
    const entry = downloadedMaterial([textureFile({ md5: 'a'.repeat(31) })]);
    await expect(loadSourceManifests(await manifestDir([entry]))).rejects.toThrow(
      /32 lowercase hex/
    );
  });

  it('rejects a path that escapes the source tree', async () => {
    const entry = downloadedMaterial([textureFile({ path: '../escape.jpg' })]);
    await expect(loadSourceManifests(await manifestDir([entry]))).rejects.toThrow(/free of ".."/);
  });
});
