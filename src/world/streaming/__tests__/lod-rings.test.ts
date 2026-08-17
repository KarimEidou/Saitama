/**
 * LOD RINGS AND HYSTERESIS
 *
 * The test that matters here is the oscillation test: a camera parked on a ring
 * boundary and jittering must produce ZERO ring changes. Without the dead band
 * that same camera rebuilds and re-uploads a chunk every frame forever, which
 * is the most expensive failure mode this system has and the easiest to trigger
 * — players stand still all the time.
 */

import { describe, expect, it } from 'vitest';
import {
  RingAssigner,
  residentRadiusFor,
  ringForDistance,
  ringWithHysteresis,
  shouldEvict,
  shouldLoad,
} from '../lod-rings';
import {
  EVICT_MARGIN_CHUNKS,
  RESIDENT_RADIUS_CHUNKS_BY_TIER,
  RING_HYSTERESIS_CHUNKS,
  RING_OUTER_CHUNKS,
  RING_R0,
  RING_R1,
  RING_R2,
  RING_R3,
} from '../constants';

describe('ringForDistance', () => {
  it('matches the documented ring plan', () => {
    // R0 covers chunk rings 0-1, whose centres sit at distance 0..1.5.
    expect(ringForDistance(0)).toBe(RING_R0);
    expect(ringForDistance(1)).toBe(RING_R0);
    expect(ringForDistance(1.5)).toBe(RING_R0);
    // R1 covers chunk rings 2-4.
    expect(ringForDistance(1.51)).toBe(RING_R1);
    expect(ringForDistance(4)).toBe(RING_R1);
    expect(ringForDistance(4.5)).toBe(RING_R1);
    // R2 covers chunk rings 5-8.
    expect(ringForDistance(4.51)).toBe(RING_R2);
    expect(ringForDistance(8)).toBe(RING_R2);
    expect(ringForDistance(8.5)).toBe(RING_R2);
    // Everything beyond is the impostor.
    expect(ringForDistance(8.51)).toBe(RING_R3);
    expect(ringForDistance(15)).toBe(RING_R3);
  });
});

describe('ringWithHysteresis', () => {
  it('is the plain assignment for a chunk with no history', () => {
    expect(ringWithHysteresis(3, -1)).toBe(RING_R1);
    expect(ringWithHysteresis(0.2, -1)).toBe(RING_R0);
  });

  it('holds the current ring inside the dead band', () => {
    const boundary = RING_OUTER_CHUNKS[0]!;
    // Just past R0's edge but inside the band: stays R0.
    expect(ringWithHysteresis(boundary + RING_HYSTERESIS_CHUNKS * 0.5, RING_R0)).toBe(RING_R0);
    // Just inside R0's edge but coming from R1: stays R1.
    expect(ringWithHysteresis(boundary - RING_HYSTERESIS_CHUNKS * 0.5, RING_R1)).toBe(RING_R1);
  });

  it('changes ring once the band is cleared', () => {
    const boundary = RING_OUTER_CHUNKS[0]!;
    expect(ringWithHysteresis(boundary + RING_HYSTERESIS_CHUNKS * 1.5, RING_R0)).toBe(RING_R1);
    expect(ringWithHysteresis(boundary - RING_HYSTERESIS_CHUNKS * 1.5, RING_R1)).toBe(RING_R0);
  });

  it('has no distance at which the promote and demote thresholds coincide', () => {
    // The defining property of hysteresis: for every distance in the band,
    // the answer depends on where you came from.
    const boundary = RING_OUTER_CHUNKS[1]!;
    for (let offset = -RING_HYSTERESIS_CHUNKS * 0.9; offset < RING_HYSTERESIS_CHUNKS * 0.9; offset += 0.05) {
      const d = boundary + offset;
      expect(ringWithHysteresis(d, RING_R1)).toBe(RING_R1);
      expect(ringWithHysteresis(d, RING_R2)).toBe(RING_R2);
    }
  });
});

describe('RingAssigner', () => {
  /** Walk a chunk's distance through a sequence and count ring changes. */
  const run = (distances: readonly number[]): RingAssigner => {
    const assigner = new RingAssigner();
    for (const d of distances) assigner.assign(0, d);
    return assigner;
  };

  it('does not thrash for a camera jittering on a boundary', () => {
    const boundary = RING_OUTER_CHUNKS[0]!;
    const jitter: number[] = [];
    // 600 frames of +/- 0.25 chunks (24 m) of noise straddling the boundary —
    // a player standing on a street corner shifting their weight.
    for (let frame = 0; frame < 600; frame++) {
      const phase = frame % 4;
      const offset = phase === 0 ? 0.25 : phase === 1 ? -0.2 : phase === 2 ? 0.18 : -0.24;
      jitter.push(boundary + offset);
    }
    const assigner = run(jitter);

    expect(assigner.transitionCount).toBe(0);
    expect(assigner.suppressedCount).toBeGreaterThan(0);
    expect(assigner.ringOf(0)).toBe(RING_R0);
  });

  it('does transition for real movement across the band', () => {
    const boundary = RING_OUTER_CHUNKS[0]!;
    const walk: number[] = [];
    for (let i = 0; i < 40; i++) walk.push(boundary - 1 + i * 0.1);
    const assigner = run(walk);
    expect(assigner.transitionCount).toBeGreaterThan(0);
    expect(assigner.ringOf(0)).toBe(RING_R1);
  });

  it('counts one transition per crossing, not one per frame', () => {
    const boundary = RING_OUTER_CHUNKS[0]!;
    const wide = RING_HYSTERESIS_CHUNKS * 2;
    const sequence: number[] = [];
    // Two full round trips well clear of the band: exactly four transitions.
    for (let lap = 0; lap < 2; lap++) {
      for (let i = 0; i < 20; i++) sequence.push(boundary + wide);
      for (let i = 0; i < 20; i++) sequence.push(boundary - wide);
    }
    const assigner = run(sequence);
    expect(assigner.transitionCount).toBe(4);
  });

  it('forgets an evicted chunk', () => {
    const assigner = new RingAssigner();
    assigner.assign(9, 0.2);
    expect(assigner.ringOf(9)).toBe(RING_R0);
    assigner.forget(9);
    expect(assigner.ringOf(9)).toBe(-1);
  });
});

describe('load and eviction radii', () => {
  it('evicts at a wider radius than it loads', () => {
    const radius = residentRadiusFor('high');
    expect(shouldLoad(radius, radius)).toBe(true);
    expect(shouldLoad(radius + 0.01, radius)).toBe(false);
    // The gap between "stop loading" and "start evicting" is the dead band.
    expect(shouldEvict(radius + 0.01, radius)).toBe(false);
    expect(shouldEvict(radius + EVICT_MARGIN_CHUNKS, radius)).toBe(false);
    expect(shouldEvict(radius + EVICT_MARGIN_CHUNKS + 0.01, radius)).toBe(true);
  });

  it('shrinks the resident set on weaker tiers', () => {
    expect(residentRadiusFor('low')).toBeLessThan(residentRadiusFor('medium'));
    expect(residentRadiusFor('medium')).toBeLessThan(residentRadiusFor('high'));
    expect(residentRadiusFor('high')).toBe(RESIDENT_RADIUS_CHUNKS_BY_TIER.high);
    // The high tier reaches exactly the outer edge of R2, so every ring the
    // plan describes is actually reachable.
    expect(residentRadiusFor('high')).toBe(RING_OUTER_CHUNKS[2]);
  });
});
