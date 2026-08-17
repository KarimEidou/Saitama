/**
 * COSTUME COLOUR -> SURFACE CLASS
 *
 * The mesh generator's costume functions paint a small, exact set of colours
 * into the `color` vertex attribute. This file turns those colours back into
 * MATERIAL MEANING, which is the join the whole roster hangs off:
 *
 *     vertex colour  ->  SurfaceClass  ->  roughness / metalness / detail map
 *
 * ── WHY NOT USE THE MATERIAL SLOT ─────────────────────────────────────────
 * `geometry.groups` carries `MeshSlot`, but the slots follow GEOMETRY (which
 * strand a triangle came from), not costume. Saitama's jumpsuit, his bare head
 * and his red gloves are all `MeshSlot.Skin`, because they are all painted onto
 * the body strands rather than modelled as separate shells. Materialising by
 * slot would give him a skin-coloured suit. Colour is the only signal that
 * knows the difference, so colour is what we classify.
 *
 * ── WHY EXACT MATCHING WORKS ──────────────────────────────────────────────
 * `THREE.Color` converts hex to LINEAR floats on assignment, and the costume
 * assigns from a literal. Two costume colours that are indistinguishable once
 * quantised to 8-bit sRGB (Genos' shirt `0x1b1e24` and his trousers `0x14161a`
 * differ by four counts) are still 6e-3 apart in linear float space, which is
 * far above the matching epsilon. So the table is matched exactly, and
 * `maxDistance` is reported so a test can prove no build silently produced a
 * colour nobody declared.
 */

import * as THREE from 'three';
import type { ClassColor, SurfaceClass } from './types';

/** Distance below which a vertex colour is considered a declared colour. */
export const CLASS_MATCH_EPSILON = 2e-3;

/** A resolved colour table, ready to classify a whole build. */
export interface ColorClassifier {
  /** Declared colours, in linear space. */
  readonly entries: readonly { readonly linear: THREE.Color; readonly surface: SurfaceClass }[];
  /** Class used when nothing matches. */
  readonly fallback: SurfaceClass;
  /** Nearest declared class for a linear RGB triple. */
  classify(r: number, g: number, b: number): SurfaceClass;
  /** Squared distance to the nearest declared colour. */
  distanceSq(r: number, g: number, b: number): number;
}

/** Build a classifier from a character's declared colour table. */
export function buildClassifier(
  colors: readonly ClassColor[],
  fallback: SurfaceClass = 'skin'
): ColorClassifier {
  const entries = colors.map((entry) => ({
    linear: new THREE.Color(entry.hex),
    surface: entry.surface,
  }));

  const nearest = (r: number, g: number, b: number): { index: number; distSq: number } => {
    let best = -1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < entries.length; i++) {
      const c = entries[i]!.linear;
      const dr = c.r - r;
      const dg = c.g - g;
      const db = c.b - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return { index: best, distSq: bestDist };
  };

  return {
    entries,
    fallback,
    classify(r, g, b) {
      if (entries.length === 0) return fallback;
      const { index } = nearest(r, g, b);
      return entries[index]!.surface;
    },
    distanceSq(r, g, b) {
      if (entries.length === 0) return Number.POSITIVE_INFINITY;
      return nearest(r, g, b).distSq;
    },
  };
}

/** Result of auditing a build against its declared colour table. */
export interface ClassifyAudit {
  /** Distinct vertex colours found. */
  readonly distinct: number;
  /** Largest distance from a vertex colour to its nearest declared colour. */
  readonly maxDistance: number;
  /** Colours that matched nothing within `CLASS_MATCH_EPSILON`, as hex. */
  readonly undeclared: readonly string[];
}

/**
 * Check that every colour a build actually produced is declared.
 *
 * This is the guard that keeps the table honest: if someone re-tunes a costume
 * in `mesh/characters.ts`, the roster does not quietly materialise the new
 * colour as whatever happened to be nearest — the test fails and names it.
 */
export function auditColors(
  color: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  classifier: ColorClassifier
): ClassifyAudit {
  const seen = new Map<string, [number, number, number]>();
  for (let i = 0; i < color.count; i++) {
    const r = color.getX(i);
    const g = color.getY(i);
    const b = color.getZ(i);
    const key = `${r.toFixed(5)},${g.toFixed(5)},${b.toFixed(5)}`;
    if (!seen.has(key)) seen.set(key, [r, g, b]);
  }

  let maxDistance = 0;
  const undeclared: string[] = [];
  const probe = new THREE.Color();
  for (const [r, g, b] of seen.values()) {
    const distance = Math.sqrt(classifier.distanceSq(r, g, b));
    if (distance > maxDistance) maxDistance = distance;
    if (distance > CLASS_MATCH_EPSILON) {
      probe.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
      undeclared.push(`#${probe.getHexString(THREE.SRGBColorSpace)}`);
    }
  }

  return { distinct: seen.size, maxDistance, undeclared };
}

/**
 * Per-triangle class for a whole geometry.
 *
 * A triangle spanning a costume boundary (the ring where a sleeve ends) gets
 * the class of its majority corner. The albedo still interpolates the vertex
 * colours across that triangle, so the COLOUR transition stays smooth; only
 * the detail map and the roughness flip, and flipping those on a triangle edge
 * is exactly the crisp hem a real garment has.
 */
export function classifyTriangles(
  geometry: THREE.BufferGeometry,
  classifier: ColorClassifier
): SurfaceClass[] {
  const index = geometry.getIndex();
  const color = geometry.getAttribute('color');
  if (index === null) throw new Error('roster: geometry must be indexed');

  const triangles = index.count / 3;
  const out: SurfaceClass[] = new Array<SurfaceClass>(triangles);
  const votes = new Map<SurfaceClass, number>();

  for (let t = 0; t < triangles; t++) {
    votes.clear();
    let best: SurfaceClass = classifier.fallback;
    let bestVotes = 0;
    for (let k = 0; k < 3; k++) {
      const v = index.getX(t * 3 + k);
      const surface = classifier.classify(color.getX(v), color.getY(v), color.getZ(v));
      const n = (votes.get(surface) ?? 0) + 1;
      votes.set(surface, n);
      if (n > bestVotes) {
        bestVotes = n;
        best = surface;
      }
    }
    out[t] = best;
  }
  return out;
}
