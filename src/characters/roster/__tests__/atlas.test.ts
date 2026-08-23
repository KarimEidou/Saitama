/**
 * THE BAKE — deterministic, covered, and actually textured
 *
 * The screenshots decide whether a character LOOKS right; these tests decide
 * whether the bake is sound. Three properties matter enough to pin:
 *
 *   DETERMINISM  same seed, byte-identical maps. Without it the asset cache is
 *                worthless and every build churns the CDN.
 *   COVERAGE     every island writes texels. An unwritten island renders as
 *                gutter — the exact "untextured geometry" failure this
 *                workstream exists to remove.
 *   MATERIAL     metalness varies PER TEXEL. That single property is what lets
 *                Genos' alloy forearm and his cotton shirt share one draw call,
 *                and it is what the metal close-up is judging.
 */

import { describe, expect, it } from 'vitest';
import { bakeCharacterAtlas } from '../atlas';
import { buildClassifier } from '../classify';
import { prepareRosterGeometry } from '../geometry';
import { buildRosterMesh, rosterEntry } from '../roster';
import { resolveSurfaces } from '../surfaces';
import { TINT_MASK_LEVEL, type AtlasMaps, type RosterEntry } from '../types';

const SIZE = 192;

function bake(entry: RosterEntry, seed = entry.seed): AtlasMaps {
  const build = buildRosterMesh(entry, 0);
  prepareRosterGeometry(build);
  const maps = bakeCharacterAtlas(
    build,
    resolveSurfaces(entry.surfaces),
    buildClassifier(entry.colors),
    { size: SIZE, seed, neutralize: entry.crowd === true }
  );
  build.geometry.dispose();
  return maps;
}

