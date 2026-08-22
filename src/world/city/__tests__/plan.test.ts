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
import { CITY_Z_PLAN, SAMPLE_CHUNKS, makeGenerator } from './fixtures';

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

  it('preloads every model the city actually emits', () => {
    // `allPropAssetKeys()` IS `CityGenerator.requiredAssets().models`, and
    // `buildChunkNodes` drops a whole instance batch without a word when its
    // model is not resident — so an id the city emits but does not preload is
    // a prop that silently never renders. The facade kit's attachments are the
    // easy ones to miss: they come from `facade.ts`, not from a scatter table.
    const known = new Set(allPropAssetKeys());
    const generator = makeGenerator('box');
    const emitted = new Set<string>();
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      for (const batch of generator.generate(cx, cz).instances) emitted.add(batch.assetKey);
    }
    expect(emitted.size).toBeGreaterThan(5);
    expect([...emitted].filter((key) => !known.has(key))).toEqual([]);
  }, 30_000);

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

  it('rejects a zone whose lot size would divide by zero', () => {
    // `subdivideBlock` computes `round(runLength / lotWidth)`. At zero that is
    // Infinity lots: several seconds of pushing into an array and then a
    // RangeError inside the chunk generator, on the first chunk of the zone.
    const zone = CITY_Z_PLAN.zones[0];
    const broken = {
      ...CITY_Z_PLAN,
      zones: [{ ...zone, params: { ...zone.params, lotWidth: [0, 0] as const } }],
    };
    expect(validatePlan(broken).join('\n')).toMatch(/invalid lotWidth/);

    const inverted = {
      ...CITY_Z_PLAN,
      zones: [{ ...zone, params: { ...zone.params, lotDepth: [30, 12] as const } }],
    };
    expect(validatePlan(inverted).join('\n')).toMatch(/invalid lotDepth/);
  });

  it('rejects a mistyped panel kind in a weight table', () => {
    // `normaliseWeights` drops keys it does not recognise and falls back to a
    // blank wall, so "windows" for "window" turns a whole zone windowless with
    // no error anywhere.
    const zone = CITY_Z_PLAN.zones[0];
    const broken = {
      ...CITY_Z_PLAN,
      zones: [{ ...zone, params: { ...zone.params, panelWeights: { windows: 10 } } }],
    };
    expect(validatePlan(broken).join('\n')).toMatch(/unknown panel kind "windows"/);
  });

  it('rejects a clockwise landmark footprint', () => {
    // Winding decides which way the walls face; a clockwise footprint renders
    // the landmark inside-out and every existing test still passes.
    const first = CITY_Z_PLAN.landmarks[0];
    const broken = {
      ...CITY_Z_PLAN,
      landmarks: [{ ...first, footprint: [...first.footprint].reverse() }],
    };
    expect(validatePlan(broken).join('\n')).toMatch(/counter-clockwise/);
  });

  it('rejects a landmark on the exclusive world boundary', () => {
    // The world is addressable on [-768, 768): a landmark at x = 768 maps to
    // chunk 8, which `indexPlan` silently drops.
    const first = CITY_Z_PLAN.landmarks[0];
    const broken = {
      ...CITY_Z_PLAN,
      landmarks: [{ ...first, position: [768, 0] as const }],
    };
    expect(validatePlan(broken).join('\n')).toMatch(/outside the chunk grid/);
  });
});
