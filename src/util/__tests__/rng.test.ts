/**
 * SEEDED RNG — SNAPSHOT FIDELITY
 *
 * `getState()` exists so a save regenerates an identical world. That makes an
 * unfaithful snapshot a silent content bug rather than a crash: restore, and
 * the city, the civilian body proportions or the debris scatter come back
 * subtly different with nothing raised.
 *
 * `gaussian()` is where it bites. Box-Muller produces two samples per pair of
 * draws and caches the second, so a snapshot taken between the two halves of a
 * pair carries state the uint32 core does not.
 *
 * ── GOLDEN VECTORS ─────────────────────────────────────────────────────────
 * The second half of this file pins the actual NUMBER SEQUENCE. `rng.ts` opens
 * with the hard invariant of the whole project — the city generates from seeds
 * and must be byte-identical across runs, devices and platforms — and 62
 * modules import `createRng`. The determinism suites elsewhere in the tree
 * compare a run against another run of the SAME build, so they move together: a
 * one-character change to `mulberry32Step`, `mixSeeds` or `hashString` (a
 * "harmless" `>>> 0` to `| 0`, the two `Math.imul` lines reordered) passes all
 * of them while silently changing every world every player has saved. Exact
 * literals asserted with `toBe` are the only thing that catches that.
 *
 * If one of these fails, the RNG changed. That is a save-compatibility break,
 * not a test to update.
 */

import { describe, it, expect } from 'vitest';
import {
  createChunkRng,
  createRng,
  hashCoord,
  hashString,
  mixSeeds,
  type IRandom,
  type IRandomState,
} from '../rng';

/** A mixed draw sequence, so a snapshot has to restore more than `next()`. */
function draw(rng: IRandom): number[] {
  return [rng.next(), rng.gaussian(), rng.int(0, 100), rng.gaussian(1.71, 0.075), rng.range(-1, 1)];
}

describe('IRandom.getState / setState', () => {
  it('round-trips a snapshot taken while a Box-Muller spare is pending', () => {
    const rng = createRng(12345);
    rng.gaussian(); // consumes two draws and caches the second sample
    const snapshot = rng.getState();
    expect(typeof snapshot.spare).toBe('number');

    const beforeRestore = rng.gaussian(); // returns the cached spare
    rng.setState(snapshot);
    expect(rng.gaussian()).toBe(beforeRestore);
  });

  it('round-trips a snapshot taken with no spare pending', () => {
    const rng = createRng('downtown');
    rng.gaussian();
    rng.gaussian(); // spare consumed, none cached
    const snapshot = rng.getState();
    expect(snapshot.spare).toBeUndefined();

    const beforeRestore = [rng.next(), rng.gaussian(), rng.next()];
    rng.setState(snapshot);
    expect([rng.next(), rng.gaussian(), rng.next()]).toEqual(beforeRestore);
  });

  it('survives the JSON round-trip a save file puts it through', () => {
    const rng = createRng(7);
    rng.gaussian();
    const snapshot = JSON.parse(JSON.stringify(rng.getState())) as IRandomState;

    const beforeRestore = rng.gaussian();
    rng.setState(snapshot);
    expect(rng.gaussian()).toBe(beforeRestore);
  });

  it('reproduces a long mixed stream from a mid-stream snapshot', () => {
    const rng = createRng('civilians');
    draw(rng);
    const snapshot = rng.getState();
    const expected = [draw(rng), draw(rng)];

    rng.setState(snapshot);
    expect([draw(rng), draw(rng)]).toEqual(expected);
  });

  it('clears a cached spare when the snapshot does not carry one', () => {
    const restored = createRng(99);
    restored.gaussian(); // caches a spare
    const core = restored.getState().state;

    const reference = createRng(99);
    reference.gaussian();
    expect(reference.getState().state).toBe(core);

    // A spare-less snapshot means "no pending sample": the next gaussian has
    // to recompute rather than hand back the sample still cached in `restored`.
    restored.setState({ state: core });
    expect(restored.gaussian()).not.toBe(reference.gaussian());
  });
});

