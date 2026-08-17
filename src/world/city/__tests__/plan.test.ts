/**
 * THE COMMITTED PLAN
 *
 * `assets/district/cityz.plan.json` is a hand-editable artifact, which means it
 * is an artifact somebody will edit by hand and get slightly wrong. These tests
 * are the guard rail: they check the invariants generation silently assumes,
 * and they check that every material and model id the city references actually
 * exists in the asset manifests rather than being a plausible-looking typo that
 * renders as an untextured surface.
 */

import { describe, expect, it } from 'vitest';
import textureManifest from '../../../../tools/manifest/textures.json';
import modelManifest from '../../../../tools/manifest/models.json';
import { indexPlan, validatePlan } from '../plan';
import { allCityMaterialKeys, verifyMaterialTable } from '../materials';
import { allPropAssetKeys } from '../props';
import { polygonArea, polygonBounds } from '../polygon';
import { CHUNK_SIZE, chunkIndex } from '../../../spatial/constants';
import { CITY_Z_PLAN } from './fixtures';

interface IManifestEntry {
  readonly id: string;
  readonly tileSizeMeters?: number;
}

const textureEntries = (textureManifest as { entries: IManifestEntry[] }).entries;
const modelEntries = (modelManifest as { entries: IManifestEntry[] }).entries;

