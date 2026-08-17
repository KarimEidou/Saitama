/**
 * CROWD TINTING
 *
 * Two hundred civilians, one geometry, one atlas, one material, one draw call.
 * The only thing that differs per instance is four colours, uploaded as
 * instanced vertex attributes and applied through a single-channel tint mask
 * baked alongside the atlas (see `materials.ts`).
 *
 * ── WHY A MASK RATHER THAN FOUR MATERIALS ─────────────────────────────────
 * The obvious alternative is one material per palette, which multiplies draw
 * calls by the number of palettes and defeats instancing entirely. The mask
 * costs one small greyscale upload and one texture fetch, and it buys an
 * unlimited wardrobe.
 *
 * ── DETERMINISM ───────────────────────────────────────────────────────────
 * Colours come from `civilianProfile(seed)`, the same function the mesh
 * generator uses to build bodies, so instance N of the crowd is always the
 * same person: same body, same clothes, same hair. A save file stores a seed,
 * not a wardrobe.
 */

import * as THREE from 'three';
import { civilianOptions, civilianProfile, type Palette } from '@/characters/mesh';
import { createRng } from '@/util';

/** The four colours one crowd instance carries. */
export interface CrowdColors {
  readonly skin: THREE.Color;
  readonly cloth: THREE.Color;
  readonly accent: THREE.Color;
  readonly hair: THREE.Color;
}

/** Attribute names the crowd injection reads. Keep in sync with the shader. */
export const CROWD_ATTRIBUTES = [
  'instanceSkin',
  'instanceCloth',
  'instanceAccent',
  'instanceHair',
] as const;

/** Deterministic colours for one civilian seed. */
export function crowdColors(seed: number): CrowdColors {
  const profile = civilianProfile(seed);
  const palette = civilianOptions(profile, 2).palette as Palette;
  return {
    skin: palette.skin.clone(),
    cloth: palette.cloth.clone(),
    accent: palette.accent.clone(),
    hair: palette.hair.clone(),
  };
}

/** Packed per-instance colour buffers, ready to attach to a geometry. */
export interface CrowdAttributes {
  readonly count: number;
  readonly skin: Float32Array;
  readonly cloth: Float32Array;
  readonly accent: Float32Array;
  readonly hair: Float32Array;
  /** Seeds used, so a caller can rebuild the same crowd later. */
  readonly seeds: Int32Array;
}

/**
 * Build colour attributes for a crowd.
 *
 * Values are written in LINEAR space, because the shader multiplies them into
 * `diffuseColor` after the sRGB texture fetch has already been decoded.
 * `THREE.Color` stores linear components, so this is simply what the object
 * already holds — but it is the kind of thing that is silently a stop too
 * bright when someone "fixes" it later.
 */
export function buildCrowdAttributes(count: number, baseSeed = 9000): CrowdAttributes {
  const skin = new Float32Array(count * 3);
  const cloth = new Float32Array(count * 3);
  const accent = new Float32Array(count * 3);
  const hair = new Float32Array(count * 3);
  const seeds = new Int32Array(count);
  const rng = createRng(baseSeed).derive('crowd');

  for (let i = 0; i < count; i++) {
    const seed = rng.int(1, 0x7ffffffe);
    seeds[i] = seed;
    const colors = crowdColors(seed);
    const o = i * 3;
    skin[o] = colors.skin.r;
    skin[o + 1] = colors.skin.g;
    skin[o + 2] = colors.skin.b;
    cloth[o] = colors.cloth.r;
    cloth[o + 1] = colors.cloth.g;
    cloth[o + 2] = colors.cloth.b;
    accent[o] = colors.accent.r;
    accent[o + 1] = colors.accent.g;
    accent[o + 2] = colors.accent.b;
    hair[o] = colors.hair.r;
    hair[o + 1] = colors.hair.g;
    hair[o + 2] = colors.hair.b;
  }

  return { count, skin, cloth, accent, hair, seeds };
}

/** Attach crowd colour attributes to an instanced geometry. */
export function attachCrowdAttributes(
  geometry: THREE.BufferGeometry,
  attributes: CrowdAttributes
): void {
  geometry.setAttribute('instanceSkin', new THREE.InstancedBufferAttribute(attributes.skin, 3));
  geometry.setAttribute('instanceCloth', new THREE.InstancedBufferAttribute(attributes.cloth, 3));
  geometry.setAttribute('instanceAccent', new THREE.InstancedBufferAttribute(attributes.accent, 3));
  geometry.setAttribute('instanceHair', new THREE.InstancedBufferAttribute(attributes.hair, 3));
}

/**
 * Dress ONE non-instanced civilian.
 *
 * The crowd injection reads four vertex attributes. On an `InstancedMesh` they
 * are instanced; on a plain mesh they are absent, and an absent attribute reads
 * as (0, 0, 0) — which multiplies the civilian to solid black. That is not a
 * hypothetical: it is what the first contact sheet showed. Attaching constant
 * per-vertex colours makes a single civilian display correctly with the same
 * material and the same shader.
 */
export function attachSoloCrowdColors(geometry: THREE.BufferGeometry, colors: CrowdColors): void {
  const count = geometry.getAttribute('position').count;
  const fill = (color: THREE.Color): THREE.Float32BufferAttribute => {
    const array = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      array[i * 3] = color.r;
      array[i * 3 + 1] = color.g;
      array[i * 3 + 2] = color.b;
    }
    return new THREE.Float32BufferAttribute(array, 3);
  };
  geometry.setAttribute('instanceSkin', fill(colors.skin));
  geometry.setAttribute('instanceCloth', fill(colors.cloth));
  geometry.setAttribute('instanceAccent', fill(colors.accent));
  geometry.setAttribute('instanceHair', fill(colors.hair));
}

/**
 * How many distinct colour combinations a crowd actually shows.
 *
 * The harness asserts this is close to the instance count: a crowd where the
 * palette collapses is a crowd of clones, and that is far more obvious on
 * screen than any triangle budget.
 */
export function distinctCrowdPalettes(attributes: CrowdAttributes): number {
  const seen = new Set<string>();
  for (let i = 0; i < attributes.count; i++) {
    const o = i * 3;
    seen.add(
      `${attributes.cloth[o]!.toFixed(3)},${attributes.accent[o + 1]!.toFixed(3)},` +
        `${attributes.skin[o + 2]!.toFixed(3)},${attributes.hair[o]!.toFixed(3)}`
    );
  }
  return seen.size;
}
