/**
 * SEEDED RNG — SNAPSHOT FIDELITY
 *
 * `getState()` exists so a save regenerates an identical world. That makes an
 * unfaithful snapshot a silent content bug rather than a crash: restore, and
 * the city, the civilian body proportions or the debris scatter come back
 * subtly different with nothing raised.
 *
 * `gaussian()` is where it bites. Box-Muller produces two samples per pair of
 * draws and caches the second, so a snapshot taken between the two halves of a
 * pair carries state the uint32 core does not.
 */

import { describe, it, expect } from 'vitest';
import { createRng, type IRandom, type IRandomState } from '../rng';

/** A mixed draw sequence, so a snapshot has to restore more than `next()`. */
function draw(rng: IRandom): number[] {
  return [rng.next(), rng.gaussian(), rng.int(0, 100), rng.gaussian(1.71, 0.075), rng.range(-1, 1)];
}

describe('IRandom.getState / setState', () => {
  it('round-trips a snapshot taken while a Box-Muller spare is pending', () => {
    const rng = createRng(12345);
    rng.gaussian(); // consumes two draws and caches the second sample
    const snapshot = rng.getState();
    expect(typeof snapshot.spare).toBe('number');

    const beforeRestore = rng.gaussian(); // returns the cached spare
    rng.setState(snapshot);
    expect(rng.gaussian()).toBe(beforeRestore);
  });

  it('round-trips a snapshot taken with no spare pending', () => {
    const rng = createRng('downtown');
    rng.gaussian();
    rng.gaussian(); // spare consumed, none cached
    const snapshot = rng.getState();
    expect(snapshot.spare).toBeUndefined();

    const beforeRestore = [rng.next(), rng.gaussian(), rng.next()];
    rng.setState(snapshot);
    expect([rng.next(), rng.gaussian(), rng.next()]).toEqual(beforeRestore);
  });

  it('survives the JSON round-trip a save file puts it through', () => {
    const rng = createRng(7);
    rng.gaussian();
    const snapshot = JSON.parse(JSON.stringify(rng.getState())) as IRandomState;

    const beforeRestore = rng.gaussian();
    rng.setState(snapshot);
    expect(rng.gaussian()).toBe(beforeRestore);
  });

  it('reproduces a long mixed stream from a mid-stream snapshot', () => {
    const rng = createRng('civilians');
    draw(rng);
    const snapshot = rng.getState();
    const expected = [draw(rng), draw(rng)];

    rng.setState(snapshot);
    expect([draw(rng), draw(rng)]).toEqual(expected);
  });

  it('clears a cached spare when the snapshot does not carry one', () => {
    const restored = createRng(99);
    restored.gaussian(); // caches a spare
    const core = restored.getState().state;

    const reference = createRng(99);
    reference.gaussian();
    expect(reference.getState().state).toBe(core);

    // A spare-less snapshot means "no pending sample": the next gaussian has
    // to recompute rather than hand back the sample still cached in `restored`.
    restored.setState({ state: core });
    expect(restored.gaussian()).not.toBe(reference.gaussian());
  });
});
