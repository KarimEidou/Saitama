/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE MONSTER TABLE — EVERY MONSTER IN THE GAME, AS DATA                  ║
 * ║                                                                          ║
 * ║  A new monster is a row in this file. Not a subclass, not a branch in    ║
 * ║  the FSM, not a flag read somewhere else. If a monster needs code, the   ║
 * ║  table is missing a field and the field is the fix.                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHAT THE CAST IS FOR ──────────────────────────────────────────────────
 * The player deletes anything he touches, so a monster cannot be a difficulty
 * curve. What a monster CAN be is a question about reach, position and time:
 *
 *   THE SWARM      too many to jab one at a time; a serious punch clears them
 *                  and takes the block with it.
 *   THE FLYER      out of reach of 1.2 m entirely. Jump, or spend the cone.
 *   THE GUNNER     hits from further than you can walk in the time you have.
 *   THE WALL       slow, enormous, and standing between you and a person.
 *
 * Every row below is one of those four with different numbers, and the four
 * bosses are the same four questions asked once each, hand-tuned.
 *
 * ── HOW THIS TABLE RELATES TO THE ROSTER ──────────────────────────────────
 * `assetKey` is the ONLY link to geometry, and it points at an id the roster
 * workstream owns (`chr.mosquitoGirl`, `chr.mook.demon`, …). This module never
 * imports the roster, never builds a mesh and never picks a colour; the
 * spawner resolves the key through `ICharacterFactory`. Behaviour and body are
 * two workstreams and one string.
 *
 * ── UNITS ─────────────────────────────────────────────────────────────────
 * Metres, seconds, radians, kilograms. `wavePower` is UNITLESS and UNBOUNDED,
 * matching `IPunchEvent.power` — the audio and camera systems log-scale it.
 */

import type { ClipName, DistrictType, IAnimationSet, ThreatTier } from '@/types';
import { DEG2RAD } from '@/util';
import type { IMonsterArchetype, IMonsterAttack, IMovementProfile, MonsterMotion } from './types';

/* -------------------------------------------------------------------------- */
/* Shared building blocks                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The animation set every monster shares.
 *
 * All monsters are built by the same humanoid generator on the same 27-bone
 * rig, so they all resolve the same slots. The animator's locomotion adapts to
 * an arbitrary `BodyProfile` — verified on a 2.45 m monster — which is why a
 * 3.6 m god-tier threat and a 1.5 m pest can share one row here without either
 * of them foot-sliding.
 */
const MONSTER_CLIPS: IAnimationSet = Object.freeze({
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  attack: 'attack',
  hit: 'hit',
  death: 'death',
  sprint: 'sprint',
  heavyAttack: 'heavyAttack',
  stagger: 'stagger',
  taunt: 'taunt',
  special: 'special',
  flee: 'flee',
  jump: 'jump',
  fall: 'fall',
  land: 'land',
});

/** Fields shared by every attack, so a row only states what differs. */
interface IAttackPatch {
  readonly id: string;
  readonly kind: IMonsterAttack['kind'];
  readonly rangeMetres: number;
  readonly minRangeMetres?: number;
  readonly halfAngleRad?: number;
  readonly windupSeconds: number;
  readonly activeSeconds?: number;
  readonly recoverySeconds?: number;
  readonly cooldownSeconds: number;
  readonly weight?: number;
  readonly clip?: ClipName;
  readonly waveRangeMetres: number;
  readonly waveHalfAngleRad?: number;
  readonly wavePower: number;
  readonly summonArchetypeId?: string;
  readonly summonCount?: number;
}

function attack(patch: IAttackPatch): IMonsterAttack {
  return Object.freeze({
    id: patch.id,
    kind: patch.kind,
    rangeMetres: patch.rangeMetres,
    minRangeMetres: patch.minRangeMetres ?? 0,
    halfAngleRad: patch.halfAngleRad ?? 50 * DEG2RAD,
    windupSeconds: patch.windupSeconds,
    activeSeconds: patch.activeSeconds ?? 0.12,
    recoverySeconds: patch.recoverySeconds ?? 0.35,
    cooldownSeconds: patch.cooldownSeconds,
    weight: patch.weight ?? 1,
    clip: patch.clip ?? 'attack',
    waveRangeMetres: patch.waveRangeMetres,
    waveHalfAngleRad: patch.waveHalfAngleRad ?? 60 * DEG2RAD,
    wavePower: patch.wavePower,
    summonArchetypeId: patch.summonArchetypeId,
    summonCount: patch.summonCount,
  });
}

