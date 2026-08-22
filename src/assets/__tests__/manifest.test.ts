/**
 * MANIFEST AND CHARACTER-INDEX PARSING
 *
 * Both files are produced by other workstreams and shipped inside an APK, so
 * a shape change has to degrade rather than throw halfway through the boot
 * screen. These tests feed the parsers rubbish on purpose.
 */

import { describe, it, expect } from 'vitest';
import {
  emptyRuntimeManifest,
  materialTextureKeys,
  outputBytes,
  parseRuntimeManifest,
} from '../manifest';
import {
  CharacterIndex,
  indexCharacterFiles,
  parseCharacterIndex,
  parseRoleToken,
  parseTierToken,
} from '../characters';
import { testCharacterIndex, testManifest } from './fixtures';

describe('parseRuntimeManifest', () => {
  it('keeps the extension blocks the typed contract does not model', () => {
    const manifest = parseRuntimeManifest(testManifest());
    expect(manifest.tiersBuilt).toEqual(['mobile', 'high', 'ultra']);
    expect(manifest.pipeline?.textureOrigin).toBe('bottom-left');
    expect(Object.keys(manifest.environments)).toEqual(['hdri.sky.day', 'hdri.sky.night']);
  });

  it('drops an SH set that is not exactly 27 floats', () => {
    const raw = testManifest();
    (raw.environments as Record<string, { sh9: number[] }>)['hdri.sky.day']!.sh9 = [1, 2, 3];
    expect(parseRuntimeManifest(raw).environments['hdri.sky.day']?.sh9).toBeUndefined();
  });

  it('drops a zero or negative meanLuminance rather than dividing by it', () => {
    const raw = testManifest();
    (raw.environments as Record<string, { meanLuminance: number }>)['hdri.sky.day']!.meanLuminance =
      0;
    expect(parseRuntimeManifest(raw).environments['hdri.sky.day']?.meanLuminance).toBeUndefined();
  });

  it('falls back to the tiers the outputs actually mention', () => {
    const raw = { ...testManifest(), tiersBuilt: undefined };
    expect(parseRuntimeManifest(raw).tiersBuilt).toEqual(
      expect.arrayContaining(['mobile', 'high', 'ultra'])
    );
  });

  it('treats a manifest with nothing in it as mobile-only, not as an error', () => {
    for (const junk of [null, undefined, 42, 'nope', {}, { entries: 'no' }]) {
      const manifest = parseRuntimeManifest(junk);
      expect(manifest.entries).toEqual([]);
      expect(manifest.tiersBuilt).toEqual(['mobile']);
    }
  });

  it('skips entries with no id or kind', () => {
    const manifest = parseRuntimeManifest({
      entries: [{ id: 'ok', kind: 'texture', outputs: [] }, { kind: 'texture' }, null, 7],
    });
    expect(manifest.entries.map((entry) => entry.id)).toEqual(['ok']);
  });

  it('gives every entry an outputs array, whatever the generator emitted', () => {
    // Every reader dereferences `outputs` unguarded — `tier.ts` does
    // `entry.outputs.map(...)` from `estimateBytes`, which `preloadCore` calls
    // OUTSIDE any try. One row without it killed the boot with a TypeError.
    const manifest = parseRuntimeManifest({
      entries: [
        { id: 'no-outputs', kind: 'texture' },
        { id: 'junk-outputs', kind: 'texture', outputs: 'nope' },
        {
          id: 'junk-rows',
          kind: 'texture',
          outputs: [null, 7, { tier: 'mobile', file: 'a.ktx2' }],
        },
      ],
    });
    expect(manifest.entries.map((entry) => entry.outputs)).toEqual([
      [],
      [],
      [{ tier: 'mobile', file: 'a.ktx2' }],
    ]);
    expect(() => manifest.entries.map((entry) => entry.outputs.map((o) => o.tier))).not.toThrow();
  });

  it('exposes an empty manifest for the no-index case', () => {
    expect(emptyRuntimeManifest().entries).toEqual([]);
  });
});

describe('manifest queries', () => {
  const manifest = parseRuntimeManifest(testManifest());

  it('reports the bytes of one tier of one asset', () => {
    const entry = manifest.entries.find((candidate) => candidate.id === 'hdri.sky.day');
    expect(outputBytes(entry!, 'mobile')).toBe(2_500_000);
    expect(outputBytes(entry!, 'ultra')).toBe(2_500_000);
  });

  it('lists the textures a material needs', () => {
    const entry = manifest.entries.find((candidate) => candidate.id === 'mat.road.asphalt.worn');
    expect(materialTextureKeys(entry!)).toEqual([
      'mat.road.asphalt.worn.albedo',
      'mat.road.asphalt.worn.normal',
      'mat.road.asphalt.worn.orm',
    ]);
  });

  it('returns nothing for a non-material', () => {
    const entry = manifest.entries.find((candidate) => candidate.id === 'hdri.sky.day');
    expect(materialTextureKeys(entry!)).toEqual([]);
  });
});

