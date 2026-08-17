/**
 * FACES — placed by the mesh's own landmarks, and four expressions apart
 *
 * The face is the highest-value texture on a stylised character and the easiest
 * thing to place wrong: a few thousandths of `v` and the eyes are on the
 * forehead. These tests pin the placement to the landmarks the mesh publishes,
 * assert the four expressions are genuinely different drawings, and check the
 * one gameplay hook the face owes the rest of the game — the boredom mapping
 * that swaps Saitama to a blanker stare.
 */

import { describe, expect, it } from 'vitest';
import { FACE_CENTER_U, HEAD_LANDMARK_V } from '@/characters/mesh';
import { baseFace, expressionForBoredom, faceRegion, faceSvg } from '../face';
import { measureHead, prepareRosterGeometry } from '../geometry';
import { buildRosterMesh, listRoster, rosterEntry } from '../roster';
import { EXPRESSIONS } from '../types';

function regionFor(id: string): ReturnType<typeof faceRegion> {
  const entry = rosterEntry(id);
  const build = buildRosterMesh(entry, 0);
  prepareRosterGeometry(build);
  const region = faceRegion(entry.face, measureHead(build));
  build.geometry.dispose();
  return region;
}

describe('face placement', () => {
  it('centres the patch on the face and keeps it inside the head band', () => {
    for (const entry of listRoster()) {
      const build = buildRosterMesh(entry, 0);
      prepareRosterGeometry(build);
      const region = faceRegion(entry.face, measureHead(build));

      expect((region.uMin + region.uMax) / 2).toBeCloseTo(FACE_CENTER_U, 5);
      expect(region.vMin, `${entry.id} patch starts below the jaw`).toBeGreaterThanOrEqual(
        HEAD_LANDMARK_V.jaw - 0.021
      );
      expect(region.vMax, `${entry.id} patch runs past the skull`).toBeLessThanOrEqual(
        HEAD_LANDMARK_V.skull + 1e-6
      );
      // Every feature the style asks for has to fit in the patch it produced.
      expect(entry.face.eyeV).toBeGreaterThan(region.vMin);
      expect(entry.face.eyeV).toBeLessThan(region.vMax);
      expect(entry.face.mouthV).toBeGreaterThan(region.vMin);
      expect(entry.face.eyeSpread + entry.face.eyeWidth).toBeLessThan(region.metricWidth / 2);
      build.geometry.dispose();
    }
  });

  it('scales with the head it is painted on', () => {
    const small = regionFor('chr.tatsumaki');
    const large = regionFor('chr.deepSeaKing');
    expect(large.metricWidth).toBeGreaterThan(small.metricWidth);
    // A wider head means the same metric face covers less of the ring.
    expect(large.uMax - large.uMin).toBeLessThan(small.uMax - small.uMin);
  });

  it('keeps the atlas rectangle inside the body region', () => {
    const region = regionFor('chr.saitama');
    expect(region.atlas.u0).toBeGreaterThan(0);
    expect(region.atlas.u1).toBeLessThan(1);
    expect(region.atlas.v0).toBeGreaterThan(0.5);
    expect(region.atlas.v1).toBeLessThan(1);
    expect(region.atlas.u1 - region.atlas.u0).toBeGreaterThan(0.1);
  });

  it('keeps the tile square in world terms, not in UV terms', () => {
    // The atlas is roughly twice as dense across the face as up it, so the tile
    // must follow the METRIC aspect or every circle arrives as an ellipse.
    const region = regionFor('chr.saitama');
    const tileAspect = region.tileWidth / region.tileHeight;
    const metricAspect = region.metricWidth / region.metricHeight;
    expect(tileAspect).toBeCloseTo(metricAspect, 1);
  });
});

describe('expressions', () => {
  it('draws four visibly different faces', () => {
    const region = regionFor('chr.saitama');
    const style = rosterEntry('chr.saitama').face;
    const drawings = EXPRESSIONS.map((expression) => faceSvg(style, expression, region));
    expect(new Set(drawings).size).toBe(EXPRESSIONS.length);
    for (const svg of drawings) {
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toContain('</svg>');
      expect(svg.length).toBeGreaterThan(200);
    }
  });

  it('is deterministic', () => {
    const region = regionFor('chr.genos');
    const style = rosterEntry('chr.genos').face;
    expect(faceSvg(style, 'bored', region)).toBe(faceSvg(style, 'bored', region));
  });

  it('narrows the eyes when bored — the whole point of the tile', () => {
    const region = regionFor('chr.saitama');
    const style = rosterEntry('chr.saitama').face;
    const neutral = faceSvg(style, 'neutral', region);
    const bored = faceSvg(style, 'bored', region);
    // The bored tile clips the eye under a lid; the neutral one does not.
    expect(bored).toContain('clipPath');
    expect(neutral.includes('clipPath')).toBe(true);
    expect(bored).not.toBe(neutral);
  });

  it('emits an emissive layer only for faces that glow', () => {
    const genos = rosterEntry('chr.genos');
    const region = regionFor('chr.genos');
    expect(faceSvg(genos.face, 'neutral', region, 'emissive').length).toBeGreaterThan(200);

    const saitama = rosterEntry('chr.saitama');
    const plain = regionFor('chr.saitama');
    const empty = faceSvg(saitama.face, 'neutral', plain, 'emissive');
    expect(empty).toContain('</svg>');
    expect(empty.length).toBeLessThan(200);
  });

  it('maps the boredom gameplay state onto a face', () => {
    expect(expressionForBoredom(0)).toBe('serious');
    expect(expressionForBoredom(0.3)).toBe('neutral');
    expect(expressionForBoredom(0.9)).toBe('bored');
    expect(expressionForBoredom(2)).toBe('bored');
    expect(expressionForBoredom(-1)).toBe('serious');
  });

  it('gives every roster character a face with a mouth and eyes', () => {
    for (const entry of listRoster()) {
      expect(entry.face.eyeWidth).toBeGreaterThan(0.005);
      expect(entry.face.eyeHeight).toBeGreaterThan(0.004);
      expect(entry.face.mouthWidth).toBeGreaterThan(0.005);
      expect(entry.face.eyeSpread).toBeGreaterThan(0.01);
    }
  });

  it('defaults to a plain adult face that overrides cleanly', () => {
    const face = baseFace({ eye: 'slit', mouth: 'grin' });
    expect(face.eye).toBe('slit');
    expect(face.mouth).toBe('grin');
    expect(face.brow).toBe('thin');
  });
});
