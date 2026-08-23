/**
 * LOFT SAMPLING AND CAPS
 *
 * Two properties of the lofting core that nothing else in the suite can see,
 * because both fail silently — the counts stay right and only the surface goes
 * wrong.
 *
 * WHICH POINTS EXIST. The ring parameter samples at `k / segments`, which lands
 * on the four axis extremes when there are four of them — and every
 * superellipse touches its bounding box exactly there, whatever its exponent.
 * A four-segment plate is therefore a rhombus of half the requested area
 * unless the samples are offset onto the corners.
 *
 * CAPS MATCH THEIR RIM. A flat cap duplicates the strand's own rim and relies
 * on the two copies being bit-identical in position, so the weld collapses
 * them and the surface stays closed. Deriving the cap from a different frame
 * than the surface used — by ignoring `Ring.roll`, say — opens a hole ringing
 * the cap that reads as a tear rather than a compile error.
 *
 * The rest of the file covers the five pure functions the whole generator is
 * built on — `evalRingPoint`, `packSkin`, `evaluateChain`, `blendSkin` and
 * `poleHeight` — which are otherwise exercised only in aggregate, through whole
 * character builds. Three of their properties are load-bearing:
 *
 *  - `evalRingPoint`'s t -> axis mapping is what `uv.ts` calls "the single most
 *    important property of this layout": t=0 sits at -axisB, the BACK.
 *  - `packSkin`'s deterministic slot ordering (weight-descending, bone-index
 *    tiebreak) is what makes morph targets vertex-compatible across re-lofts.
 *  - `evaluateChain` IGNORES the first span's `start` and the last span's `end`
 *    by construction, which is why every chain in body.ts writes `+/-1e9`
 *    sentinels. That is pinned below so the sentinels stay decoration.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { BoneName } from '@/types';
import { analyseTopology } from '../analysis';
import { casualCostume, LOD_SETTINGS, resolvePalette } from '../assemble';
import { buildArmStrand, SMOOTH, type BodyContext } from '../body';
import { characterRecipe } from '../characters';
import { buildPanel } from '../hardsurface';
import {
  blendSkin,
  capSmoothGroup,
  evalRingPoint,
  evaluateChain,
  loftStrand,
  makeStrand,
  MeshBuilder,
  packSkin,
  poleHeight,
} from '../loft';
import { BONE_ORDER, buildRig } from '../rig';
import { resolveShape } from '../shape';
import { MeshSlot, type Ring, type SkinWeight4 } from '../types';
import { UV_REGIONS } from '../uv';

const RIGID: SkinWeight4 = { index: [0, 0, 0, 0], weight: [1, 0, 0, 0] };

/** Bone indices, built without going through `buildRig`. */
const INDEX = Object.fromEntries(BONE_ORDER.map((n, i) => [n, i])) as Record<BoneName, number>;

/** Sum of a skin's four slots, in slot order. */
function weightSum(skin: SkinWeight4): number {
  return skin.weight[0] + skin.weight[1] + skin.weight[2] + skin.weight[3];
}

function context(): BodyContext {
  const profile = characterRecipe('genos').profile;
  const palette = resolvePalette(profile);
  return {
    rig: buildRig(profile),
    shape: resolveShape(profile),
    lod: LOD_SETTINGS[0],
    paint: casualCostume(palette),
    skinColor: palette.skin,
  };
}

/** Area of a planar quadrilateral from its four corners, in order. */
function quadArea(corners: readonly THREE.Vector3[]): number {
  const d0 = corners[2]!.clone().sub(corners[0]!);
  const d1 = corners[3]!.clone().sub(corners[1]!);
  return d0.cross(d1).length() * 0.5;
}

describe('loft sampling', () => {
  it('gives a hard-surface panel its full rectangular footprint', () => {
    const ctx = context();
    const u = ctx.rig.dims.unit;
    const width = 0.075 * u;
    const height = 0.06 * u;
    const panel = buildPanel(ctx, {
      name: 'pauldron',
      source: buildArmStrand(ctx, 'Left'),
      v: 0.11,
      t: 0.25,
      width,
      height,
      depth: 0.012 * u,
      color: new THREE.Color(0x98a2ad),
    });

    const builder = new MeshBuilder();
    loftStrand(builder, panel);
    const position = builder.build().geometry.getAttribute('position');

    const corners = [0, 1, 2, 3].map((k) =>
      new THREE.Vector3().fromBufferAttribute(position as THREE.BufferAttribute, k)
    );
    // A rhombus through the axis extremes covers exactly half the plate; the
    // exponent-7 corners cover ~82% of it.
    expect(quadArea(corners)).toBeGreaterThan(width * height * 0.7);
    expect(quadArea(corners)).toBeLessThanOrEqual(width * height);
  });
});

