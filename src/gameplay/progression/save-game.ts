/**
 * SAVE / LOAD
 *
 * ── THREE BACKENDS, ONE INTERFACE ──────────────────────────────────────────
 *   Capacitor Preferences — the shipping path on Android. Backed by
 *                           SharedPreferences, survives app updates, and is
 *                           not wiped by "clear browsing data".
 *   localStorage          — the clean web fallback, for dev and for the
 *                           browser build.
 *   memory                — Node, tests, and any environment with neither.
 *
 * `@capacitor/preferences` is imported DYNAMICALLY and only when the platform
 * is actually native. A static import pulls `@capacitor/core` into every
 * bundle and, worse, into the Node test process, where it touches `window`
 * during module evaluation. Lazy loading keeps the whole thing out of the way
 * of every environment that does not need it.
 *
 * ── "ROUND-TRIP MUST BE EXACT" ─────────────────────────────────────────────
 * Taken literally: `load(save(x))` must deep-equal `x`, including every float.
 * `JSON.stringify` emits the shortest decimal that round-trips to the same
 * double, and `JSON.parse` reads it back to the same double, so IEEE-754
 * values survive intact. What does NOT survive is anything JSON cannot
 * express, so `validate()` rejects `NaN`, `Infinity` and `undefined` inside
 * the payload at SAVE time rather than letting them silently become `null` and
 * corrupt a player's file.
 */

import type { ISaveGame, IProgressionState, QuestState } from '@/types';
import { createLogger } from '@/util';
import { SAVE_KEY, SAVE_VERSION } from './constants';

const log = createLogger('gameplay.save');

/** Minimal key/value store. Everything below is an implementation of this. */
export interface ISaveBackend {
  readonly name: 'capacitor' | 'localStorage' | 'memory';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

/** Extra state the shared `ISaveGame` contract has no field for. */
export interface ISaveExtras {
  /** Rival standings, keyed by rival id. */
  readonly rivals?: Readonly<Record<string, { points: number; shared: number; offscreen: number; joint: number }>>;
  /** Heroic deeds recorded this session, for the "how did I get here" screen. */
  readonly heroicDeeds?: readonly string[];
  /** Lunar age in days, so the sky reloads identically. */
  readonly lunarAgeDays?: number;
}

/** What is actually written. `ISaveGame` plus this workstream's extras. */
export interface IStoredSave extends ISaveGame {
  readonly extras?: ISaveExtras;
}

/* -------------------------------------------------------------------------- */
/* Backends                                                                   */
/* -------------------------------------------------------------------------- */

export class MemorySaveBackend implements ISaveBackend {
  readonly name = 'memory' as const;
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }
  async keys(): Promise<readonly string[]> {
    return [...this.store.keys()];
  }
}

export class LocalStorageSaveBackend implements ISaveBackend {
  readonly name = 'localStorage' as const;
  private readonly storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async get(key: string): Promise<string | undefined> {
    return this.storage.getItem(key) ?? undefined;
  }
  async set(key: string, value: string): Promise<void> {
    // Quota exhaustion is the one realistic failure and it must not be
    // swallowed: a save that silently did not happen is worse than a crash.
    this.storage.setItem(key, value);
  }
  async remove(key: string): Promise<void> {
    this.storage.removeItem(key);
  }
  async keys(): Promise<readonly string[]> {
    const out: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (key !== null) out.push(key);
    }
    return out;
  }
}

/** Shape of the `@capacitor/preferences` plugin actually used here. */
interface IPreferencesPlugin {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
  keys(): Promise<{ keys: string[] }>;
}

export class CapacitorSaveBackend implements ISaveBackend {
  readonly name = 'capacitor' as const;
  private readonly plugin: IPreferencesPlugin;

  constructor(plugin: IPreferencesPlugin) {
    this.plugin = plugin;
  }

  /** Resolves undefined off-device, so the caller can fall back cleanly. */
  static async open(): Promise<CapacitorSaveBackend | undefined> {
    if (!isCapacitorNative()) return undefined;
    try {
      const module = (await import('@capacitor/preferences')) as { Preferences: IPreferencesPlugin };
      return new CapacitorSaveBackend(module.Preferences);
    } catch (error) {
      log.warn(`@capacitor/preferences unavailable: ${String(error)}`);
      return undefined;
    }
  }

  async get(key: string): Promise<string | undefined> {
    const result = await this.plugin.get({ key });
    return result.value ?? undefined;
  }
  async set(key: string, value: string): Promise<void> {
    await this.plugin.set({ key, value });
  }
  async remove(key: string): Promise<void> {
    await this.plugin.remove({ key });
  }
  async keys(): Promise<readonly string[]> {
    return (await this.plugin.keys()).keys;
  }
}

function isCapacitorNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return cap?.isNativePlatform?.() === true;
}

/**
 * Pick the best available backend: Capacitor on device, localStorage in a
 * browser, memory otherwise.
 *
 * `localStorage` is probed with a real write, not with a truthiness check:
 * Safari in private mode exposes the object and throws on `setItem`, which is
 * a failure that would otherwise land on the player's first save rather than
 * here.
 */
