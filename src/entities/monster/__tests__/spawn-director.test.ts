/**
 * THE SPAWN DIRECTOR
 *
 * Two claims matter more than the rest and both are asserted over thousands of
 * orders rather than over one:
 *
 *   NOTHING SPAWNS IN R2   a monster there is invisible, has no colliders and
 *                          has nobody to threaten. It is pure cost.
 *   NOTHING SPAWNS ON THE  turning around into something that was not there a
 *   PLAYER                 moment ago reads as a bug even when it is a spawn.
 *
 * Everything else here is pacing, zoning and determinism.
 */

import { describe, expect, it } from 'vitest';
import type { DistrictType, Vec3 } from '@/types';
import {
  DEFAULT_SPAWN_POLICY,
  DISTRICT_TIER_WEIGHTS,
  MONSTER_CHUNK_SIZE_METRES,
  SpawnDirector,
  ringBetween,
  type ILiveMonsterRef,
} from '../spawn-director';
import { monsterArchetype } from '../archetypes';
import type { ISpawnOrder, SpawnPacingState, ThreatTier } from '../types';

const FOCUS: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Drive a director for `seconds`, maintaining a live list from its own orders
 * so budgets, separation and culling are all exercised against real state.
 */
function drive(
  director: SpawnDirector,
  seconds: number,
  options: {
    readonly focus?: Vec3;
    readonly dt?: number;
    readonly encounterActive?: boolean;
    readonly engaged?: boolean;
  } = {}
): { orders: ISpawnOrder[]; live: ILiveMonsterRef[]; retired: string[] } {
  const dt = options.dt ?? 0.5;
  const focus = options.focus ?? FOCUS;
  const orders: ISpawnOrder[] = [];
  const retired: string[] = [];
  const live: ILiveMonsterRef[] = [];

  for (let t = 0; t < seconds; t += dt) {
    const decision = director.update(dt, {
      focus,
      live,
      encounterActive: options.encounterActive,
    });
    for (const id of decision.retire) {
      const index = live.findIndex((m) => m.id === id);
      if (index >= 0) {
        retired.push(id);
        live.splice(index, 1);
      }
    }
    for (const order of decision.orders) {
      orders.push(order);
      live.push({
        id: `m#${order.serial}`,
        tier: order.tier,
        position: order.position,
        age: 0,
        engaged: options.engaged ?? false,
        scripted: false,
      });
    }
    for (const monster of live) (monster as { age: number }).age += dt;
  }
  return { orders, live, retired };
}

/* -------------------------------------------------------------------------- */
/* Ring geometry                                                              */
/* -------------------------------------------------------------------------- */

