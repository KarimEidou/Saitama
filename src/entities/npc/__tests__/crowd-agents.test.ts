/**
 * THE AGENT POOL
 *
 * `CrowdAgents` is fourteen typed arrays and a free list, and every recycling
 * invariant the rest of the crowd is built on lives in it: the LIFO free list,
 * the never-shrinking `extent` that every `for (i < extent)` loop in the unit
 * iterates to, the `-1` at capacity that `spawnOne` reads as "the crowd is
 * full", the "traits are a pure function of the seed" claim the determinism
 * test rests on, and the millimetre quantisation contract in `hash()`.
 *
 * The one that matters most is the DOUBLE FREE. `despawn` guards on
 * `active[index] === 0`; without that guard the same slot enters `free` twice,
 * two live agents end up sharing one row of every array, and the symptom is a
 * civilian who teleports and a hash that will not reproduce. It is silent, it
 * is catastrophic, and it is one line — so it gets an assertion.
 */

import { describe, it, expect } from 'vitest';
import { CrowdAgents, MOOD_COMMUTE, MOOD_GAWK, TIER_MID, TIER_NEAR } from '../crowd-agents';
import { AGENT_RADIUS, CIVILIAN_HEALTH, MID_CAP, NEAR_CAP } from '../constants';

const CAPACITY = MID_CAP + NEAR_CAP;

