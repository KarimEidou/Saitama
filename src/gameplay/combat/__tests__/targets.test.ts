/**
 * THE REGISTRY AND THE REFERENCE BROAD PHASE, DIRECTLY
 *
 * `TargetRegistry` is the single source of truth for everything a punch can
 * hit, and `LinearScan` is the brute-force reference the shipped grid adapter
 * is supposed to be checkable against. Both were previously exercised only
 * incidentally, through `populateStreet` and the resolver — which never calls
 * `setPosition`, `remove`, `has`, `clear`, `all` or `aliveByFaction`, and never
 * omits a flag to look at a default.
 *
 * Three of the behaviours below are load-bearing and silent when broken:
 *
 *   • `add()` COPIES the caller's vector. The bridge hands in a live entity
 *     vector; if the copy were dropped, every mirrored monster would follow
 *     its own transform for free and `setPosition` would become a no-op.
 *   • `phaseResolved` DEFAULTS to `isBoss !== true`. Inverting that default
 *     makes every scripted boss killable on the first tap, and no existing
 *     test would notice because they all pass the flag explicitly.
 *   • `aliveByFaction` must agree with `isTargetAlive`. Two liveness rules is
 *     how the narrow phase and the scorecard start disagreeing about who died.
 */

import { describe, expect, it } from 'vitest';
import type { EntityId } from '@/types';
import { createRng } from '@/util';
import { LinearScan, TargetRegistry, type ICombatTargetSpec } from '../targets';
import { isTargetAlive } from '../types';