describe('ring geometry', () => {
  it('mirrors the published ring plan: R0 ≤ 1.5, R1 ≤ 4.5, R2 ≤ 8.5 chunks', () => {
    const c = MONSTER_CHUNK_SIZE_METRES;
    expect(ringBetween({ x: 0, y: 0, z: 0 }, FOCUS)).toBe(0);
    expect(ringBetween({ x: 1.4 * c, y: 0, z: 0 }, FOCUS)).toBe(0);
    expect(ringBetween({ x: 1.6 * c, y: 0, z: 0 }, FOCUS)).toBe(1);
    expect(ringBetween({ x: 4.4 * c, y: 0, z: 0 }, FOCUS)).toBe(1);
    expect(ringBetween({ x: 4.6 * c, y: 0, z: 0 }, FOCUS)).toBe(2);
    expect(ringBetween({ x: 8.6 * c, y: 0, z: 0 }, FOCUS)).toBe(3);
  });

  it('is Chebyshev, not Euclidean — a chunk grid has square rings', () => {
    const c = MONSTER_CHUNK_SIZE_METRES;
    // Euclidean distance 4.4 * sqrt(2) chunks, Chebyshev distance 4.4.
    expect(ringBetween({ x: 4.4 * c, y: 0, z: 4.4 * c }, FOCUS)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The two hard rules                                                         */
/* -------------------------------------------------------------------------- */

describe('placement rules', () => {
  it('NEVER places a monster in R2 or beyond, over thousands of orders', () => {
    const director = new SpawnDirector({ seed: 'ring-rule' });
    const { orders } = drive(director, 4000, { dt: 0.25 });
    expect(orders.length).toBeGreaterThan(200);
    for (const order of orders) {
      expect(order.ring).toBeLessThanOrEqual(DEFAULT_SPAWN_POLICY.maxSpawnRing);
      expect(ringBetween(order.position, FOCUS)).toBeLessThanOrEqual(
        DEFAULT_SPAWN_POLICY.maxSpawnRing
      );
    }
    // And the rule is doing real work: the sampling annulus reaches 520 m, so
    // candidates in R2 genuinely occur and are genuinely rejected.
    expect(director.stats().ordersRejected).toBeGreaterThan(0);
  });

  it('NEVER places a monster on top of the player', () => {
    const director = new SpawnDirector({ seed: 'no-ambush' });
    const { orders } = drive(director, 4000, { dt: 0.25 });
    for (const order of orders) {
      const distance = Math.hypot(order.position.x - FOCUS.x, order.position.z - FOCUS.z);
      expect(distance).toBeGreaterThanOrEqual(DEFAULT_SPAWN_POLICY.minSpawnDistanceMetres);
      expect(order.distanceFromFocus).toBeGreaterThanOrEqual(
        DEFAULT_SPAWN_POLICY.minSpawnDistanceMetres
      );
    }
  });

  it('honours a host-supplied ringAt in preference to its own mirror', () => {
    // The real streaming system says everything is R3. Nothing may spawn.
    const director = new SpawnDirector({ seed: 'injected-ring', ringAt: () => 3 });
    const { orders } = drive(director, 600);
    expect(orders).toHaveLength(0);
    expect(director.stats().lastRejection).toBe('ring');
  });

  it('keeps spawns inside the world box', () => {
    const director = new SpawnDirector({ seed: 'bounds' });
    const { orders } = drive(director, 2000, { focus: { x: 700, y: 0, z: 700 }, dt: 0.25 });
    expect(orders.length).toBeGreaterThan(20);
    for (const order of orders) {
      expect(Math.abs(order.position.x)).toBeLessThanOrEqual(
        DEFAULT_SPAWN_POLICY.worldRadiusMetres
      );
      expect(Math.abs(order.position.z)).toBeLessThanOrEqual(
        DEFAULT_SPAWN_POLICY.worldRadiusMetres
      );
    }
  });

  it('keeps spawned monsters apart', () => {
    const director = new SpawnDirector({ seed: 'separation' });
    const { orders } = drive(director, 400);
    const min = DEFAULT_SPAWN_POLICY.spawnSeparationMetres;
    for (let i = 0; i < orders.length; i++) {
      for (let j = i + 1; j < orders.length; j++) {
        const a = orders[i]!.position;
        const b = orders[j]!.position;
        // Only orders alive at the same moment are constrained; a later wave
        // may legitimately reuse a spot the first wave's monster left.
        if (orders[j]!.waveId - orders[i]!.waveId > 3) continue;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(min - 1e-9);
      }
    }
  });

  it('faces every spawn at the player', () => {
    const director = new SpawnDirector({ seed: 'facing' });
    const { orders } = drive(director, 400);
    expect(orders.length).toBeGreaterThan(5);
    for (const order of orders) {
      const expected = Math.atan2(FOCUS.x - order.position.x, FOCUS.z - order.position.z);
      expect(order.yaw).toBeCloseTo(expected, 6);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Budgets                                                                    */
/* -------------------------------------------------------------------------- */

describe('budgets', () => {
  it('never exceeds maxActive or any per-tier cap', () => {
    const director = new SpawnDirector({ seed: 'budget' });
    const live: ILiveMonsterRef[] = [];
    let peak = 0;
    const perTier: Record<string, number> = {};

    for (let t = 0; t < 3000; t += 0.5) {
      const decision = director.update(0.5, { focus: FOCUS, live });
      for (const id of decision.retire) {
        const index = live.findIndex((m) => m.id === id);
        if (index >= 0) live.splice(index, 1);
      }
      for (const order of decision.orders) {
        live.push({
          id: `m#${order.serial}`,
          tier: order.tier,
          position: order.position,
          age: 0,
          // Engaged, so culling never quietly makes room and the cap is the
          // only thing holding the population down.
          engaged: true,
          scripted: false,
        });
      }
      peak = Math.max(peak, live.length);
      for (const tier of ['wolf', 'tiger', 'demon', 'dragon', 'god'] as ThreatTier[]) {
        const count = live.filter((m) => m.tier === tier).length;
        perTier[tier] = Math.max(perTier[tier] ?? 0, count);
        expect(count).toBeLessThanOrEqual(DEFAULT_SPAWN_POLICY.maxPerTier[tier]);
      }
    }
    expect(peak).toBeLessThanOrEqual(DEFAULT_SPAWN_POLICY.maxActive);
    expect(peak).toBeGreaterThan(4);
  });

  it('ignores scripted monsters when counting the budget', () => {
    const director = new SpawnDirector({ seed: 'scripted' });
    const swarm: ILiveMonsterRef[] = Array.from({ length: 40 }, (_unused, i) => ({
      id: `swarm#${i}`,
      tier: 'wolf' as ThreatTier,
      // Far enough away not to trip the separation test.
      position: { x: 400 + i, y: 0, z: 400 },
      age: 0,
      engaged: false,
      scripted: true,
    }));
    director.setPacing('peak');
    const decision = director.update(0.5, { focus: FOCUS, live: swarm });
    expect(decision.orders.length).toBeGreaterThan(0);
    expect(decision.retire).toHaveLength(0); // scripted monsters are never culled
  });

  it('suppresses all spawning while a boss encounter owns the screen', () => {
    const director = new SpawnDirector({ seed: 'boss-quiet' });
    director.setPacing('peak');
    const { orders } = drive(director, 600, { encounterActive: true });
    expect(orders).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Pacing                                                                     */
/* -------------------------------------------------------------------------- */

describe('pacing', () => {
  it('cycles lull → build → peak → cooldown → lull', () => {
    const director = new SpawnDirector({ seed: 'pacing' });
    const live: ILiveMonsterRef[] = [
      { id: 'x', tier: 'wolf', position: { x: 300, y: 0, z: 0 }, age: 0, engaged: true, scripted: false },
    ];
    const seen: SpawnPacingState[] = [director.stats().pacing];
    for (let t = 0; t < 400; t += 0.5) {
      director.update(0.5, { focus: FOCUS, live });
      const state = director.stats().pacing;
      if (state !== seen[seen.length - 1]) seen.push(state);
    }
    expect(seen.slice(0, 5)).toEqual(['lull', 'build', 'peak', 'cooldown', 'lull']);
  });

  it('shortens an EMPTY lull, so a cleared district does not go quiet forever', () => {
    const busy = new SpawnDirector({ seed: 'lull-busy' });
    const empty = new SpawnDirector({ seed: 'lull-empty' });
    const occupied: ILiveMonsterRef[] = [
      { id: 'x', tier: 'wolf', position: { x: 300, y: 0, z: 0 }, age: 0, engaged: true, scripted: false },
    ];

    let busySeconds = 0;
    while (busy.stats().pacing === 'lull' && busySeconds < 200) {
      busy.update(0.5, { focus: FOCUS, live: occupied });
      busySeconds += 0.5;
    }
    let emptySeconds = 0;
    while (empty.stats().pacing === 'lull' && emptySeconds < 200) {
      empty.update(0.5, { focus: FOCUS, live: [] });
      emptySeconds += 0.5;
    }
    expect(emptySeconds).toBeLessThan(busySeconds);
  });

  it('spawns more per wave at peak than at lull', () => {
    const measure = (state: SpawnPacingState): number => {
      const director = new SpawnDirector({ seed: `wave-${state}` });
      director.setPacing(state);
      const decision = director.update(0.5, { focus: FOCUS, live: [] });
      return decision.orders.length;
    };
    expect(measure('peak')).toBeGreaterThan(measure('lull'));
    expect(measure('cooldown')).toBe(0);
  });

  it('leaves gaps: the world is not continuously producing monsters', () => {
    const director = new SpawnDirector({ seed: 'gaps' });
    const live: ILiveMonsterRef[] = [];
    let framesWithOrders = 0;
    let frames = 0;
    for (let t = 0; t < 600; t += 0.5) {
      const decision = director.update(0.5, { focus: FOCUS, live });
      for (const order of decision.orders) {
        live.push({
          id: `m#${order.serial}`,
          tier: order.tier,
          position: order.position,
          age: 0,
          engaged: true,
          scripted: false,
        });
      }
      frames++;
      if (decision.orders.length > 0) framesWithOrders++;
    }
    // Waves are events, not weather: fewer than one frame in eight produces
    // anything at all, even at the peak of the cycle.
    expect(framesWithOrders / frames).toBeLessThan(0.13);
    expect(framesWithOrders).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Zoning                                                                     */
/* -------------------------------------------------------------------------- */

describe('zoning', () => {
  it('weights every district and gives each one at least two tiers', () => {
    for (const [district, row] of Object.entries(DISTRICT_TIER_WEIGHTS)) {
      const nonZero = Object.values(row).filter((w) => w > 0);
      expect(nonZero.length, district).toBeGreaterThanOrEqual(2);
      const total = Object.values(row).reduce((s, w) => s + w, 0);
      expect(total, district).toBeGreaterThan(0.9);
    }
  });

  it('puts serious things in the wasteland and pests in the park', () => {
    const sample = (district: DistrictType): number => {
      const director = new SpawnDirector({ seed: `zone-${district}`, districtAt: () => district });
      const { orders } = drive(director, 6000, { dt: 0.25, engaged: false });
      const rank: Record<ThreatTier, number> = { wolf: 0, tiger: 1, demon: 2, dragon: 3, god: 4 };
      return orders.reduce((sum, o) => sum + rank[o.tier], 0) / Math.max(1, orders.length);
    };
    const park = sample('park');
    const wasteland = sample('wasteland');
    const residential = sample('residential');
    expect(wasteland).toBeGreaterThan(residential);
    expect(residential).toBeGreaterThan(park);
  });

  it('honours a district whitelist — no god-tier outside the wasteland', () => {
    for (const district of ['downtown', 'residential', 'park'] as DistrictType[]) {
      const director = new SpawnDirector({ seed: `whitelist-${district}`, districtAt: () => district });
      const { orders } = drive(director, 4000, { dt: 0.25 });
      for (const order of orders) {
        const archetype = monsterArchetype(order.archetypeId);
        expect(archetype.threatTier).not.toBe('god');
        const allowed = archetype.spawnDistricts;
        if (allowed !== undefined && allowed.length > 0) expect(allowed).toContain(district);
        expect(order.district).toBe(district);
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Culling                                                                    */
/* -------------------------------------------------------------------------- */

describe('culling', () => {
  it('retires monsters that drifted out of relevance', () => {
    const director = new SpawnDirector({ seed: 'cull' });
    const far: ILiveMonsterRef = {
      id: 'far',
      tier: 'wolf',
      position: { x: 900, y: 0, z: 0 },
      age: 5,
      engaged: false,
      scripted: false,
    };
    const stale: ILiveMonsterRef = {
      id: 'stale',
      tier: 'wolf',
      position: { x: 60, y: 0, z: 0 },
      age: DEFAULT_SPAWN_POLICY.staleSeconds + 1,
      engaged: false,
      scripted: false,
    };
    const decision = director.update(0.5, { focus: FOCUS, live: [far, stale] });
    expect([...decision.retire].sort()).toEqual(['far', 'stale']);
  });

  it('never retires a monster that is currently chasing someone', () => {
    const director = new SpawnDirector({ seed: 'cull-engaged' });
    const chasing: ILiveMonsterRef = {
      id: 'chasing',
      tier: 'demon',
      position: { x: 900, y: 0, z: 0 },
      age: 9999,
      engaged: true,
      scripted: false,
    };
    const decision = director.update(0.5, { focus: FOCUS, live: [chasing] });
    expect(decision.retire).toHaveLength(0);
  });

  it('retires a monster that wandered a full ring past where it could spawn', () => {
    const director = new SpawnDirector({ seed: 'cull-ring' });
    const drifted: ILiveMonsterRef = {
      id: 'drifted',
      tier: 'wolf',
      // Ring 3, inside the recycle distance, young. Only the ring rule catches it.
      position: { x: 9 * MONSTER_CHUNK_SIZE_METRES, y: 0, z: 0 },
      age: 1,
      engaged: false,
      scripted: false,
    };
    expect(ringBetween(drifted.position, FOCUS)).toBe(3);
    const decision = director.update(0.5, {
      focus: FOCUS,
      live: [{ ...drifted, position: { x: 600, y: 0, z: 0 } }],
    });
    // 600 m is ring 2 and inside the 620 m recycle distance: still allowed.
    expect(decision.retire).toHaveLength(0);
    const next = director.update(0.5, { focus: FOCUS, live: [drifted] });
    expect(next.retire).toEqual(['drifted']);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('produces identical orders from an identical seed', () => {
    const replay = (): string =>
      JSON.stringify(drive(new SpawnDirector({ seed: 'replay-me' }), 1200, { dt: 0.25 }).orders);
    expect(replay()).toBe(replay());
  });

  it('produces different orders from a different seed', () => {
    const a = JSON.stringify(drive(new SpawnDirector({ seed: 'seed-a' }), 600).orders);
    const b = JSON.stringify(drive(new SpawnDirector({ seed: 'seed-b' }), 600).orders);
    expect(a).not.toBe(b);
  });

  it('resets to the same stream it started with', () => {
    const director = new SpawnDirector({ seed: 'resettable' });
    const first = JSON.stringify(drive(director, 600).orders);
    director.reset();
    const second = JSON.stringify(drive(director, 600).orders);
    expect(second).toBe(first);
  });
});
