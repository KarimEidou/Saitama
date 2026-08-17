/**
 * COLOUR TABLES MUST MATCH THE COSTUMES
 *
 * The roster maps costume colours to surface classes by an explicit table. That
 * table is a DUPLICATE of constants that live in `mesh/characters.ts`, and a
 * duplicate that nobody checks is a duplicate that drifts. This test is the
 * check: it builds every character and asserts that every colour the build
 * actually produced is declared, naming the offender when it is not.
 *
 * Without it, re-tuning a jumpsuit's yellow in the mesh workstream would
 * silently re-materialise it as whatever class happened to be nearest —
 * leather, say — and the failure would show up as a shiny costume three
 * workstreams away.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { auditColors, buildClassifier, classifyTriangles, CLASS_MATCH_EPSILON } from '../classify';
import { buildRosterMesh, listRoster } from '../roster';
import { SURFACE_CLASSES } from '../types';

describe('costume colour classification', () => {
  for (const entry of listRoster()) {
    it(`${entry.id} declares every colour its costume paints`, () => {
      const build = buildRosterMesh(entry, 0);
      const classifier = buildClassifier(entry.colors);
      const audit = auditColors(
        build.geometry.getAttribute('color') as THREE.BufferAttribute,
        classifier
      );

      expect(
        audit.undeclared,
        `${entry.name} paints colours the roster does not declare: ${audit.undeclared.join(', ')}`
      ).toEqual([]);
      expect(audit.maxDistance).toBeLessThan(CLASS_MATCH_EPSILON);
      expect(audit.distinct).toBeGreaterThan(1);
      build.geometry.dispose();
    });
  }

  it('classifies every triangle into a known class', () => {
    for (const entry of listRoster()) {
      const build = buildRosterMesh(entry, 0);
      const classes = classifyTriangles(build.geometry, buildClassifier(entry.colors));
      expect(classes.length).toBe(build.stats.triangles);
      for (const surface of classes) expect(SURFACE_CLASSES).toContain(surface);
      build.geometry.dispose();
    }
  });

  it('separates colours that are indistinguishable once quantised to 8 bits', () => {
    // Genos' shirt and trousers differ by four counts in sRGB but are 6e-3
    // apart in linear float space. Exact matching is what keeps them apart.
    const classifier = buildClassifier([
      { hex: 0x1b1e24, surface: 'cloth' },
      { hex: 0x14161a, surface: 'accent' },
    ]);
    const shirt = new THREE.Color(0x1b1e24);
    const trousers = new THREE.Color(0x14161a);
    expect(classifier.classify(shirt.r, shirt.g, shirt.b)).toBe('cloth');
    expect(classifier.classify(trousers.r, trousers.g, trousers.b)).toBe('accent');
  });

  it('is deterministic across builds', () => {
    const entry = listRoster()[0]!;
    const a = buildRosterMesh(entry, 0);
    const b = buildRosterMesh(entry, 0);
    const classifier = buildClassifier(entry.colors);
    expect(classifyTriangles(a.geometry, classifier)).toEqual(
      classifyTriangles(b.geometry, classifier)
    );
    a.geometry.dispose();
    b.geometry.dispose();
  });
});