/** Movement profile defaults, so a row states only its character. */
interface IMovementPatch {
  readonly walkSpeed: number;
  readonly runSpeed: number;
  readonly acceleration?: number;
  readonly turnRateRad?: number;
  readonly erratic?: number;
  readonly erraticPeriodSeconds?: number;
  readonly hoverHeightMetres?: number;
  readonly bobAmplitudeMetres?: number;
  readonly standoffMetres?: number;
}

function movement(patch: IMovementPatch): IMovementProfile {
  return Object.freeze({
    walkSpeed: patch.walkSpeed,
    runSpeed: patch.runSpeed,
    acceleration: patch.acceleration ?? patch.runSpeed * 2.4,
    turnRateRad: patch.turnRateRad ?? 3.2,
    erratic: patch.erratic ?? 0,
    erraticPeriodSeconds: patch.erraticPeriodSeconds ?? 1.2,
    hoverHeightMetres: patch.hoverHeightMetres ?? 0,
    bobAmplitudeMetres: patch.bobAmplitudeMetres ?? 0,
    standoffMetres: patch.standoffMetres ?? 0,
  });
}

/** Everything an archetype row may leave unstated. */
interface IArchetypePatch {
  readonly id: string;
  readonly name: string;
  readonly threatTier: ThreatTier;
  readonly assetKey: string;
  readonly motion?: MonsterMotion;
  readonly maxHealth: number;
  readonly attackDamage: number;
  readonly moveSpeed?: number;
  readonly attackRange?: number;
  readonly attackCooldown?: number;
  readonly aggroRadius: number;
  readonly loseAggroMetres?: number;
  readonly scale?: number;
  readonly bodyHeightMetres: number;
  readonly massKg: number;
  readonly radiusMetres?: number;
  readonly visionHalfAngleRad?: number;
  readonly hearingMetres?: number;
  readonly memorySeconds?: number;
  readonly staggerSeconds?: number;
  readonly staggerFraction?: number;
  readonly roarPeriodSeconds?: number;
  readonly rewardPoints: number;
  readonly isBoss?: boolean;
  readonly summonOnly?: boolean;
  readonly spawnDistricts?: readonly DistrictType[];
  readonly abilities?: readonly string[];
  readonly movement: IMovementProfile;
  readonly attacks: readonly IMonsterAttack[];
}

function archetype(patch: IArchetypePatch): IMonsterArchetype {
  const attacks = patch.attacks;
  // `IMonsterSpec.attackRange` / `attackCooldown` are the SUMMARY of the set —
  // the widest reach and the shortest cooldown — so anything reading the
  // shared contract without knowing about attack sets still gets a true
  // answer rather than an arbitrary first entry.
  const reach = attacks.reduce((max, a) => Math.max(max, a.rangeMetres), 0);
  const cooldown = attacks.reduce(
    (min, a) => Math.min(min, a.cooldownSeconds),
    Number.POSITIVE_INFINITY
  );
  return Object.freeze({
    id: patch.id,
    name: patch.name,
    threatTier: patch.threatTier,
    assetKey: patch.assetKey,
    maxHealth: patch.maxHealth,
    attackDamage: patch.attackDamage,
    moveSpeed: patch.moveSpeed ?? patch.movement.runSpeed,
    attackRange: patch.attackRange ?? reach,
    attackCooldown: patch.attackCooldown ?? (Number.isFinite(cooldown) ? cooldown : 1),
    aggroRadius: patch.aggroRadius,
    scale: patch.scale ?? 1,
    animations: MONSTER_CLIPS,
    abilities: patch.abilities,
    rewardPoints: patch.rewardPoints,
    isBoss: patch.isBoss ?? false,
    spawnDistricts: patch.spawnDistricts,
    motion: patch.motion ?? 'ground',
    movement: patch.movement,
    attacks,
    bodyHeightMetres: patch.bodyHeightMetres,
    massKg: patch.massKg,
    radiusMetres: patch.radiusMetres ?? patch.bodyHeightMetres * 0.28,
    loseAggroMetres: patch.loseAggroMetres ?? patch.aggroRadius * 1.8,
    visionHalfAngleRad: patch.visionHalfAngleRad ?? 65 * DEG2RAD,
    hearingMetres: patch.hearingMetres ?? patch.aggroRadius * 1.4,
    memorySeconds: patch.memorySeconds ?? 6,
    staggerSeconds: patch.staggerSeconds ?? 0.9,
    staggerFraction: patch.staggerFraction ?? 0.18,
    roarPeriodSeconds: patch.roarPeriodSeconds ?? 11,
    summonOnly: patch.summonOnly ?? false,
  });
}

