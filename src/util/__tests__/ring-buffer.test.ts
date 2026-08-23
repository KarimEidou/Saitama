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

/**
 * The suites below pin the read paths. Every one of them runs the same
 * non-obvious modular arithmetic — `(head - size + capacity) % capacity`
 * appears in four places — and both classes are unused today, which makes this
 * the cheapest moment to fix their semantics: the first consumer (a frame-time
 * history feeding `IGameDiagnostics.fps`) should be debugging its own logic,
 * not the container underneath it.
 */

describe('RingBuffer', () => {
  it('reports an empty buffer consistently', () => {
    const rb = new RingBuffer<string>(3);
    expect(rb.length).toBe(0);
    expect(rb.isEmpty).toBe(true);
    expect(rb.isFull).toBe(false);
    expect(rb.first).toBeUndefined();
    expect(rb.last).toBeUndefined();
    expect(rb.toArray()).toEqual([]);
    expect([...rb]).toEqual([]);
  });

  it('fills, then evicts oldest-first as it wraps', () => {
    const rb = new RingBuffer<string>(3);
    rb.push('a');
    rb.push('b');
    expect(rb.toArray()).toEqual(['a', 'b']);
    expect(rb.first).toBe('a');
    expect(rb.last).toBe('b');
    expect(rb.isFull).toBe(false);

    rb.push('c');
    expect(rb.isFull).toBe(true);
    expect(rb.toArray()).toEqual(['a', 'b', 'c']);

    rb.push('d');
    expect(rb.toArray()).toEqual(['b', 'c', 'd']);
    expect(rb.first).toBe('b');
    expect(rb.last).toBe('d');
    expect(rb.length).toBe(3);

    // Two more wraps: this is the case that catches an off-by-one in `start`.
    rb.push('e');
    rb.push('f');
    expect(rb.toArray()).toEqual(['d', 'e', 'f']);
    expect([...rb]).toEqual(['d', 'e', 'f']);
  });

  it('indexes by age and returns undefined out of range', () => {
    const rb = new RingBuffer<string>(3);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    expect(rb.get(0)).toBe('a');
    expect(rb.get(2)).toBe('c');
    expect(rb.get(-1)).toBeUndefined();
    expect(rb.get(3)).toBeUndefined();
  });

  it('returns to the exact empty state after clear()', () => {
    const rb = new RingBuffer<string>(3);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    rb.push('d');
    rb.clear();

    expect(rb.length).toBe(0);
    expect(rb.isEmpty).toBe(true);
    expect(rb.isFull).toBe(false);
    expect(rb.first).toBeUndefined();
    expect(rb.last).toBeUndefined();
    expect(rb.toArray()).toEqual([]);
    expect([...rb]).toEqual([]);
  });

  it('is re-iterable, oldest to newest', () => {
    const rb = new RingBuffer<string>(3);
    for (const item of ['a', 'b', 'c', 'd']) rb.push(item);
    expect([...rb]).toEqual(['b', 'c', 'd']);
    expect([...rb]).toEqual(['b', 'c', 'd']);
  });
});

describe('NumericRingBuffer statistics', () => {
  it('reports zeroes for an empty buffer rather than NaN', () => {
    const buffer = new NumericRingBuffer(4);
    expect(buffer.length).toBe(0);
    expect(buffer.average).toBe(0);
    expect(buffer.min).toBe(0);
    expect(buffer.max).toBe(0);
    expect(buffer.percentile(0.99)).toBe(0);
    expect(buffer.last).toBeUndefined();
  });

  it('tracks the retained window through eviction', () => {
    const buffer = new NumericRingBuffer(4);
    for (const value of [10, 20, 30, 40]) buffer.push(value);
    expect(buffer.average).toBe(25);
    expect(buffer.min).toBe(10);
    expect(buffer.max).toBe(40);
    expect(buffer.last).toBe(40);
    expect([0, 1, 2, 3].map((i) => buffer.get(i))).toEqual([10, 20, 30, 40]);

    buffer.push(50);
    buffer.push(60);
    expect([0, 1, 2, 3].map((i) => buffer.get(i))).toEqual([30, 40, 50, 60]);
    expect(buffer.average).toBe(45);
    expect(buffer.min).toBe(30);
    expect(buffer.max).toBe(60);
    expect(buffer.last).toBe(60);
  });

  it('computes nearest-rank percentiles over the window', () => {
    const buffer = new NumericRingBuffer(4);
    for (const value of [10, 20, 30, 40]) buffer.push(value);
    expect(buffer.percentile(0)).toBe(10);
    expect(buffer.percentile(0.5)).toBe(20);
    expect(buffer.percentile(0.75)).toBe(30);
    expect(buffer.percentile(0.99)).toBe(40);
    expect(buffer.percentile(1)).toBe(40);
  });

  it('resolves p99 over a realistic window — the metric that actually matters', () => {
    const buffer = new NumericRingBuffer(100);
    for (let i = 1; i <= 100; i++) buffer.push(i);
    expect(buffer.percentile(0.99)).toBe(99);
    expect(buffer.percentile(0.5)).toBe(50);
    expect(buffer.percentile(0.01)).toBe(1);
  });

  it('wraps a small capacity correctly', () => {
    const buffer = new NumericRingBuffer(3);
    for (let i = 1; i <= 7; i++) buffer.push(i);
    expect([0, 1, 2].map((i) => buffer.get(i))).toEqual([5, 6, 7]);
    expect(buffer.average).toBe(6);
  });

  it('returns to the empty state after clear()', () => {
    const buffer = new NumericRingBuffer(4);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(value);
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.average).toBe(0);
    expect(buffer.last).toBeUndefined();
  });
});