describe('CrowdAgents', () => {
  it('populates a slot from one seed', () => {
    const agents = new CrowdAgents();
    const i = agents.spawn(1234, 5, -7, 0.5, TIER_NEAR);
    expect(i).toBe(0);
    expect(agents.count).toBe(1);
    expect(agents.extent).toBe(1);
    expect(agents.active[0]).toBe(1);
    expect(agents.posX[0]).toBe(5);
    expect(agents.posZ[0]).toBe(-7);
    expect(agents.yaw[0]).toBe(0.5);
    // Stored as float32, so an exact equality here would be testing the FPU.
    expect(agents.radius[0]!).toBeCloseTo(AGENT_RADIUS, 6);
    expect(agents.health[0]).toBe(CIVILIAN_HEALTH);
    expect(agents.maxHealth[0]).toBe(CIVILIAN_HEALTH);
    expect(agents.mood[0]).toBe(MOOD_COMMUTE);
    expect(agents.stamina[0]).toBe(1);
    expect(agents.tierOf(0)).toBe('near');
    expect(agents.moodOf(0)).toBe('commute');
    expect(agents.idOf(0).length).toBeGreaterThan(0);
  });

  it('recycles slots most-recently-freed first', () => {
    const agents = new CrowdAgents();
    agents.spawn(1, 0, 0, 0, TIER_MID);
    agents.spawn(2, 1, 0, 0, TIER_MID);
    agents.spawn(3, 2, 0, 0, TIER_MID);
    agents.despawn(1);
    expect(agents.count).toBe(2);
    expect(agents.spawn(4, 3, 0, 0, TIER_MID)).toBe(1);
    expect(agents.count).toBe(3);
    expect(agents.extent).toBe(3);
  });

  it('never shrinks its extent, so the iteration bound stays valid', () => {
    const agents = new CrowdAgents();
    for (let n = 0; n < 5; n++) agents.spawn(n, n, 0, 0, TIER_MID);
    expect(agents.extent).toBe(5);
    for (let n = 0; n < 5; n++) agents.despawn(n);
    expect(agents.count).toBe(0);
    expect(agents.extent).toBe(5);
    for (let n = 0; n < agents.extent; n++) expect(agents.active[n]).toBe(0);
  });

  it('cannot be made to hand the same slot to two live agents', () => {
    const agents = new CrowdAgents();
    for (let n = 0; n < 5; n++) agents.spawn(n, n, 0, 0, TIER_MID);
    agents.despawn(2);
    // The second one must be a no-op. If it pushed 2 onto the free list again,
    // the next two spawns would both land on slot 2 and share every array row.
    agents.despawn(2);
    expect(agents.count).toBe(4);
    const a = agents.spawn(90, 0, 0, 0, TIER_MID);
    const b = agents.spawn(91, 0, 0, 0, TIER_MID);
    expect(a).not.toBe(b);
    expect(agents.count).toBe(6);
  });

  it('treats the cap as a budget and refuses to grow past it', () => {
    const agents = new CrowdAgents();
    const seen = new Set<number>();
    for (let n = 0; n < CAPACITY; n++) {
      const i = agents.spawn(n, 0, 0, 0, TIER_MID);
      expect(i).toBeGreaterThanOrEqual(0);
      seen.add(i);
    }
    expect(seen.size).toBe(CAPACITY);
    expect(agents.count).toBe(CAPACITY);
    expect(agents.spawn(999, 0, 0, 0, TIER_MID)).toBe(-1);
    expect(agents.count).toBe(CAPACITY);
  });

  it('comes back empty from clear, with the whole pool available again', () => {
    const agents = new CrowdAgents();
    for (let n = 0; n < 40; n++) agents.spawn(n, n, 0, 0, TIER_MID);
    agents.clear();
    expect(agents.count).toBe(0);
    expect(agents.extent).toBe(0);
    for (let n = 0; n < CAPACITY; n++) {
      expect(agents.spawn(n, 0, 0, 0, TIER_MID)).toBeGreaterThanOrEqual(0);
    }
    expect(agents.count).toBe(CAPACITY);
  });

  it('derives every trait from the seed and nothing else', () => {
    const a = new CrowdAgents();
    const b = new CrowdAgents();
    // Different slot histories, different positions, same seed.
    a.spawn(5, 0, 0, 0, TIER_MID);
    a.despawn(0);
    const ai = a.spawn(77, 10, 20, 1, TIER_NEAR);
    const bi = b.spawn(77, -30, 4, 0, TIER_MID);

    expect(a.archetype[ai]).toBe(b.archetype[bi]);
    expect(a.palette[ai]).toBe(b.palette[bi]);
    expect(a.bravado[ai]).toBe(b.bravado[bi]);
    expect(a.timeOffset[ai]).toBe(b.timeOffset[bi]);
    expect(a.rate[ai]).toBe(b.rate[bi]);
    expect(a.goalPhase[ai]).toBe(b.goalPhase[bi]);

    const c = new CrowdAgents();
    const ci = c.spawn(78, -30, 4, 0, TIER_MID);
    const differs =
      c.archetype[ci] !== b.archetype[bi] ||
      c.palette[ci] !== b.palette[bi] ||
      c.bravado[ci] !== b.bravado[bi] ||
      c.timeOffset[ci] !== b.timeOffset[bi] ||
      c.rate[ci] !== b.rate[bi] ||
      c.goalPhase[ci] !== b.goalPhase[bi];
    expect(differs).toBe(true);
  });

  it('keeps the seeded traits inside the ranges the rest of the crowd assumes', () => {
    const agents = new CrowdAgents();
    for (let seed = 0; seed < 200; seed++) {
      const i = agents.spawn(seed * 7919 + 3, 0, 0, 0, TIER_MID);
      // The clamp01 on the beta-ish sum: bravado is a probability, and the
      // steering thresholds are only meaningful inside [0, 1].
      expect(agents.bravado[i]!).toBeGreaterThanOrEqual(0);
      expect(agents.bravado[i]!).toBeLessThanOrEqual(1);
      // Float32 storage, so the interval bounds get a rounding allowance.
      expect(agents.rate[i]!).toBeGreaterThanOrEqual(0.88 - 1e-6);
      expect(agents.rate[i]!).toBeLessThanOrEqual(1.14 + 1e-6);
      agents.despawn(i);
    }
  });

  it('resets the dwell timer only when the mood actually changes', () => {
    const agents = new CrowdAgents();
    const i = agents.spawn(3, 0, 0, 0, TIER_MID);
    agents.moodTime[i] = 0.9;
    agents.setMood(i, MOOD_COMMUTE);
    expect(agents.moodTime[i]).toBeCloseTo(0.9, 6);
    agents.setMood(i, MOOD_GAWK);
    expect(agents.moodTime[i]).toBe(0);
    expect(agents.moodOf(i)).toBe('gawk');
  });

  it('hashes to a millimetre, and ignores the slots nobody is standing in', () => {
    const agents = new CrowdAgents();
    const i = agents.spawn(1, 5, 5, 0, TIER_MID);
    const base = agents.hash();
    expect(agents.hash()).toBe(base);

    // Two millimetres is a different run.
    agents.posX[i] = 5.002;
    expect(agents.hash()).not.toBe(base);
    // A tenth of a millimetre is the FPU's rounding mode, not a divergence.
    agents.posX[i] = 5.0001;
    expect(agents.hash()).toBe(base);
    agents.posX[i] = 5;

    agents.spawn(2, -9, 3, 0.25, TIER_NEAR);
    const c = agents.spawn(3, 40, -12, 1, TIER_MID);
    agents.despawn(1);

    // The same two live agents in the same two slots, with something completely
    // different having occupied the freed one.
    const twin = new CrowdAgents();
    twin.spawn(1, 5, 5, 0, TIER_MID);
    twin.spawn(4242, 700, -700, 3, TIER_MID);
    twin.spawn(3, 40, -12, 1, TIER_MID);
    twin.despawn(1);
    expect(twin.hash()).toBe(agents.hash());

    // And the assertion is not vacuous: a live agent in that slot does change it.
    const populated = new CrowdAgents();
    populated.spawn(1, 5, 5, 0, TIER_MID);
    populated.spawn(4242, 700, -700, 3, TIER_MID);
    populated.spawn(3, 40, -12, 1, TIER_MID);
    expect(populated.hash()).not.toBe(agents.hash());
    expect(c).toBe(2);
  });
});
