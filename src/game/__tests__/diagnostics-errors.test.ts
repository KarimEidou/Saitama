/**
 * `__GAME_DIAG__.errors` IS READ AFTER A FAULT, SO IT HAS TO STAY READABLE
 *
 * `Game.tick` deliberately keeps the loop alive through a throwing frame — a
 * dead rAF is a black screen with no way back — and records the throw. That call
 * site is the only per-FRAME one: a deterministic fault (a null deref after a
 * bad state transition, a disposed Rapier handle) therefore appended sixty
 * strings a second, forever. Ten minutes of it is 36 000 identical entries in an
 * object the harness serialises, and the first occurrence — the one worth
 * reading — is buried under them.
 *
 * So repeats collapse onto a counter and the distinct set is capped, while
 * `systems.failed[scope]` keeps carrying the latest detail per scope.
 */

import { describe, expect, it } from 'vitest';
import { recordError, type IIntegrationDiagnostics } from '../diagnostics';

/** Only the two fields `recordError` touches. */
function stubDiagnostics(): IIntegrationDiagnostics {
  return {
    errors: [],
    systems: { online: [], skipped: {}, failed: {} },
  } as unknown as IIntegrationDiagnostics;
}

describe('recordError', () => {
  it('counts a repeated failure instead of appending it 36 000 times', () => {
    const diagnostics = stubDiagnostics();
    for (let frame = 0; frame < 600; frame++) {
      recordError(diagnostics, 'frame', new Error('cannot read properties of undefined'));
    }
    expect(diagnostics.errors).toEqual(['frame: cannot read properties of undefined (x600)']);
    expect(diagnostics.systems.failed['frame']).toBe('cannot read properties of undefined');
  });

  it('keeps distinct failures apart, and the first ones when there are too many', () => {
    const diagnostics = stubDiagnostics();
    recordError(diagnostics, 'sky', new Error('hdri 404'));
    recordError(diagnostics, 'audio', 'no output device');
    expect(diagnostics.errors).toEqual(['sky: hdri 404', 'audio: no output device']);

    for (let i = 0; i < 500; i++) recordError(diagnostics, 'frame', new Error(`unique ${i}`));

    const errors = diagnostics.errors!;
    // The boot-time errors are still at the top, where a reader looks first.
    expect(errors[0]).toBe('sky: hdri 404');
    expect(errors[1]).toBe('audio: no output device');
    // Bounded, and the suppressed count is stated rather than lost.
    expect(errors.length).toBeLessThan(70);
    expect(errors[errors.length - 1]).toMatch(
      /^diagnostics: further distinct errors suppressed \(x\d+\)$/
    );
    // The latest detail for the scope is never stale.
    expect(diagnostics.systems.failed['frame']).toBe('unique 499');
  });
});
