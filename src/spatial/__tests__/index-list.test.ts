/**
 * INDEX LIST AND FLOAT LIST — STORAGE POLICY
 *
 * Every query in `src/spatial/` writes its results into an `IndexList`, and
 * `IndexList` is constructed directly outside this unit too. The other specs
 * exercise it only as an output sink: they check the CONTENTS of `[0, length)`
 * and never the storage policy underneath.
 *
 * The parts with real logic are exactly the ones that leaves uncovered —
 * `grow`'s three interacting clauses, `pushRange`'s copy from an arbitrary
 * offset (an off-by-one there silently drops or duplicates items in the
 * INSIDE-subtree fast path `cullFrustum` uses for wholesale acceptance), and
 * `FloatList`'s separately hand-written growth path.
 *
 * The exact capacity assertions are deliberate. They pin the geometric growth
 * policy that the allocation-discipline tests in `determinism.test.ts` and
 * `frustum-cull.test.ts` depend on: those assert a warm list stops
 * reallocating, which only means something while growth is bounded.
 */

import { describe, it, expect } from 'vitest';
import { IndexList, FloatList } from '../index-list';

describe('IndexList', () => {
  it('grows geometrically from a tiny capacity and keeps every value', () => {
    const list = new IndexList(1);
    for (let i = 0; i < 20; i++) list.push(i * 3);
    expect(list.length).toBe(20);
    expect(list.toArray()).toEqual(Array.from({ length: 20 }, (_, i) => i * 3));
    // 1 -> 8 -> 16 -> 32: pins the documented geometric policy and the >= 8 floor.
    expect(list.capacity).toBe(32);
    expect(list.at(0)).toBe(0);
    expect(list.at(19)).toBe(57);
  });

  it('clear() resets the length and retains the backing store', () => {
    const list = new IndexList(4);
    for (let i = 0; i < 40; i++) list.push(i);
    const capacity = list.capacity;
    list.clear();
    expect(list.length).toBe(0);
    expect(list.capacity).toBe(capacity);
    list.push(7);
    expect(list.toArray()).toEqual([7]);
    expect(list.capacity).toBe(capacity);
  });

  it('pushRange appends exactly n values from the given offset', () => {
    const list = new IndexList(8);
    list.push(100);
    list.pushRange(new Int32Array([9, 8, 7, 6]), 1, 2);
    expect(list.toArray()).toEqual([100, 8, 7]);
    list.pushRange([1, 2, 3], 0, 3);
    expect(list.toArray()).toEqual([100, 8, 7, 1, 2, 3]);
  });

  it('pushRange larger than the capacity grows once and preserves prior contents', () => {
    const list = new IndexList(2);
    list.push(-1);
    const src = new Int32Array(500);
    for (let i = 0; i < 500; i++) src[i] = i;
    list.pushRange(src, 0, 500);
    expect(list.length).toBe(501);
    expect(list.at(0)).toBe(-1);
    expect(list.at(1)).toBe(0);
    expect(list.at(500)).toBe(499);
    expect(list.capacity).toBeGreaterThanOrEqual(501);
  });

  it('reserve pre-allocates so later pushes do not reallocate', () => {
    const list = new IndexList(4);
    list.reserve(1000);
    expect(list.capacity).toBe(1000);
    for (let i = 0; i < 1000; i++) list.push(i);
    expect(list.capacity).toBe(1000);
    expect(list.length).toBe(1000);
    // reserve below the current capacity is a no-op.
    list.reserve(4);
    expect(list.capacity).toBe(1000);
  });

  it('sort orders only the valid range, and includes is a membership test over it', () => {
    const list = new IndexList(8);
    for (const v of [5, 1, 9, 3]) list.push(v);
    list.sort();
    expect(list.toArray()).toEqual([1, 3, 5, 9]);
    expect(list.includes(9)).toBe(true);
    expect(list.includes(4)).toBe(false);
    list.clear();
    expect(list.includes(9)).toBe(false); // stale storage must not be visible
  });
});

describe('FloatList', () => {
  it('grows from a tiny capacity and round-trips doubles exactly', () => {
    const list = new FloatList(1);
    const values = [0.1, -3.5, 1e-9, 1234.5678, Infinity];
    for (const v of values) list.push(v);
    for (let i = 5; i < 50; i++) list.push(i * 0.25);
    expect(list.length).toBe(50);
    expect(list.at(0)).toBe(0.1);
    expect(list.at(2)).toBe(1e-9);
    expect(list.at(4)).toBe(Infinity);
    expect(list.data.length).toBe(64); // 1 -> 8 -> 16 -> 32 -> 64
    expect(list.toArray().slice(0, 5)).toEqual(values);
  });

  it('clear() resets the length and retains the buffer', () => {
    const list = new FloatList(4);
    for (let i = 0; i < 20; i++) list.push(i);
    const size = list.data.length;
    list.clear();
    expect(list.length).toBe(0);
    expect(list.data.length).toBe(size);
    expect(list.toArray()).toEqual([]);
  });
});
