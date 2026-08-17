/**
 * BUILD SOLVER — turning a `BodyProfile` into flesh
 *
 * `BodyProfile` is a cross-system contract and deliberately small: height,
 * bulk, shoulder width, limb length, head scale. But "bulk" alone cannot tell
 * a powerlifter from a shopkeeper — both are wide, and they are wide in
 * completely different places. This module resolves the profile into the two
 * axes the cross-section tables actually need:
 *
 *   MUSCLE  adds to chest, deltoid, biceps and quad, and NARROWS the waist —
 *           it produces a V-taper.
 *   BELLY   adds to waist and lower ribs and pushes the outline FORWARD —
 *           it produces a barrel.
 *
 * Both are derived from `archetype` + `bulk` so callers keep working with the
 * shared contract, and both are overridable so named characters (Genos'
 * machine build, Tatsumaki's very small frame) can be dialled in exactly.
 */

import type { BodyArchetype, BodyProfile } from '@/types';
import { clamp, clamp01, lerp } from '@/util';
import { createRng } from '@/util';

/** The resolved shape axes the cross-section tables read. */
export interface ShapeParams {
  /** 0 soft, 1 heavily defined. Widens chest/shoulders, narrows the waist. */
  readonly muscle: number;
  /** 0 flat, 1 barrel. Widens and pushes the midsection forward. */
  readonly belly: number;
  /** Global radial multiplier for the torso. */
  readonly bulk: number;
  /** Global radial multiplier for arms and legs. */
  readonly limb: number;
  /** Extra width across the trapezius yoke. */
  readonly yoke: number;
  /** Neck thickness multiplier. */
  readonly neck: number;
  /** 0 adult skull, 1 infant skull (rounder, higher forehead, smaller jaw). */
  readonly juvenile: number;
  /** Hard-surface bias: pushes cross-sections toward boxy superellipses. */
  readonly angular: number;
}

/** Fields a caller may pin instead of deriving. */
export type ShapeOverrides = Partial<ShapeParams>;

const MUSCLE_BY_ARCHETYPE: Readonly<Record<BodyArchetype, number>> = {
  hero: 0.8,
  civilian: 0.28,
  child: 0.12,
  heavy: 0.22,
  lithe: 0.38,
  monsterHumanoid: 0.92,
  monsterBeast: 1.0,
};

const BELLY_BY_ARCHETYPE: Readonly<Record<BodyArchetype, number>> = {
  hero: 0.02,
  civilian: 0.18,
  child: 0.3,
  heavy: 0.78,
  lithe: 0.04,
  monsterHumanoid: 0.12,
  monsterBeast: 0.3,
};

/**
 * Resolve a profile (plus optional pins) into shape axes.
 *
 * `bulk` above 1 is split between muscle and fat according to the archetype's
 * disposition: the same `bulk: 1.4` reads as a bodybuilder on a `hero` and as
 * a publican on a `heavy`. That single rule is what stops procedural civilians
 * from all looking like the same inflated mannequin.
 */
export function resolveShape(profile: BodyProfile, overrides?: ShapeOverrides): ShapeParams {
  const archetype = profile.archetype;
  const bulk = clamp(profile.bulk, 0.45, 2.6);
  const excess = bulk - 1;

  const leanBias = MUSCLE_BY_ARCHETYPE[archetype];
  const fatBias = BELLY_BY_ARCHETYPE[archetype];
  // Split surplus bulk between the two axes in the archetype's own ratio.
  const split = leanBias / Math.max(leanBias + fatBias, 1e-3);

  let muscle = clamp01(leanBias + Math.max(0, excess) * split * 0.9 + Math.min(0, excess) * 0.5);
  let belly = clamp01(fatBias + Math.max(0, excess) * (1 - split) * 1.15 + Math.min(0, excess) * 0.6);

  // Per-character jitter so a crowd built from one archetype is not a chorus
  // line. Deterministic: same seed, same body, every run and every device.
  if (profile.seed !== undefined) {
    const rng = createRng(profile.seed).derive('shape');
    muscle = clamp01(muscle + rng.range(-0.09, 0.09));
    belly = clamp01(belly + rng.range(-0.1, 0.12));
  }

  const juvenile = archetype === 'child' ? 0.85 : 0;
  const angular = archetype === 'monsterBeast' ? 0.2 : 0;

  const resolved: ShapeParams = {
    muscle,
    belly,
    bulk,
    limb: lerp(1, bulk, 0.72),
    yoke: lerp(1, profile.shoulderWidth, 0.65),
    neck: lerp(1, 0.6 + muscle * 0.7 + belly * 0.25, 0.85),
    juvenile,
    angular,
  };

  return overrides === undefined ? resolved : { ...resolved, ...overrides };
}
