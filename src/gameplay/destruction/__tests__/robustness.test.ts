/**
 * ONE BAD NUMBER MUST NOT LEVEL THE CITY
 *
 * Every reject in this unit is written as a comparison, and every comparison
 * against `NaN` is FALSE. That turns each of them from a guard into a hole:
 *
 *   • `range <= 0` does not fire for `NaN`, so a NaN range reaches
 *     `aabbInCone`, where `pointAabbDistanceSq(...) > NaN` is also false — the
 *     range reject never fires and every structure in front of the apex is
 *     accepted at unlimited distance.
 *   • `blastRange = NaN` then makes `clamp01(distance / NaN)` NaN, so every
 *     impulse handed to `IDebrisSink.spawn` is NaN and every rigid body in the
 *     scene is ejected to nowhere.
 *   • `normaliseInto`'s `length < 1e-6` is false for `NaN`, so it falls through
 *     to `x / NaN` and writes the NaN axis its own doc comment promises never
 *     to produce.
 *
 * None of that needs a bug in this unit to reach: `onPlayerLanded` derives its
 * radius from `event.impactSpeed`, and `clamp(NaN * 0.35, 4, 45)` is `NaN`.
 *
 * Every case here carries a POSITIVE CONTROL — the same call with finite
 * numbers really does take chunks — so none of them can pass by the punch
 * simply having missed.
 */

import { describe, expect, it } from 'vitest';
import { createEventBus } from '@/util';
import { collapsingFloors as cityCollapsingFloors } from '@/world/city';
import { DestructionSystem } from '../destruction-system';
import { normaliseInto } from '../geometry';
import { makeTower } from './fixtures';

function setup(seed: string) {
  const bus = createEventBus();
  const system = new DestructionSystem({
    bus,
    collapsingFloors: cityCollapsingFloors,
    seed,
  });
  const { layout, attribute } = makeTower({ floors: 12 });
  const structure = system.register({
    id: 'tower',
    layout,
    target: { destroyed: attribute },
    position: { x: 20, y: 0, z: 0 },
  });
  return { bus, system, structure, attribute };
}

/** Nothing came off, and nothing was even counted as coming off. */
function expectUntouched(system: DestructionSystem, structure: { destroyedCount: number }): void {
  expect(structure.destroyedCount).toBe(0);
  expect(system.diagnostics.chunksDestroyed).toBe(0);
  expect(system.diagnostics.destroyedMassKg).toBe(0);
}

const BAD_NUMBERS: [string, number][] = [
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
];

