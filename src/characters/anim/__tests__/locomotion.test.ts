/**
 * FOOT PLANTING AND THE GAIT MODEL
 *
 * The headline assertion of this workstream, and the one that has to be a
 * measurement rather than a judgement: a planted foot's LOADED contact point
 * must not move.
 *
 * The threshold is 0.5 mm per stance — roughly one hundredth of a foot's
 * width. That is far below anything a viewer could see, which is the point:
 * the design pins feet in world space, so the residual is geometric rounding
 * rather than a tuned compromise, and a threshold that only just passes would
 * mean the mechanism had quietly stopped working.
 *
 * The control case (`measureNaiveFootSlide`) is measured the same way and
 * lands around 100 mm. The two numbers together are the actual claim.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  gaitProfile,
  measureFootSlide,
  measureLimbSanity,
  measureNaiveFootSlide,
} from '../analysis';
import { LocomotionSolver, solveGait } from '../locomotion';
import { copyPose, createPose, poseToModelMatrices } from '../pose';
import type { AnimRig, LocomotionInput, LocomotionReport } from '../types';
import { civilianFixture, heroFixture, scaledSpeed, showcaseFixtures } from './support';

/** Drive a solver for `steps` frames and hand back the last report. */
function run(
  rig: AnimRig,
  steps: number,
  input: LocomotionInput,
  solver = new LocomotionSolver(rig),
  dt = 1 / 120
): { solver: LocomotionSolver; report: LocomotionReport } {
  const pose = createPose(rig.boneCount);
  let report!: LocomotionReport;
  for (let i = 0; i < steps; i++) {
    copyPose(pose, rig.rest);
    report = solver.update(dt, input, pose);
  }
  return { solver, report };
}

/** Metres. A tenth of a millimetre is invisible; this is five times that. */
const SLIDE_LIMIT = 0.0005;