/* -------------------------------------------------------------------------- */
/* Mooks — the open world                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Threat-tier mooks.
 *
 * Two per tier at the bottom, one each at the top, because the top of the
 * scale is supposed to be RARE: a dragon-tier threat that shows up on a
 * street corner twice an hour is a tiger-tier threat with a bigger number.
 * The tier is a promise about frequency as much as about size.
 *
 * Every mook dies to one punch of any lethal intent, at every tier, with no
 * exception and no phase gate — that is the whole joke, and `harness/monster`
 * asserts it at all five tiers rather than trusting the sentence.
 */
const MOOKS: readonly IMonsterArchetype[] = Object.freeze([
  archetype({
    id: 'mob.wolf.pest',
    name: 'Street Pest',
    threatTier: 'wolf',
    assetKey: 'chr.mook.wolf',
    maxHealth: 40,
    attackDamage: 6,
    aggroRadius: 18,
    bodyHeightMetres: 1.52,
    massKg: 78,
    rewardPoints: 4,
    roarPeriodSeconds: 14,
    movement: movement({ walkSpeed: 1.5, runSpeed: 4.4, erratic: 0.22 }),
    attacks: [
      attack({
        id: 'swipe',
        kind: 'melee',
        rangeMetres: 1.6,
        windupSeconds: 0.32,
        cooldownSeconds: 1.1,
        waveRangeMetres: 2.2,
        wavePower: 60,
      }),
    ],
  }),
  archetype({
    id: 'mob.wolf.thug',
    name: 'Mob Thug',
    threatTier: 'wolf',
    assetKey: 'chr.mook.wolf',
    maxHealth: 60,
    attackDamage: 9,
    aggroRadius: 22,
    bodyHeightMetres: 1.66,
    massKg: 96,
    rewardPoints: 5,
    spawnDistricts: ['downtown', 'residential', 'industrial', 'waterfront'],
    movement: movement({ walkSpeed: 1.4, runSpeed: 3.9 }),
    attacks: [
      attack({
        id: 'haymaker',
        kind: 'melee',
        rangeMetres: 1.9,
        windupSeconds: 0.44,
        cooldownSeconds: 1.6,
        clip: 'heavyAttack',
        waveRangeMetres: 3,
        wavePower: 110,
      }),
      attack({
        id: 'shove',
        kind: 'melee',
        rangeMetres: 1.4,
        windupSeconds: 0.2,
        cooldownSeconds: 0.9,
        weight: 0.6,
        waveRangeMetres: 2,
        wavePower: 45,
      }),
    ],
  }),

  archetype({
    id: 'mob.tiger.brute',
    name: 'Alley Brute',
    threatTier: 'tiger',
    assetKey: 'chr.mook.tiger',
    maxHealth: 220,
    attackDamage: 24,
    aggroRadius: 30,
    bodyHeightMetres: 1.95,
    massKg: 190,
    rewardPoints: 18,
    staggerFraction: 0.24,
    movement: movement({ walkSpeed: 1.6, runSpeed: 5.2, acceleration: 9 }),
    attacks: [
      attack({
        id: 'slam',
        kind: 'slam',
        rangeMetres: 3.2,
        windupSeconds: 0.62,
        activeSeconds: 0.18,
        cooldownSeconds: 3.4,
        clip: 'heavyAttack',
        waveRangeMetres: 7,
        waveHalfAngleRad: Math.PI,
        wavePower: 900,
      }),
      attack({
        id: 'claw',
        kind: 'melee',
        rangeMetres: 2.4,
        windupSeconds: 0.36,
        cooldownSeconds: 1.3,
        weight: 1.4,
        waveRangeMetres: 3.4,
        wavePower: 180,
      }),
    ],
  }),
  archetype({
    id: 'mob.tiger.stalker',
    name: 'Rooftop Stalker',
    threatTier: 'tiger',
    assetKey: 'chr.mook.tiger',
    maxHealth: 160,
    attackDamage: 20,
    aggroRadius: 38,
    bodyHeightMetres: 1.86,
    massKg: 140,
    rewardPoints: 16,
    memorySeconds: 11,
    spawnDistricts: ['downtown', 'residential', 'heroAssociation'],
    movement: movement({
      walkSpeed: 2.1,
      runSpeed: 7.4,
      turnRateRad: 4.4,
      erratic: 0.35,
      standoffMetres: 6,
    }),
    attacks: [
      attack({
        id: 'pounce',
        kind: 'charge',
        rangeMetres: 12,
        minRangeMetres: 4,
        windupSeconds: 0.5,
        activeSeconds: 0.4,
        cooldownSeconds: 4.2,
        clip: 'special',
        waveRangeMetres: 5,
        wavePower: 420,
      }),
      attack({
        id: 'slash',
        kind: 'melee',
        rangeMetres: 2.1,
        windupSeconds: 0.26,
        cooldownSeconds: 1,
        weight: 1.2,
        waveRangeMetres: 2.8,
        wavePower: 140,
      }),
    ],
  }),

  archetype({
    id: 'mob.demon.carapace',
    name: 'Carapace',
    threatTier: 'demon',
    assetKey: 'chr.mook.demon',
    maxHealth: 900,
    attackDamage: 65,
    aggroRadius: 44,
    bodyHeightMetres: 2.42,
    massKg: 520,
    rewardPoints: 90,
    staggerFraction: 0.32,
    staggerSeconds: 1.2,
    roarPeriodSeconds: 8,
    movement: movement({ walkSpeed: 1.8, runSpeed: 5.6, acceleration: 8, turnRateRad: 2.4 }),
    attacks: [
      attack({
        id: 'sweep',
        kind: 'melee',
        rangeMetres: 4.2,
        windupSeconds: 0.7,
        activeSeconds: 0.22,
        cooldownSeconds: 2.6,
        halfAngleRad: 80 * DEG2RAD,
        clip: 'heavyAttack',
        waveRangeMetres: 9,
        waveHalfAngleRad: 85 * DEG2RAD,
        wavePower: 2600,
      }),
      attack({
        id: 'quake',
        kind: 'slam',
        rangeMetres: 5,
        windupSeconds: 1.05,
        activeSeconds: 0.25,
        cooldownSeconds: 7,
        weight: 0.7,
        clip: 'special',
        waveRangeMetres: 16,
        waveHalfAngleRad: Math.PI,
        wavePower: 7400,
      }),
    ],
  }),
  archetype({
    id: 'mob.demon.howler',
    name: 'Howler',
    threatTier: 'demon',
    assetKey: 'chr.mook.demon',
    maxHealth: 640,
    attackDamage: 48,
    aggroRadius: 52,
    bodyHeightMetres: 2.28,
    massKg: 400,
    rewardPoints: 82,
    hearingMetres: 110,
    roarPeriodSeconds: 6,
    spawnDistricts: ['wasteland', 'industrial', 'waterfront'],
    movement: movement({ walkSpeed: 2.2, runSpeed: 6.4, standoffMetres: 11 }),
    attacks: [
      attack({
        id: 'shriek',
        kind: 'ranged',
        rangeMetres: 34,
        minRangeMetres: 6,
        windupSeconds: 0.85,
        activeSeconds: 0.3,
        cooldownSeconds: 5.5,
        halfAngleRad: 24 * DEG2RAD,
        clip: 'special',
        waveRangeMetres: 36,
        waveHalfAngleRad: 20 * DEG2RAD,
        wavePower: 3100,
      }),
      attack({
        id: 'rake',
        kind: 'melee',
        rangeMetres: 3.1,
        windupSeconds: 0.4,
        cooldownSeconds: 1.5,
        waveRangeMetres: 4,
        wavePower: 300,
      }),
    ],
  }),

  archetype({
    id: 'mob.dragon.leviathan',
    name: 'Leviathan Spawn',
    threatTier: 'dragon',
    assetKey: 'chr.mook.dragon',
    maxHealth: 6400,
    attackDamage: 320,
    aggroRadius: 70,
    bodyHeightMetres: 3.05,
    massKg: 1800,
    rewardPoints: 620,
    staggerFraction: 0.4,
    staggerSeconds: 1.5,
    memorySeconds: 14,
    roarPeriodSeconds: 7,
    spawnDistricts: ['waterfront', 'wasteland', 'industrial', 'downtown'],
    movement: movement({ walkSpeed: 2.4, runSpeed: 7.2, acceleration: 7, turnRateRad: 1.8 }),
    attacks: [
      attack({
        id: 'tide',
        kind: 'slam',
        rangeMetres: 8,
        windupSeconds: 1.25,
        activeSeconds: 0.35,
        cooldownSeconds: 8.5,
        clip: 'special',
        waveRangeMetres: 30,
        waveHalfAngleRad: Math.PI,
        wavePower: 42000,
      }),
      attack({
        id: 'maul',
        kind: 'melee',
        rangeMetres: 5.4,
        windupSeconds: 0.72,
        activeSeconds: 0.2,
        cooldownSeconds: 2.4,
        weight: 1.5,
        clip: 'heavyAttack',
        waveRangeMetres: 11,
        wavePower: 9800,
      }),
    ],
  }),

  archetype({
    id: 'mob.god.harbinger',
    name: 'Harbinger',
    threatTier: 'god',
    assetKey: 'chr.mook.god',
    maxHealth: 90000,
    attackDamage: 4000,
    aggroRadius: 120,
    bodyHeightMetres: 3.55,
    massKg: 4200,
    rewardPoints: 5000,
    staggerFraction: 0.55,
    staggerSeconds: 2.2,
    memorySeconds: 25,
    roarPeriodSeconds: 5,
    // God-tier is a wasteland event. A Harbinger downtown is not a difficulty
    // spike, it is the end of the district — so the table simply does not
    // allow it to appear where there are people.
    spawnDistricts: ['wasteland'],
    movement: movement({ walkSpeed: 3, runSpeed: 9.5, acceleration: 6, turnRateRad: 1.4 }),
    attacks: [
      attack({
        id: 'annihilate',
        kind: 'ranged',
        rangeMetres: 140,
        minRangeMetres: 0,
        windupSeconds: 2.1,
        activeSeconds: 0.5,
        cooldownSeconds: 14,
        halfAngleRad: 18 * DEG2RAD,
        clip: 'special',
        waveRangeMetres: 150,
        waveHalfAngleRad: 16 * DEG2RAD,
        wavePower: 640000,
      }),
      attack({
        id: 'crush',
        kind: 'melee',
        rangeMetres: 6.5,
        windupSeconds: 0.9,
        activeSeconds: 0.25,
        cooldownSeconds: 3,
        weight: 1.3,
        clip: 'heavyAttack',
        waveRangeMetres: 18,
        wavePower: 120000,
      }),
    ],
  }),

  /* ---- summon-only ---------------------------------------------------- */
  archetype({
    id: 'mob.swarm.mosquito',
    name: 'Swarm Mosquito',
    threatTier: 'wolf',
    assetKey: 'chr.mook.wolf',
    motion: 'flying',
    maxHealth: 4,
    attackDamage: 1,
    aggroRadius: 40,
    bodyHeightMetres: 0.42,
    massKg: 3,
    radiusMetres: 0.3,
    rewardPoints: 1,
    scale: 0.28,
    staggerFraction: 1.1, // nothing staggers it; it simply dies
    roarPeriodSeconds: 3.5,
    summonOnly: true,
    // 92% sideways drift resampled six times a second. A monster you cannot
    // predict is the only kind a 1.2 m reach struggles with, and this is the
    // cheapest possible statement of that.
    movement: movement({
      walkSpeed: 4,
      runSpeed: 11,
      acceleration: 26,
      turnRateRad: 9,
      erratic: 0.92,
      erraticPeriodSeconds: 0.17,
      hoverHeightMetres: 3.4,
      bobAmplitudeMetres: 1.1,
      standoffMetres: 2.5,
    }),
    attacks: [
      attack({
        id: 'bite',
        kind: 'melee',
        rangeMetres: 1.1,
        windupSeconds: 0.14,
        activeSeconds: 0.06,
        recoverySeconds: 0.12,
        cooldownSeconds: 0.7,
        waveRangeMetres: 1.2,
        wavePower: 8,
      }),
    ],
  }),
]);