describe('hash golden vectors', () => {
  it('pins hashString', () => {
    expect(hashString('downtown')).toBe(2418787471);
    expect(hashString('')).toBe(167010153);
    expect(hashString('a')).toBe(519299066);
  });

  it('pins mixSeeds, which is deliberately not commutative', () => {
    expect(mixSeeds(0, 0)).toBe(701265802);
    expect(mixSeeds(1, 2)).toBe(1315352272);
    expect(mixSeeds(2, 1)).toBe(265602189);
  });

  it('pins hashCoord, including the negative coordinates it claims to separate', () => {
    expect(hashCoord(0, 0, 0)).toBe(2951219013);
    expect(hashCoord(-1, 2)).toBe(2952502380);
    expect(hashCoord(1, -2)).toBe(2531873110);
    expect(hashCoord(-1, 2)).not.toBe(hashCoord(1, -2));
  });
});

describe('stream golden vectors', () => {
  it('pins the float stream for a numeric seed', () => {
    const rng = createRng(12345);
    expect([rng.next(), rng.next(), rng.next(), rng.next(), rng.next()]).toEqual([
      0.9797282677609473, 0.3067522644996643, 0.484205421525985, 0.817934412509203,
      0.5094283693470061,
    ]);
  });

  it('pins the raw uint32 stream', () => {
    const rng = createRng(12345);
    expect([rng.nextUint32(), rng.nextUint32(), rng.nextUint32()]).toEqual([
      4207900869, 1317490944, 2079646450,
    ]);
  });

  it('does not degenerate on seed 0', () => {
    const rng = createRng(0);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([
      0.26642920868471265, 0.0003297457005828619, 0.2232720274478197,
    ]);
  });

  it('hashes string seeds through hashString', () => {
    expect(createRng('city').seed).toBe(393418674);
    expect(createRng('city').seed).toBe(hashString('city'));
  });

  it('pins createChunkRng, THE entry point for world generation', () => {
    const rng = createChunkRng(1234, -3, 5);
    expect(rng.seed).toBe(3021404499);
    expect([rng.next(), rng.next(), rng.next()]).toEqual([
      0.8430136574897915, 0.13251630193553865, 0.45019192062318325,
    ]);
  });

  it('keeps the seed stable across construction', () => {
    expect([...Array(5)].map(() => createRng(12345).seed)).toEqual(Array(5).fill(12345));
  });
});

describe('derive — hierarchical, order-independent generation', () => {
  it('yields the same child however much the parent has been drawn from', () => {
    const parent = createRng(999);
    const before = parent.derive('buildings');
    for (let i = 0; i < 50; i++) parent.next();
    const after = parent.derive('buildings');

    // This is the property that lets any chunk be generated at any time in any
    // order and still match.
    expect(after.seed).toBe(before.seed);
    expect(before.seed).toBe(307104232);
    expect([before.next(), before.next(), before.next()]).toEqual([
      0.6144432416185737, 0.008382868254557252, 0.20107759651727974,
    ]);
  });

  it('accepts numeric labels and separates distinct ones', () => {
    expect(createRng(999).derive(7).seed).toBe(1776794805);
    expect(createRng(999).derive('a').seed).not.toBe(createRng(999).derive('b').seed);
  });
});

describe('stream reproducibility', () => {
  it('produces identical sequences from two instances of one seed', () => {
    const a = createRng('city');
    const b = createRng('city');
    const drawMany = (rng: IRandom): number[] => [...Array(100)].map(() => rng.next());
    expect(drawMany(a)).toEqual(drawMany(b));
  });

  it('replays the stream after reset()', () => {
    const rng = createRng(777);
    const first = [rng.next(), rng.next(), rng.next()];
    expect(first).toEqual([0.6863787178881466, 0.03445141832344234, 0.19238732964731753]);
    rng.reset();
    expect([rng.next(), rng.next(), rng.next()]).toEqual(first);
  });
});