describe('applyShockwave refuses non-finite parameters', () => {
  for (const [label, bad] of BAD_NUMBERS) {
    it(`returns 0 for a ${label} range`, () => {
      const { system, structure } = setup(`shockwave-range-${label}`);
      expect(
        system.applyShockwave({ x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, bad, 0.4, 2.5e6, 'full')
      ).toBe(0);
      expectUntouched(system, structure);
      system.dispose();
    });
  }

  it('returns 0 for a NaN half-angle, power or origin', () => {
    for (const [label, call] of [
      [
        'halfAngle',
        (s: DestructionSystem) =>
          s.applyShockwave({ x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 200, NaN, 2.5e6, 'full'),
      ],
      [
        'power',
        (s: DestructionSystem) =>
          s.applyShockwave({ x: 0, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 200, 0.4, NaN, 'full'),
      ],
      [
        'origin.x',
        (s: DestructionSystem) =>
          s.applyShockwave({ x: NaN, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 200, 0.4, 2.5e6, 'full'),
      ],
      [
        'origin.y',
        (s: DestructionSystem) =>
          s.applyShockwave({ x: 0, y: NaN, z: 0 }, { x: 1, y: 0, z: 0 }, 200, 0.4, 2.5e6, 'full'),
      ],
      [
        'origin.z',
        (s: DestructionSystem) =>
          s.applyShockwave({ x: 0, y: 2, z: NaN }, { x: 1, y: 0, z: 0 }, 200, 0.4, 2.5e6, 'full'),
      ],
    ] as [string, (s: DestructionSystem) => number][]) {
      const { system, structure } = setup(`shockwave-${label}`);
      expect(call(system), label).toBe(0);
      expectUntouched(system, structure);
      system.dispose();
    }
  });

  it('still takes the building when the same punch is finite', () => {
    const { system, structure } = setup('shockwave-control');
    const took = system.applyShockwave(
      { x: 0, y: 2, z: 0 },
      { x: 1, y: 0, z: 0 },
      200,
      0.4,
      2.5e6,
      'full'
    );
    expect(took).toBeGreaterThan(0);
    expect(structure.destroyedCount).toBeGreaterThan(0);
    system.dispose();
  });

  it('leaves every emitted impulse finite for a NaN direction', () => {
    // A degenerate direction is legal — `normaliseInto` is documented to turn
    // it into +X — and it must not become a NaN axis on the way through.
    const bus = createEventBus();
    const impulses: number[] = [];
    bus.on('ChunkDetached', (event) => {
      impulses.push(event.impulse.x, event.impulse.y, event.impulse.z);
    });
    const system = new DestructionSystem({
      bus,
      collapsingFloors: cityCollapsingFloors,
      seed: 'nan-axis',
    });
    const { layout, attribute } = makeTower({ floors: 12 });
    system.register({
      id: 'tower',
      layout,
      target: { destroyed: attribute },
      position: { x: 20, y: 0, z: 0 },
    });

    const took = system.applyShockwave(
      { x: 0, y: 2, z: 0 },
      { x: NaN, y: NaN, z: NaN },
      200,
      Math.PI,
      2.5e6,
      'full'
    );
    expect(took).toBeGreaterThan(0);
    expect(impulses.length).toBeGreaterThan(0);
    for (const value of impulses) expect(Number.isFinite(value)).toBe(true);
    system.dispose();
  });
});

describe('applyRadial refuses non-finite parameters', () => {
  for (const [label, bad] of BAD_NUMBERS) {
    it(`returns 0 for a ${label} radius`, () => {
      const { system, structure } = setup(`radial-radius-${label}`);
      expect(system.applyRadial({ x: 20, y: 2, z: 0 }, bad, 2.5e6, 'full')).toBe(0);
      expectUntouched(system, structure);
      system.dispose();
    });
  }

  it('returns 0 for a NaN power or origin', () => {
    for (const [label, call] of [
      ['power', (s: DestructionSystem) => s.applyRadial({ x: 20, y: 2, z: 0 }, 60, NaN, 'full')],
      [
        'origin.x',
        (s: DestructionSystem) => s.applyRadial({ x: NaN, y: 2, z: 0 }, 60, 2.5e6, 'full'),
      ],
      [
        'origin.y',
        (s: DestructionSystem) => s.applyRadial({ x: 20, y: NaN, z: 0 }, 60, 2.5e6, 'full'),
      ],
      [
        'origin.z',
        (s: DestructionSystem) => s.applyRadial({ x: 20, y: 2, z: NaN }, 60, 2.5e6, 'full'),
      ],
    ] as [string, (s: DestructionSystem) => number][]) {
      const { system, structure } = setup(`radial-${label}`);
      expect(call(system), label).toBe(0);
      expectUntouched(system, structure);
      system.dispose();
    }
  });

  it('still craters when the same call is finite', () => {
    const { system, structure } = setup('radial-control');
    expect(system.applyRadial({ x: 20, y: 2, z: 0 }, 60, 2.5e6, 'full')).toBeGreaterThan(0);
    expect(structure.destroyedCount).toBeGreaterThan(0);
    system.dispose();
  });
});

describe('a landing with a broken impact speed', () => {
  it('craters nothing when impactSpeed is NaN', () => {
    const { bus, system, structure } = setup('landing-nan');
    bus.emit('PlayerLanded', {
      position: { x: 20, y: 0, z: 0 },
      impactSpeed: NaN,
      fallHeight: 120,
      createsCrater: true,
      intent: 'full',
    });
    expectUntouched(system, structure);
    system.dispose();
  });

  it('still craters at a real landing speed', () => {
    const { bus, system, structure } = setup('landing-control');
    bus.emit('PlayerLanded', {
      position: { x: 20, y: 0, z: 0 },
      impactSpeed: 90,
      fallHeight: 120,
      createsCrater: true,
      intent: 'full',
    });
    expect(structure.destroyedCount).toBeGreaterThan(0);
    system.dispose();
  });
});

describe('normaliseInto', () => {
  it('yields +X and a zero length for a non-finite input', () => {
    const out = new Float64Array(3);
    for (const [x, y, z] of [
      [NaN, 0, 0],
      [0, NaN, 0],
      [0, 0, NaN],
      [NaN, NaN, NaN],
    ]) {
      out.fill(7);
      expect(normaliseInto(out, x!, y!, z!)).toBe(0);
      expect([...out]).toEqual([1, 0, 0]);
    }
  });

  it('yields +X for an infinite input too', () => {
    // `Infinity` passes a bare smallness gate — `Math.sqrt(Infinity)` is
    // `Infinity`, which is not `< 1e-6` — and then `Infinity / Infinity` is
    // NaN, i.e. the same poisoned axis by the other door.
    const out = new Float64Array(3);
    for (const [x, y, z] of [
      [Infinity, 0, 0],
      [0, -Infinity, 0],
      [Infinity, Infinity, 0],
      // Merely astronomical: `1e200 * 1e200` overflows to `Infinity` before the
      // square root ever runs.
      [1e200, 1e200, 0],
    ]) {
      out.fill(7);
      expect(normaliseInto(out, x!, y!, z!)).toBe(0);
      expect([...out]).toEqual([1, 0, 0]);
    }
  });
});