/* -------------------------------------------------------------------------- */
/* Bosses — four questions, asked once each                                   */
/* -------------------------------------------------------------------------- */

const BOSSES: readonly IMonsterArchetype[] = Object.freeze([
  /**
   * MOSQUITO GIRL — the flying-target test.
   *
   * Fast, erratic, permanently airborne at 5.2 m, which is four times the
   * normal punch's reach. She cannot be jabbed from the pavement. The player
   * either finds height, times a jump, or pays for a cone — and while they
   * decide, the swarm is eating the district.
   */
  archetype({
    id: 'boss.mosquitoGirl',
    name: 'Mosquito Girl',
    threatTier: 'demon',
    assetKey: 'chr.mosquitoGirl',
    motion: 'flying',
    maxHealth: 1400,
    attackDamage: 55,
    aggroRadius: 60,
    bodyHeightMetres: 1.74,
    massKg: 62,
    radiusMetres: 0.6,
    rewardPoints: 300,
    isBoss: true,
    staggerFraction: 0.5,
    staggerSeconds: 0.7,
    memorySeconds: 20,
    roarPeriodSeconds: 5,
    abilities: ['summon-swarm', 'dive'],
    movement: movement({
      walkSpeed: 5,
      runSpeed: 15.5,
      acceleration: 34,
      turnRateRad: 7.5,
      erratic: 0.78,
      erraticPeriodSeconds: 0.28,
      hoverHeightMetres: 5.2,
      bobAmplitudeMetres: 1.8,
      standoffMetres: 9,
    }),
    attacks: [
      attack({
        id: 'summon',
        kind: 'summon',
        rangeMetres: 60,
        windupSeconds: 1.1,
        activeSeconds: 0.2,
        cooldownSeconds: 16,
        clip: 'taunt',
        waveRangeMetres: 14,
        waveHalfAngleRad: Math.PI,
        wavePower: 400,
        summonArchetypeId: 'mob.swarm.mosquito',
        summonCount: 14,
      }),
      attack({
        id: 'dive',
        kind: 'charge',
        rangeMetres: 22,
        minRangeMetres: 3,
        windupSeconds: 0.42,
        activeSeconds: 0.3,
        recoverySeconds: 0.5,
        cooldownSeconds: 2.8,
        weight: 1.6,
        clip: 'special',
        waveRangeMetres: 6,
        wavePower: 2200,
      }),
      attack({
        id: 'lash',
        kind: 'melee',
        rangeMetres: 2.6,
        windupSeconds: 0.22,
        cooldownSeconds: 1,
        waveRangeMetres: 3,
        wavePower: 500,
      }),
    ],
  }),

  /**
   * VACCINE MAN — the cover-and-destruction test.
   *
   * Hovers at 14 m and fires a 90 m beam every four seconds. The beam is a
   * `ShockwaveFired` cone at lethal intent, so the destruction system takes
   * whatever is between him and the player — which means the cover the player
   * hides behind is being deleted while they use it, and standing still is a
   * strictly losing strategy expressed entirely through geometry.
   */
  archetype({
    id: 'boss.vaccineMan',
    name: 'Vaccine Man',
    threatTier: 'demon',
    assetKey: 'chr.vaccineMan',
    motion: 'flying',
    maxHealth: 2600,
    attackDamage: 140,
    aggroRadius: 95,
    bodyHeightMetres: 2.08,
    massKg: 210,
    radiusMetres: 0.85,
    rewardPoints: 340,
    isBoss: true,
    staggerFraction: 0.45,
    memorySeconds: 30,
    roarPeriodSeconds: 9,
    abilities: ['beam', 'nova'],
    movement: movement({
      walkSpeed: 3,
      runSpeed: 8.2,
      acceleration: 12,
      turnRateRad: 2.6,
      erratic: 0.18,
      hoverHeightMetres: 14,
      bobAmplitudeMetres: 0.9,
      standoffMetres: 46,
    }),
    attacks: [
      attack({
        id: 'beam',
        kind: 'ranged',
        rangeMetres: 90,
        minRangeMetres: 8,
        windupSeconds: 1.15,
        activeSeconds: 0.45,
        recoverySeconds: 0.8,
        cooldownSeconds: 4,
        halfAngleRad: 14 * DEG2RAD,
        clip: 'special',
        waveRangeMetres: 92,
        waveHalfAngleRad: 11 * DEG2RAD,
        wavePower: 52000,
      }),
      attack({
        id: 'nova',
        kind: 'slam',
        rangeMetres: 18,
        windupSeconds: 1.6,
        activeSeconds: 0.4,
        cooldownSeconds: 12,
        weight: 0.6,
        clip: 'heavyAttack',
        waveRangeMetres: 28,
        waveHalfAngleRad: Math.PI,
        wavePower: 96000,
      }),
    ],
  }),

  /**
   * DEEP SEA KING — the emotional core.
   *
   * Mechanically the least interesting boss in the game: he walks at you and
   * hits you. That is deliberate. The test is not the fight, it is the
   * TRAVEL — he is already beating Mumen Rider when the encounter opens, and
   * the rescue window is a wall-clock number the player cannot negotiate with.
   * A player who takes the direct route arrives; a player who stops to clear
   * the street does not, and the fight afterwards is identical either way.
   */
  archetype({
    id: 'boss.deepSeaKing',
    name: 'Deep Sea King',
    threatTier: 'dragon',
    assetKey: 'chr.deepSeaKing',
    motion: 'aquatic',
    maxHealth: 9800,
    attackDamage: 480,
    aggroRadius: 55,
    bodyHeightMetres: 2.72,
    massKg: 1450,
    rewardPoints: 900,
    isBoss: true,
    staggerFraction: 0.5,
    staggerSeconds: 1.4,
    memorySeconds: 40,
    roarPeriodSeconds: 6,
    abilities: ['rain-form', 'grapple'],
    movement: movement({ walkSpeed: 2.6, runSpeed: 8.8, acceleration: 10, turnRateRad: 2.2 }),
    attacks: [
      attack({
        id: 'backhand',
        kind: 'melee',
        rangeMetres: 4.6,
        windupSeconds: 0.55,
        activeSeconds: 0.2,
        cooldownSeconds: 2,
        weight: 1.6,
        clip: 'heavyAttack',
        waveRangeMetres: 9,
        wavePower: 18000,
      }),
      attack({
        id: 'deluge',
        kind: 'slam',
        rangeMetres: 9,
        windupSeconds: 1.1,
        activeSeconds: 0.3,
        cooldownSeconds: 7,
        clip: 'special',
        waveRangeMetres: 26,
        waveHalfAngleRad: Math.PI,
        wavePower: 61000,
      }),
      attack({
        id: 'lunge',
        kind: 'charge',
        rangeMetres: 16,
        minRangeMetres: 5,
        windupSeconds: 0.65,
        activeSeconds: 0.45,
        cooldownSeconds: 6,
        weight: 0.9,
        waveRangeMetres: 8,
        wavePower: 24000,
      }),
    ],
  }),

  /**
   * BOROS — where the phase gate matters most.
   *
   * Three beats: an arena that establishes him, a Collapsing Star Roaring
   * Cannon the player simply has to STAND IN for nine seconds, and then the
   * finisher. The middle phase is the only sustained "you cannot win yet" in
   * the game, and it is the reason the gate is a timer and not a health bar —
   * if the burst could be cut short by punching harder, the one moment the
   * protagonist is asked to endure something would evaporate.
   */
  archetype({
    id: 'boss.boros',
    name: 'Boros',
    threatTier: 'dragon',
    assetKey: 'chr.boros',
    maxHealth: 24000,
    attackDamage: 900,
    aggroRadius: 110,
    bodyHeightMetres: 2.18,
    massKg: 520,
    rewardPoints: 2400,
    isBoss: true,
    staggerFraction: 0.6,
    staggerSeconds: 1.1,
    memorySeconds: 60,
    roarPeriodSeconds: 8,
    abilities: ['meteoric-burst', 'collapsing-star', 'regeneration'],
    movement: movement({
      walkSpeed: 3.4,
      runSpeed: 13.5,
      acceleration: 30,
      turnRateRad: 5.5,
      erratic: 0.12,
    }),
    attacks: [
      attack({
        id: 'meteoric-burst',
        kind: 'charge',
        rangeMetres: 45,
        minRangeMetres: 6,
        windupSeconds: 0.55,
        activeSeconds: 0.5,
        recoverySeconds: 0.6,
        cooldownSeconds: 3.4,
        weight: 1.7,
        clip: 'special',
        waveRangeMetres: 20,
        wavePower: 180000,
      }),
      attack({
        id: 'collapsing-star',
        kind: 'ranged',
        rangeMetres: 120,
        windupSeconds: 2.4,
        activeSeconds: 0.9,
        recoverySeconds: 1.4,
        cooldownSeconds: 18,
        halfAngleRad: 20 * DEG2RAD,
        clip: 'special',
        waveRangeMetres: 130,
        waveHalfAngleRad: 18 * DEG2RAD,
        wavePower: 1400000,
      }),
      attack({
        id: 'flurry',
        kind: 'melee',
        rangeMetres: 3.4,
        windupSeconds: 0.24,
        activeSeconds: 0.1,
        recoverySeconds: 0.2,
        cooldownSeconds: 0.9,
        weight: 1.2,
        waveRangeMetres: 5,
        wavePower: 34000,
      }),
    ],
  }),
]);

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

