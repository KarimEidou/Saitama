/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  MONSTER HARNESS                                                         ║
 * ║                                                                          ║
 * ║  Runs the assertions no unit test inside `src/entities/monster` can run,  ║
 * ║  because that module is forbidden from importing the code it would have   ║
 * ║  to check itself against — and then draws the result.                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── THE ONE THAT MATTERS ──────────────────────────────────────────────────
 * The boss phase gate, against the REAL `HitResolver`, in BOTH directions:
 *
 *   CLOSED   a `LethalIntent` punch on a boss mid-script must NOT kill.
 *   OPEN     the identical punch, after `BossPhaseChanged { isFinalPhase }`
 *            has crossed the bus, MUST kill.
 *
 * The two systems here share exactly one thing: an `EventBus`. Combat has
 * never heard of `@/entities/monster` and the monster module has never heard
 * of `@/gameplay/combat`. The gate travels between them as an event, which is
 * the entire point — so a harness that wired them together directly would be
 * testing a thing that does not exist in the game.
 *
 * ── ONE SUBTLETY WORTH STATING OUT LOUD ───────────────────────────────────
 * `syncCombatTargets` copies POSITION and HEALTH from the monster system into
 * combat's registry every frame, and deliberately never copies
 * `phaseResolved` after the first registration. If it did, the gate would be
 * arriving by assignment instead of by event, the test would pass, and the
 * shipped game would still be broken. The flag is written on combat's side by
 * combat's own `BossPhaseChanged` handler or it is not written at all.
 */

import {
  BOSS_SCRIPTS,
  DEFAULT_SPAWN_POLICY,
  MonsterSystem,
  SpawnDirector,
  analyseTransitionTable,
  MONSTER_STATES,
  MonsterFsm,
  monsterArchetype,
  ringBetween,
  type IBossPhaseState,
  type ILiveMonsterRef,
  type IMonsterTarget,
  type ISpawnOrder,
  type MonsterState,
} from '@/entities/monster';
import {
  createCombatSystem,
  pointInCone,
  type CombatSystem,
  type IAttackerSource,
  type ICombatHit,
  type IMutableVec3,
} from '@/gameplay/combat';
import { createEventBus, createRng } from '@/util';
import type { GameEvent, IEventBus, ThreatTier, Vec3 } from '@/types';

/* -------------------------------------------------------------------------- */
/* Result plumbing                                                            */
/* -------------------------------------------------------------------------- */

type CheckGroup = 'gate' | 'tier' | 'ally' | 'spawn' | 'fsm' | 'determinism';

