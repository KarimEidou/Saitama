/**
 * A FULL ENCOUNTER, DRIVEN THROUGH THE SYNTHETIC INPUT API
 *
 * This is the test that proves the three verbs are actually wired to a thumb
 * rather than to a method call. It drives `createInputManager`'s synthetic
 * backend — the input workstream's documented entry point — polls it once per
 * frame exactly as the game loop does, and asserts on the events that come out
 * the other end and on the scorecard they add up to.
 *
 * ── THE SCRIPT ─────────────────────────────────────────────────────────────
 *   0.00 s  the fight starts: one demon-tier monster, one dragon-tier boss
 *           whose phase has NOT resolved, six civilians, Mumen Rider, and
 *           three blocks of downtown frontage.
 *   0.50 s  TAP with the monster at arm's length -> it is deleted.
 *   0.68 s  the boss's scripted phase resolves.
 *   0.75 s  HOLD for 1.25 s, then release -> a fully charged Serious Punch.
 *           The boss dies. So do five civilians and most of the street.
 *   +2.5 s  the collapse finishes falling and the books close.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────
 * The same script is run twice under the same seed and the two event
 * transcripts are compared byte for byte, with `Math.random` replaced by a
 * function that throws for the duration — so an accidental unseeded draw is a
 * hard failure rather than a flake somebody chases in six months.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createInputManager, type IInputManager } from '@/ui/input';
import type { GameEventType } from '@/types';
import { CombatSystem } from '../combat-system';
import { DEFAULT_COMBAT_TUNING } from '../tuning';
import type { IEncounterResult, IPunchOutcome } from '../types';
import { createScene, populateStreet, RecordingBus, STREET_HOSTILES } from './fixtures';

const TUNING = DEFAULT_COMBAT_TUNING;
const DT = 1 / 60;

/* -------------------------------------------------------------------------- */
/* A stand-in for the destruction workstream                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the destruction system does when it hears `ShockwaveFired`, in the
 * smallest form that exercises combat's side of the contract: sweep the
 * structures the cone reached and release their chunks OVER SEVERAL FRAMES,
 * because a real collapse is staggered to stay inside the debris budget.
 *
 * Combat never calls this and never imports it. It only hears `ChunkDetached`.
 */
class FakeDestruction {
  private pending: { structureId: string; mass: number; z: number }[] = [];

  constructor(
    private readonly bus: RecordingBus,
    private readonly combat: CombatSystem
  ) {
    this.bus.on('ShockwaveFired', (event) => {
      if (event.punchKind !== 'serious' && event.punchKind !== 'slam') return;
      const swept =
        event.angle >= Math.PI - 1e-6
          ? this.combat.structures.sweepRadius(event.origin, event.range)
          : this.combat.structures.sweepCone(
              event.origin,
              event.direction,
              event.range,
              event.angle
            );
      for (const structure of swept) {
        // 60 chunks per block, a fifth of the intact mass actually comes down.
        for (let i = 0; i < 60; i++) {
          this.pending.push({
            structureId: structure.id,
            mass: (structure.massKg * 0.2) / 60,
            z: (structure.bounds.minZ + structure.bounds.maxZ) * 0.5,
          });
        }
      }
    });
  }

  /** Release up to eight pieces. Called once per frame. */
  step(): void {
    for (let i = 0; i < 8 && this.pending.length > 0; i++) {
      const piece = this.pending.shift()!;
      this.bus.emit('ChunkDetached', {
        structureId: piece.structureId,
        chunkIndex: i,
        position: { x: 0, y: 6, z: piece.z },
        mass: piece.mass,
        impulse: { x: 0, y: 0, z: 0 },
        material: 'concrete',
        collateralCost: piece.mass * 3,
      });
    }
  }

  get settled(): boolean {
    return this.pending.length === 0;
  }
}

/* -------------------------------------------------------------------------- */
/* The scripted run                                                           */
/* -------------------------------------------------------------------------- */

interface IRunResult {
  readonly bus: RecordingBus;
  readonly combat: CombatSystem;
  readonly result: IEncounterResult | undefined;
  readonly outcomes: IPunchOutcome[];
  readonly transcript: string;
}

const managers: IInputManager[] = [];