/** Every archetype, mooks first then bosses, in a stable order. */
export const MONSTER_ARCHETYPES: readonly IMonsterArchetype[] = Object.freeze([
  ...MOOKS,
  ...BOSSES,
]);

const BY_ID: ReadonlyMap<string, IMonsterArchetype> = new Map(
  MONSTER_ARCHETYPES.map((entry) => [entry.id, entry])
);

/** Look up an archetype. Throws on an unknown id — a typo is a bug, not data. */
export function monsterArchetype(id: string): IMonsterArchetype {
  const found = BY_ID.get(id);
  if (found === undefined) {
    throw new Error(`[monster] unknown archetype '${id}'`);
  }
  return found;
}

/** Look up without throwing, for callers validating user/save data. */
export function findMonsterArchetype(id: string): IMonsterArchetype | undefined {
  return BY_ID.get(id);
}

/** Everything the spawn director may place: mooks that are not summon-only. */
export function spawnableArchetypes(): readonly IMonsterArchetype[] {
  return MONSTER_ARCHETYPES.filter((a) => !a.isBoss && !a.summonOnly);
}

/** Spawnable archetypes at one tier, in table order. */
export function archetypesForTier(tier: ThreatTier): readonly IMonsterArchetype[] {
  return spawnableArchetypes().filter((a) => a.threatTier === tier);
}

/**
 * Spawnable archetypes allowed in a district.
 *
 * An archetype with no `spawnDistricts` may appear anywhere — the contract
 * says "empty means anywhere" — so absence is permissive and presence is a
 * whitelist. That asymmetry is what lets the god-tier row above be confined to
 * the wasteland with one line.
 */
export function archetypesForDistrict(
  district: DistrictType,
  tier?: ThreatTier
): readonly IMonsterArchetype[] {
  return spawnableArchetypes().filter((a) => {
    if (tier !== undefined && a.threatTier !== tier) return false;
    const districts = a.spawnDistricts;
    return districts === undefined || districts.length === 0 || districts.includes(district);
  });
}

/** The four named bosses, in encounter order. */
export function bossArchetypes(): readonly IMonsterArchetype[] {
  return MONSTER_ARCHETYPES.filter((a) => a.isBoss);
}
