/**
 * VOICE BUDGET — the bookkeeping, not the audio.
 *
 * `VoiceBank` is what stops a building collapse from allocating a hundred
 * graphs and eating the frame. Everything it does is integer/float
 * bookkeeping: lazy construction, "prefer a genuinely idle slot", steal the
 * lowest priority and break ties on the earliest start, generation stamping so
 * a stale handle can tell it no longer owns its voice.
 *
 * The only existing coverage is the Chromium probe `mix.budget`, which checks
 * aggregate counts end-to-end and therefore cannot tell a WRONG victim from a
 * right one — and a comparison chain like the steal rule is exactly the sort
 * of thing that silently inverts under edit. The bank takes its instances from
 * an injected factory, so a structural fake exercises the real logic with no
 * `AudioContext` at all.
 */

import { describe, expect, it } from 'vitest';
import { VoiceBank, type IVoiceLease, type SynthVoice } from '../voice';

/** Records what the bank asks of an instance; renders nothing. */
class FakeVoice {
  readonly stops: { time: number; fade: number }[] = [];
  disposed = 0;

  stopAt(time: number, fadeSeconds = 0.012): void {
    this.stops.push({ time, fade: fadeSeconds });
  }

  dispose(): void {
    this.disposed++;
  }
}

interface IHarness {
  readonly bank: VoiceBank<SynthVoice>;
  /** The fakes, indexed by slot; a hole means "never constructed". */
  readonly made: (FakeVoice | undefined)[];
  readonly state: { builds: number };
}

function makeBank(size = 4): IHarness {
  const made: (FakeVoice | undefined)[] = [];
  const state = { builds: 0 };
  const bank = new VoiceBank<SynthVoice>('test', size, (index) => {
    state.builds++;
    const voice = new FakeVoice();
    made[index] = voice;
    return voice as unknown as SynthVoice;
  });
  return { bank, made, state };
}

/** Check out `count` leases in slot order, each at its own priority. */
function acquireAll(h: IHarness, priorities: readonly number[], now = 0): IVoiceLease[] {
  return priorities.map((p) => {
    const lease = h.bank.acquire(now, p);
    expect(lease).toBeDefined();
    return lease!;
  });
}

/* -------------------------------------------------------------------------- */

describe('construction', () => {
  it('builds nothing until a slot is needed', () => {
    const h = makeBank(4);
    expect(h.bank.size).toBe(4);
    expect(h.bank.builtCount).toBe(0);
    expect(h.state.builds).toBe(0);
  });

  it('preallocate warms exactly the requested count, clamped to size', () => {
    const h = makeBank(4);
    h.bank.preallocate(2);
    expect(h.bank.builtCount).toBe(2);
    h.bank.preallocate(99);
    expect(h.bank.builtCount).toBe(4);
    expect(h.state.builds).toBe(4);
    expect(h.bank.size).toBe(4);
  });
});

describe('acquire', () => {
  it('takes the first slot and marks it busy', () => {
    const h = makeBank(4);
    const lease = h.bank.acquire(0, 0.5);
    expect(lease?.slot).toBe(0);
    // A checked-out slot is +Infinity busy until `markBusyUntil` refines it.
    expect(h.bank.activeCount(0)).toBe(1);
  });

  it('markBusyUntil frees the slot at exactly the reported time', () => {
    const h = makeBank(4);
    h.bank.acquire(0, 0.5);
    h.bank.markBusyUntil(0, 0.5);
    expect(h.bank.activeCount(0.4)).toBe(1);
    expect(h.bank.activeCount(0.6)).toBe(0);
  });

  it('prefers the LONGEST-idle slot, not the first one scanned', () => {
    const h = makeBank(4);
    acquireAll(h, [0.5, 0.5, 0.5, 0.5]);
    [1.0, 0.2, 0.5, 0.8].forEach((t, i) => h.bank.markBusyUntil(i, t));
    // At 0.9 slot 0 is still sounding; of the idle three, slot 1 freed first.
    expect(h.bank.acquire(0.9, 0.5)?.slot).toBe(1);
  });
});

