/**
 * NUMERIC RING BUFFER — AVERAGE OVER A HOSTILE SAMPLE STREAM
 *
 * The class's declared job is per-frame metrics sampled every frame for a whole
 * session, so it has to survive the two things frame timing actually produces:
 * a non-finite sample (`1 / dt` on a `performance.now()` tie, or the first frame
 * after a tab resume) and one enormous outlier (a hitch measured in the wrong
 * unit). A running `sum` survives neither — `NaN - NaN` is `NaN`, and
 * `1e17 + 1` is `1e17`, so the eviction subtracts more than was ever added.
 *
 * Both leave `average` permanently wrong with nothing thrown, and `NaN`
 * compares false against every threshold, so an adaptive-resolution governor
 * reading it simply stops governing.
 */

import { describe, it, expect } from 'vitest';
import { NumericRingBuffer, RingBuffer } from '../ring-buffer';

describe('NumericRingBuffer.average', () => {
  it('recovers once a NaN sample has been evicted', () => {
    const buffer = new NumericRingBuffer(3);
    buffer.push(16);
    buffer.push(NaN);
    buffer.push(16);
    expect(buffer.average).toBeNaN();

    buffer.push(16);
    buffer.push(16);
    buffer.push(16);
    expect(buffer.average).toBe(16);
  });

  it('recovers once an Infinity sample has been evicted', () => {
    const buffer = new NumericRingBuffer(2);
    buffer.push(Number.POSITIVE_INFINITY);
    buffer.push(8);
    buffer.push(8);
    expect(buffer.average).toBe(8);
  });

  it('is not destroyed by a large outlier that has since been evicted', () => {
    const buffer = new NumericRingBuffer(3);
    buffer.push(1e17);
    buffer.push(1);
    buffer.push(1);
    buffer.push(1);
    expect(buffer.average).toBe(1);
  });

  it('reports the mean of exactly the retained samples', () => {
    const buffer = new NumericRingBuffer(4);
    expect(buffer.average).toBe(0);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.average).toBe(1.5);
    buffer.push(3);
    buffer.push(4);
    buffer.push(5);
    // Window is [2, 3, 4, 5]; the evicted 1 must not count.
    expect(buffer.average).toBe(3.5);
    expect(buffer.length).toBe(4);
    expect(buffer.min).toBe(2);
    expect(buffer.max).toBe(5);
    buffer.clear();
    expect(buffer.average).toBe(0);
  });
});

describe('ring buffer capacity validation', () => {
  it('rejects a fractional capacity instead of indexing past its own array', () => {
    // `new Float64Array(2.5)` truncates to 2 while `this.capacity` keeps 2.5,
    // which then drives every `% this.capacity` and produces a fractional head.
    expect(() => new NumericRingBuffer(2.5)).toThrow(/positive integer/);
    expect(() => new RingBuffer<number>(2.5)).toThrow(/positive integer/);
  });

  it('still rejects zero, negative and non-numeric capacities', () => {
    expect(() => new NumericRingBuffer(0)).toThrow();
    expect(() => new NumericRingBuffer(-1)).toThrow();
    expect(() => new NumericRingBuffer(NaN)).toThrow();
    expect(() => new RingBuffer<number>(0)).toThrow();
    expect(() => new RingBuffer<number>(-1)).toThrow();
  });

  it('accepts an integral capacity', () => {
    expect(new NumericRingBuffer(120).capacity).toBe(120);
    expect(new RingBuffer<number>(120).capacity).toBe(120);
  });
});