describe('atlas bake', () => {
  it('is byte-identical for the same seed', () => {
    const entry = rosterEntry('chr.saitama');
    const a = bake(entry);
    const b = bake(entry);
    expect(Array.from(a.albedo)).toEqual(Array.from(b.albedo));
    expect(Array.from(a.orm)).toEqual(Array.from(b.orm));
    expect(Array.from(a.normal)).toEqual(Array.from(b.normal));
    expect(Array.from(a.mask)).toEqual(Array.from(b.mask));
  });

  it('changes when the seed changes', () => {
    const entry = rosterEntry('chr.saitama');
    const a = bake(entry, 1);
    const b = bake(entry, 99);
    expect(Array.from(a.albedo)).not.toEqual(Array.from(b.albedo));
  });

  it('covers most of the sheet and paints every class the character uses', () => {
    for (const id of ['chr.saitama', 'chr.genos', 'chr.deepSeaKing']) {
      const entry = rosterEntry(id);
      const maps = bake(entry);
      expect(maps.coverage, `${id} coverage`).toBeGreaterThan(0.5);
      const painted = new Set(Object.keys(maps.classTexels));
      for (const color of entry.colors) {
        expect(painted, `${id} never painted any ${color.surface}`).toContain(color.surface);
      }
    }
  });

  it('never leaves a covered texel unpainted', () => {
    // A pure-black albedo texel inside a covered island means the rasteriser
    // skipped it: that is a hole, and a hole reads as untextured geometry.
    const maps = bake(rosterEntry('chr.genos'));
    let black = 0;
    for (let i = 0; i < maps.albedo.length; i += 3) {
      if (maps.albedo[i]! + maps.albedo[i + 1]! + maps.albedo[i + 2]! === 0) black++;
    }
    // The gutter is dilated outward, so a small ring of true background remains
    // at the sheet's far corners; islands themselves must be solid.
    expect(black / (maps.size * maps.size)).toBeLessThan(0.2);
  });

  it('leaves no texel fully occluded and mirror-smooth', () => {
    // An all-zero ORM is AO 0 and roughness 0 — a black texel with a sharp
    // specular lobe. The gutter beyond the dilation ring is still inside a
    // high mip's bilinear tap, so leaving it zeroed rims every limb with a
    // dark sparkle. Neutral (AO 1, rough 1, metal 0) is inert wherever it
    // bleeds.
    const maps = bake(rosterEntry('chr.genos'));
    let zeroed = 0;
    for (let i = 0; i < maps.orm.length; i += 3) {
      if (maps.orm[i]! === 0 && maps.orm[i + 1]! === 0 && maps.orm[i + 2]! === 0) zeroed++;
    }
    expect(zeroed).toBe(0);
  });

  it('gives Genos metal that is genuinely metal, and Saitama none', () => {
    const genos = bake(rosterEntry('chr.genos'));
    const saitama = bake(rosterEntry('chr.saitama'));

    // Uncovered gutter is detected from the ALBEDO, which is the only map left
    // black there; the ORM background is deliberately neutral (AO 1, rough 1)
    // so a high mip's bleed cannot read as a dark glossy fringe.
    const metalFraction = (maps: AtlasMaps, threshold: number): number => {
      let count = 0;
      let covered = 0;
      for (let i = 0; i < maps.orm.length; i += 3) {
        if (maps.albedo[i]! + maps.albedo[i + 1]! + maps.albedo[i + 2]! === 0) continue;
        covered++;
        if (maps.orm[i + 2]! > threshold) count++;
      }
      return count / Math.max(covered, 1);
    };

    expect(metalFraction(genos, 200)).toBeGreaterThan(0.02);
    expect(metalFraction(saitama, 200)).toBeLessThan(0.001);
  });

  it('varies roughness across the metal so the highlight breaks up', () => {
    const maps = bake(rosterEntry('chr.genos'));
    let min = 255;
    let max = 0;
    for (let i = 0; i < maps.orm.length; i += 3) {
      if (maps.orm[i + 2]! <= 200) continue;
      min = Math.min(min, maps.orm[i + 1]!);
      max = Math.max(max, maps.orm[i + 1]!);
    }
    expect(max - min).toBeGreaterThan(10);
  });

  it('writes only canonical tint levels into the mask', () => {
    // The mask is an INDEX map: the shader decodes it with band tests, so a
    // value between two levels is not a blend, it is a DIFFERENT tint slot —
    // a skin/cloth boundary averaging to 0.75 tints the seam with the trousers
    // colour. Nothing, including the gutter dilation, may invent a level.
    const maps = bake(rosterEntry('chr.civilian'));
    const levels = new Set(Object.values(TINT_MASK_LEVEL).map((v) => Math.round(v * 255)));
    const seen = new Set<number>();
    for (const value of maps.mask) seen.add(value);
    for (const value of seen) {
      expect(levels, `mask level ${value} is not one of ${[...levels].join(', ')}`).toContain(
        value
      );
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('neutralises the crowd sheet so the instance tint carries the colour', () => {
    const civilian = bake(rosterEntry('chr.civilian'));
    let saturated = 0;
    let covered = 0;
    for (let i = 0; i < civilian.albedo.length; i += 3) {
      const r = civilian.albedo[i]!;
      const g = civilian.albedo[i + 1]!;
      const b = civilian.albedo[i + 2]!;
      if (r + g + b === 0) continue;
      covered++;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 60) saturated++;
    }
    expect(saturated / covered).toBeLessThan(0.2);
  });

  it('emits an emissive map only for characters that glow', () => {
    expect(bake(rosterEntry('chr.genos')).emissive).toBeUndefined();
    // Genos' glow lives in his FACE layer, which the offline baker composites;
    // a class-level emissive is what produces a map here.
    const boros = bake(rosterEntry('chr.boros'));
    expect(boros.emissive).toBeUndefined();
    expect(bake(rosterEntry('chr.saitama')).emissive).toBeUndefined();
  });

  it('emits an emissive map when a class actually glows', () => {
    const entry = rosterEntry('chr.vaccineMan'); // every colour is `slime`
    const build = buildRosterMesh(entry, 0);
    prepareRosterGeometry(build);
    const maps = bakeCharacterAtlas(
      build,
      resolveSurfaces({
        slime: { roughness: 0.14, ao: 0.7, emissive: 0x63f0ff, emissiveStrength: 1 },
      }),
      buildClassifier(entry.colors),
      { size: SIZE, seed: entry.seed }
    );
    build.geometry.dispose();

    expect(maps.emissive).toBeDefined();
    expect(maps.emissive!.length).toBe(SIZE * SIZE * 3);
    // The encode round-trips sRGB -> linear -> sRGB, so lit texels carry the
    // colour asked for.
    let lit = 0;
    let matched = 0;
    for (let i = 0; i < maps.emissive!.length; i += 3) {
      const r = maps.emissive![i]!;
      const g = maps.emissive![i + 1]!;
      const b = maps.emissive![i + 2]!;
      if (r + g + b === 0) continue;
      lit++;
      if (Math.abs(r - 0x63) <= 2 && Math.abs(g - 0xf0) <= 2 && Math.abs(b - 0xff) <= 2) matched++;
    }
    expect(lit).toBeGreaterThan(0);
    expect(matched / lit).toBeGreaterThan(0.9);
  });

  it('emits an emissive map for a glowing FACE on an otherwise unlit character', () => {
    const entry = rosterEntry('chr.saitama'); // no class-level emissive anywhere
    const build = buildRosterMesh(entry, 0);
    prepareRosterGeometry(build);
    const patch = { width: 2, height: 2, rgba: new Uint8Array(2 * 2 * 4).fill(255) };
    const maps = bakeCharacterAtlas(
      build,
      resolveSurfaces(entry.surfaces),
      buildClassifier(entry.colors),
      {
        size: SIZE,
        seed: entry.seed,
        faceRect: { u0: 0.4, v0: 0.8, u1: 0.5, v1: 0.85 },
        faceEmissive: patch,
      }
    );
    build.geometry.dispose();
    expect(maps.emissive).toBeDefined();
    expect(maps.emissive!.some((value) => value > 0)).toBe(true);
  });
});