describe('distribution and API contracts', () => {
  it('keeps next() inside [0, 1) across 200k draws', () => {
    const rng = createRng(11);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 200_000; i++) {
      const value = rng.next();
      if (value < min) min = value;
      if (value > max) max = value;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThan(1);
  });

  it('int() is inclusive of both ends and hits every bucket', () => {
    const rng = createRng(5);
    const counts = new Map<number, number>();
    for (let i = 0; i < 20_000; i++) {
      const value = rng.int(3, 7);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
    for (const count of counts.values()) expect(count).toBeGreaterThan(0);
  });

  it('int() swaps reversed bounds rather than returning nothing', () => {
    const rng = createRng(5);
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(7, 3);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
    }
  });

  it('bool() honours its probability, including the degenerate ends', () => {
    const rng = createRng(8);
    for (let i = 0; i < 1000; i++) expect(rng.bool(0)).toBe(false);
    for (let i = 0; i < 1000; i++) expect(rng.bool(1)).toBe(true);

    const biased = createRng(8);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (biased.bool(0.25)) hits++;
    expect(hits / 20_000).toBeCloseTo(0.25, 2);
  });

  it('validates pick() and weighted() inputs', () => {
    const rng = createRng(1);
    expect(() => rng.pick([])).toThrow(/empty array/);
    expect(() => rng.weighted([], [])).toThrow();
    expect(() => rng.weighted(['a'], [1, 2])).toThrow(/1 items vs 2 weights/);
    expect(() => rng.weighted(['a', 'b'], [0, 0])).toThrow(/sum to 0/);
    expect(() => rng.weighted(['a', 'b'], [1, -1])).toThrow(/>= 0/);
  });

  it('rejects non-finite weights instead of silently returning the last item', () => {
    // NaN slipped past every guard: `NaN < 0` is false, so `total` and then
    // `roll` became NaN, no `roll < 0` test ever succeeded, and the
    // float-rounding fallthrough returned the LAST entry with nothing thrown.
    expect(() => createRng(1).weighted(['a', 'b', 'c'], [1, NaN, 1])).toThrow(/finite/);
    expect(() => createRng(1).weighted(['a', 'b'], [1, Infinity])).toThrow(/finite/);
    expect(() => createRng(1).weighted(['a', 'b'], [1, -Infinity])).toThrow(/finite/);
  });

  it('pins the weighted() sequence for valid input', () => {
    const rng = createRng(101);
    expect([...Array(10)].map(() => rng.weighted(['a', 'b', 'c'], [1, 2, 7]))).toEqual([
      'b',
      'c',
      'c',
      'c',
      'c',
      'c',
      'c',
      'c',
      'b',
      'a',
    ]);
  });

  it('shuffle() returns a new array and leaves the input untouched', () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = createRng(42).shuffle(source);
    expect(shuffled).toEqual([3, 8, 2, 1, 7, 6, 4, 5]);
    expect(shuffled).not.toBe(source);
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('unitVector2() is unit length', () => {
    const rng = createRng(3);
    for (let i = 0; i < 1000; i++) {
      const [x, z] = rng.unitVector2();
      expect(Math.hypot(x, z)).toBeCloseTo(1, 12);
    }
  });

  it('insideCircle() stays inside the radius and is uniform by AREA', () => {
    const bounded = createRng(4);
    for (let i = 0; i < 5000; i++) {
      const [x, z] = bounded.insideCircle(2.5);
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(2.5);
    }

    // Uniform by area means a quarter of the points fall inside half-radius,
    // not half of them — that is what the `Math.sqrt` in the source buys.
    const uniform = createRng(6);
    let inner = 0;
    for (let i = 0; i < 20_000; i++) {
      const [x, z] = uniform.insideCircle(1);
      if (Math.hypot(x, z) < 0.5) inner++;
    }
    expect(inner / 20_000).toBeCloseTo(0.25, 2);
  });

  it('gaussian() centres on its mean', () => {
    const rng = createRng(31);
    let total = 0;
    for (let i = 0; i < 20_000; i++) total += rng.gaussian(5, 2);
    expect(total / 20_000).toBeCloseTo(5, 1);
  });
});
