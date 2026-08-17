import { describe, expect, it } from 'vitest';
import { ButtonTracker, INPUT_ACTIONS, NEUTRAL_BUTTON } from './buttons';

const DT = 1 / 60;

describe('INPUT_ACTIONS', () => {
  it('covers every action in the contract exactly once', () => {
    expect(new Set(INPUT_ACTIONS).size).toBe(INPUT_ACTIONS.length);
    expect(INPUT_ACTIONS).toContain('punch');
    expect(INPUT_ACTIONS).toContain('heavyPunch');
    expect(INPUT_ACTIONS).toContain('debugToggle');
    expect(INPUT_ACTIONS.length).toBe(14);
  });
});

describe('ButtonTracker edges', () => {
  it('emits pressed for exactly one frame, then held', () => {
    const t = new ButtonTracker();

    t.set('jump', true);
    let s = t.commit(DT).jump;
    expect(s).toMatchObject({ pressed: true, held: true, released: false });
    expect(s.holdTime).toBe(0);

    t.set('jump', true);
    s = t.commit(DT).jump;
    expect(s).toMatchObject({ pressed: false, held: true, released: false });
    expect(s.holdTime).toBeCloseTo(DT, 9);

    t.set('jump', true);
    s = t.commit(DT).jump;
    expect(s.holdTime).toBeCloseTo(DT * 2, 9);
  });

  it('emits released for exactly one frame, then nothing', () => {
    const t = new ButtonTracker();
    t.set('jump', true);
    t.commit(DT);

    let s = t.commit(DT).jump; // nothing contributed
    expect(s).toMatchObject({ pressed: false, held: false, released: true });
    expect(s.holdTime).toBe(0);
    expect(s.value).toBe(0);

    s = t.commit(DT).jump;
    expect(s).toBe(NEUTRAL_BUTTON);
  });

  it('a one-frame tap produces pressed+held then released', () => {
    const t = new ButtonTracker();
    t.pulse('punch');
    const first = t.commit(DT).punch;
    expect(first).toMatchObject({ pressed: true, held: true, released: false, value: 1 });
    const second = t.commit(DT).punch;
    expect(second).toMatchObject({ pressed: false, held: false, released: true });
  });

  it('merges contributions from several backends with max', () => {
    const t = new ButtonTracker();
    t.contribute('heavyPunch', 0.3);
    t.contribute('heavyPunch', 0.9);
    t.contribute('heavyPunch', 0.5);
    expect(t.commit(DT).heavyPunch.value).toBeCloseTo(0.9, 6);
  });

  it('carries analogue values while held and zeroes them on release', () => {
    const t = new ButtonTracker();
    t.contribute('heavyPunch', 0.42);
    expect(t.commit(DT).heavyPunch.value).toBeCloseTo(0.42, 6);
    const released = t.commit(DT).heavyPunch;
    expect(released.released).toBe(true);
    expect(released.value).toBe(0);
  });

  it('clearSilently drops a held action WITHOUT a released edge', () => {
    const t = new ButtonTracker();
    t.set('punch', true);
    expect(t.commit(DT).punch.held).toBe(true);

    t.clearSilently('punch');
    const s = t.commit(DT).punch;
    expect(s.held).toBe(false);
    expect(s.released).toBe(false);
    expect(s.pressed).toBe(false);
  });

  it('reset() leaves no pending edges', () => {
    const t = new ButtonTracker();
    t.set('sprint', true);
    t.commit(DT);
    t.reset();
    const s = t.commit(DT).sprint;
    expect(s.held).toBe(false);
    expect(s.released).toBe(false);
  });

  it('reports every action on every commit', () => {
    const t = new ButtonTracker();
    const record = t.commit(DT);
    for (const action of INPUT_ACTIONS) {
      expect(record[action], action).toBeDefined();
    }
  });

  it('committed snapshots are immutable and independent', () => {
    const t = new ButtonTracker();
    t.set('block', true);
    const a = t.commit(DT);
    t.set('block', true);
    const b = t.commit(DT);
    expect(a).not.toBe(b);
    expect(a.block.pressed).toBe(true);
    expect(b.block.pressed).toBe(false);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('a pulse on an already-held action does not re-press it', () => {
    const t = new ButtonTracker();
    t.set('jump', true);
    t.commit(DT);
    t.set('jump', true);
    t.pulse('jump');
    const s = t.commit(DT).jump;
    expect(s.pressed).toBe(false);
    expect(s.held).toBe(true);
  });

  it('exposes hold state between commits', () => {
    const t = new ButtonTracker();
    t.set('sprint', true);
    t.commit(0.5);
    expect(t.isHeld('sprint')).toBe(true);
    t.set('sprint', true);
    t.commit(0.5);
    expect(t.holdTime('sprint')).toBeCloseTo(0.5, 6);
  });
});
