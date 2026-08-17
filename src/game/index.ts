/**
 * GAME COMPOSITION BARREL
 *
 *   import { Game } from '@/game';
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS DIRECTORY IS THE ONE EXCEPTION TO THE ARCHITECTURAL RULE
 *
 *  `src/types/index.ts` states it plainly: a system imports `@/types` and
 *  `@/util` and never another system's implementation. Everything under
 *  `src/game/` breaks that rule ON PURPOSE and is the only place allowed to —
 *  somebody has to hold a `Renderer` and a `CrowdSystem` at the same time, and
 *  concentrating that in one directory is what keeps the other twenty-six
 *  independently buildable, testable and replaceable.
 *
 *  The rule that replaces it here: NOTHING IMPORTS `@/game`. Not a system, not
 *  a harness, not a test. An import pointing this way is a cycle and a system
 *  that can no longer be booted on its own.
 * ══════════════════════════════════════════════════════════════════════════
 */

export { Game, type IBootOptions } from './game';

export {
  CityStreamer,
  type ICityStreamerOptions,
  type IResidentChunk,
} from './city-streamer';

export { CityMaterialLibrary } from './city-materials';

export {
  CombatTargetBridge,
  ThreatBridge,
  WitnessBridge,
  auditAimPoints,
  perceivableTargets,
  type ICombatSyncReport,
} from './bridges';

export {
  createDiagnostics,
  recordError,
  type IBootTimings,
  type IFrameTimings,
  type IIntegrationDiagnostics,
  type ISystemDiagnostics,
  type IWorldDiagnostics,
} from './diagnostics';

export * from './config';