function runEncounter(seed: string): IRunResult {
  // The whole street is downtown. Injected, because zoning lives in
  // `src/world` and combat may not import it.
  const scene = createScene({ seed, boredom: 0.5, districtAt: () => 'downtown' });
  populateStreet(scene);
  const { bus, combat, attacker } = scene;
  const destruction = new FakeDestruction(bus, combat);

  const input = createInputManager({ headless: true, exposeTestBridge: false });
  managers.push(input);
  input.syntheticEnabled = true;

  const outcomes: IPunchOutcome[] = [];
  const originalResolve = combat.resolver.resolve.bind(combat.resolver);
  combat.resolver.resolve = (punch) => {
    const outcome = originalResolve(punch);
    outcomes.push(outcome);
    return outcome;
  };

  combat.beginEncounter({
    encounterId: 'street-fight',
    hostileIds: [...STREET_HOSTILES],
    allyIds: ['mumen-rider'],
    time: 0,
  });

  // Close to arm's length of the monster at z = -8 (radius 1.1 m).
  attacker.moveTo(0, 1.4, -6.5);
  attacker.faceTowards(0, 1, -8);

  const TAP_FRAME = 30;
  const PHASE_FRAME = 41;
  const HOLD_FROM = 45;
  const HOLD_TO = 120; // 75 frames = 1.25 s, past the 1.2 s full charge
  const TOTAL = 420; // long enough for the 2.5 s settle window to elapse

  // The whole script, declared up front. `queue` consumes one step per poll,
  // which is exactly the granularity the game loop runs at.
  input.synthetic.queue([
    { frames: TAP_FRAME, label: 'approach' },
    { frames: 1, taps: ['punch'], label: 'tap: normal punch' },
    { frames: HOLD_FROM - TAP_FRAME - 1, label: 'wait' },
    { frames: HOLD_TO - HOLD_FROM, patch: { buttons: { punch: true } }, label: 'hold: charge' },
    { frames: 1, patch: { buttons: { punch: false } }, label: 'release: serious punch' },
    { frames: TOTAL - HOLD_TO, label: 'settle' },
  ]);

  for (let frame = 0; frame <= TOTAL; frame++) {
    const time = frame * DT;
    bus.setFrame(frame, time);

    if (frame === PHASE_FRAME) {
      // The narrative gate opens. Nothing about the boss's health changed.
      bus.emit('BossPhaseChanged', {
        entityId: 'boss-01',
        specId: 'deep-sea-king',
        previousPhase: 0,
        phase: 2,
        healthFraction: 1,
        isFinalPhase: true,
      });
    }
    if (frame === HOLD_FROM) attacker.faceTowards(0, 2, -30);

    const state = input.poll(frame, time);
    combat.update(state, DT, time);
    destruction.step();
  }

  return {
    bus,
    combat,
    result: combat.lastResult,
    outcomes,
    transcript: bus.transcript(),
  };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

/* -------------------------------------------------------------------------- */
/* The encounter                                                              */
/* -------------------------------------------------------------------------- */

describe('a full encounter through the synthetic input API', () => {
  const run = runEncounter('street-fight-seed');

  it('drove the game from InputState, not from method calls', () => {
    expect(run.outcomes.length).toBeGreaterThan(0);
    expect(run.bus.ofType('ShockwaveFired').length).toBe(run.outcomes.length);
  });

  it('emits the expected punch sequence', () => {
    const punches = run.bus.ofType('ShockwaveFired').map((e) => ({
      kind: e.punchKind,
      intent: e.intent,
      range: e.range,
    }));
    expect(punches).toEqual([
      // The tap that deletes the monster.
      { kind: 'normal', intent: 'normal', range: TUNING.normalReachMetres },
      // Beginning the charge ALSO throws a jab, because the input contract
      // fires `punch.pressed` on the press edge — and because that press is
      // only 0.25 s after the tap, it counts as the second link of a chain.
      // At 23 m from the boss it whiffs harmlessly. See the note on
      // `normalPunchOnPress` in tuning.ts; this is a live design question,
      // not an accident.
      { kind: 'consecutive', intent: 'normal', range: TUNING.normalReachMetres },
      // The release: a fully charged 180 m cone at full intent.
      { kind: 'serious', intent: 'full', range: TUNING.seriousRangeMaxMetres },
    ]);
  });

  it('kills the monster with the tap, in one, with no collateral', () => {
    const tap = run.outcomes[0]!;
    expect(tap.hits).toHaveLength(1);
    expect(tap.hits[0]!.targetId).toBe('monster-01');
    expect(tap.hits[0]!.instantKill).toBe(true);
    expect(tap.civiliansKilled).toBe(0);
    expect(tap.destructiblesHit).toEqual([]);
    expect(tap.collateralCost).toBe(0);
  });

  it('does not kill the boss until its phase has resolved', () => {
    const killOrder = run.bus.ofType('EntityKilled').map((e) => e.entityId);
    const phaseIndex = run.bus.events.findIndex((e) => e.type === 'BossPhaseChanged');
    const bossKillIndex = run.bus.events.findIndex(
      (e) => e.type === 'EntityKilled' && e.entityId === 'boss-01'
    );
    expect(phaseIndex).toBeGreaterThan(-1);
    expect(bossKillIndex).toBeGreaterThan(phaseIndex);
    expect(killOrder[0]).toBe('monster-01');
    expect(killOrder).toContain('boss-01');
  });

  it('the serious punch takes the boss, five civilians and three blocks', () => {
    const serious = run.outcomes[2]!;
    expect(serious.punch.charge).toBe(1);
    expect(serious.punch.intent).toBe('full');
    expect(serious.hits.some((h) => h.targetId === 'boss-01')).toBe(true);
    expect(serious.civiliansKilled).toBe(5);
    expect(serious.destructiblesHit.map((d) => d.id)).toEqual([
      'block-0',
      'block-1',
      'block-2',
    ]);
    // Mumen Rider is behind the shoulder, and behind is safe.
    expect(serious.hits.some((h) => h.targetId === 'mumen-rider')).toBe(false);
  });

  it('emits the events downstream systems key off, in the documented order', () => {
    // Around the serious punch: the wave first, then victim by victim,
    // nearest first, the death then the faction consequence then the impulse.
    const events = run.bus.events;
    const start = events.findIndex((e) => e.type === 'ShockwaveFired' && e.punchKind === 'serious');
    const window: GameEventType[] = [];
    for (let i = start; i < events.length; i++) {
      const type = events[i]!.type;
      if (type === 'ChunkDetached' || type === 'BoredomChanged') continue;
      if (i > start && type === 'ShockwaveFired') break;
      window.push(type);
    }
    expect(window[0]).toBe('ShockwaveFired');
    // Nearest first, which is the civilian at 6.6 m — NOT the boss at 21 m.
    // Death, then the faction consequence, then the impulse.
    expect(window.slice(1, 4)).toEqual(['EntityKilled', 'CivilianLost', 'ImpulseApplied']);
    expect(window.filter((t) => t === 'EntityKilled')).toHaveLength(6);
    expect(window.filter((t) => t === 'CivilianLost')).toHaveLength(5);
    expect(window.filter((t) => t === 'ImpulseApplied')).toHaveLength(6);
    expect(window.filter((t) => t === 'AllyDowned')).toHaveLength(0);
  });

  it('closes the books only AFTER the staggered collapse has finished falling', () => {
    const lastChunk = run.bus.events.map((e) => e.type).lastIndexOf('ChunkDetached');
    const ended = run.bus.events.map((e) => e.type).indexOf('EncounterEnded');
    expect(lastChunk).toBeGreaterThan(-1);
    expect(ended).toBeGreaterThan(lastChunk);
  });

  it('produces a correct EncounterResult', () => {
    const result = run.result;
    expect(result).toBeDefined();
    if (result === undefined) return;

    expect(result.encounterId).toBe('street-fight');
    expect(result.victory).toBe(true);
    expect(result.kills).toBe(2);

    // The tap landed at frame 30 and the serious punch at frame 120.
    expect(result.timeToKill).toBeGreaterThan(1.9);
    expect(result.timeToKill).toBeLessThan(2.1);

    expect(result.civiliansLost).toBe(5);
    expect(result.civiliansSaved).toBe(0);
    expect(result.alliesSaved).toBe(1);
    expect(result.alliesDowned).toBe(0);

    // Three downtown blocks: 900 t each, a fifth of it comes down, at 5200
    // yen per kilogram.
    const expectedMass = 3 * 900_000 * 0.2;
    expect(result.debrisMassKg).toBeCloseTo(expectedMass, 3);
    expect(result.propertyDamageYen).toBeCloseTo(expectedMass * 5200, 0);
    expect(result.propertyDamageYen).toBeGreaterThan(2.8e9);

    expect(result.normalPunches).toBe(2);
    expect(result.seriousPunches).toBe(1);
    // Two, not one: the press that began the charge landed inside the chain
    // window opened by the tap, so it counted as a second link.
    expect(result.longestChain).toBe(2);
    // Both killing blows were seen by a living civilian.
    expect(result.witnessed).toBe(2);

    // Two instant kills, no heroism, and nothing that could earn a bonus.
    expect(result.boredomAfter).toBeGreaterThan(result.boredomBefore);
  });

  it('emits EncounterEnded carrying the invoice', () => {
    const ended = run.bus.ofType('EncounterEnded');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.outcome).toBe('victory');
    expect(ended[0]!.civiliansLost).toBe(5);
    expect(ended[0]!.collateralCost).toBeCloseTo(run.result!.propertyDamageYen, 0);
  });

  it('never awards a restraint bonus for a fight that cost three city blocks', () => {
    const reasons = run.bus.ofType('BoredomChanged').map((e) => e.reason);
    expect(reasons).toContain('trivialVictory');
    expect(reasons).not.toContain('restraintBonus');
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                */
/* -------------------------------------------------------------------------- */

describe('determinism', () => {
  it('same seed + same input script = byte-identical events', () => {
    const original = Math.random;
    Math.random = (): number => {
      throw new Error('Math.random() is banned in combat — use @/util createRng');
    };
    try {
      const a = runEncounter('deterministic');
      const b = runEncounter('deterministic');
      expect(a.transcript).toBe(b.transcript);
      expect(JSON.stringify(a.outcomes)).toBe(JSON.stringify(b.outcomes));
      expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
    } finally {
      Math.random = original;
    }
  });

  it('the seed genuinely reaches the resolver', () => {
    // Proof the determinism test is not vacuous: a different seed must change
    // the seeded draws (hit sockets), while leaving the outcome identical —
    // randomness in this system decorates, it never decides.
    const a = runEncounter('seed-alpha');
    const b = runEncounter('seed-beta');
    const bonesA = a.outcomes.flatMap((o) => o.hits.map((h) => h.bone));
    const bonesB = b.outcomes.flatMap((o) => o.hits.map((h) => h.bone));
    expect(bonesA.length).toBeGreaterThan(4);
    expect(bonesA).not.toEqual(bonesB);
    expect(a.result!.kills).toBe(b.result!.kills);
    expect(a.result!.civiliansLost).toBe(b.result!.civiliansLost);
    expect(a.result!.propertyDamageYen).toBe(b.result!.propertyDamageYen);
  });

  it('resolution is independent of registration order', () => {
    const forward = createScene({ seed: 'order' });
    const reverse = createScene({ seed: 'order' });
    const specs = [
      { id: 'c', z: -20 },
      { id: 'a', z: -6 },
      { id: 'b', z: -13 },
    ];
    for (const spec of specs) {
      forward.combat.addTarget({
        id: spec.id,
        type: 'monster',
        faction: 'monster',
        position: { x: 0, y: 1, z: spec.z },
      });
    }
    for (const spec of [...specs].reverse()) {
      reverse.combat.addTarget({
        id: spec.id,
        type: 'monster',
        faction: 'monster',
        position: { x: 0, y: 1, z: spec.z },
      });
    }
    forward.combat.seriousPunch(0);
    reverse.combat.seriousPunch(0);
    expect(forward.bus.transcript()).toBe(reverse.bus.transcript());
    forward.combat.dispose();
    reverse.combat.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The chain                                                                  */
/* -------------------------------------------------------------------------- */

describe('consecutive normal punches', () => {
  it('escalates power monotonically, which is what the audio ramp needs', () => {
    const scene = createScene({ seed: 'chain' });
    const input = createInputManager({ headless: true, exposeTestBridge: false });
    managers.push(input);
    input.syntheticEnabled = true;

    // A tap every four frames — 67 ms apart, inside the 0.42 s chain window.
    const TAPS = 14;
    const GAP = 3;
    const steps = [];
    for (let i = 0; i < TAPS; i++) {
      steps.push({ frames: 1, taps: ['punch' as const] });
      steps.push({ frames: GAP });
    }
    input.synthetic.queue(steps);

    // One step is consumed per POLL and a step lasts `frames` polls, so the
    // script runs for taps * (1 + gap) frames, not `steps.length`.
    const frames = TAPS * (1 + GAP);
    for (let frame = 0; frame < frames; frame++) {
      const time = frame * DT;
      scene.bus.setFrame(frame, time);
      scene.combat.update(input.poll(frame, time), DT, time);
    }

    const powers = scene.bus.ofType('ShockwaveFired').map((e) => e.power);
    expect(powers).toHaveLength(14);
    for (let i = 1; i < powers.length; i++) {
      expect(powers[i]!).toBeGreaterThan(powers[i - 1]!);
    }

    const kinds = scene.bus.ofType('ShockwaveFired').map((e) => e.punchKind);
    expect(kinds[0]).toBe('normal');
    expect(kinds[1]).toBe('consecutive');
    expect(kinds[13]).toBe('consecutive');

    // The audio system escalates `punch.consecutive` to `punch.barrage` above
    // a log-normalised power of 0.7, i.e. above 10^4.2. The chain must
    // actually get there, or the barrage voice is dead code.
    const normalised = powers.map((p) => Math.log10(p) / 6);
    expect(normalised[0]!).toBeLessThan(0.7);
    expect(normalised[normalised.length - 1]!).toBeGreaterThan(0.7);
    for (let i = 1; i < normalised.length; i++) {
      expect(normalised[i]!).toBeGreaterThan(normalised[i - 1]!);
    }
    scene.combat.dispose();
  });

  it('lapses when the taps stop, and starts again from one', () => {
    const scene = createScene({ seed: 'chain-lapse' });
    scene.combat.normalPunch();
    scene.combat.normalPunch();
    expect(scene.combat.chain.state(0).length).toBe(2);

    // Advance past the window without punching.
    scene.combat.chain.update(TUNING.chainWindowSeconds + 0.1);
    expect(scene.combat.chain.state(TUNING.chainWindowSeconds + 0.1).length).toBe(0);
    scene.combat.dispose();
  });

  it('a serious punch resets the chain rather than inheriting its multiplier', () => {
    const scene = createScene({ seed: 'chain-reset' });
    for (let i = 0; i < 5; i++) scene.combat.normalPunch();
    scene.combat.seriousPunch(0.5);
    expect(scene.combat.chain.state(0).length).toBe(0);
    scene.combat.dispose();
  });

  it('accumulates camera trauma along the chain', () => {
    const scene = createScene({ seed: 'chain-shake' });
    const shakes: number[] = [];
    for (let i = 0; i < 6; i++) shakes.push(scene.combat.normalPunch().cameraShake);
    for (let i = 1; i < shakes.length; i++) {
      expect(shakes[i]!).toBeGreaterThan(shakes[i - 1]!);
    }
    scene.combat.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The ground slam                                                            */
/* -------------------------------------------------------------------------- */

describe('the ground slam', () => {
  it('fires off PlayerLanded, but only when it craters', () => {
    const scene = createScene({ seed: 'slam' });
    populateStreet(scene);

    scene.bus.emit('PlayerLanded', {
      position: { x: 0, y: 0, z: -8 },
      impactSpeed: 8,
      fallHeight: 3,
      createsCrater: false,
      intent: 'normal',
    });
    expect(scene.bus.ofType('ShockwaveFired')).toHaveLength(0);

    scene.bus.emit('PlayerLanded', {
      position: { x: 0, y: 0, z: -8 },
      impactSpeed: 34,
      fallHeight: 28,
      createsCrater: true,
      intent: 'serious',
    });
    const waves = scene.bus.ofType('ShockwaveFired');
    expect(waves).toHaveLength(1);
    expect(waves[0]!.punchKind).toBe('slam');
    expect(waves[0]!.angle).toBeCloseTo(Math.PI, 9);
    scene.combat.dispose();
  });

  it('kills inside a small crater and only shoves out to the pressure radius', () => {
    const scene = createScene({ seed: 'slam-radius' });
    populateStreet(scene);
    scene.bus.emit('PlayerLanded', {
      position: { x: 0, y: 0, z: -8 },
      impactSpeed: 34,
      fallHeight: 28,
      createsCrater: true,
      intent: 'serious',
    });

    const killRadius = Math.min(
      TUNING.slamKillRadiusMaxMetres,
      TUNING.slamKillRadiusBaseMetres + 28 * TUNING.slamKillRadiusPerFallMetre
    );
    const wave = scene.bus.ofType('ShockwaveFired')[0]!;
    expect(wave.range).toBeCloseTo(killRadius * TUNING.slamPressureRadiusFactor, 6);

    // Everything killed must be inside the LETHAL radius, not the wave's.
    for (const killed of scene.bus.ofType('EntityKilled')) {
      const dx = killed.position.x - 0;
      const dz = killed.position.z - -8;
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(killRadius + 1.5);
    }
    expect(scene.bus.ofType('EntityKilled').length).toBeGreaterThan(0);
    expect(wave.range).toBeGreaterThan(killRadius);
    scene.combat.dispose();
  });

  it('a hard landing on a crowd is a mass-casualty event, and says so', () => {
    const scene = createScene({ seed: 'slam-crowd' });
    for (let i = 0; i < 12; i++) {
      scene.combat.addTarget({
        id: `civ-${i}`,
        type: 'npc',
        faction: 'civilian',
        position: { x: Math.cos(i) * 5, y: 1, z: Math.sin(i) * 5 },
      });
    }
    scene.bus.emit('PlayerLanded', {
      position: { x: 0, y: 0, z: 0 },
      impactSpeed: 40,
      fallHeight: 40,
      createsCrater: true,
      intent: 'serious',
    });
    expect(scene.bus.ofType('CivilianLost')).toHaveLength(12);
    scene.combat.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The charge forecast                                                        */
/* -------------------------------------------------------------------------- */

describe('the charge forecast', () => {
  it('prices the punch BEFORE it is thrown, and the price rises with charge', () => {
    const scene = createScene({ seed: 'forecast' });
    populateStreet(scene);
    scene.attacker.moveTo(0, 1.4, 0);
    scene.attacker.faceTowards(0, 12, -60);

    const low = scene.combat.chargeForecast(0);
    const high = scene.combat.chargeForecast(1);
    expect(low.rangeMetres).toBe(TUNING.seriousRangeMinMetres);
    expect(high.rangeMetres).toBe(TUNING.seriousRangeMaxMetres);
    expect(high.structures).toBeGreaterThan(low.structures);
    expect(high.yen).toBeGreaterThan(low.yen);
    expect(low.yen).toBeGreaterThan(0);
    scene.combat.dispose();
  });

  it('reports zero when nothing is in the way — pointing at the sky is free', () => {
    const scene = createScene({ seed: 'forecast-sky' });
    populateStreet(scene);
    scene.attacker.moveTo(0, 1.4, 0);
    scene.attacker.faceTowards(0, 400, 0);
    expect(scene.combat.chargeForecast(1).yen).toBe(0);
    scene.combat.dispose();
  });

  it('surfaces the live charge on the diagnostics the HUD reads', () => {
    const scene = createScene({ seed: 'diagnostics' });
    const input = createInputManager({ headless: true, exposeTestBridge: false });
    managers.push(input);
    input.syntheticEnabled = true;
    input.synthetic.press('punch');

    for (let frame = 0; frame < 40; frame++) {
      const time = frame * DT;
      scene.combat.update(input.poll(frame, time), DT, time);
    }
    const diagnostics = scene.combat.diagnostics();
    expect(diagnostics.charging).toBe(true);
    expect(diagnostics.charge).toBeGreaterThan(0.4);
    expect(diagnostics.charge).toBeLessThan(0.7);
    expect(diagnostics.chargeRangeMetres).toBeGreaterThan(TUNING.seriousRangeMinMetres);
    scene.combat.dispose();
  });
});