describe('character filename tokens', () => {
  it('reads the tier from between the dots', () => {
    expect(parseTierToken('chr/saitama/albedo.mobile.png')).toBe('mobile');
    expect(parseTierToken('chr/saitama/normal.high.png')).toBe('high');
    expect(parseTierToken('chr/saitama/face.png')).toBeUndefined();
  });

  it('is not fooled by a directory that contains a tier name', () => {
    expect(parseTierToken('chr/mobile-hero/face.png')).toBeUndefined();
  });

  it('reads the role from the filename head', () => {
    expect(parseRoleToken('chr/genos/emissive.high.png')).toBe('emissive');
    expect(parseRoleToken('chr/civilian/mask.mobile.png')).toBe('mask');
    expect(parseRoleToken('chr/genos/vat.bin')).toBeUndefined();
  });
});

describe('parseCharacterIndex', () => {
  const records = parseCharacterIndex(testCharacterIndex());

  it('reads the declared tier and recovers the undeclared one from the name', () => {
    const files = records[0]!.files;
    expect(files.map((file) => `${file.role}:${file.tier}`)).toEqual([
      'albedo:mobile',
      'albedo:high',
      'normal:mobile',
    ]);
  });

  it('skips tier-less source art rather than guessing a tier for it', () => {
    expect(records[0]!.files.some((file) => file.file.endsWith('face.png'))).toBe(false);
  });

  it('derives the directory and model path from the listed files', () => {
    expect(records[0]!.dir).toBe('chr/saitama');
    expect(records[0]!.modelFile).toBe('chr/saitama/model.glb');
  });

  it('advertises the VAT sidecars only when the bake declared one', () => {
    // `vatFile` is typed optional so a crowd system can do
    // `if (record.vatFile !== undefined) fetchFile(record.vatFile)`. Naming the
    // path unconditionally turned "this character has no VAT" into a 404 the
    // caller could not tell from a file missing out of the package.
    expect(records[0]!.vatFile).toBeUndefined();
    expect(records[0]!.vatMetaFile).toBeUndefined();

    const raw = testCharacterIndex();
    const characters = raw.characters as Record<string, unknown>[];
    characters[0]!.vat = { bytes: 435456, width: 81, height: 672, clips: 21 };
    const baked = parseCharacterIndex(raw)[0]!;
    expect(baked.vatFile).toBe('chr/saitama/vat.bin');
    expect(baked.vatMetaFile).toBe('chr/saitama/vat.json');
  });

  it('returns nothing for junk instead of throwing', () => {
    for (const junk of [null, undefined, {}, { characters: 'no' }, { characters: [null, 3] }]) {
      expect(parseCharacterIndex(junk)).toEqual([]);
    }
  });
});

describe('indexCharacterFiles', () => {
  it('skips a path with no directory rather than inventing a character', () => {
    // A listing already relative to the character folder. `lastIndexOf('/')`
    // returns -1 and `slice(0, -1)` drops the last character, which produced
    // the id `chr.albedo.mobile.pn` and a model URL that could only 404.
    expect(indexCharacterFiles(['albedo.mobile.png', 'normal.mobile.png'])).toEqual([]);
  });

  it('names the VAT sidecars only when the listing contains them', () => {
    // Sorted by id, so civilian (no VAT in the listing) comes first.
    const [civilian, genos] = indexCharacterFiles([
      'chr/genos/albedo.mobile.png',
      'chr/genos/vat.bin',
      'chr/civilian/albedo.mobile.png',
    ]);
    expect(civilian?.id).toBe('chr.civilian');
    expect(civilian?.vatFile).toBeUndefined();
    expect(genos?.id).toBe('chr.genos');
    expect(genos?.vatFile).toBe('chr/genos/vat.bin');
    expect(genos?.vatMetaFile).toBe('chr/genos/vat.json');
  });

  it('builds an index from bare paths using the tier token alone', () => {
    const records = indexCharacterFiles([
      'chr/mook.wolf/albedo.mobile.png',
      'chr/mook.wolf/normal.mobile.png',
      'chr/mook.wolf/albedo.high.png',
      'chr/mook.wolf/model.glb',
      'chr/genos/emissive.high.png',
    ]);
    expect(records.map((record) => record.id)).toEqual(['chr.genos', 'chr.mook.wolf']);
    const wolf = records.find((record) => record.id === 'chr.mook.wolf')!;
    expect(wolf.files).toHaveLength(3);
    expect(wolf.dir).toBe('chr/mook.wolf');
  });
});

describe('CharacterIndex', () => {
  const index = new CharacterIndex(parseCharacterIndex(testCharacterIndex()));

  it('lists the tiers a character actually has', () => {
    expect(index.tiersFor('chr.saitama')).toEqual(['mobile', 'high']);
  });

  it('downgrades ultra to the best tier the bake produced', () => {
    const files = index.filesFor('chr.saitama', 'ultra');
    expect(files.every((file) => file.tier === 'high')).toBe(true);
  });

  it('serves the mobile set on the mobile tier', () => {
    const files = index.filesFor('chr.saitama', 'mobile');
    expect(files.map((file) => file.role).sort()).toEqual(['albedo', 'normal']);
  });

  it('reports nothing for an unknown character', () => {
    expect(index.filesFor('chr.nobody', 'mobile')).toEqual([]);
    expect(index.has('chr.nobody')).toBe(false);
  });
});