describe('stealing', () => {
  it('takes the lowest-priority voice and fades it to avoid a click', () => {
    const h = makeBank(4);
    acquireAll(h, [0.9, 0.2, 0.5, 0.7]);
    const lease = h.bank.acquire(0, 0.6);
    expect(lease?.slot).toBe(1);
    expect(h.made[1]!.stops).toEqual([{ time: 0, fade: 0.008 }]);
  });

  it('refuses to steal from something MORE important', () => {
    // "A boss roar never loses to footsteps."
    const h = makeBank(4);
    acquireAll(h, [0.9, 0.2, 0.5, 0.7]);
    expect(h.bank.acquire(0, 0.1)).toBeUndefined();
    for (const voice of h.made) expect(voice!.stops).toEqual([]);
  });

  it('breaks a priority tie on the earliest free time', () => {
    const h = makeBank(4);
    acquireAll(h, [0.5, 0.5, 0.5, 0.5]);
    [5, 3, 9, 7].forEach((t, i) => h.bank.markBusyUntil(i, t));
    expect(h.bank.acquire(0, 0.5)?.slot).toBe(1);
  });

  it('bumps the generation so the previous lease reads as stale', () => {
    const h = makeBank(4);
    const leases = acquireAll(h, [0.9, 0.2, 0.5, 0.7]);
    const old = leases[1]!;
    expect(h.bank.isCurrent(old)).toBe(true);
    const fresh = h.bank.acquire(0, 0.6)!;
    expect(fresh.slot).toBe(old.slot);
    expect(h.bank.isCurrent(old)).toBe(false);
    expect(h.bank.isCurrent(fresh)).toBe(true);
    expect(fresh.generation).toBeGreaterThan(old.generation);
  });
});

describe('release', () => {
  it('stops the instance and frees the slot after the fade', () => {
    const h = makeBank(1);
    const lease = h.bank.acquire(0, 0.5)!;
    h.bank.release(lease, 2, 0.05);
    expect(h.made[lease.slot]!.stops).toEqual([{ time: 2, fade: 0.05 }]);
    expect(h.bank.activeCount(2.1)).toBe(0);
  });

  it('is a no-op on a lease whose slot has been re-acquired', () => {
    const h = makeBank(1);
    const stale = h.bank.acquire(0, 0.5)!;
    h.bank.release(stale, 2, 0.05);
    const fresh = h.bank.acquire(3, 0.5)!;
    expect(fresh.slot).toBe(stale.slot);
    h.bank.release(stale, 4, 0.05);
    expect(h.made[0]!.stops).toEqual([{ time: 2, fade: 0.05 }]);
  });
});

describe('bulk operations', () => {
  it('stopAll touches only constructed, still-sounding instances', () => {
    const h = makeBank(4);
    acquireAll(h, [0.5, 0.5]);
    h.bank.stopAll(0, 0.05);
    expect(h.made[0]!.stops).toEqual([{ time: 0, fade: 0.05 }]);
    expect(h.made[1]!.stops).toEqual([{ time: 0, fade: 0.05 }]);
    expect(h.made[2]).toBeUndefined();
    expect(h.made[3]).toBeUndefined();
    expect(h.bank.activeCount(0.06)).toBe(0);
  });

  it('forEach visits only constructed instances', () => {
    const h = makeBank(4);
    h.bank.preallocate(3);
    const seen: number[] = [];
    h.bank.forEach((_voice, slot) => seen.push(slot));
    expect(seen).toEqual([0, 1, 2]);
    expect(seen.length).toBe(h.bank.builtCount);
  });
});

describe('dispose', () => {
  it('empties every parallel array so the pool reports itself empty', () => {
    // `freeAt`, `priority` and `generation` are parallel to `voices`. Leaving
    // them populated made a disposed pool claim to be sounding forever (a
    // checked-out slot is +Infinity, so it never ages out) and kept answering
    // "yes, you still own your voice" to leases into a disconnected graph.
    const h = makeBank(4);
    const lease = acquireAll(h, [0.5, 0.5])[0]!;
    expect(h.bank.activeCount(0)).toBe(2);

    h.bank.dispose();

    expect(h.made[0]!.disposed).toBe(1);
    expect(h.made[1]!.disposed).toBe(1);
    expect(h.made[2]).toBeUndefined();
    expect(h.made[3]).toBeUndefined();
    expect(h.bank.size).toBe(0);
    expect(h.bank.builtCount).toBe(0);
    expect(h.bank.activeCount(0)).toBe(0);
    expect(h.bank.activeCount(1e9)).toBe(0);
    expect(h.bank.isCurrent(lease)).toBe(false);
    expect(h.bank.acquire(0, 1)).toBeUndefined();
  });

  it('is idempotent and never double-disposes an instance', () => {
    const h = makeBank(4);
    acquireAll(h, [0.5, 0.5]);
    h.bank.dispose();
    expect(() => h.bank.dispose()).not.toThrow();
    expect(h.made[0]!.disposed).toBe(1);
    expect(h.made[1]!.disposed).toBe(1);
  });
});
