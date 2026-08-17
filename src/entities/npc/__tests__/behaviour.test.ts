/**
 * BEHAVIOUR TREES AND THE ALLIES
 *
 * The tree library gets tested for the two bugs that actually happen in
 * practice — a sequence that restarts instead of resuming, and a selector that
 * refuses to be pre-empted — and then the allies get tested for the things
 * that are characterisation rather than mechanics.
 *
 * Mumen Rider's assertion is the load-bearing one. "He always gets back up" is
 * the game's thesis; if it is only true because nobody has knocked him down
 * eleven times in a row, it is not a thesis, it is a coincidence.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '@/util';
import {
  BehaviourTree,
  action,
  always,
  condition,
  cooldown,
  effect,
  guard,
  invert,
  selector,
  sequence,
} from '../behaviour-tree';
import { HeroNpc, HERO_SPECS, type IHeroWorld } from '../hero-npc';
import { MUMEN_HEALTH, MUMEN_DOWN_SECONDS } from '../constants';
import type { IHeroCallout, IThreatSource } from '../types';

// These simulate hundreds of frames of a 250-agent crowd. Vitest's default
// five-second budget is comfortable on an idle machine and not comfortable at
// all when a dozen other workstreams are compiling on the same box, and a test
// that fails on CPU contention is worse than no test.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Ctx {
  count: number;
  flag: boolean;
}

describe('behaviour tree', () => {
  it('runs a sequence to completion', () => {
    const ctx: Ctx = { count: 0, flag: false };
    const tree = new BehaviourTree(
      sequence<Ctx>('all', [
        effect<Ctx>('a', (c) => {
          c.count++;
        }),
        effect<Ctx>('b', (c) => {
          c.count++;
        }),
      ])
    );
    expect(tree.tick(ctx, 0.1)).toBe('success');
    expect(ctx.count).toBe(2);
  });

  it('resumes a running sequence instead of restarting it', () => {
    const ctx: Ctx = { count: 0, flag: false };
    let releases = 0;
    const tree = new BehaviourTree(
      sequence<Ctx>('draw-then-swing', [
        effect<Ctx>('draw', (c) => {
          c.count++;
        }),
        action<Ctx>('swing', () => (releases++ < 2 ? 'running' : 'success')),
      ])
    );
    tree.tick(ctx, 0.1);
    tree.tick(ctx, 0.1);
    tree.tick(ctx, 0.1);
    // The side effect must have fired ONCE, not once per tick. A sequence that
    // restarts is how an NPC re-draws its weapon sixty times a second.
    expect(ctx.count).toBe(1);
  });

  it('lets a selector pre-empt a running lower-priority branch', () => {
    const ctx: Ctx = { count: 0, flag: false };
    const reset = vi.fn();
    const low = {
      name: 'low',
      tick: (): 'running' => 'running',
      reset,
    };
    const tree = new BehaviourTree(
      selector<Ctx>('priority', [
        guard<Ctx>('emergency', (c) => c.flag, effect<Ctx>('handle', () => {})),
        low,
      ])
    );
    expect(tree.tick(ctx, 0.1)).toBe('running');
    ctx.flag = true;
    expect(tree.tick(ctx, 0.1)).toBe('success');
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('gates a child behind a cooldown', () => {
    const ctx: Ctx = { count: 0, flag: false };
    const tree = new BehaviourTree(
      cooldown<Ctx>('fire', 1, effect<Ctx>('shot', (c) => {
        c.count++;
      }))
    );
    tree.tick(ctx, 0.1);
    tree.tick(ctx, 0.1);
    tree.tick(ctx, 0.1);
    expect(ctx.count).toBe(1);
    tree.tick(ctx, 1.2);
    expect(ctx.count).toBe(2);
  });

  it('inverts, guards and swallows failure as documented', () => {
    const ctx: Ctx = { count: 0, flag: false };
    expect(invert(condition<Ctx>('t', () => true)).tick(ctx, 0)).toBe('failure');
    expect(invert(condition<Ctx>('f', () => false)).tick(ctx, 0)).toBe('success');
    expect(guard<Ctx>('closed', () => false, effect<Ctx>('x', () => {})).tick(ctx, 0)).toBe(
      'failure'
    );
    expect(always(action<Ctx>('fails', () => 'failure')).tick(ctx, 0)).toBe('success');
  });
});

/* -------------------------------------------------------------------------- */
/* Allies                                                                     */
/* -------------------------------------------------------------------------- */

function heroWorld(
  bus: EventBus | undefined,
  threats: IThreatSource[],
  callouts: IHeroCallout[]
): IHeroWorld {
  return {
    bus,
    now: () => 0,
    threats,
    playerPosition: () => ({ x: 0, z: 0 }),
    debris: [{ x: 4, y: 0, z: 4, mass: 9000 }],
    hasLineOfSight: () => true,
    seedAlarm: () => {},
    say: (callout) => callouts.push(callout),
  };
}