export async function selectSaveBackend(): Promise<ISaveBackend> {
  const capacitor = await CapacitorSaveBackend.open();
  if (capacitor) return capacitor;

  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  if (storage) {
    try {
      const probe = '__saitama_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      return new LocalStorageSaveBackend(storage);
    } catch (error) {
      log.warn(`localStorage present but unusable: ${String(error)}`);
    }
  }
  return new MemorySaveBackend();
}

/* -------------------------------------------------------------------------- */
/* Manager                                                                    */
/* -------------------------------------------------------------------------- */

export interface ISaveValidationIssue {
  readonly path: string;
  readonly problem: string;
}

/**
 * Reject anything JSON cannot represent, before it reaches disk.
 *
 * `NaN` and `Infinity` both serialise to `null` and come back as `null`, which
 * would then be arithmetic on `null` for the rest of the session. Catching it
 * at save time turns a silent, permanent corruption into a loud, local one.
 */
export function validateSave(save: unknown, path = 'save'): readonly ISaveValidationIssue[] {
  const issues: ISaveValidationIssue[] = [];
  const walk = (value: unknown, at: string, depth: number): void => {
    if (depth > 32) {
      issues.push({ path: at, problem: 'nested too deeply (cycle?)' });
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) issues.push({ path: at, problem: `non-finite (${value})` });
      return;
    }
    if (value === undefined) {
      issues.push({ path: at, problem: 'undefined is dropped by JSON' });
      return;
    }
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      issues.push({ path: at, problem: `${typeof value} is not serialisable` });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(entry, `${at}[${i}]`, depth + 1));
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, `${at}.${key}`, depth + 1);
    }
  };
  walk(save, path, 0);
  return issues;
}

export interface ISaveManagerOptions {
  readonly backend?: ISaveBackend;
  readonly key?: string;
}

/** Reads and writes the save slot. */
export class SaveManager {
  private backend: ISaveBackend | undefined;
  private readonly key: string;
  private readonly explicitBackend: ISaveBackend | undefined;

  constructor(options: ISaveManagerOptions = {}) {
    this.explicitBackend = options.backend;
    this.backend = options.backend;
    this.key = options.key ?? SAVE_KEY;
  }

  /** Which store is in use. Undefined until the first call resolves it. */
  get backendName(): ISaveBackend['name'] | undefined {
    return this.backend?.name;
  }

  private async resolveBackend(): Promise<ISaveBackend> {
    this.backend ??= this.explicitBackend ?? (await selectSaveBackend());
    return this.backend;
  }

  /**
   * Write the slot.
   *
   * @throws when the payload contains a value JSON cannot round-trip.
   */
  async save(save: IStoredSave): Promise<void> {
    const issues = validateSave(save);
    if (issues.length > 0) {
      const detail = issues.map((i) => `${i.path}: ${i.problem}`).join('; ');
      throw new Error(`refusing to write a corrupt save — ${detail}`);
    }
    const backend = await this.resolveBackend();
    await backend.set(this.key, JSON.stringify(save));
    log.info(`saved to ${backend.name} (${save.questStates ? Object.keys(save.questStates).length : 0} quests)`);
  }

  /** Read the slot. Resolves undefined when empty or unreadable. */
  async load(): Promise<IStoredSave | undefined> {
    const backend = await this.resolveBackend();
    const raw = await backend.get(this.key);
    if (raw === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.error(`save slot is not valid JSON, ignoring it: ${String(error)}`);
      return undefined;
    }
    const migrated = migrate(parsed);
    if (!migrated) {
      log.error('save slot failed validation, ignoring it');
      return undefined;
    }
    return migrated;
  }

  async clear(): Promise<void> {
    const backend = await this.resolveBackend();
    await backend.remove(this.key);
  }

  async hasSave(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }
}

/**
 * Bring an older payload up to the current schema.
 *
 * Returns undefined when the payload is not a save at all, which is the
 * correct response to a key collision or to hand-edited JSON: refuse it rather
 * than load half a game.
 */
export function migrate(parsed: unknown): IStoredSave | undefined {
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const save = parsed as Partial<IStoredSave>;
  if (typeof save.version !== 'number') return undefined;
  if (save.version > SAVE_VERSION) {
    log.warn(`save is from a newer build (v${save.version} > v${SAVE_VERSION}); refusing it`);
    return undefined;
  }
  if (!save.progression || typeof save.progression !== 'object') return undefined;
  // v1 is the first schema; nothing to migrate yet. New versions add cases
  // here, oldest first, each bumping `version` as it goes.
  return save as IStoredSave;
}

/** Assemble a save payload. Kept separate so it is trivially testable. */
export function buildSave(input: {
  worldSeed: number;
  progression: IProgressionState;
  playerPosition: { x: number; y: number; z: number };
  playerYaw: number;
  timeOfDay: number;
  dayCount: number;
  questStates: Record<string, QuestState>;
  questProgress: Record<string, Record<string, number>>;
  extras?: ISaveExtras;
  savedAt?: string;
}): IStoredSave {
  return {
    version: SAVE_VERSION,
    savedAt: input.savedAt ?? new Date().toISOString(),
    worldSeed: input.worldSeed,
    progression: input.progression,
    playerPosition: { ...input.playerPosition },
    playerYaw: input.playerYaw,
    timeOfDay: input.timeOfDay,
    dayCount: input.dayCount,
    questStates: { ...input.questStates },
    questProgress: input.questProgress,
    extras: input.extras,
  };
}