describe('cityz.plan.json', () => {
  it('passes validation', () => {
    expect(validatePlan(CITY_Z_PLAN)).toEqual([]);
  });

  it('matches the world constants', () => {
    expect(CITY_Z_PLAN.worldSize).toBe(1536);
    expect(CITY_Z_PLAN.chunkSize).toBe(CHUNK_SIZE);
    expect(CITY_Z_PLAN.chunkGrid).toBe(16);
  });

  it('places every parcel inside the chunk it claims', () => {
    for (const block of CITY_Z_PLAN.blocks) {
      const b = polygonBounds(block.outline);
      const [cx, cz] = block.chunk;
      expect(b.minX).toBeGreaterThanOrEqual(cx * CHUNK_SIZE);
      expect(b.maxX).toBeLessThanOrEqual((cx + 1) * CHUNK_SIZE);
      expect(b.minZ).toBeGreaterThanOrEqual(cz * CHUNK_SIZE);
      expect(b.maxZ).toBeLessThanOrEqual((cz + 1) * CHUNK_SIZE);
      expect(chunkIndex(cx, cz)).toBeGreaterThanOrEqual(0);
    }
  });

  it('winds every parcel and zone counter-clockwise', () => {
    for (const block of CITY_Z_PLAN.blocks) expect(polygonArea(block.outline)).toBeGreaterThan(0);
    for (const zone of CITY_Z_PLAN.zones) expect(polygonArea(zone.polygon)).toBeGreaterThan(0);
  });

  it('leaves a carriageway between neighbouring parcels', () => {
    // Two parcels either side of a street must not touch, or the road has no
    // width and the complement trick in ground.ts has nothing to draw.
    const byChunk = new Map<string, (typeof CITY_Z_PLAN.blocks)[number]>();
    for (const block of CITY_Z_PLAN.blocks) byChunk.set(block.chunk.join(','), block);
    let checked = 0;
    for (const block of CITY_Z_PLAN.blocks) {
      const [cx, cz] = block.chunk;
      const east = byChunk.get(`${cx + 1},${cz}`);
      if (!east) continue;
      const a = polygonBounds(block.outline);
      const b = polygonBounds(east.outline);
      expect(b.minX - a.maxX).toBeGreaterThanOrEqual(8);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('covers the whole 16x16 grid with parcels', () => {
    const covered = new Set(CITY_Z_PLAN.blocks.map((b) => chunkIndex(b.chunk[0], b.chunk[1])));
    expect(covered.size).toBe(256);
  });

  it('indexes blocks, landmarks and roads by chunk', () => {
    const index = indexPlan(CITY_Z_PLAN);
    expect(index.blocksByChunk.length).toBe(256);
    const counted = index.blocksByChunk.reduce((n, list) => n + list.length, 0);
    expect(counted).toBe(CITY_Z_PLAN.blocks.length);
    const landmarks = index.landmarksByChunk.reduce((n, list) => n + list.length, 0);
    expect(landmarks).toBe(CITY_Z_PLAN.landmarks.length);
    // Every chunk touches at least the two streets bounding it.
    for (const list of index.roadsByChunk) expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it('names every zone a block references', () => {
    const index = indexPlan(CITY_Z_PLAN);
    for (const block of CITY_Z_PLAN.blocks) {
      expect(index.zoneOfBlock(block), block.id).toBeDefined();
    }
  });

  it('carries the landmarks the district is built around', () => {
    const ids = CITY_Z_PLAN.landmarks.map((l) => l.id);
    expect(ids).toContain('hero-association-z');
    expect(ids).toContain('shotengai-arcade');
    expect(ids).toContain('saitama-apartment');
    expect(ids).toContain('z-park-pavilion');
    expect(CITY_Z_PLAN.craters.length).toBeGreaterThanOrEqual(1);
  });

  it('spans a sensible range of zone kinds', () => {
    const kinds = new Set(CITY_Z_PLAN.zones.map((z) => z.kind));
    for (const kind of ['downtown', 'shopping', 'residential', 'industrial', 'park', 'crater']) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
  });
});

describe('asset bindings', () => {
  it('references only material ids that exist in the manifest', () => {
    const known = new Set(textureEntries.map((e) => e.id));
    for (const key of allCityMaterialKeys()) {
      expect(known.has(key), `unknown material id ${key}`).toBe(true);
    }
  });

  it('mirrors the manifest tile sizes exactly', () => {
    expect(verifyMaterialTable(textureEntries)).toEqual([]);
  });

  it('references only model ids that exist in the manifest', () => {
    const known = new Set(modelEntries.map((e) => e.id));
    for (const key of allPropAssetKeys()) {
      expect(known.has(key), `unknown model id ${key}`).toBe(true);
    }
    for (const prop of CITY_Z_PLAN.props) {
      expect(known.has(prop.assetKey), `unknown model id ${prop.assetKey}`).toBe(true);
    }
  });

  it('binds only manifest material ids from the plan itself', () => {
    const known = new Set(textureEntries.map((e) => e.id));
    for (const zone of CITY_Z_PLAN.zones) {
      for (const id of zone.params.facadeMaterials) expect(known.has(id), id).toBe(true);
      for (const id of zone.params.roofMaterials) expect(known.has(id), id).toBe(true);
    }
    for (const landmark of CITY_Z_PLAN.landmarks) {
      expect(known.has(landmark.facadeMaterial), landmark.facadeMaterial).toBe(true);
      expect(known.has(landmark.roofMaterial), landmark.roofMaterial).toBe(true);
    }
  });

  it('never hardcodes a file path anywhere in the plan', () => {
    const text = JSON.stringify(CITY_Z_PLAN);
    expect(text).not.toMatch(/\.ktx2/);
    expect(text).not.toMatch(/\.glb/);
    expect(text).not.toMatch(/public\/assets/);
    expect(text).not.toMatch(/\.(png|jpg|jpeg|webp)/);
  });
});

describe('validation catches broken plans', () => {
  it('rejects a parcel outside its chunk', () => {
    const broken = {
      ...CITY_Z_PLAN,
      blocks: [{ ...CITY_Z_PLAN.blocks[0], chunk: [7, 7] as const }],
    };
    expect(validatePlan(broken).join('\n')).toMatch(/is not in chunk/);
  });

  it('rejects a clockwise parcel', () => {
    const first = CITY_Z_PLAN.blocks[0];
    const broken = {
      ...CITY_Z_PLAN,
      blocks: [{ ...first, outline: [...first.outline].reverse() }],
    };
    expect(validatePlan(broken).join('\n')).toMatch(/counter-clockwise/);
  });

  it('rejects an unknown zone reference', () => {
    const broken = {
      ...CITY_Z_PLAN,
      blocks: [{ ...CITY_Z_PLAN.blocks[0], zone: 'no-such-zone' }],
    };
    expect(validatePlan(broken).join('\n')).toMatch(/unknown zone/);
  });

  it('rejects a mismatched world size', () => {
    expect(validatePlan({ ...CITY_Z_PLAN, worldSize: 1024 }).join('\n')).toMatch(/worldSize/);
  });
});