describe('flat caps', () => {
  it('stays closed when the capped ring carries a roll', () => {
    const rings: Ring[] = [
      {
        center: new THREE.Vector3(0, 0, 0),
        shape: { radiusA: 0.06, radiusB: 0.04, exponent: 2.4 },
        skin: RIGID,
        v: 0,
        roll: 0.2,
      },
      {
        center: new THREE.Vector3(0, 0.12, 0),
        shape: { radiusA: 0.055, radiusB: 0.038, exponent: 2.4 },
        skin: RIGID,
        v: 1,
      },
    ];

    const builder = new MeshBuilder();
    loftStrand(
      builder,
      makeStrand('rolled', rings, {
        radialSegments: 8,
        uvRect: UV_REGIONS.trim,
        slot: MeshSlot.Accent,
        color: new THREE.Color(0xffffff),
        frameHint: new THREE.Vector3(1, 0, 0),
        smoothGroup: SMOOTH.garment,
        capStart: 'flat',
        capEnd: 'flat',
      })
    );

    const report = analyseTopology(builder.build().geometry);
    expect(report.boundaryEdges, 'hole around the rolled cap').toBe(0);
    expect(report.nonManifoldEdges).toBe(0);
    expect(report.watertight).toBe(true);
  });

  it('gives every flat cap its own smoothing group', () => {
    // A cap must crease against its own strand AND against every other cap, so
    // the (group, end) -> cap group mapping has to be injective. The naive
    // `group + flag + (0|1)` collided one strand's end cap with the next
    // strand's start cap — live pairs were garment-end vs hair-start, and panel
    // `i` end vs panel `i+1` start.
    const groups = new Set<number>();
    const bases = [
      ...new Set([
        ...Object.values(SMOOTH),
        ...Array.from({ length: 8 }, (_, i) => SMOOTH.panel + i),
      ]),
    ];
    for (const base of bases) {
      for (const atStart of [true, false]) {
        const group = capSmoothGroup(base, atStart);
        expect(groups.has(group), `collision at ${base}/${atStart}`).toBe(false);
        groups.add(group);
        expect(bases, 'collides with a surface group').not.toContain(group);
      }
    }
  });
});