/** The smallest legal registration; individual cases override what they test. */
function spec(overrides: Partial<ICombatTargetSpec> = {}): ICombatTargetSpec {
  return {
    id: 'target',
    type: 'npc',
    faction: 'civilian',
    position: { x: 0, y: 1, z: 0 },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

describe('TargetRegistry.add', () => {
  it('COPIES the caller position instead of aliasing it', () => {
    // `CombatTargetBridge` passes `descriptor.position` straight through, and
    // that is a live entity vector. Aliasing it would make every mirrored
    // monster follow its own transform without the registry being told.
    const registry = new TargetRegistry();
    const p = { x: 1, y: 2, z: 3 };
    registry.add(spec({ id: 'copied', position: p }));
    p.x = 999;

    const stored = registry.get('copied')!;
    expect(stored.position.x).toBe(1);
    expect(stored.position.y).toBe(2);
    expect(stored.position.z).toBe(3);
    expect(stored.position).not.toBe(p);
  });

  it('fills in every default a caller can omit', () => {
    const registry = new TargetRegistry();
    const target = registry.add(spec({ id: 'bare' }));

    expect(target.radius).toBe(0.45);
    expect(target.massKg).toBe(70);
    expect(target.maxHealth).toBe(100);
    expect(target.health).toBe(target.maxHealth);
    expect(target.displayName).toBe('bare');
    expect(target.isBoss).toBe(false);
    expect(target.rewardPoints).toBe(0);
    expect(target.dead).toBe(false);
  });

  it('defaults phaseResolved to CLOSED for a boss and OPEN for everything else', () => {
    const registry = new TargetRegistry();
    expect(registry.add(spec({ id: 'boss', isBoss: true })).phaseResolved).toBe(false);
    expect(registry.add(spec({ id: 'mook', isBoss: false })).phaseResolved).toBe(true);
    expect(registry.add(spec({ id: 'unsaid' })).phaseResolved).toBe(true);
    // An explicit flag still wins over the default.
    expect(
      registry.add(spec({ id: 'scripted', isBoss: true, phaseResolved: true })).phaseResolved
    ).toBe(true);

    expect(registry.get('boss')!.phaseResolved, 'a boss registers with its gate CLOSED').toBe(
      false
    );
  });

  it('keeps an explicit health below maxHealth', () => {
    const registry = new TargetRegistry();
    const target = registry.add(spec({ id: 'hurt', maxHealth: 90, health: 12 }));
    expect(target.maxHealth).toBe(90);
    expect(target.health).toBe(12);
  });
});

/* -------------------------------------------------------------------------- */
/* Movement                                                                   */
/* -------------------------------------------------------------------------- */

describe('TargetRegistry.setPosition', () => {
  it('moves a target where the broad phase can see it', () => {
    const registry = new TargetRegistry();
    registry.add(spec({ id: 'walker', position: { x: 0, y: 1, z: -50 } }));
    const scan = new LinearScan(registry);
    const out: EntityId[] = [];

    expect(scan.queryCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 10, 0.4, out)).toBe(0);

    registry.setPosition('walker', 0, 1, -3);
    expect(scan.queryCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 10, 0.4, out)).toBe(1);
    expect(out[0]).toBe('walker');
  });

  it('MUTATES the stored vector rather than replacing it', () => {
    // The bridge calls this once per already-registered target per frame. A
    // replacement allocates one three-field object per mirrored actor per
    // frame — 12 000 a second at 200 actors — for no behavioural gain.
    const registry = new TargetRegistry();
    registry.add(spec({ id: 'walker' }));
    const v = registry.get('walker')!.position;

    registry.setPosition('walker', 7, 8, 9);
    expect(v.x).toBe(7);
    expect(v.y).toBe(8);
    expect(v.z).toBe(9);
    expect(registry.get('walker')!.position).toBe(v);
  });

  it('is a no-op for an id nobody registered', () => {
    const registry = new TargetRegistry();
    expect(() => registry.setPosition('ghost', 1, 2, 3)).not.toThrow();
    expect(registry.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Membership                                                                 */
/* -------------------------------------------------------------------------- */

describe('TargetRegistry membership', () => {
  it('tracks has / size / remove / clear', () => {
    const registry = new TargetRegistry();
    registry.add(spec({ id: 'a' }));
    registry.add(spec({ id: 'b' }));

    expect(registry.has('a')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(registry.size).toBe(2);

    expect(registry.remove('a')).toBe(true);
    expect(registry.remove('a')).toBe(false);
    expect(registry.has('a')).toBe(false);
    expect(registry.size).toBe(1);

    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.get('b')).toBeUndefined();
  });

  it('all() hands out a SNAPSHOT, not the live collection', () => {
    const registry = new TargetRegistry();
    registry.add(spec({ id: 'a' }));
    registry.add(spec({ id: 'b' }));

    const snap = registry.all();
    expect(snap).toHaveLength(2);
    snap.length = 0;
    expect(registry.size).toBe(2);
  });

  it('aliveByFaction uses exactly the same liveness rule as isTargetAlive', () => {
    const registry = new TargetRegistry();
    const live = registry.add(spec({ id: 'civ-live' }));
    const flagged = registry.add(spec({ id: 'civ-dead' }));
    flagged.dead = true;
    const drained = registry.add(spec({ id: 'civ-zero', health: 0 }));
    const monster = registry.add(spec({ id: 'mon', type: 'monster', faction: 'monster' }));

    expect(registry.aliveByFaction('civilian')).toEqual([live]);
    for (const target of [live, flagged, drained, monster]) {
      expect(registry.aliveByFaction('civilian').includes(target)).toBe(
        target.faction === 'civilian' && isTargetAlive(target)
      );
    }
    expect(registry.aliveByFaction('monster')).toEqual([monster]);
    expect(registry.aliveByFaction('hero')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The reference broad phase                                                  */
/* -------------------------------------------------------------------------- */

describe('LinearScan', () => {
  it('TRUNCATES the out-parameter rather than appending to it', () => {
    // The interface documents fill-in-place with a returned count. A caller
    // reusing a buffer must never see a previous punch's candidates.
    const registry = new TargetRegistry();
    registry.add(spec({ id: 'near', position: { x: 0, y: 1, z: -2 } }));
    const scan = new LinearScan(registry);

    const radial: EntityId[] = ['junk-a', 'junk-b', 'junk-c'];
    expect(scan.queryRadius({ x: 0, y: 1, z: 0 }, 10, radial)).toBe(radial.length);
    expect(radial).toEqual(['near']);

    const cone: EntityId[] = ['junk-a', 'junk-b', 'junk-c'];
    expect(scan.queryCone({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 10, 0.4, cone)).toBe(
      cone.length
    );
    expect(cone).toEqual(['near']);
  });

  it('a fully radial cone query and a radius query agree exactly', () => {
    // The resolver switches to `queryRadius` for a ground slam, so the two
    // paths have to select the same set or a slam and a PI-cone punch would
    // delete different crowds.
    const rng = createRng('linear-scan');
    const registry = new TargetRegistry();
    for (let i = 0; i < 200; i++) {
      registry.add(
        spec({
          id: `t-${i}`,
          position: { x: rng.range(-30, 30), y: rng.range(0, 12), z: rng.range(-30, 30) },
          radius: rng.range(0.2, 3),
        })
      );
    }

    const scan = new LinearScan(registry);
    const origin = { x: 1, y: 1.4, z: -2 };
    const a: EntityId[] = [];
    const b: EntityId[] = [];
    for (const range of [1.2, 8, 25, 60]) {
      scan.queryCone(origin, { x: 0, y: 0, z: -1 }, range, Math.PI, a);
      scan.queryRadius(origin, range, b);
      expect([...a].sort()).toEqual([...b].sort());
    }
    // Proof the parity is not the trivial empty-vs-empty one.
    scan.queryRadius(origin, 60, b);
    expect(b.length).toBeGreaterThan(20);
  });

  it('reports dead and invulnerable targets too — liveness is the resolver filter', () => {
    const registry = new TargetRegistry();
    const corpse = registry.add(spec({ id: 'corpse', position: { x: 0, y: 1, z: -2 } }));
    corpse.dead = true;
    registry.add(spec({ id: 'statue', position: { x: 0, y: 1, z: -3 }, invulnerable: true }));

    const scan = new LinearScan(registry);
    const out: EntityId[] = [];
    scan.queryRadius({ x: 0, y: 1, z: 0 }, 10, out);
    expect([...out].sort()).toEqual(['corpse', 'statue']);
  });
});
