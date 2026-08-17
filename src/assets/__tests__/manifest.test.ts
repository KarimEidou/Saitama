/**
 * MANIFEST AND CHARACTER-INDEX PARSING
 *
 * Both files are produced by other workstreams and shipped inside an APK, so
 * a shape change has to degrade rather than throw halfway through the boot
 * screen. These tests feed the parsers rubbish on purpose.
 */

import { describe, it, expect } from 'vitest';
import { emptyRuntimeManifest, materialTextureKeys, outputBytes, parseRuntimeManifest } from '../manifest';
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
    (raw.environments as Record<string, { meanLuminance: number }>)['hdri.sky.day']!
      .meanLuminance = 0;
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
    const entry = manifest.entries.find(
      (candidate) => candidate.id === 'mat.road.asphalt.worn'
    );
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
    expect(records[0]!.vatMetaFile).toBe('chr/saitama/vat.json');
  });

  it('returns nothing for junk instead of throwing', () => {
    for (const junk of [null, undefined, {}, { characters: 'no' }, { characters: [null, 3] }]) {
      expect(parseCharacterIndex(junk)).toEqual([]);
    }
  });
});

describe('indexCharacterFiles', () => {
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