describe('evalRingPoint', () => {
  it('puts t=0 at the back and advances anticlockwise through the frame', () => {
    // The seam-at-the-back contract `uv.ts` is built on: t=0 is -axisB, t=0.25
    // is +axisA, t=0.5 is +axisB (the FRONT), t=0.75 is -axisA. Move any of
    // these and the face slides out of the middle of its atlas rectangle.
    const out = new THREE.Vector2();
    const shape = { radiusA: 2, radiusB: 3 };

    for (const [t, a, b] of [
      [0, 0, -3],
      [0.25, 2, 0],
      [0.5, 0, 3],
      [0.75, -2, 0],
    ] as const) {
      evalRingPoint(shape, t, out);
      expect(out.x, `t=${t} axisA`).toBeCloseTo(a, 9);
      expect(out.y, `t=${t} axisB`).toBeCloseTo(b, 9);
    }
  });

  it('is a true ellipse at exponent 2', () => {
    const out = new THREE.Vector2();
    evalRingPoint({ radiusA: 2, radiusB: 3 }, 0.375, out);
    expect(out.x).toBeCloseTo(2 * Math.SQRT1_2, 9);
    expect(out.y).toBeCloseTo(3 * Math.SQRT1_2, 9);
  });

  it('samples a near-box corner at a high exponent', () => {
    // The property a 4-segment panel loses: at exponent 7 the corner sits at
    // ~0.906 of the radius rather than the ellipse's 0.707, and the four axis
    // extremes still land exactly on the bounding box.
    const out = new THREE.Vector2();
    const shape = { radiusA: 1, radiusB: 1, exponent: 7 };

    evalRingPoint(shape, 0.125, out);
    expect(out.x).toBeCloseTo(0.9057, 3);
    expect(out.y).toBeCloseTo(-0.9057, 3);

    for (const [t, axis, extreme] of [
      [0, 'y', -1],
      [0.25, 'x', 1],
      [0.5, 'y', 1],
      [0.75, 'x', -1],
    ] as const) {
      evalRingPoint(shape, t, out);
      expect(out[axis], `t=${t}`).toBeCloseTo(extreme, 9);
      // The off-axis component only approaches zero — `|cos|^(2/7)` decays very
      // slowly — so it is bounded rather than pinned.
      expect(Math.abs(axis === 'x' ? out.y : out.x)).toBeLessThan(1e-4);
    }
  });

  it('scales one half of the section at a time', () => {
    const out = new THREE.Vector2();
    evalRingPoint({ radiusA: 2, radiusB: 3, frontScale: 0.5 }, 0.5, out);
    expect(out.y).toBeCloseTo(1.5, 9);
    evalRingPoint({ radiusA: 2, radiusB: 3, frontScale: 0.5 }, 0, out);
    expect(out.y).toBeCloseTo(-3, 9);
    evalRingPoint({ radiusA: 2, radiusB: 3, backScale: 0.5 }, 0, out);
    expect(out.y).toBeCloseTo(-1.5, 9);
    evalRingPoint({ radiusA: 2, radiusB: 3, backScale: 0.5 }, 0.5, out);
    expect(out.y).toBeCloseTo(3, 9);
  });

  it('adds the centre offsets after scaling', () => {
    const out = new THREE.Vector2();
    evalRingPoint({ radiusA: 1, radiusB: 1, offsetA: 10, offsetB: -4 }, 0.25, out);
    expect(out.x).toBeCloseTo(11, 9);
    expect(out.y).toBeCloseTo(-4, 9);
  });

  it('keeps a hostile exponent finite', () => {
    // `resolveShapeAt` composes the exponent ADDITIVELY, so a costume's
    // `Coat.exponent` can drive it to zero or below without meaning to — and
    // `2/exponent` then diverges, spraying the character across a kilometre
    // with nothing thrown. The clamp in `evalRingPoint` is the one choke point
    // every ring passes through.
    const out = new THREE.Vector2();
    for (const exponent of [-0.1, -5, 0, 1e-9, 1e9, Number.POSITIVE_INFINITY]) {
      for (const t of [0, 0.05, 0.125, 0.25, 0.5, 0.75, 0.999]) {
        evalRingPoint({ radiusA: 1, radiusB: 1, exponent }, t, out);
        expect(Number.isFinite(out.x), `${exponent} @ ${t}`).toBe(true);
        expect(Number.isFinite(out.y), `${exponent} @ ${t}`).toBe(true);
        expect(Math.abs(out.x)).toBeLessThanOrEqual(1 + 1e-9);
        expect(Math.abs(out.y)).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });
});

describe('poleHeight', () => {
  it('bounds the dome by the SMALLER semi-axis', () => {
    expect(poleHeight({ radiusA: 3, radiusB: 1 })).toBe(0.92);
    expect(poleHeight({ radiusA: 1, radiusB: 3 })).toBe(0.92);
    expect(poleHeight({ radiusA: 1, radiusB: 1 })).toBe(0.92);
    // Negative radii are a mirrored frame, not a smaller section.
    expect(poleHeight({ radiusA: -3, radiusB: -1 })).toBe(0.92);
  });
});

describe('packSkin', () => {
  it('falls back to a valid bone when nothing contributes', () => {
    expect(packSkin(new Map(), 7)).toEqual({ index: [7, 7, 7, 7], weight: [1, 0, 0, 0] });
    // Sub-1e-5 contributions are noise and are dropped before the fallback.
    expect(packSkin(new Map([[3, 1e-6]]), 7)).toEqual({
      index: [7, 7, 7, 7],
      weight: [1, 0, 0, 0],
    });
  });

  it('repeats a VALID index in the unused slots, never -1', () => {
    // Some mobile drivers sample the bone texture before multiplying by the
    // weight, so a stale index in a zero-weight slot reads garbage.
    const skin = packSkin(new Map([[5, 0.4]]));
    expect(skin.index).toEqual([5, 5, 5, 5]);
    expect(skin.weight).toEqual([1, 0, 0, 0]);
  });

  it('keeps the four strongest, renormalised and weight-descending', () => {
    const skin = packSkin(
      new Map([
        [0, 0.5],
        [1, 0.2],
        [2, 0.15],
        [3, 0.1],
        [4, 0.05],
      ])
    );
    expect(skin.index).toEqual([0, 1, 2, 3]);
    for (let i = 0; i < 3; i++) {
      expect(skin.weight[i], `slot ${i} vs ${i + 1}`).toBeGreaterThanOrEqual(skin.weight[i + 1]!);
    }
    // The dominant slot absorbs the renormalisation residual, which lands the
    // sum within one ULP of 1 — the correction cannot do better than that,
    // because the correcting addition rounds too.
    expect(weightSum(skin)).toBeCloseTo(1, 15);
  });

  it('breaks weight ties on the lower bone index, whatever the insertion order', () => {
    const forward = packSkin(
      new Map([
        [9, 0.5],
        [2, 0.5],
      ])
    );
    const reversed = packSkin(
      new Map([
        [2, 0.5],
        [9, 0.5],
      ])
    );
    expect(forward.index[0]).toBe(2);
    expect(forward).toEqual(reversed);
    expect(weightSum(forward)).toBe(1);
  });
});

describe('evaluateChain', () => {
  const chain = {
    spans: [
      { bone: 'Hips' as BoneName, start: -1e9, end: 1, blend: 0.25 },
      { bone: 'Spine' as BoneName, start: 1, end: 1e9 },
    ],
  };

  it('hands the surface from one bone to the next across the joint', () => {
    expect(evaluateChain(chain, 0, INDEX).index[0]).toBe(INDEX.Hips);
    expect(evaluateChain(chain, 0, INDEX).weight[0]).toBe(1);

    const joint = evaluateChain(chain, 1, INDEX);
    expect(joint.index[0]).toBe(INDEX.Hips);
    expect(joint.index[1]).toBe(INDEX.Spine);
    expect(joint.weight[0]).toBeCloseTo(0.5, 9);
    expect(joint.weight[1]).toBeCloseTo(0.5, 9);
    expect(weightSum(joint)).toBe(1);

    expect(evaluateChain(chain, 2, INDEX).index[0]).toBe(INDEX.Spine);
    expect(evaluateChain(chain, 2, INDEX).weight[0]).toBe(1);
  });

  it('is a partition of unity across and beyond the chain', () => {
    for (let s = -2; s <= 4.0001; s += 0.05) {
      const skin = evaluateChain(chain, s, INDEX);
      expect(weightSum(skin), `s=${s.toFixed(2)}`).toBeCloseTo(1, 9);
      for (const w of skin.weight) expect(w, `s=${s.toFixed(2)}`).toBeGreaterThanOrEqual(0);
    }
  });

  it('ignores the first span start and the last span end', () => {
    // The enter/leave ramps are hard-coded to 1 at the two ends, so the `+/-1e9`
    // sentinels every chain in body.ts writes are pure decoration: replacing
    // them with values that would be nonsense if they were read changes nothing.
    const decoy = {
      spans: [
        { bone: 'Hips' as BoneName, start: 5, end: 1, blend: 0.25 },
        { bone: 'Spine' as BoneName, start: 1, end: -5 },
      ],
    };
    for (const s of [0, 1, 2]) {
      expect(evaluateChain(decoy, s, INDEX), `s=${s}`).toEqual(evaluateChain(chain, s, INDEX));
    }
  });

  it('layers a localised bias on top and lets it fade out', () => {
    const biased = {
      ...chain,
      bias: [{ bone: 'Spine2' as BoneName, at: 0, range: 1, amount: 0.5 }],
    };
    const at = evaluateChain(biased, 0, INDEX);
    expect(at.index[0]).toBe(INDEX.Hips);
    expect(at.weight[0]).toBeCloseTo(2 / 3, 6);
    expect(at.index[1]).toBe(INDEX.Spine2);
    expect(at.weight[1]).toBeCloseTo(1 / 3, 6);

    // Outside the bias range the chain is untouched.
    expect(evaluateChain(biased, 1.5, INDEX)).toEqual(evaluateChain(chain, 1.5, INDEX));
  });

  it('returns a valid rigid skin for an empty chain', () => {
    expect(evaluateChain({ spans: [] }, 0, INDEX)).toEqual({
      index: [0, 0, 0, 0],
      weight: [1, 0, 0, 0],
    });
  });
});

describe('blendSkin', () => {
  const a: SkinWeight4 = { index: [4, 4, 4, 4], weight: [1, 0, 0, 0] };
  const b: SkinWeight4 = { index: [1, 1, 1, 1], weight: [1, 0, 0, 0] };

  it('returns each end exactly', () => {
    expect(blendSkin(a, b, 0)).toEqual(a);
    expect(blendSkin(a, b, 1)).toEqual(b);
  });

  it('splits two disjoint rigid skins evenly, tiebroken on bone index', () => {
    const half = blendSkin(a, b, 0.5);
    expect(half.index[0]).toBe(1);
    expect(half.index[1]).toBe(4);
    expect(half.weight[0]).toBeCloseTo(0.5, 9);
    expect(half.weight[1]).toBeCloseTo(0.5, 9);
    expect(weightSum(half)).toBe(1);
  });
});
