/**
 * THE CAST, THE CROWD, AND THE LICENCE
 *
 * Three things this file refuses to let regress:
 *
 *   1. The roster is COMPLETE — four heroes, a civilian, four named monsters
 *      and every threat tier — and every entry fits the triangle budget the
 *      mesh workstream enforces.
 *   2. The crowd is CHEAP and VARIED: one shared sheet, deterministic
 *      per-instance colour, no clones.
 *   3. The committed manifest declares ZERO third-party character assets and
 *      records an author for every CC0 texture the bake consumed. That is a
 *      shipping requirement, not a nicety, and it is mechanically checkable.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ThreatTier } from '@/types';
import { LOD_BUDGET } from '@/characters/mesh';
import { buildCrowdAttributes, crowdColors, distinctCrowdPalettes } from '../crowd';
import { entryAssetIds, entryGlows, materialSpecFor } from '../manifest';
import { THREAT_TIERS, mookEntry } from '../monsters';
import { buildRosterMesh, entryClasses, listRoster, rosterIds } from '../roster';
import { detailMaterialIds, resolveSurfaces } from '../surfaces';

const MANIFEST = path.resolve(import.meta.dirname, '../../../../tools/manifest/characters.json');

interface ManifestFile {
  readonly thirdPartyCharacterAssets: number;
  readonly cc0Attribution: Record<string, { license: string; author: string; sourceUrl: string }>;
  readonly entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly attribution: { license: string; author: string };
    readonly cc0Textures: readonly string[];
    readonly materialKeys: readonly string[];
    readonly triangles: number;
    readonly textures: readonly { id: string; colorSpace: string }[];
  }[];
}

function manifest(): ManifestFile {
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestFile;
}

describe('the cast', () => {
  it('covers heroes, a civilian, the named monsters and every threat tier', () => {
    const roster = listRoster();
    const ids = rosterIds();
    expect(ids).toContain('chr.saitama');
    expect(ids).toContain('chr.genos');
    expect(ids).toContain('chr.tatsumaki');
    expect(ids).toContain('chr.mumenRider');
    expect(ids).toContain('chr.civilian');
    expect(ids).toContain('chr.mosquitoGirl');
    expect(ids).toContain('chr.vaccineMan');
    expect(ids).toContain('chr.deepSeaKing');
    expect(ids).toContain('chr.boros');

    const tiers = new Set(roster.map((entry) => entry.threat).filter(Boolean));
    for (const tier of THREAT_TIERS) expect(tiers).toContain(tier);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives exactly one character the player flag and the dither that goes with it', () => {
    const players = listRoster().filter((entry) => entry.player === true);
    expect(players.length).toBe(1);
    expect(players[0]!.id).toBe('chr.saitama');
  });

  it('fits the triangle budget the mesh workstream enforces, at every LOD', () => {
    for (const entry of listRoster()) {
      for (const lod of [0, 1, 2] as const) {
        const build = buildRosterMesh(entry, lod);
        expect(build.stats.triangles, `${entry.id} LOD${lod}`).toBeLessThanOrEqual(LOD_BUDGET[lod]);
        build.geometry.dispose();
      }
    }
  });

  it('spans a real range of silhouettes', () => {
    const heights = listRoster().map((entry) => {
      const build = buildRosterMesh(entry, 2);
      const height = build.stats.height;
      build.geometry.dispose();
      return height;
    });
    expect(Math.min(...heights)).toBeLessThan(1.6);
    expect(Math.max(...heights)).toBeGreaterThan(3);
  });

  it('resolves a complete surface table for every class a character uses', () => {
    for (const entry of listRoster()) {
      const styles = resolveSurfaces(entry.surfaces);
      for (const surface of entryClasses(entry)) {
        const style = styles[surface];
        expect(style.roughness).toBeGreaterThan(0);
        expect(style.roughness).toBeLessThanOrEqual(1);
        expect(style.metalness).toBeGreaterThanOrEqual(0);
        expect(style.metalness).toBeLessThanOrEqual(1);
        expect(style.detail.tiles).toBeGreaterThan(0);
      }
    }
  });

  it('generates the same mook every time from a tier and a seed', () => {
    for (const tier of THREAT_TIERS) {
      const a = mookEntry(tier as ThreatTier, 4242);
      const b = mookEntry(tier as ThreatTier, 4242);
      expect(a.recipe.profile).toEqual(b.recipe.profile);
      expect(a.colors).toEqual(b.colors);
      const other = mookEntry(tier as ThreatTier, 99);
      expect(other.recipe.profile.height).not.toBe(a.recipe.profile.height);
    }
  });

  it('scales mass with threat tier', () => {
    const heights = THREAT_TIERS.map(
      (tier) => mookEntry(tier as ThreatTier, 7).recipe.profile.height
    );
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]!, `${THREAT_TIERS[i]} vs ${THREAT_TIERS[i - 1]}`).toBeGreaterThan(
        heights[i - 1]!
      );
    }
  });
});

describe('crowd tinting', () => {
  it('is deterministic per seed', () => {
    const a = buildCrowdAttributes(64, 11);
    const b = buildCrowdAttributes(64, 11);
    expect(Array.from(a.cloth)).toEqual(Array.from(b.cloth));
    expect(Array.from(a.seeds)).toEqual(Array.from(b.seeds));
  });

  it('dresses a crowd without cloning it', () => {
    const attributes = buildCrowdAttributes(220, 4242);
    expect(distinctCrowdPalettes(attributes)).toBeGreaterThan(150);
  });

  it('writes linear colours in range', () => {
    const attributes = buildCrowdAttributes(32, 5);
    for (const array of [attributes.skin, attributes.cloth, attributes.accent, attributes.hair]) {
      for (const value of array) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reproduces one civilian from a seed alone', () => {
    expect(crowdColors(1234).cloth.getHex()).toBe(crowdColors(1234).cloth.getHex());
    expect(crowdColors(1234).cloth.getHex()).not.toBe(crowdColors(9999).cloth.getHex());
  });
});

describe('the committed manifest', () => {
  it('declares every roster character', () => {
    const declared = new Set(manifest().entries.map((entry) => entry.id));
    for (const id of rosterIds())
      expect(declared, `${id} missing from characters.json`).toContain(id);
  });

  it('claims — and can back — zero third-party character assets', () => {
    const file = manifest();
    expect(file.thirdPartyCharacterAssets).toBe(0);
    for (const entry of file.entries) {
      expect(entry.attribution.license.length).toBeGreaterThan(0);
      expect(entry.attribution.author.length).toBeGreaterThan(0);
      // Nothing in the roster may claim provenance from a third-party model.
      expect(entry.attribution.author.toLowerCase()).not.toContain('mixamo');
    }
  });

  it('records an author and a licence for every CC0 texture the bake consumes', () => {
    const file = manifest();
    for (const entry of file.entries) {
      for (const id of entry.cc0Textures) {
        const credit = file.cc0Attribution[id];
        expect(credit, `${entry.id} uses ${id} with no recorded attribution`).toBeDefined();
        expect(credit!.license).toBe('CC0-1.0');
        expect(credit!.author.length).toBeGreaterThan(0);
        expect(credit!.sourceUrl.startsWith('http')).toBe(true);
      }
    }
  });

  it('only references CC0 ids the surface tables actually name', () => {
    const known = new Set(detailMaterialIds(resolveSurfaces()));
    for (const entry of manifest().entries) {
      for (const id of entry.cc0Textures) expect(known).toContain(id);
    }
  });

  it('describes each character with a material spec that binds real maps', () => {
    for (const entry of listRoster()) {
      const spec = materialSpecFor(entry);
      expect(spec.mapKey).toBe(`${entry.id}.albedo`);
      expect(spec.normalMapKey).toBe(`${entry.id}.normal`);
      expect(spec.ormMapKey).toBe(`${entry.id}.orm`);
      expect(spec.roughness).toBe(1);
      expect(spec.metalness).toBe(1);
      expect(entryAssetIds(entry)).toContain(`${entry.id}.face`);
      if (entryGlows(entry)) expect(spec.emissiveMapKey).toBe(`${entry.id}.emissive`);
    }
  });

  it('tags colour maps sRGB and data maps linear', () => {
    for (const entry of manifest().entries) {
      for (const texture of entry.textures) {
        const expected = texture.id.endsWith('.albedo') || texture.id.endsWith('.emissive');
        expect(texture.colorSpace, texture.id).toBe(expected ? 'srgb' : 'linear');
      }
    }
  });
});
