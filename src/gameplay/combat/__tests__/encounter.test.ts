/**
 * ENCOUNTER SCORING — THE PATHS THE FULL PLAYTHROUGH DOES NOT REACH
 *
 * `system.test.ts` scores one complete fight end to end. This file covers the
 * edges around it: starting from the bus rather than by hand, allies dying,
 * losing, and the accounting that keeps running when no fight is on — because
 * it is entirely possible to bankrupt City Z with no monster in sight, and the
 * game should be able to say so.
 */

import { describe, expect, it } from 'vitest';
import { EncounterTracker } from '../encounter';
import { DEFAULT_COMBAT_TUNING, ZONING_YEN_PER_KG } from '../tuning';
import { createScene, populateStreet, RecordingBus, STREET_HOSTILES } from './fixtures';

const TUNING = DEFAULT_COMBAT_TUNING;

/** Emit one detached chunk, as the destruction system would. */
function chunk(bus: RecordingBus, mass: number, z = 0): void {
  bus.emit('ChunkDetached', {
    structureId: 'block-0',
    chunkIndex: 0,
    position: { x: 0, y: 3, z },
    mass,
    impulse: { x: 0, y: 0, z: 0 },
    material: 'concrete',
    collateralCost: mass * 2,
  });
}

describe('property damage accounting', () => {
  it('prices mass by the district it fell in', () => {
    const bus = new RecordingBus();
    const tracker = new EncounterTracker({
      bus,
      tuning: TUNING,
      districtAt: (position) => (position.z < -50 ? 'wasteland' : 'downtown'),
    });
    tracker.begin({ encounterId: 'e', hostileIds: [], time: 0, boredom: 0.5 });

    chunk(bus, 1000, 0);
    chunk(bus, 1000, -100);

    const result = tracker.end(10, 0.5)!;
    expect(result.debrisMassKg).toBe(2000);
    expect(result.propertyDamageYen).toBe(
      1000 * ZONING_YEN_PER_KG.downtown + 1000 * ZONING_YEN_PER_KG.wasteland
    );
    // Wasteland is nearly free — which is exactly why the tutorial fight
    // should happen there and the boss fight should not.
    expect(ZONING_YEN_PER_KG.downtown / ZONING_YEN_PER_KG.wasteland).toBeGreaterThan(100);
    tracker.dispose();
  });

  it('falls back to the default rate when no zoning lookup is wired in', () => {
    const bus = new RecordingBus();
    const tracker = new EncounterTracker({ bus, tuning: TUNING });
    tracker.begin({ encounterId: 'e', hostileIds: [], time: 0, boredom: 0.5 });
    chunk(bus, 500);
    expect(tracker.end(1, 0.5)!.propertyDamageYen).toBe(500 * TUNING.defaultZoningYenPerKg);
    tracker.dispose();
  });

  it('keeps a running session total even with no fight on', () => {
    const bus = new RecordingBus();
    const tracker = new EncounterTracker({ bus, tuning: TUNING });
    chunk(bus, 250);
    chunk(bus, 250);
    expect(tracker.active).toBe(false);
    expect(tracker.sessionDebrisMassKg).toBe(500);
    expect(tracker.sessionYen).toBe(500 * TUNING.defaultZoningYenPerKg);
    tracker.dispose();
  });

  it('keeps the destruction system own collateral estimate as a cross-check', () => {
    const bus = new RecordingBus();
    const tracker = new EncounterTracker({ bus, tuning: TUNING });
    tracker.begin({ encounterId: 'e', hostileIds: [], time: 0, boredom: 0.5 });
    chunk(bus, 100);
    const result = tracker.end(1, 0.5)!;
    expect(result.collateralCost).toBe(200);
    expect(result.propertyDamageYen).not.toBe(result.collateralCost);
    tracker.dispose();
  });
});