describe('HeroNpc', () => {
  it('Mumen Rider gets back up, every single time', () => {
    const bus = new EventBus();
    const threats: IThreatSource[] = [
      { id: 'm', position: new THREE.Vector3(30, 0, 0), intensity: 1 },
    ];
    const callouts: IHeroCallout[] = [];
    const mumen = new HeroNpc('mumen', 'mumenRider', heroWorld(bus, threats, callouts));

    const KNOCKDOWNS = 11;
    for (let round = 0; round < KNOCKDOWNS; round++) {
      mumen.knockdown();
      expect(mumen.isDown).toBe(true);
      // Wait out the count.
      for (let f = 0; f < Math.ceil((MUMEN_DOWN_SECONDS + 0.2) * 60); f++) mumen.update(1 / 60);
      expect(mumen.isDown).toBe(false);
      expect(mumen.isDead).toBe(false);
      expect(mumen.reEngagements).toBe(round + 1);
    }
    // And he is moving at the thing again, not standing there.
    for (let f = 0; f < 30; f++) mumen.update(1 / 60);
    expect(mumen.transform.position.x).toBeGreaterThan(0.5);
    expect(callouts.filter((c) => c.key === 'mumen.rise').length).toBe(KNOCKDOWNS);
  });

  it('Mumen Rider has no retreat branch: he closes even at one hit point', () => {
    const threats: IThreatSource[] = [
      { id: 'm', position: new THREE.Vector3(40, 0, 0), intensity: 1 },
    ];
    const mumen = new HeroNpc('mumen', 'mumenRider', heroWorld(undefined, threats, []));
    mumen.takeDamage(MUMEN_HEALTH - 1);
    expect(mumen.health).toBe(1);
    // Damage that big knocks him down first; ride it out.
    for (let f = 0; f < 200; f++) mumen.update(1 / 60);
    expect(mumen.isDead).toBe(false);
    // Distance to the monster must have SHRUNK.
    const distance = 40 - mumen.transform.position.x;
    expect(distance).toBeLessThan(38);
  });

  it('Genos fires at range and emits a shockwave the bus can see', () => {
    const bus = new EventBus();
    const fired: number[] = [];
    bus.on('ShockwaveFired', (e) => fired.push(e.power));
    const threats: IThreatSource[] = [
      { id: 'm', position: new THREE.Vector3(18, 0, 0), intensity: 1 },
    ];
    const genos = new HeroNpc('genos', 'genos', heroWorld(bus, threats, []));
    for (let f = 0; f < 60; f++) genos.update(1 / 60);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0]).toBe(HERO_SPECS.genos.attackPower);
  });

  it('Genos calls for Saitama when he is losing, and emits AllyDowned when he falls', () => {
    const bus = new EventBus();
    const downed: string[] = [];
    bus.on('AllyDowned', (e) => downed.push(e.displayName));
    const callouts: IHeroCallout[] = [];
    const threats: IThreatSource[] = [
      { id: 'm', position: new THREE.Vector3(18, 0, 0), intensity: 1 },
    ];
    const genos = new HeroNpc('genos', 'genos', heroWorld(bus, threats, callouts));

    genos.takeDamage(genos.maxHealth * 0.7);
    for (let f = 0; f < 120; f++) genos.update(1 / 60);
    expect(callouts.some((c) => c.key === 'genos.callout')).toBe(true);

    genos.takeDamage(genos.maxHealth);
    expect(genos.isDead).toBe(true);
    expect(downed).toEqual(['Genos']);
    expect(callouts.some((c) => c.key === 'genos.down')).toBe(true);

    // Fires AllyDowned exactly once, however many times he is hit afterwards.
    genos.takeDamage(100);
    genos.kill();
    expect(downed.length).toBe(1);
  });

  it('Tatsumaki keeps her distance and is rude about it', () => {
    const callouts: IHeroCallout[] = [];
    const threats: IThreatSource[] = [
      { id: 'm', position: new THREE.Vector3(6, 0, 0), intensity: 1 },
    ];
    const tatsumaki = new HeroNpc('tatsumaki', 'tatsumaki', heroWorld(undefined, threats, callouts));
    tatsumaki.transform.set(2, 0, 0, 0);
    for (let f = 0; f < 180; f++) tatsumaki.update(1 / 60);
    // Backed off towards her preferred range.
    const distance = Math.abs(6 - tatsumaki.transform.position.x);
    expect(distance).toBeGreaterThan(12);
    expect(callouts.some((c) => c.key === 'tatsumaki.contempt')).toBe(true);
  });

  it('reports a status the HUD can render', () => {
    const hero = new HeroNpc('genos', 'genos', heroWorld(undefined, [], []));
    const status = hero.status();
    expect(status.displayName).toBe('Genos');
    expect(status.maxHealth).toBe(HERO_SPECS.genos.maxHealth);
    expect(status.isDead).toBe(false);
    expect(status.faction).toBe('hero');
  });
});