describe('planted feet', () => {
  const saitama = heroFixture('saitama');

  for (const speed of [0.8, 1.4, 2.2, 3.5, 6.0, 9.0]) {
    it(`does not slide at ${speed} m/s`, () => {
      const report = measureFootSlide(saitama.rig, { speed, seconds: 8 });
      expect(report.stances.length).toBeGreaterThan(6);
      expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
      expect(report.maxFlatDrift).toBeLessThan(SLIDE_LIMIT);
      // The ankle DOES travel: the foot rolls from heel to ball. Asserting it
      // is non-zero keeps the test honest — a frozen foot would pass the
      // slide check trivially and look like a mannequin on a conveyor belt.
      expect(report.maxAnkleDrift).toBeGreaterThan(0.01);
    });
  }

  it('does not slide while accelerating through every gait', () => {
    // The case a clip-based system cannot win: stride length must change
    // mid-stance, and a foot animated backwards at "the current speed" skates
    // the instant that speed moves.
    const report = measureFootSlide(saitama.rig, {
      speedAt: (t) => 0.6 + (t / 12) * 6.4,
      seconds: 12,
      warmup: 1.5,
    });
    expect(report.stances.length).toBeGreaterThan(20);
    expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
  });

  it('does not slide while turning', () => {
    const report = measureFootSlide(saitama.rig, { speed: 1.4, turnRate: 1.05, seconds: 8 });
    expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
  });

  it('does not slide while decelerating to a stop', () => {
    const report = measureFootSlide(saitama.rig, {
      speedAt: (t) => Math.max(0, 4 - t * 0.5),
      seconds: 9,
      warmup: 1,
    });
    expect(report.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
  });

  it('beats a naive sinusoidal walk by more than two orders of magnitude', () => {
    const solved = measureFootSlide(saitama.rig, { speed: 1.4, seconds: 8 });
    const naive = measureNaiveFootSlide(saitama.rig, 1.4, 8);
    expect(naive.maxContactDrift).toBeGreaterThan(0.03);
    expect(solved.maxContactDrift * 100).toBeLessThan(naive.maxContactDrift);
  });

  it('keeps feet planted for every body in the showcase', () => {
    for (const fixture of showcaseFixtures()) {
      const report = measureFootSlide(fixture.rig, {
        speed: scaledSpeed(fixture.rig, 0.47),
        seconds: 6,
      });
      expect(report.maxContactDrift, fixture.name).toBeLessThan(SLIDE_LIMIT);
    }
  });

  it('keeps feet planted for procedural civilians', () => {
    for (let seed = 0; seed < 6; seed++) {
      const fixture = civilianFixture(seed * 5471 + 3);
      const report = measureFootSlide(fixture.rig, {
        speed: scaledSpeed(fixture.rig, 0.47),
        seconds: 5,
      });
      expect(report.maxContactDrift, fixture.name).toBeLessThan(SLIDE_LIMIT);
    }
  });
});

describe('the solver starting mid-stride', () => {
  // Every seeded crowd member starts at a random cycle phase, and roughly a
  // third of them start with a foot already in swing — with no toe-off behind
  // them to swing away from.
  const { rig } = heroFixture('saitama');

  const firstFrame = (root: THREE.Vector3): LocomotionReport => {
    const solver = new LocomotionSolver(rig, { phase: 0.73 });
    solver.setRoot(root, 0);
    const pose = createPose(rig.boneCount);
    copyPose(pose, rig.rest);
    return solver.update(1 / 60, { speed: 1.4 }, pose, false);
  };

  it('does not lerp a swinging ankle in from the world origin', () => {
    // The lock is a WORLD position, so an unwritten one is the world origin —
    // hundreds of metres away for anything standing in the city. The leg then
    // snaps straight backwards and the reach limiter pins the pelvis at its
    // crouch floor for the rest of the swing.
    const near = firstFrame(new THREE.Vector3(0, 0, 0));
    const far = firstFrame(new THREE.Vector3(300, 0, 300));
    expect(far.right.phase).toBe('swing');
    expect(far.right.slip).toBeLessThan(0.001);
    expect(far.left.slip).toBeLessThan(0.001);
    // The whole solve is translation invariant, which is the real statement.
    expect(far.reachDrop).toBeCloseTo(near.reachDrop, 6);
    expect(far.reachDrop).toBeLessThan(rig.metrics.legLength * 0.17);
  });
});

describe('airborne', () => {
  const { rig } = heroFixture('saitama');

  /** Worst slip and reach drop over `steps` frames of the given input. */
  const worstOf = (
    solver: LocomotionSolver,
    steps: number,
    input: LocomotionInput
  ): { slip: number; drop: number } => {
    const pose = createPose(rig.boneCount);
    let slip = 0;
    let drop = 0;
    for (let i = 0; i < steps; i++) {
      copyPose(pose, rig.rest);
      const report = solver.update(1 / 120, input, pose);
      slip = Math.max(slip, report.left.slip, report.right.slip);
      drop = Math.max(drop, report.reachDrop);
    }
    return { slip, drop };
  };

  it('holds the legs instead of dragging a stale swing anchor', () => {
    // The cycle phase freezes while `grounded` is false. Continuing the swing
    // anyway drags its world anchor backwards at the root's speed for the whole
    // flight, and a foot that was in stance restarts its swing parked at the
    // toe-off extreme — out of the leg's reach. Either one pins the pelvis at
    // the crouch floor and makes `reachDrop`, `pelvisY` and `slip` meaningless
    // for as long as the character is in the air.
    const { solver } = run(rig, 400, { speed: 3 });
    const air = worstOf(solver, 180, { speed: 3, grounded: false });
    expect(air.slip).toBeLessThan(0.001);
    expect(air.drop).toBeLessThan(rig.metrics.legLength * 0.02);
  });

  it('lands without a leg reaching for where it took off from', () => {
    // Two landing hazards at once. The world anchors went stale while the phase
    // was frozen, so a foot still in swing would blend in from metres back; and
    // touchdown charges `local` as sub-frame overshoot, which is only true when
    // the crossing happened this frame — a foot re-entering stance at an
    // arbitrary `local` would have its lock shifted back by up to a full stance
    // excursion and be pinned there for the rest of the step.
    const { solver } = run(rig, 400, { speed: 1.4 });
    worstOf(solver, 60, { speed: 1.4, grounded: false });
    const landed = worstOf(solver, 240, { speed: 1.4 });
    expect(landed.slip).toBeLessThan(0.001);
    expect(landed.drop).toBeLessThan(rig.metrics.legLength * 0.05);
  });
});

describe('posture under the gait', () => {
  const { rig } = heroFixture('saitama');

  /** Model-space fore/aft offset of the neck from the hips. Forward is -Z. */
  const neckLean = (speed: number, slouch: number): number => {
    const { solver } = run(rig, 240, { speed, slouch });
    // Pin the phase so two speeds are compared at the same point of the cycle.
    solver.phase = 0.25;
    const pose = createPose(rig.boneCount);
    copyPose(pose, rig.rest);
    solver.update(1e-6, { speed, slouch }, pose);
    const model = poseToModelMatrices(pose, rig, []);
    const neck = new THREE.Vector3().setFromMatrixPosition(model[rig.index.Neck!]!);
    const hips = new THREE.Vector3().setFromMatrixPosition(model[rig.index.Hips!]!);
    return neck.z - hips.z;
  };

  it('leans the thorax FORWARD as the gait moves from standing to a run', () => {
    // The sagittal axis again, this time on the path that bypasses
    // `posture.ts`. A run that leans backwards is the single most obvious tell
    // a procedural gait can have, and no height or slip measurement sees it.
    expect(neckLean(6, 0)).toBeLessThan(neckLean(0, 0) - 0.05);
  });

  it('slouches forward as boredom rises, rather than arching back', () => {
    // `LocomotionInput.slouch` is fed straight from Saitama's Boredom meter.
    expect(neckLean(1.4, 1)).toBeLessThan(neckLean(1.4, 0) - 0.02);
  });
});

describe('report hygiene', () => {
  const { rig } = heroFixture('saitama');

  it('hands out a copy of the plant lock rather than the live vector', () => {
    // `FootState.plantWorld` is rewritten in place at every touchdown, so a
    // consumer that keeps two reports to measure a step length would see both
    // references mutate to the newest value and always measure zero.
    const solver = new LocomotionSolver(rig);
    const { report: first } = run(rig, 1, { speed: 1.4 }, solver);
    const snapshot = first.right.plantWorld.clone();
    const { report: later } = run(rig, 600, { speed: 1.4 }, solver);
    expect(first.right.plantWorld.equals(snapshot)).toBe(true);
    expect(later.right.plantWorld.distanceTo(snapshot)).toBeGreaterThan(1);
  });
});

describe('gait model', () => {
  const saitama = heroFixture('saitama');

  it('reproduces adult walking cadence and stride from the formula', () => {
    // 1.4 m/s is the textbook comfortable walking speed. Real adults land near
    // 110-125 steps/min with a 1.3-1.5 m stride. Nothing here is a lookup —
    // these come out of `2.28 * u^0.49` and `0.42 * u^-0.51`.
    const [row] = gaitProfile(saitama.rig, [1.4]);
    expect(row!.stepsPerMinute).toBeGreaterThan(105);
    expect(row!.stepsPerMinute).toBeLessThan(135);
    expect(row!.strideLength).toBeGreaterThan(1.2);
    expect(row!.strideLength).toBeLessThan(1.55);
    expect(row!.duty).toBeGreaterThan(0.55);
    expect(row!.duty).toBeLessThan(0.68);
  });

  it('produces a flight phase only when running', () => {
    const walk = solveGait(1.4, saitama.rig.metrics.legLength);
    const run = solveGait(6, saitama.rig.metrics.legLength);
    expect(walk.duty).toBeGreaterThan(0.5); // double support, no flight
    expect(run.duty).toBeLessThan(0.5); // both feet off the ground
  });

  it('keeps speed equal to stride times cadence at every speed', () => {
    // Foot planting depends on this identity: if the stride and the cadence
    // disagree with the ground speed, the feet cannot be both correctly spaced
    // and correctly timed.
    for (const speed of [0.4, 1.4, 3, 7, 14, 30]) {
      const g = solveGait(speed, saitama.rig.metrics.legLength);
      expect(g.strideLength * g.cycleFrequency).toBeCloseTo(speed, 6);
    }
  });

  it('scales cadence with body size rather than holding it fixed', () => {
    // The Froude scaling in one assertion. At the SAME normalised speed, a
    // short leg must take quicker steps; scaling a human cycle by height
    // instead would give both bodies the same cadence.
    const bodies = showcaseFixtures();
    const child = bodies.find((b) => b.name === 'Child')!;
    const monster = bodies.find((b) => b.name === 'Monster humanoid')!;
    const childGait = solveGait(scaledSpeed(child.rig, 0.47), child.rig.metrics.legLength);
    const monsterGait = solveGait(scaledSpeed(monster.rig, 0.47), monster.rig.metrics.legLength);
    expect(childGait.cycleFrequency).toBeGreaterThan(monsterGait.cycleFrequency * 1.3);
    // ...and their strides must differ by roughly the leg-length ratio.
    // At matched Froude number the strides differ by exactly the leg ratio.
    const ratio = monster.rig.metrics.legLength / child.rig.metrics.legLength;
    expect(monsterGait.strideLength / childGait.strideLength).toBeCloseTo(ratio, 2);
  });

  it('never takes a step at zero speed', () => {
    const g = solveGait(0, saitama.rig.metrics.legLength);
    expect(g.strideLength).toBe(0);
    expect(g.excursion).toBe(0);
    expect(g.activity).toBe(0);
  });
});

describe('hostile input', () => {
  // `mod` still passes NaN through untouched, and `clamp`, `clamp01` and
  // `smoothstep` only floor it at their low bound — the solver guards its own
  // entry rather than relying on either. That would all be survivable if the
  // damage were confined to one frame, but `phase` and `rootYaw` are
  // ACCUMULATORS: one non-finite frame from a stalled clock or a physics body
  // that went bad makes every bone NaN for the rest of the session, with
  // nothing thrown and nothing logged. The character simply disappears.
  const saitama = heroFixture('saitama');

  it('solves a finite gait from a non-finite speed', () => {
    const g = solveGait(NaN, 0.9);
    for (const value of Object.values(g)) {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
    // Not merely finite — it is exactly the standing solution.
    expect(g.cycleFrequency).toBe(solveGait(0, 0.9).cycleFrequency);
    expect(g.speed).toBe(0);
    expect(g.gait).toBe('stand');
    // ...and a non-finite BODY falls back to the minimum leg rather than
    // dividing by it.
    expect(Number.isFinite(solveGait(1.4, NaN).cycleFrequency)).toBe(true);
  });

  it('recovers completely from one non-finite frame', () => {
    const { rig } = saitama;
    const solver = new LocomotionSolver(rig);
    const pose = createPose(rig.boneCount);
    const good = (): void => {
      copyPose(pose, rig.rest);
      solver.update(1 / 60, { speed: 1.4 }, pose);
    };

    for (let i = 0; i < 10; i++) good();
    copyPose(pose, rig.rest);
    solver.update(NaN, { speed: NaN, turnRate: NaN, groundY: NaN, slouch: NaN }, pose);
    expect(Number.isFinite(solver.phase)).toBe(true);
    expect(Number.isFinite(solver.rootYaw)).toBe(true);

    for (let i = 0; i < 10; i++) good();
    expect(Number.isFinite(solver.phase)).toBe(true);
    expect(Number.isFinite(solver.rootYaw)).toBe(true);
    expect(Number.isFinite(solver.rootPosition.x)).toBe(true);
    expect(Number.isFinite(solver.rootPosition.z)).toBe(true);
    for (let i = 0; i < pose.rot.length; i++)
      expect(Number.isFinite(pose.rot[i]!), `rot ${i}`).toBe(true);
    for (let i = 0; i < pose.pos.length; i++)
      expect(Number.isFinite(pose.pos[i]!), `pos ${i}`).toBe(true);
  });
});

describe('limb integrity', () => {
  it('never stretches a bone, inverts a knee or sinks a foot', () => {
    for (const fixture of showcaseFixtures()) {
      const L = fixture.rig.metrics.legLength;
      const speeds = [0, 0.15, 0.47, 1.15, 2.1, 3.4].map((u) => u * Math.sqrt(9.81 * L));
      const report = measureLimbSanity(fixture.rig, speeds, 3);
      // Rotation-only animation: any length change is float32 noise.
      expect(report.maxLengthError, `${fixture.name} bone length`).toBeLessThan(1e-5);
      // A knee past 180 degrees is inverted; past ~150 is anatomically absurd.
      expect(report.maxKneeFlexion, `${fixture.name} knee`).toBeLessThan(Math.PI * 0.85);
      // Not exactly zero: the IK leaves a few tens of microns of residual when
      // it lands on a target, and that residual can point downward. A tenth of
      // a millimetre is four orders of magnitude below anything visible.
      expect(report.maxGroundPenetration, `${fixture.name} ground`).toBeLessThan(1e-4);
      expect(report.frames).toBeGreaterThan(1000);
    }
  });

  it('crouches rather than over-extending when the stride outgrows the leg', () => {
    // The reach limiter's whole job. A 2.45 m monster running at hero speed
    // demands a stride its leg cannot span from a standing pelvis height.
    const monster = showcaseFixtures().find((b) => b.name === 'Monster humanoid')!;
    const fast = measureFootSlide(monster.rig, {
      speed: scaledSpeed(monster.rig, 2.6),
      seconds: 6,
    });
    expect(fast.maxReachDrop).toBeGreaterThan(0.01);
    expect(fast.maxContactDrift).toBeLessThan(SLIDE_LIMIT);
    // ...and the crouch stays within a fraction of the leg, not a collapse.
    expect(fast.maxReachDrop).toBeLessThan(monster.rig.metrics.legLength * 0.35);
  });
});