describe('participants', () => {
  it('starts scoring from EncounterStarted, sorting hostiles from allies', () => {
    const scene = createScene({ seed: 'auto-begin' });
    populateStreet(scene);
    scene.bus.emit('EncounterStarted', {
      encounterId: 'auto',
      threatTier: 'dragon',
      position: { x: 0, y: 0, z: -20 },
      radius: 60,
      participantIds: ['monster-01', 'boss-01', 'mumen-rider', 'civ-0', 'nonexistent'],
      isBoss: true,
    });
    expect(scene.combat.encounters.active).toBe(true);
    expect(scene.combat.encounters.encounterId).toBe('auto');
    expect(scene.combat.encounters.cleared).toBe(false);

    // Only the two monsters gate the victory; the ally is scored, the
    // civilian is neither, and the unknown id is ignored rather than fatal.
    scene.combat.targets.get('boss-01')!.phaseResolved = true;
    scene.attacker.moveTo(0, 1.4, 0);
    scene.attacker.faceTowards(0, 2, -30);
    scene.combat.seriousPunch(1);
    expect(scene.combat.encounters.cleared).toBe(true);

    const result = scene.combat.endEncounter()!;
    expect(result.kills).toBe(2);
    expect(result.alliesSaved).toBe(1);
    scene.combat.dispose();
  });

  it('counts an ally who went down, and only a registered one', () => {
    const bus = new RecordingBus();
    const tracker = new EncounterTracker({ bus, tuning: TUNING });
    tracker.begin({
      encounterId: 'e',
      hostileIds: ['m'],
      allyIds: ['mumen-rider', 'genos'],
      time: 0,
      boredom: 0.5,
    });
    bus.emit('AllyDowned', {
      entityId: 'mumen-rider',
      displayName: 'Mumen Rider',
      position: { x: 0, y: 0, z: 0 },
    });
    bus.emit('AllyDowned', {
      entityId: 'some-other-hero',
      displayName: 'Not In This Fight',
      position: { x: 0, y: 0, z: 0 },
    });
    const result = tracker.end(5, 0.5, 'defeat')!;
    expect(result.alliesDowned).toBe(1);
    expect(result.alliesSaved).toBe(1);
    expect(result.victory).toBe(false);
    expect(bus.ofType('EncounterEnded')[0]!.outcome).toBe('defeat');
    tracker.dispose();
  });

  it('measures timeToKill to the LAST kill, not to the walk home', () => {
    const bus = new RecordingBus();
    const tracker = new EncounterTracker({ bus, tuning: TUNING });
    tracker.begin({ encounterId: 'e', hostileIds: ['a', 'b'], time: 10, boredom: 0.5 });

    tracker.tick(12.5);
    bus.emit('EntityKilled', {
      entityId: 'a',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 0, y: 0, z: 0 },
      intent: 'normal',
      rewardPoints: 1,
    });
    tracker.tick(17.25);
    bus.emit('EntityKilled', {
      entityId: 'b',
      entityType: 'monster',
      faction: 'monster',
      position: { x: 0, y: 0, z: 0 },
      intent: 'normal',
      rewardPoints: 1,
    });
    tracker.tick(60);

    const result = tracker.end(60, 0.5)!;
    expect(result.timeToKill).toBeCloseTo(7.25, 6);
    expect(result.victory).toBe(true);
    expect(bus.ofType('EncounterEnded')[0]!.duration).toBeCloseTo(50, 6);
    tracker.dispose();
  });

  it('a fight that dragged on earns the challenge bonus', () => {
    const scene = createScene({ seed: 'challenge', boredom: 0.6 });
    populateStreet(scene);
    scene.combat.beginEncounter({ encounterId: 'slow', hostileIds: ['monster-01'], time: 0 });
    scene.combat.encounters.tick(TUNING.challengeSeconds + 5);
    scene.attacker.moveTo(0, 1.4, -6.6);
    scene.attacker.faceTowards(0, 1, -8);
    scene.combat.normalPunch();

    const result = scene.combat.endEncounter()!;
    expect(result.timeToKill).toBeGreaterThanOrEqual(TUNING.challengeSeconds);
    const reasons = scene.bus.ofType('BoredomChanged').map((e) => e.reason);
    expect(reasons).toContain('challengingFight');
    scene.combat.dispose();
  });

  it('closes the live fight before starting a second one, rather than dropping it', () => {
    // Combat is the ONLY production emitter of `EncounterEnded`. Discarding a
    // second `EncounterStarted` — or overwriting the tally with it — leaves an
    // encounter id that can never be closed: progression files an incident on
    // `EncounterStarted` and only ever deletes it on `EncounterEnded`, and the
    // HUD opens a banner that never comes down.
    const scene = createScene({ seed: 'reentrant' });
    populateStreet(scene);
    scene.combat.beginEncounter({
      encounterId: 'first',
      hostileIds: [...STREET_HOSTILES],
      time: 0,
    });
    scene.bus.emit('EncounterStarted', {
      encounterId: 'second',
      threatTier: 'wolf',
      position: { x: 0, y: 0, z: 0 },
      radius: 10,
      participantIds: ['monster-01'],
      isBoss: false,
    });
    expect(scene.combat.encounters.encounterId).toBe('second');

    const ended = scene.bus.ofType('EncounterEnded');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.encounterId).toBe('first');
    expect(ended[0]!.outcome).toBe('aborted');
    scene.combat.dispose();
  });

  it('closes a fight still running when the system is torn down', () => {
    const scene = createScene({ seed: 'dispose-open' });
    populateStreet(scene);
    scene.combat.beginEncounter({
      encounterId: 'interrupted',
      hostileIds: ['monster-01'],
      time: 0,
    });
    scene.combat.dispose();

    const ended = scene.bus.ofType('EncounterEnded');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.encounterId).toBe('interrupted');
    // Tearing down mid-fight is an abort, not a win — but it is still a close.
    expect(ended[0]!.outcome).toBe('aborted');
  });

  it('ending with no fight on is a no-op, not a crash', () => {
    const scene = createScene({ seed: 'no-fight' });
    expect(scene.combat.endEncounter()).toBeUndefined();
    expect(scene.bus.ofType('EncounterEnded')).toHaveLength(0);
    scene.combat.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* What the scorecard fields actually count                                   */
/* -------------------------------------------------------------------------- */

describe('the counters mean what their docs say', () => {
  it('counts a ground slam as a serious punch', () => {
    // `recordPunch` files everything that is not `'normal'` under
    // `seriousPunches`. That is the honest reading — a slam is the same
    // collateral decision — but the field's name invites the other one.
    const scene = createScene({ seed: 'slam-counts' });
    populateStreet(scene);
    scene.combat.beginEncounter({ encounterId: 'slam', hostileIds: ['monster-01'], time: 0 });
    scene.bus.emit('PlayerLanded', {
      position: { x: 0, y: 0, z: -8 },
      impactSpeed: 60,
      fallHeight: 40,
      createsCrater: true,
      intent: 'serious',
    });

    const result = scene.combat.endEncounter()!;
    expect(result.seriousPunches).toBe(1);
    expect(result.normalPunches).toBe(0);
    scene.combat.dispose();
  });

  it('counts a self-rescue as a civilian saved', () => {
    // `civiliansSaved` is a plain event counter, NOT "civilians still alive at
    // the end", and it does not filter on `byPlayer` — deliberately, because
    // the HUD banner counts the same event unfiltered and the two scoreboards
    // have to agree.
    const bus = new RecordingBus();
    const tracker = new EncounterTracker({ bus, tuning: TUNING });
    tracker.begin({ encounterId: 'e', hostileIds: [], time: 0, boredom: 0.5 });
    bus.emit('CivilianSaved', {
      entityId: 'ran-for-it',
      position: { x: 0, y: 0, z: 0 },
      byPlayer: false,
      reputationDelta: 0,
    });

    expect(tracker.end(1, 0.5)!.civiliansSaved).toBe(1);
    tracker.dispose();
  });

  it('witnessed counts PUNCHES that killed, not victims', () => {
    const scene = createScene({ seed: 'witnessed' });
    populateStreet(scene);
    scene.combat.beginEncounter({ encounterId: 'seen', hostileIds: ['monster-01'], time: 0 });

    // Arm's length from the monster, with most of the crowd well inside the
    // 60 m witness radius.
    scene.attacker.moveTo(0, 1.4, -6.6);
    scene.attacker.faceTowards(0, 1, -8);
    scene.combat.normalPunch();
    expect(scene.combat.lastPunch!.kills).toBe(1);

    // A second punch into empty air, still with witnesses in range. Nothing
    // dies, so the count must not move: it counts KILLING punches.
    scene.attacker.moveTo(0, 1.4, 20);
    scene.attacker.faceTowards(0, 1.4, 100);
    scene.combat.normalPunch();
    expect(scene.combat.lastPunch!.kills).toBe(0);

    const result = scene.combat.endEncounter()!;
    expect(result.witnessed).toBe(1);
    expect(result.normalPunches).toBe(2);
    expect(result.kills).toBe(1);
    scene.combat.dispose();
  });
});