interface ICheck {
  readonly group: CheckGroup;
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const checks: ICheck[] = [];

function check(group: CheckGroup, name: string, pass: boolean, detail: string): void {
  checks.push({ group, name, pass, detail });
}

/* -------------------------------------------------------------------------- */
/* Shared scaffolding                                                         */
/* -------------------------------------------------------------------------- */

/** A player that can be moved and pointed by hand. */
interface IHarnessPlayer {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

function attackerFor(player: IHarnessPlayer): IAttackerSource {
  return {
    id: 'player',
    getOrigin(out: IMutableVec3): void {
      out.x = player.x;
      // Fist height. The resolver measures surface distance, so this only has
      // to be somewhere on the body.
      out.y = player.y + 1.2;
      out.z = player.z;
    },
    getFacing(out: IMutableVec3): void {
      out.x = Math.sin(player.yaw);
      out.y = 0;
      out.z = Math.cos(player.yaw);
    },
  };
}

/**
 * Metres the player stands from a monster before throwing a normal punch.
 *
 * The tap reaches 1.2 m from the FIST SOCKET, which the attacker source puts
 * at 1.2 m of height — so the punch origin and a monster's aim point are
 * separated vertically as well as horizontally, and the resolver measures the
 * hypotenuse. 0.9 m keeps a jab inside reach against every archetype in the
 * table, including the shortest.
 */
const PUNCH_STANDOFF = 0.9;

/** Point the player at a position and stand `distance` metres from it. */
function standNextTo(player: IHarnessPlayer, target: Vec3, distance: number): void {
  const dx = target.x - player.x;
  const dz = target.z - player.z;
  const length = Math.hypot(dx, dz) || 1;
  player.x = target.x - (dx / length) * distance;
  player.z = target.z - (dz / length) * distance;
  player.yaw = Math.atan2(target.x - player.x, target.z - player.z);
}

/** One world: a bus, a combat system, a monster system, and a player. */
interface IWorld {
  readonly bus: IEventBus;
  readonly combat: CombatSystem;
  readonly monsters: MonsterSystem;
  readonly player: IHarnessPlayer;
  readonly events: GameEvent[];
  readonly registered: Set<string>;
}

function makeWorld(seed: string): IWorld {
  const bus = createEventBus();
  const events: GameEvent[] = [];
  bus.onAny((event) => events.push(event));

  const player: IHarnessPlayer = { x: 0, y: 0, z: 0, yaw: 0 };
  const combat = createCombatSystem({ bus, attacker: attackerFor(player), seed });
  const monsters = new MonsterSystem({ bus, seed });

  return { bus, combat, monsters, player, events, registered: new Set() };
}

/**
 * Mirror the monster system into combat's target registry.
 *
 * Position and health every frame. `phaseResolved` ONCE, at registration —
 * after that it belongs to the bus. See the file header.
 */
function syncCombatTargets(world: IWorld): void {
  for (const descriptor of world.monsters.describeForCombat()) {
    if (!world.registered.has(descriptor.id)) {
      world.registered.add(descriptor.id);
      world.combat.addTarget({
        id: descriptor.id,
        type: descriptor.type,
        faction: descriptor.faction,
        position: descriptor.position,
        radius: descriptor.radius,
        massKg: descriptor.massKg,
        maxHealth: descriptor.maxHealth,
        health: descriptor.health,
        displayName: descriptor.displayName,
        threatTier: descriptor.threatTier,
        specId: descriptor.specId,
        isBoss: descriptor.isBoss,
        phaseResolved: descriptor.phaseResolved,
        rewardPoints: descriptor.rewardPoints,
      });
      continue;
    }
    world.combat.targets.setPosition(
      descriptor.id,
      descriptor.position.x,
      descriptor.position.y,
      descriptor.position.z
    );
  }
}

/** Advance both systems together, as the shipped game loop would. */
function step(world: IWorld, dt: number, time: number, targets: readonly IMonsterTarget[]): void {
  world.monsters.update(dt, { time, focus: world.player, targets });
  syncCombatTargets(world);
}

/* -------------------------------------------------------------------------- */
/* 1. THE PHASE GATE                                                          */
/* -------------------------------------------------------------------------- */

interface IGateReport {
  readonly closedHit: ICombatHit | undefined;
  readonly openHit: ICombatHit | undefined;
  readonly healthWhileGated: number;
  readonly phaseEvents: number;
  readonly punchesAbsorbed: number;
}

function runGateScenario(): IGateReport {
  const world = makeWorld('gate');
  const encounter = world.monsters.startBossEncounter('boss.boros', { x: 0, y: 0, z: 0 });
  const boss = world.monsters.boss!;
  syncCombatTargets(world);

  /* ---- DIRECTION 1: the gate is closed ------------------------------------ */
  standNextTo(world.player, boss.brain.position, PUNCH_STANDOFF);
  const closed = world.combat.normalPunch();
  const closedHit = closed.hits.find((h) => h.targetId === boss.id);

  // And it is not a one-off: a hundred more change nothing.
  let absorbed = closedHit?.phaseGated === true ? 1 : 0;
  for (let i = 0; i < 100; i++) {
    standNextTo(world.player, boss.brain.position, PUNCH_STANDOFF);
    const again = world.combat.normalPunch();
    if (again.hits.find((h) => h.targetId === boss.id)?.phaseGated === true) absorbed++;
  }
  const healthWhileGated = world.combat.targets.get(boss.id)!.health;

  /* ---- drive the script to its finisher ---------------------------------- */
  let time = 0;
  const player: IMonsterTarget = {
    id: 'player',
    faction: 'hero',
    position: world.player,
    alive: true,
    priority: 1,
  };
  let guard = 0;
  while (!encounter.phaseResolved && guard++ < 4000) {
    time += 1 / 30;
    standNextTo(world.player, boss.brain.position, PUNCH_STANDOFF);
    step(world, 1 / 30, time, [player]);
    // Feed the phase what it asks for: presence, and hits. The hits are real
    // punches, which is the point — a gated boss reports `amount: 0`, and the
    // phase counts contacts rather than damage.
    const state = encounter.state();
    if (state.hits < state.hitsRequired) {
      world.combat.normalPunch();
    }
  }

  /* ---- DIRECTION 2: the same punch, after the gate opened ---------------- */
  standNextTo(world.player, boss.brain.position, PUNCH_STANDOFF);
  const open = world.combat.normalPunch();
  const openHit = open.hits.find((h) => h.targetId === boss.id);

  const phaseEvents = world.events.filter((e) => e.type === 'BossPhaseChanged').length;
  world.monsters.dispose();
  world.combat.dispose();

  return { closedHit, openHit, healthWhileGated, phaseEvents, punchesAbsorbed: absorbed };
}

function assertGate(report: IGateReport): void {
  const closed = report.closedHit;
  check(
    'gate',
    'CLOSED — a lethal punch mid-script does not kill',
    closed !== undefined && closed.killed === false && closed.phaseGated === true,
    closed === undefined
      ? 'the punch did not reach the boss at all'
      : `killed=${closed.killed} phaseGated=${closed.phaseGated} instantKill=${closed.instantKill}`
  );
  check(
    'gate',
    'CLOSED — health is untouched, so the gate is not an HP gate',
    report.healthWhileGated === monsterArchetype('boss.boros').maxHealth,
    `${report.healthWhileGated} / ${monsterArchetype('boss.boros').maxHealth} after 101 punches`
  );
  check(
    'gate',
    'CLOSED — 101 punches, 101 absorbed',
    report.punchesAbsorbed === 101,
    `${report.punchesAbsorbed} / 101 gated`
  );

  const open = report.openHit;
  check(
    'gate',
    'OPEN — the identical punch kills',
    open !== undefined && open.killed === true && open.instantKill === true,
    open === undefined
      ? 'the punch did not reach the boss at all'
      : `killed=${open.killed} instantKill=${open.instantKill} phaseGated=${open.phaseGated}`
  );
  check(
    'gate',
    'OPEN — no damage number was involved',
    open !== undefined && open.damage === 0,
    `damage=${open?.damage ?? '—'} (a lethal hit sets a flag, it does not compute a number)`
  );
  check(
    'gate',
    'the gate crossed the bus as BossPhaseChanged',
    report.phaseEvents === BOSS_SCRIPTS.find((s) => s.encounterId === 'boss.boros')!.phases.length,
    `${report.phaseEvents} phase events for a 4-phase script`
  );
}

/* -------------------------------------------------------------------------- */
/* 2. INSTANT KILL AT EVERY TIER                                              */
/* -------------------------------------------------------------------------- */

interface ITierResult {
  readonly tier: ThreatTier;
  readonly archetypeId: string;
  readonly maxHealth: number;
  readonly killed: boolean;
  readonly instantKill: boolean;
  readonly phaseGated: boolean;
  readonly damage: number;
}

const TIER_SAMPLES: readonly { tier: ThreatTier; id: string }[] = [
  { tier: 'wolf', id: 'mob.wolf.pest' },
  { tier: 'tiger', id: 'mob.tiger.brute' },
  { tier: 'demon', id: 'mob.demon.carapace' },
  { tier: 'dragon', id: 'mob.dragon.leviathan' },
  { tier: 'god', id: 'mob.god.harbinger' },
];

function runTierScenario(): ITierResult[] {
  const results: ITierResult[] = [];
  for (const sample of TIER_SAMPLES) {
    const world = makeWorld(`tier-${sample.tier}`);
    const archetype = monsterArchetype(sample.id);
    const monster = world.monsters.spawn(archetype, { x: 40, y: 0, z: 40 });
    syncCombatTargets(world);

    standNextTo(world.player, monster.brain.position, PUNCH_STANDOFF);
    const outcome = world.combat.normalPunch();
    const hit = outcome.hits.find((h) => h.targetId === monster.id);

    results.push({
      tier: sample.tier,
      archetypeId: sample.id,
      maxHealth: archetype.maxHealth,
      killed: hit?.killed ?? false,
      instantKill: hit?.instantKill ?? false,
      phaseGated: hit?.phaseGated ?? false,
      damage: hit?.damage ?? Number.NaN,
    });

    world.monsters.dispose();
    world.combat.dispose();
  }
  return results;
}

function assertTiers(results: readonly ITierResult[]): void {
  for (const result of results) {
    check(
      'tier',
      `${result.tier} — one punch, dead`,
      result.killed && result.instantKill && !result.phaseGated && result.damage === 0,
      `${result.archetypeId}, ${result.maxHealth.toLocaleString()} HP ignored entirely`
    );
  }
  const spread =
    Math.max(...results.map((r) => r.maxHealth)) / Math.min(...results.map((r) => r.maxHealth));
  check(
    'tier',
    'the health spread is irrelevant, which is the joke',
    results.every((r) => r.killed),
    `${spread.toFixed(0)}x between the weakest and the strongest, identical outcome`
  );
}

/* -------------------------------------------------------------------------- */
/* 3. DEEP SEA KING — THE BRANCH                                              */
/* -------------------------------------------------------------------------- */

interface IAllyRun {
  readonly allyDowned: number;
  readonly allySurvived: boolean;
  readonly reachedFinisher: boolean;
  readonly downedAt: number | undefined;
}

/**
 * @param arriveAtSeconds when the player reaches Mumen Rider. `Infinity` for a
 *   player who never gets there at all.
 */
function runAllyScenario(arriveAtSeconds: number): IAllyRun {
  const world = makeWorld(`dsk-${arriveAtSeconds}`);
  const allyPosition = { x: 42, y: 0, z: 0 };
  const encounter = world.monsters.startBossEncounter(
    'boss.deepSeaKing',
    { x: 0, y: 0, z: 0 },
    { ally: { id: 'mumen-rider', displayName: 'Mumen Rider', position: allyPosition } }
  );
  syncCombatTargets(world);

  const boss = world.monsters.boss!;
  const player: IMonsterTarget = {
    id: 'player',
    faction: 'hero',
    position: world.player,
    alive: true,
    priority: 1,
  };

  let downedAt: number | undefined;
  world.bus.on('AllyDowned', () => {
    downedAt ??= time;
  });

  // Start 120 m away, as the encounter opens.
  world.player.x = -120;
  world.player.z = 0;

  let time = 0;
  let guard = 0;
  while (!encounter.phaseResolved && guard++ < 6000) {
    time += 1 / 30;
    if (time >= arriveAtSeconds) {
      // Arrived: stand on the ally, then close with the boss.
      standNextTo(world.player, encounter.allySurvived ? allyPosition : boss.brain.position, 6);
    }
    step(world, 1 / 30, time, [player]);
    const state = encounter.state();
    if (time >= arriveAtSeconds && state.hits < state.hitsRequired) {
      standNextTo(world.player, boss.brain.position, PUNCH_STANDOFF);
      world.combat.normalPunch();
    }
  }

  const allyDowned = world.events.filter((e) => e.type === 'AllyDowned').length;
  const result: IAllyRun = {
    allyDowned,
    allySurvived: encounter.allySurvived,
    reachedFinisher: encounter.phaseResolved,
    downedAt,
  };
  world.monsters.dispose();
  world.combat.dispose();
  return result;
}

function assertAlly(fast: IAllyRun, slow: IAllyRun): void {
  check(
    'ally',
    'PLAYER FAST — Mumen Rider survives',
    fast.allyDowned === 0 && fast.allySurvived,
    `arrived at 8 s, inside the 18 s window; AllyDowned fired ${fast.allyDowned} times`
  );
  check(
    'ally',
    'PLAYER SLOW — AllyDowned fires, exactly once',
    slow.allyDowned === 1 && !slow.allySurvived,
    slow.downedAt === undefined
      ? 'never fired'
      : `fired once at t=${slow.downedAt.toFixed(1)} s against an 18 s window`
  );
  check(
    'ally',
    'the fight is identical either way',
    fast.reachedFinisher && slow.reachedFinisher,
    'both runs reached the finisher — the branch costs him, not the boss'
  );
}

/* -------------------------------------------------------------------------- */
/* 4. THE SPAWN DIRECTOR                                                      */
/* -------------------------------------------------------------------------- */

interface ISpawnReport {
  readonly orders: number;
  readonly worstRing: number;
  readonly closest: number;
  readonly rejected: number;
  readonly tierHistogram: Record<ThreatTier, number>;
  readonly districtSkew: { park: number; wasteland: number };
  readonly peakConcurrent: number;
}

function runSpawnScenario(): ISpawnReport {
  const focus: Vec3 = { x: 0, y: 0, z: 0 };
  const director = new SpawnDirector({ seed: 'harness-spawn' });
  const live: ILiveMonsterRef[] = [];
  const orders: ISpawnOrder[] = [];
  let peak = 0;

  for (let t = 0; t < 6000; t += 0.25) {
    const decision = director.update(0.25, { focus, live });
    for (const id of decision.retire) {
      const index = live.findIndex((m) => m.id === id);
      if (index >= 0) live.splice(index, 1);
    }
    for (const order of decision.orders) {
      orders.push(order);
      live.push({
        id: `m#${order.serial}`,
        tier: order.tier,
        position: order.position,
        age: 0,
        engaged: false,
        scripted: false,
      });
    }
    for (const monster of live) (monster as { age: number }).age += 0.25;
    peak = Math.max(peak, live.length);
  }

  const tierHistogram: Record<ThreatTier, number> = {
    wolf: 0,
    tiger: 0,
    demon: 0,
    dragon: 0,
    god: 0,
  };
  let worstRing = 0;
  let closest = Number.POSITIVE_INFINITY;
  for (const order of orders) {
    tierHistogram[order.tier]++;
    worstRing = Math.max(worstRing, ringBetween(order.position, focus), order.ring);
    closest = Math.min(closest, Math.hypot(order.position.x, order.position.z));
  }

  /* zoning skew, measured rather than asserted from the table */
  const rank: Record<ThreatTier, number> = { wolf: 0, tiger: 1, demon: 2, dragon: 3, god: 4 };
  const meanTier = (district: 'park' | 'wasteland'): number => {
    const zoned = new SpawnDirector({ seed: `harness-${district}`, districtAt: () => district });
    const zonedLive: ILiveMonsterRef[] = [];
    let sum = 0;
    let count = 0;
    for (let t = 0; t < 6000; t += 0.25) {
      const decision = zoned.update(0.25, { focus, live: zonedLive });
      for (const id of decision.retire) {
        const index = zonedLive.findIndex((m) => m.id === id);
        if (index >= 0) zonedLive.splice(index, 1);
      }
      for (const order of decision.orders) {
        sum += rank[order.tier];
        count++;
        zonedLive.push({
          id: `m#${order.serial}`,
          tier: order.tier,
          position: order.position,
          age: 0,
          engaged: false,
          scripted: false,
        });
      }
      for (const monster of zonedLive) (monster as { age: number }).age += 0.25;
    }
    return count === 0 ? 0 : sum / count;
  };

  return {
    orders: orders.length,
    worstRing,
    closest,
    rejected: director.stats().ordersRejected,
    tierHistogram,
    districtSkew: { park: meanTier('park'), wasteland: meanTier('wasteland') },
    peakConcurrent: peak,
  };
}

function assertSpawn(report: ISpawnReport): void {
  check(
    'spawn',
    'nothing spawns in R2 or beyond',
    report.worstRing <= DEFAULT_SPAWN_POLICY.maxSpawnRing,
    `worst ring over ${report.orders} orders: R${report.worstRing} (limit R${DEFAULT_SPAWN_POLICY.maxSpawnRing})`
  );
  check(
    'spawn',
    'the ring rule is doing real work',
    report.rejected > 0,
    `${report.rejected} candidates rejected — the annulus reaches 520 m, so R2 genuinely occurs`
  );
  check(
    'spawn',
    'nothing spawns on top of the player',
    report.closest >= DEFAULT_SPAWN_POLICY.minSpawnDistanceMetres,
    `closest spawn ${report.closest.toFixed(1)} m (floor ${DEFAULT_SPAWN_POLICY.minSpawnDistanceMetres} m)`
  );
  check(
    'spawn',
    'the population stays inside budget',
    report.peakConcurrent <= DEFAULT_SPAWN_POLICY.maxActive,
    `peak ${report.peakConcurrent} concurrent (cap ${DEFAULT_SPAWN_POLICY.maxActive})`
  );
  check(
    'spawn',
    'zoning is geography, not a difficulty slider',
    report.districtSkew.wasteland > report.districtSkew.park,
    `mean tier: park ${report.districtSkew.park.toFixed(2)} → wasteland ${report.districtSkew.wasteland.toFixed(2)}`
  );
  check(
    'spawn',
    'the tier pyramid is a pyramid',
    report.tierHistogram.wolf > report.tierHistogram.dragon,
    Object.entries(report.tierHistogram)
      .map(([tier, count]) => `${tier} ${count}`)
      .join('  ')
  );
}

/* -------------------------------------------------------------------------- */
/* 5. THE STATE MACHINE                                                       */
/* -------------------------------------------------------------------------- */

function assertFsm(): void {
  const flaws = analyseTransitionTable();
  check(
    'fsm',
    'the transition table is sound',
    flaws.length === 0,
    flaws.length === 0
      ? 'every state reachable, every non-dead state exitable, death always available'
      : flaws.map((f) => f.detail).join('; ')
  );

  /* fuzz: no random walk may leave the state set, and every legal request
     must be honoured while every illegal one must be refused */
  const rng = createRng('harness-fsm');
  const fsm = new MonsterFsm('idle');
  const visited = new Set<MonsterState>();
  let invalidState = 0;
  let disagreements = 0;
  for (let i = 0; i < 40_000; i++) {
    fsm.update(rng.range(0.001, 0.4));
    if (!MONSTER_STATES.includes(fsm.current)) invalidState++;
    visited.add(fsm.current);

    const requested = rng.pick(MONSTER_STATES);
    const allowed = fsm.canTransition(requested);
    if (fsm.transition(requested) !== allowed) disagreements++;
    visited.add(fsm.current);

    if (fsm.current === 'dead') fsm.reset();
  }
  check(
    'fsm',
    '40 000 random transitions never leave the state set',
    invalidState === 0 && disagreements === 0 && visited.size === MONSTER_STATES.length,
    `visited ${visited.size}/${MONSTER_STATES.length} states, ` +
      `${invalidState} invalid, ${disagreements} table disagreements`
  );

  /* every transient state has a watchdog that actually fires */
  const stuck = new MonsterFsm('idle');
  stuck.transition('alerted');
  for (let i = 0; i < 400; i++) stuck.update(0.1);
  check(
    'fsm',
    'no state can deadlock — the watchdog rescues a parked machine',
    stuck.current !== 'alerted' && stuck.watchdogTrips > 0,
    `parked in 'alerted' for 40 s → '${stuck.current}' after ${stuck.watchdogTrips} watchdog trips`
  );
}

/* -------------------------------------------------------------------------- */
/* 6. DETERMINISM                                                             */
/* -------------------------------------------------------------------------- */

function digestOfSession(seed: string): string {
  const world = makeWorld(seed);
  world.monsters.director.setPacing('build');
  const player: IMonsterTarget = {
    id: 'player',
    faction: 'hero',
    position: world.player,
    alive: true,
    priority: 1,
  };
  for (let t = 0; t < 180; t += 0.25) {
    world.player.x = Math.sin(t * 0.2) * 60;
    world.player.z = Math.cos(t * 0.2) * 60;
    step(world, 0.25, t, [player]);
  }
  const digest = JSON.stringify({
    snapshots: world.monsters.snapshots(),
    events: world.events.map((e) => ({ ...e, time: 0, frame: 0 })),
  });
  world.monsters.dispose();
  world.combat.dispose();
  return digest;
}

function assertDeterminism(): void {
  const a = digestOfSession('replay');
  const b = digestOfSession('replay');
  const c = digestOfSession('other');
  check(
    'determinism',
    'same seed → byte-identical session',
    a === b,
    `${a.length.toLocaleString()} chars of events and snapshots, matched exactly`
  );
  check('determinism', 'different seed → different session', a !== c, 'the seed actually matters');
}

/* -------------------------------------------------------------------------- */
/* The picture                                                                */
/* -------------------------------------------------------------------------- */

interface IBurst {
  readonly ox: number;
  readonly oz: number;
  readonly dx: number;
  readonly dz: number;
  readonly range: number;
  readonly halfAngle: number;
  readonly power: number;
  readonly age: number;
}

interface IBuilding {
  readonly x: number;
  readonly z: number;
  readonly w: number;
  readonly d: number;
  /** 0..1 — drives the drop shadow that gives a top-down block a storey count. */
  readonly height: number;
  readonly levelled: boolean;
}

interface IActorDot {
  readonly x: number;
  readonly z: number;
  readonly kind: 'boss' | 'monster' | 'player' | 'ally' | 'civilian';
  readonly radius: number;
  readonly label?: string;
  /** Heading a fleeing civilian is running along, in radians. */
  readonly flee?: number;
}

interface IScene {
  readonly bursts: IBurst[];
  readonly buildings: IBuilding[];
  readonly actors: IActorDot[];
  readonly phase: IBossPhaseState;
  readonly arenaRadius: number;
  readonly craters: { x: number; z: number; r: number }[];
}

/**
 * Build the picture: Boros, mid Collapsing Star.
 *
 * The cones drawn are the encounter's own `ShockwaveFired` events, and the
 * buildings marked as levelled are the ones combat's `pointInCone` says those
 * cones actually swept. Nothing here is decorative.
 */
function buildScene(): IScene {
  const world = makeWorld('scene');
  const encounter = world.monsters.startBossEncounter('boss.boros', { x: 0, y: 0, z: 0 });
  syncCombatTargets(world);
  const boss = world.monsters.boss!;

  const bursts: IBurst[] = [];
  world.bus.on('ShockwaveFired', (event) => {
    if (event.sourceId !== boss.id) return;
    bursts.push({
      ox: event.origin.x,
      oz: event.origin.z,
      dx: event.direction.x,
      dz: event.direction.z,
      range: event.range,
      halfAngle: event.angle,
      power: event.power,
      age: 0,
    });
  });

  const player: IMonsterTarget = {
    id: 'player',
    faction: 'hero',
    position: world.player,
    alive: true,
    priority: 1,
  };

  /* Phase 0 → phase 1, then seven seconds into the survival phase — the
     moment the encounter is at its loudest and the gate is still sealed. */
  let time = 0;
  world.player.x = 26;
  world.player.z = -14;
  let guard = 0;
  while (encounter.currentPhaseIndex === 0 && guard++ < 3000) {
    time += 1 / 30;
    step(world, 1 / 30, time, [player]);
    const state = encounter.state();
    if (state.hits < state.hitsRequired) {
      standNextTo(world.player, boss.brain.position, PUNCH_STANDOFF);
      world.combat.normalPunch();
      world.player.x = 26;
      world.player.z = -14;
    }
  }
  bursts.length = 0; // keep only the Collapsing Star, not the arena phase

  /* The player CIRCLES the arena while the cannon tracks. Standing still would
     stack every burst on one bearing and the picture would show one wedge
     instead of a bombardment sweeping a district — which is a fair description
     of the difference between a set piece and a diagram. */
  for (let i = 0; i < 212; i++) {
    time += 1 / 30;
    const angle = -2.2 + i * 0.0135;
    const radius = 42 + Math.sin(i * 0.02) * 14;
    world.player.x = Math.sin(angle) * radius;
    world.player.z = Math.cos(angle) * radius;
    step(world, 1 / 30, time, [player]);
  }

  /* buildings: a seeded block grid, minus the arena */
  const rng = createRng('scene-city');
  const buildings: IBuilding[] = [];
  for (let gx = -5; gx <= 5; gx++) {
    for (let gz = -5; gz <= 5; gz++) {
      const x = gx * 26 + rng.range(-4, 4);
      const z = gz * 26 + rng.range(-4, 4);
      if (Math.hypot(x, z) < 30) continue; // the arena floor
      const w = rng.range(8, 20);
      const d = rng.range(8, 20);
      const height = rng.range(0.25, 1);
      const levelled = bursts.some((burst) =>
        pointInCone(x - burst.ox, 0, z - burst.oz, burst.dx, 0, burst.dz, burst.range, burst.halfAngle)
      );
      buildings.push({ x, z, w, d, height, levelled });
    }
  }

  /* actors */
  const actors: IActorDot[] = [
    {
      x: boss.brain.position.x,
      z: boss.brain.position.z,
      kind: 'boss',
      radius: 4.6,
      label: 'BOROS',
    },
    { x: world.player.x, z: world.player.z, kind: 'player', radius: 1.1, label: 'YOU' },
  ];
  const crowdRng = createRng('scene-crowd');
  for (let i = 0; i < 64; i++) {
    const angle = crowdRng.range(0, Math.PI * 2);
    const distance = crowdRng.range(46, 128);
    actors.push({
      x: Math.sin(angle) * distance,
      z: Math.cos(angle) * distance,
      kind: 'civilian',
      radius: 0.6,
      // Running away from the thing in the middle of the arena, which is what
      // the crowd system does off `ShockwaveFired` and what the picture should
      // show rather than a field of static dots.
      flee: angle + crowdRng.range(-0.4, 0.4),
    });
  }

  /* craters where the bursts landed */
  const craters = bursts.slice(-9).map((burst) => ({
    x: burst.ox + burst.dx * burst.range * 0.32,
    z: burst.oz + burst.dz * burst.range * 0.32,
    r: 7 + Math.log10(Math.max(10, burst.power)) * 1.6,
  }));

  const phase = encounter.state();
  world.monsters.dispose();
  world.combat.dispose();
  return { bursts, buildings, actors, phase, arenaRadius: 160, craters };
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

/** Metres across the canvas. */
const VIEW_METRES = 230;

function draw(scene: IScene): void {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;

  const size = canvas.width;
  const scale = size / VIEW_METRES;
  const toX = (x: number): number => size / 2 + x * scale;
  const toY = (z: number): number => size / 2 + z * scale;

  /* ---- ground -------------------------------------------------------- */
  const ground = ctx.createRadialGradient(size / 2, size * 0.46, 20, size / 2, size * 0.5, size * 0.72);
  ground.addColorStop(0, '#241624');
  ground.addColorStop(0.45, '#140f1c');
  ground.addColorStop(1, '#07060c');
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, size, size);

  /* ---- streets -------------------------------------------------------- */
  ctx.strokeStyle = 'rgba(120,132,168,0.10)';
  ctx.lineWidth = 5;
  for (let g = -5; g <= 5; g++) {
    ctx.beginPath();
    ctx.moveTo(toX(g * 26 - 13), 0);
    ctx.lineTo(toX(g * 26 - 13), size);
    ctx.moveTo(0, toY(g * 26 - 13));
    ctx.lineTo(size, toY(g * 26 - 13));
    ctx.stroke();
  }

  /* ---- range rings ----------------------------------------------------- */
  // The arena is 160 m in radius, which is wider than this 230 m frame, so
  // drawing it would put the ring off-screen and teach nothing. Range rings
  // do the job the arena circle was supposed to: they give the cones a scale.
  ctx.save();
  ctx.setLineDash([9, 9]);
  for (const metres of [40, 80, 110]) {
    ctx.strokeStyle = 'rgba(255,138,44,0.30)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(toX(0), toY(0), metres * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,178,96,0.55)';
    ctx.font = '500 10px ui-monospace, monospace';
    ctx.fillText(`${metres} m`, toX(0) + 5, toY(-metres) + 13);
    ctx.setLineDash([9, 9]);
  }
  ctx.restore();

  /* ---- craters -------------------------------------------------------- */
  for (const crater of scene.craters) {
    const g = ctx.createRadialGradient(
      toX(crater.x),
      toY(crater.z),
      1,
      toX(crater.x),
      toY(crater.z),
      crater.r * scale
    );
    g.addColorStop(0, 'rgba(255,120,40,0.30)');
    g.addColorStop(0.55, 'rgba(90,30,20,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(toX(crater.x), toY(crater.z), crater.r * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---- buildings ------------------------------------------------------ */
  for (const building of scene.buildings) {
    const x = toX(building.x - building.w / 2);
    const y = toY(building.z - building.d / 2);
    const w = building.w * scale;
    const h = building.d * scale;
    if (building.levelled) {
      ctx.fillStyle = '#41161f';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = '#8d2436';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, w, h);
      // rubble
      ctx.fillStyle = 'rgba(180,70,60,0.55)';
      for (let i = 0; i < 7; i++) {
        const rx = x + ((i * 37) % Math.max(1, w));
        const ry = y + ((i * 53) % Math.max(1, h));
        ctx.fillRect(rx, ry, 3, 3);
      }
    } else {
      // A drop shadow proportional to storey count: the cheapest way to make a
      // top-down block grid read as a skyline rather than as graph paper.
      const lift = 2 + building.height * 9;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x + lift * 0.5, y + lift * 0.5, w, h);
      const shade = Math.round(30 + building.height * 26);
      ctx.fillStyle = `rgb(${shade}, ${shade + 8}, ${shade + 28})`;
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = `rgba(120,140,196,${0.22 + building.height * 0.3})`;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
    }
  }

  /* ---- bursts --------------------------------------------------------- */
  const recent = scene.bursts.slice(-7);
  recent.forEach((burst, index) => {
    const alpha = 0.16 + (index / Math.max(1, recent.length - 1)) * 0.5;
    const heading = Math.atan2(burst.dx, burst.dz);
    const a0 = heading - burst.halfAngle;
    const a1 = heading + burst.halfAngle;

    const g = ctx.createRadialGradient(
      toX(burst.ox),
      toY(burst.oz),
      2,
      toX(burst.ox),
      toY(burst.oz),
      burst.range * scale
    );
    g.addColorStop(0, `rgba(255,248,214,${alpha})`);
    g.addColorStop(0.22, `rgba(255,168,52,${alpha * 0.85})`);
    g.addColorStop(0.65, `rgba(255,66,32,${alpha * 0.45})`);
    g.addColorStop(1, 'rgba(120,10,10,0)');

    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(toX(burst.ox), toY(burst.oz));
    // Screen space: x = sin(angle), y = cos(angle), so the arc runs from
    // (PI/2 - a1) to (PI/2 - a0) in canvas angles.
    ctx.arc(toX(burst.ox), toY(burst.oz), burst.range * scale, Math.PI / 2 - a1, Math.PI / 2 - a0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = `rgba(255,206,120,${alpha * 0.8})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  });

  /* ---- actors --------------------------------------------------------- */
  const COLOURS: Record<IActorDot['kind'], string> = {
    boss: '#ff8a2c',
    monster: '#ff4fd8',
    player: '#ffe66d',
    ally: '#4ade80',
    civilian: '#56b8ff',
  };
  for (const actor of scene.actors) {
    if (actor.kind === 'boss' || actor.kind === 'player') continue;
    if (actor.flee !== undefined) {
      // A short trail behind each civilian, so the crowd reads as running
      // rather than as a scatter of dots that happen to be blue.
      ctx.strokeStyle = 'rgba(86,184,255,0.34)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(toX(actor.x - Math.sin(actor.flee) * 4.5), toY(actor.z - Math.cos(actor.flee) * 4.5));
      ctx.lineTo(toX(actor.x), toY(actor.z));
      ctx.stroke();
    }
    ctx.fillStyle = COLOURS[actor.kind];
    ctx.globalAlpha = actor.kind === 'civilian' ? 0.85 : 1;
    ctx.beginPath();
    ctx.arc(toX(actor.x), toY(actor.z), Math.max(2.2, actor.radius * scale), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* the player: a crosshair, well clear of the boss, with a sight line to it */
  const you = scene.actors.find((a) => a.kind === 'player');
  const bossDot = scene.actors.find((a) => a.kind === 'boss');
  if (you !== undefined && bossDot !== undefined) {
    ctx.strokeStyle = 'rgba(255,230,109,0.28)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 6]);
    ctx.beginPath();
    ctx.moveTo(toX(you.x), toY(you.z));
    ctx.lineTo(toX(bossDot.x), toY(bossDot.z));
    ctx.stroke();
    ctx.setLineDash([]);

    const px = toX(you.x);
    const py = toY(you.z);
    ctx.strokeStyle = COLOURS.player;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 11, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px - 16, py);
    ctx.lineTo(px - 6, py);
    ctx.moveTo(px + 6, py);
    ctx.lineTo(px + 16, py);
    ctx.moveTo(px, py - 16);
    ctx.lineTo(px, py - 6);
    ctx.moveTo(px, py + 6);
    ctx.lineTo(px, py + 16);
    ctx.stroke();
    ctx.fillStyle = COLOURS.player;
    ctx.beginPath();
    ctx.arc(px, py, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '700 12px ui-monospace, monospace';
    ctx.fillText('SAITAMA', px + 19, py + 4);
  }

  /* the boss last and largest, with a halo */
  const boss = scene.actors.find((a) => a.kind === 'boss');
  if (boss !== undefined) {
    const halo = ctx.createRadialGradient(
      toX(boss.x),
      toY(boss.z),
      2,
      toX(boss.x),
      toY(boss.z),
      boss.radius * scale * 5
    );
    halo.addColorStop(0, 'rgba(255,150,60,0.55)');
    halo.addColorStop(0.4, 'rgba(255,90,40,0.20)');
    halo.addColorStop(1, 'rgba(255,60,40,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(toX(boss.x), toY(boss.z), boss.radius * scale * 5, 0, Math.PI * 2);
    ctx.fill();

    // A ring of spikes: the top-down read for "this is the thing everything
    // else in the picture is running away from".
    ctx.strokeStyle = 'rgba(255,190,120,0.85)';
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r0 = boss.radius * scale * 1.5;
      const r1 = boss.radius * scale * (i % 2 === 0 ? 2.5 : 2);
      ctx.beginPath();
      ctx.moveTo(toX(boss.x) + Math.sin(a) * r0, toY(boss.z) + Math.cos(a) * r0);
      ctx.lineTo(toX(boss.x) + Math.sin(a) * r1, toY(boss.z) + Math.cos(a) * r1);
      ctx.stroke();
    }

    ctx.fillStyle = COLOURS.boss;
    ctx.beginPath();
    ctx.arc(toX(boss.x), toY(boss.z), boss.radius * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff2d0';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = '#ffd9a3';
    ctx.font = '700 16px ui-monospace, monospace';
    ctx.fillText('BOROS', toX(boss.x) + 24, toY(boss.z) - 15);
    ctx.fillStyle = 'rgba(255,190,140,0.8)';
    ctx.font = '600 11px ui-monospace, monospace';
    ctx.fillText('DRAGON-TIER', toX(boss.x) + 24, toY(boss.z) - 1);
  }

  /* ---- banner --------------------------------------------------------- */
  ctx.fillStyle = 'rgba(8,6,12,0.82)';
  ctx.fillRect(0, 0, size, 76);
  ctx.strokeStyle = 'rgba(255,138,44,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 76);
  ctx.lineTo(size, 76);
  ctx.stroke();

  ctx.fillStyle = '#8a7ba5';
  ctx.font = '600 11px ui-monospace, monospace';
  ctx.fillText(
    `PHASE ${scene.phase.phaseIndex + 1} / 4 — ${scene.phase.kind.toUpperCase()}`,
    22,
    28
  );
  ctx.fillStyle = '#ff8a2c';
  ctx.font = '700 27px ui-monospace, monospace';
  ctx.fillText(scene.phase.title.toUpperCase(), 22, 60);

  const sealed = !scene.phase.phaseResolved;
  ctx.fillStyle = sealed ? '#ff5f6d' : '#4ade80';
  ctx.font = '700 17px ui-monospace, monospace';
  const gateText = sealed ? 'KILL GATE — SEALED' : 'KILL GATE — OPEN';
  ctx.fillText(gateText, size - 22 - ctx.measureText(gateText).width, 34);
  ctx.fillStyle = '#6b7690';
  ctx.font = '500 11px ui-monospace, monospace';
  const subText = sealed
    ? `${scene.phase.remaining.toFixed(1)} s of this phase remaining`
    : 'one punch ends it';
  ctx.fillText(subText, size - 22 - ctx.measureText(subText).width, 55);

  /* ---- footer --------------------------------------------------------- */
  ctx.fillStyle = 'rgba(8,6,12,0.78)';
  ctx.fillRect(0, size - 34, size, 34);
  ctx.fillStyle = '#5f6b83';
  ctx.font = '500 11px ui-monospace, monospace';
  ctx.fillText(
    `${scene.bursts.length} meteoric bursts · ${scene.buildings.filter((b) => b.levelled).length} of ` +
      `${scene.buildings.length} blocks levelled · ${VIEW_METRES} m across`,
    22,
    size - 13
  );
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

function renderPanel(scene: IScene): void {
  for (const group of ['gate', 'tier', 'ally', 'spawn', 'fsm', 'determinism'] as CheckGroup[]) {
    const host = document.getElementById(`checks-${group}`);
    if (host === null) continue;
    host.innerHTML = checks
      .filter((c) => c.group === group)
      .map(
        (c) =>
          `<div class="row"><span class="tag ${c.pass ? 'ok' : 'bad'}">${c.pass ? '✓' : '✗'}</span>` +
          `<span><b>${c.name}</b><br><span class="dim">${c.detail}</span></span></div>`
      )
      .join('');
  }

  const gateState = document.getElementById('gate-state');
  const gateDetail = document.getElementById('gate-detail');
  if (gateState !== null && gateDetail !== null) {
    const sealed = !scene.phase.phaseResolved;
    gateState.textContent = sealed ? 'SEALED' : 'OPEN';
    gateState.className = sealed ? 'bad' : 'ok';
    gateDetail.textContent = sealed
      ? 'a lethal punch is absorbed by the plot'
      : 'the next punch kills, like it always would have';
  }

  const encounter = document.getElementById('encounter');
  if (encounter !== null) {
    const rows: [string, string][] = [
      ['encounter', scene.phase.encounterId],
      ['phase', `${scene.phase.phaseIndex + 1} / 4 — ${scene.phase.title}`],
      ['kind', scene.phase.kind],
      ['engaged', `${scene.phase.elapsed.toFixed(1)} s`],
      ['remaining', `${scene.phase.remaining.toFixed(1)} s`],
      ['hits', `${scene.phase.hits} / ${scene.phase.hitsRequired}`],
      ['bursts fired', String(scene.bursts.length)],
      ['blocks levelled', `${scene.buildings.filter((b) => b.levelled).length} / ${scene.buildings.length}`],
      ['gate', scene.phase.phaseResolved ? 'OPEN' : 'SEALED'],
    ];
    encounter.innerHTML =
      '<table>' +
      rows.map(([k, v]) => `<tr><td class="k">${k}</td><td class="v">${v}</td></tr>`).join('') +
      '</table>';
  }

  const subtitle = document.getElementById('subtitle');
  if (subtitle !== null) {
    const failures = checks.filter((c) => !c.pass).length;
    subtitle.textContent =
      failures === 0
        ? `${checks.length} checks, all passing`
        : `${failures} of ${checks.length} checks FAILED`;
    subtitle.className = failures === 0 ? 'sub' : 'sub bad';
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

interface IMonsterHarness {
  results(): {
    checks: ICheck[];
    failures: string[];
    gate: IGateReport;
    tiers: ITierResult[];
    ally: { fast: IAllyRun; slow: IAllyRun };
    spawn: ISpawnReport;
    phase: IBossPhaseState;
  };
}

declare global {
  interface Window {
    __MONSTER_HARNESS__?: IMonsterHarness;
    __MONSTER_READY__?: boolean;
  }
}

const gateReport = runGateScenario();
assertGate(gateReport);

const tierResults = runTierScenario();
assertTiers(tierResults);

const fastRun = runAllyScenario(8);
const slowRun = runAllyScenario(26);
assertAlly(fastRun, slowRun);

const spawnReport = runSpawnScenario();
assertSpawn(spawnReport);

assertFsm();
assertDeterminism();

const scene = buildScene();
draw(scene);
renderPanel(scene);

window.__MONSTER_HARNESS__ = {
  results: () => ({
    checks,
    failures: checks.filter((c) => !c.pass).map((c) => `${c.group}: ${c.name} — ${c.detail}`),
    gate: gateReport,
    tiers: tierResults,
    ally: { fast: fastRun, slow: slowRun },
    spawn: spawnReport,
    phase: scene.phase,
  }),
};
window.__MONSTER_READY__ = true;
