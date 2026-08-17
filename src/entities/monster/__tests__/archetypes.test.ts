/**
 * THE TABLE, CHECKED AGAINST ITSELF
 *
 * A data-driven system is only as good as the data, and a bad row here does
 * not throw — it produces a monster that never attacks, never spawns, or
 * spawns everywhere. Each test below is a row-level mistake that has no other
 * way of announcing itself.
 */

import { describe, expect, it } from 'vitest';
import {
  MONSTER_ARCHETYPES,
  archetypesForDistrict,
  archetypesForTier,
  bossArchetypes,
  findMonsterArchetype,
  monsterArchetype,
  spawnableArchetypes,
} from '../archetypes';
import { BOSS_SCRIPTS } from '../boss-scripts';
import { MONSTER_STATE_TIMEOUT_SECONDS } from '../fsm';
import type { DistrictType, ThreatTier } from '../types';

const TIERS: readonly ThreatTier[] = ['wolf', 'tiger', 'demon', 'dragon', 'god'];
const DISTRICTS: readonly DistrictType[] = [
  'downtown',
  'residential',
  'industrial',
  'park',
  'waterfront',
  'wasteland',
  'heroAssociation',
];

describe('archetype table', () => {
  it('has unique ids and resolves each of them', () => {
    const ids = MONSTER_ARCHETYPES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(monsterArchetype(id).id).toBe(id);
    expect(findMonsterArchetype('nope')).toBeUndefined();
    expect(() => monsterArchetype('nope')).toThrow(/unknown archetype/);
  });

  it('covers every threat tier with at least one spawnable mook', () => {
    for (const tier of TIERS) {
      expect(archetypesForTier(tier).length).toBeGreaterThan(0);
    }
  });

  it('gives every archetype a usable attack set', () => {
    for (const archetype of MONSTER_ARCHETYPES) {
      expect(archetype.attacks.length).toBeGreaterThan(0);
      for (const attack of archetype.attacks) {
        expect(attack.rangeMetres).toBeGreaterThan(attack.minRangeMetres);
        // Every attack telegraphs. The player cannot be hurt, so a monster
        // attack's only job is to be readable, and an instantaneous one is not.
        expect(attack.windupSeconds).toBeGreaterThan(0);
        expect(attack.cooldownSeconds).toBeGreaterThan(0);
        expect(attack.weight).toBeGreaterThan(0);
        expect(attack.waveRangeMetres).toBeGreaterThan(0);
        expect(attack.halfAngleRad).toBeGreaterThan(0);
        expect(attack.halfAngleRad).toBeLessThanOrEqual(Math.PI);
        expect(attack.waveHalfAngleRad).toBeLessThanOrEqual(Math.PI);
      }
      // Attack ids are unique within a set, or the cooldown map collides and
      // two attacks share one timer.
      const ids = archetype.attacks.map((a) => a.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('summarises the attack set into the shared IMonsterSpec fields', () => {
    for (const archetype of MONSTER_ARCHETYPES) {
      const widest = Math.max(...archetype.attacks.map((a) => a.rangeMetres));
      const shortest = Math.min(...archetype.attacks.map((a) => a.cooldownSeconds));
      expect(archetype.attackRange).toBe(widest);
      expect(archetype.attackCooldown).toBe(shortest);
      expect(archetype.moveSpeed).toBe(archetype.movement.runSpeed);
    }
  });

  it('gives every archetype a coherent body', () => {
    for (const archetype of MONSTER_ARCHETYPES) {
      expect(archetype.bodyHeightMetres).toBeGreaterThan(0.2);
      expect(archetype.bodyHeightMetres).toBeLessThan(6);
      expect(archetype.massKg).toBeGreaterThan(0);
      expect(archetype.radiusMetres).toBeGreaterThan(0);
      expect(archetype.maxHealth).toBeGreaterThan(0);
      expect(archetype.loseAggroMetres).toBeGreaterThanOrEqual(archetype.aggroRadius);
      expect(archetype.visionHalfAngleRad).toBeGreaterThan(0);
      expect(archetype.visionHalfAngleRad).toBeLessThanOrEqual(Math.PI);
      expect(archetype.animations.idle).toBeTruthy();
      expect(archetype.animations.attack).toBeTruthy();
      expect(archetype.animations.death).toBeTruthy();
    }
  });

  it('scales body and mass monotonically with threat tier across the mooks', () => {
    // A dragon-level threat has to be visibly a different order of thing from
    // a wolf-level one before a single number is shown to the player.
    const byTier = new Map<ThreatTier, number[]>();
    for (const archetype of spawnableArchetypes()) {
      const list = byTier.get(archetype.threatTier) ?? [];
      list.push(archetype.bodyHeightMetres);
      byTier.set(archetype.threatTier, list);
    }
    let previous = 0;
    for (const tier of TIERS) {
      const heights = byTier.get(tier) ?? [];
      const mean = heights.reduce((s, h) => s + h, 0) / Math.max(1, heights.length);
      expect(mean).toBeGreaterThan(previous);
      previous = mean;
    }
  });

  it('keeps summon-only archetypes out of the director', () => {
    const swarm = monsterArchetype('mob.swarm.mosquito');
    expect(swarm.summonOnly).toBe(true);
    expect(spawnableArchetypes()).not.toContain(swarm);
    for (const district of DISTRICTS) {
      expect(archetypesForDistrict(district)).not.toContain(swarm);
    }
  });

  it('keeps bosses out of the director', () => {
    for (const boss of bossArchetypes()) {
      expect(spawnableArchetypes()).not.toContain(boss);
    }
    expect(bossArchetypes()).toHaveLength(4);
  });

  it('confines god-tier to the wasteland — nothing that size near people', () => {
    const harbinger = monsterArchetype('mob.god.harbinger');
    expect(harbinger.spawnDistricts).toEqual(['wasteland']);
    expect(archetypesForDistrict('downtown', 'god')).toHaveLength(0);
    expect(archetypesForDistrict('wasteland', 'god')).toContain(harbinger);
  });

  it('leaves every district with something to spawn', () => {
    for (const district of DISTRICTS) {
      expect(archetypesForDistrict(district).length).toBeGreaterThan(0);
    }
  });

  it('lists only real districts in every whitelist', () => {
    for (const archetype of MONSTER_ARCHETYPES) {
      for (const district of archetype.spawnDistricts ?? []) {
        expect(DISTRICTS).toContain(district);
      }
    }
  });

  it('points every boss script at a boss archetype that exists', () => {
    for (const script of BOSS_SCRIPTS) {
      const archetype = monsterArchetype(script.archetypeId);
      expect(archetype.isBoss).toBe(true);
      expect(script.arenaRadiusMetres).toBeGreaterThan(0);
      expect(script.tests.length).toBeGreaterThan(10);
    }
  });

  it('names the roster asset for each boss, which is the only link to geometry', () => {
    // If the roster renames an entry this test is the thing that notices,
    // rather than a boss silently spawning with no body at runtime.
    expect(monsterArchetype('boss.mosquitoGirl').assetKey).toBe('chr.mosquitoGirl');
    expect(monsterArchetype('boss.vaccineMan').assetKey).toBe('chr.vaccineMan');
    expect(monsterArchetype('boss.deepSeaKing').assetKey).toBe('chr.deepSeaKing');
    expect(monsterArchetype('boss.boros').assetKey).toBe('chr.boros');
    for (const tier of TIERS) {
      const mooks = archetypesForTier(tier);
      for (const mook of mooks) expect(mook.assetKey).toBe(`chr.mook.${tier}`);
    }
  });

  it('matches the roster threat tiers for the named bosses', () => {
    expect(monsterArchetype('boss.mosquitoGirl').threatTier).toBe('demon');
    expect(monsterArchetype('boss.vaccineMan').threatTier).toBe('demon');
    expect(monsterArchetype('boss.deepSeaKing').threatTier).toBe('dragon');
    expect(monsterArchetype('boss.boros').threatTier).toBe('dragon');
  });

  it('keeps every archetype inside the state machine watchdogs', () => {
    // The table and the machine are written independently, so this is the only
    // place the two can be checked against each other. A monster whose attack
    // timeline outran the `attack` watchdog would be rescued mid-swing, every
    // swing, forever — and the symptom would be a monster that never connects.
    const longestMemory = Math.max(...MONSTER_ARCHETYPES.map((a) => a.memorySeconds));
    expect(MONSTER_STATE_TIMEOUT_SECONDS.pursue).toBeGreaterThan(longestMemory);

    const longestStagger = Math.max(...MONSTER_ARCHETYPES.map((a) => a.staggerSeconds));
    expect(MONSTER_STATE_TIMEOUT_SECONDS.stagger).toBeGreaterThan(longestStagger);

    for (const archetype of MONSTER_ARCHETYPES) {
      for (const attack of archetype.attacks) {
        const timeline = attack.windupSeconds + attack.activeSeconds + attack.recoverySeconds;
        expect(timeline, `${archetype.id}/${attack.id}`).toBeLessThan(
          MONSTER_STATE_TIMEOUT_SECONDS.attack
        );
      }
    }
  });

  it('rewards higher tiers more, so the tier means something to progression', () => {
    let previous = 0;
    for (const tier of TIERS) {
      const best = Math.max(...archetypesForTier(tier).map((a) => a.rewardPoints));
      expect(best).toBeGreaterThan(previous);
      previous = best;
    }
  });
});
