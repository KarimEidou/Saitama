/**
 * WHAT A MONSTER IS ALLOWED TO SEE
 *
 * `perceivableTargets` is the function the game's premise runs through. Its own
 * header calls `harmable: false` on the player "the load-bearing entry",
 * because a monster that fixates on Saitama "walks the fight away from
 * everybody who can actually lose" — and the allies' priority of 6 is what puts
 * Mumen Rider in front of the Deep Sea King with no line of script. Both are
 * single numbers in a literal, and neither has a shape a type can defend.
 *
 * Underneath, `writeNearestCivilians` is a hand-rolled fixed-window insertion
 * sort: a full-window shift, a `found === CAP` early-out, and a
 * `Math.min(found, CAP - 1)` slot clamp. An off-by-one in any of the three
 * silently changes who every monster in the game can see, and the symptom is a
 * monster that ignores the person standing next to it — which looks exactly
 * like a brain bug, three units away from the cause.
 *
 * `CIVILIAN_VECTORS` is MODULE-LEVEL pooled state: sixteen owned vectors shared
 * by every caller and every test in this file, on the promise that slot `n`
 * always uses vector `n` and is rewritten before it is read. Break that and one
 * civilian reports another's position — invisible in a screenshot, and the last
 * case exists for it.
 *
 * `CrowdAgents` is a plain SoA with a deterministic `spawn`, so the crowd here
 * is built directly: no `CrowdSystem`, no scene, no update loop, no GL.
 */

import { describe, expect, it } from 'vitest';
import { CrowdAgents, TIER_MID, type CrowdSystem } from '@/entities/npc';
import type { IMonsterTarget } from '@/entities/monster';
import { perceivableTargets } from '../bridges';

const ORIGIN = { x: 0, y: 0, z: 0 };

/** A crowd that is nothing but its agent arrays and its allies. */
function stubCrowd(agents: CrowdAgents, allies: unknown[] = []): CrowdSystem {
  return { agents, allies } as unknown as CrowdSystem;
}

/** Spawn one civilian on the +x axis and hand back its slot. */
function spawnAt(agents: CrowdAgents, x: number): number {
  const index = agents.spawn(0x51a1 + Math.round(x * 7), x, 0, 0, TIER_MID);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function civilians(targets: readonly IMonsterTarget[]): readonly IMonsterTarget[] {
  return targets.filter((target) => target.faction === 'civilian');
}

describe('perceivableTargets', () => {
  it('puts the player first, and makes him unharmable', () => {
    const out: IMonsterTarget[] = [];
    const targets = perceivableTargets('player', ORIGIN, stubCrowd(new CrowdAgents()), out);

    expect(targets).toHaveLength(1);
    const player = targets[0]!;
    expect(player.id).toBe('player');
    // `Faction` has no 'player' member and should not: to a monster Saitama is
    // one more hero in the street. `harmable` is the whole difference.
    expect(player.faction).toBe('hero');
    expect(player.harmable).toBe(false);
    expect(player.priority).toBe(1);
    expect(player.alive).toBe(true);
    expect(player.position).toBe(ORIGIN);
  });

  it('ranks allies far above civilians and keeps them listed once downed', () => {
    const agents = new CrowdAgents();
    spawnAt(agents, 2);
    const genos = { id: 'genos', transform: { position: { x: 1, y: 0, z: 1 } }, isDead: true };
    const out: IMonsterTarget[] = [];

    const targets = perceivableTargets('player', ORIGIN, stubCrowd(agents, [genos]), out);

    const ally = targets.find((target) => target.id === 'genos');
    expect(ally).toBeDefined();
    // Six, not 1.6: priority is a ratio against distance, and in a street of
    // 250 people there is always a civilian 1.6x closer.
    expect(ally!.priority).toBe(6);
    expect(ally!.harmable).toBe(true);
    // A downed ally stays in the list — `alive: false` is how a brain learns to
    // stop chasing a body, and dropping the entry leaves the target dangling.
    expect(ally!.alive).toBe(false);
    // Aliased on purpose: the brain reads it every frame and a copy is stale.
    expect(ally!.position).toBe(genos.transform.position);
    expect(civilians(targets)).toHaveLength(1);
  });

  it('publishes only the sixteen nearest living civilians inside 90 m', () => {
    const agents = new CrowdAgents();
    const slots = new Map<number, number>();
    for (let x = 1; x <= 20; x++) slots.set(x, spawnAt(agents, x));
    // A body is not a target: the brain falls into "remembered, not seen" and
    // prowls the spot instead, which is the behaviour we want.
    agents.health[slots.get(3)!] = 0;
    spawnAt(agents, 200);

    const out: IMonsterTarget[] = [];
    const seen = civilians(perceivableTargets('player', ORIGIN, stubCrowd(agents), out));

    expect(seen).toHaveLength(16);
    // 1, 2, then 4..17: the dead one at 3 m is skipped and the one at 200 m is
    // outside the radius entirely, cap or no cap.
    expect(seen.map((target) => target.position.x)).toEqual([
      1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    for (const target of seen) {
      expect(target.faction).toBe('civilian');
      expect(target.priority).toBe(1);
      expect(target.harmable).toBe(true);
      expect(target.alive).toBe(true);
    }
  });

  it('keeps the nearest, not the first seen', () => {
    const agents = new CrowdAgents();
    // Far ones take the low slots, so a window that simply filled up in
    // iteration order would publish 20 m away and drop the man at 1 m.
    for (let x = 20; x >= 1; x--) spawnAt(agents, x);

    const out: IMonsterTarget[] = [];
    const seen = civilians(perceivableTargets('player', ORIGIN, stubCrowd(agents), out));

    expect(seen.map((target) => target.position.x)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });

  it('reuses the output array without a shrinking crowd aliasing the last one', () => {
    const agents = new CrowdAgents();
    const slots = [1, 2, 3, 4, 5].map((x) => spawnAt(agents, x));
    const out: IMonsterTarget[] = [];

    const first = perceivableTargets('player', ORIGIN, stubCrowd(agents), out);
    expect(first).toHaveLength(6);
    expect(out.length).toBe(6);

    agents.despawn(slots[4]!);
    agents.despawn(slots[3]!);

    const second = perceivableTargets('player', ORIGIN, stubCrowd(agents), out);
    // `out.length = count` is the only thing that stops the two civilians who
    // walked away from being republished forever out of the pooled slots.
    expect(second).toHaveLength(4);
    expect(out.length).toBe(4);
    expect(second).toBe(out);

    const seen = civilians(second);
    expect(seen).toHaveLength(3);
    seen.forEach((target, n) => {
      // Slot n uses vector n, rewritten before it is read: every entry reports
      // its OWN agent, not the one that held the slot last call.
      expect(target.id).toBe(agents.idOf(slots[n]!));
      expect(target.position.x).toBe(agents.posX[slots[n]!]);
      expect(target.position.z).toBe(agents.posZ[slots[n]!]);
    });
  });
});
