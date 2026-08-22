/**
 * LOGGER — RATE LIMITING MUST NOT CONSUME ITSELF
 *
 * `onceKeys` is module-global and never cleared, so a `warnOnce` key burned on
 * a message the level filter then drops can never be emitted again for the rest
 * of the process. A harness that quiets startup noise — `setLogLevel('error')`
 * or `muteNamespace('assets')` while it preloads — would therefore swallow the
 * first genuine ref-counting warning permanently. That is exactly the silent
 * failure path this module was written to avoid.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  createLogger,
  getLogLevel,
  muteNamespace,
  resetLogState,
  setLogLevel,
  unmuteNamespace,
} from '../logger';

const DEFAULT_LEVEL = getLogLevel();

describe('warnOnce', () => {
  beforeEach(() => {
    resetLogState();
  });

  afterEach(() => {
    setLogLevel(DEFAULT_LEVEL);
    unmuteNamespace('assets');
    vi.restoreAllMocks();
  });

  it('does not spend the one-shot on a message the level filter drops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('assets');

    setLogLevel('error');
    log.warnOnce('double-release:tex', 'texture released at refCount 0');
    expect(warn).not.toHaveBeenCalled();

    setLogLevel(DEFAULT_LEVEL);
    log.warnOnce('double-release:tex', 'texture released at refCount 0');
    expect(warn).toHaveBeenCalledTimes(1);

    // ...and it is still a one-shot afterwards.
    log.warnOnce('double-release:tex', 'texture released at refCount 0');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not spend the one-shot while the namespace is muted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('assets');

    muteNamespace('assets');
    log.warnOnce('role-fallback:hero', 'no material for role');
    expect(warn).not.toHaveBeenCalled();

    unmuteNamespace('assets');
    log.warnOnce('role-fallback:hero', 'no material for role');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keys are per-namespace', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createLogger('a').warnOnce('same', 'first');
    createLogger('b').warnOnce('same', 'second');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('throttle', () => {
  beforeEach(() => {
    resetLogState();
  });

  afterEach(() => {
    setLogLevel(DEFAULT_LEVEL);
    vi.restoreAllMocks();
  });

  it('does not start the interval on a call that printed nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('streaming');

    setLogLevel('error');
    log.throttle('chunk-slow', 60_000, 'chunk took too long');
    expect(warn).not.toHaveBeenCalled();

    setLogLevel(DEFAULT_LEVEL);
    log.throttle('chunk-slow', 60_000, 'chunk took too long');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('collapses a burst to one line per interval', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('streaming');
    for (let i = 0; i < 100; i++) log.throttle('burst', 60_000, 'chunk took too long');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('bounds warnOnce key memory, at the cost of a warning that may repeat', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('spawner');

    log.warnOnce('nav-missing:first', 'no nav mesh');
    log.warnOnce('nav-missing:first', 'no nav mesh');
    expect(warn).toHaveBeenCalledTimes(1);

    // A per-entity key is the natural next use of this API, and with recycled
    // entity ids over a multi-hour session it would otherwise retain one string
    // per key forever in a module-global Set.
    for (let i = 0; i < 4096; i++) log.warnOnce(`nav-missing:${i}`, 'no nav mesh');
    expect(warn).toHaveBeenCalledTimes(1 + 4096);

    // The oldest key was dropped rather than retained for the whole process,
    // so it warns a second time. That repeat is the deliberate trade.
    log.warnOnce('nav-missing:first', 'no nav mesh');
    expect(warn).toHaveBeenCalledTimes(1 + 4096 + 1);
  });
});
