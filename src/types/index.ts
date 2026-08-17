/**
 * INTERFACE CONTRACT BARREL
 *
 * Single import site for every shared contract:
 *
 *   import type { IEngineContext, IEventBus, GameEvent } from '@/types';
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE ARCHITECTURAL RULE OF THIS CODEBASE
 *
 *  Systems import ONLY from `src/types/` and `src/util/`.
 *  A system must NEVER import another system's implementation module.
 *  All cross-system communication goes through the event bus (events.ts).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every file re-exported here is TYPE-ONLY and erases completely at build
 * time, so importing this barrel costs nothing at runtime.
 *
 * SYMBOL OWNERSHIP — each name is defined in exactly ONE file. When you need a
 * type that already exists, import it; never redeclare it. Notable homes that
 * are easy to guess wrong:
 *
 *   IRenderer, RenderStats, IRendererCapabilities, MaterialSpec  -> render.ts
 *   ThreatTier, LethalIntent, HitInfo, IPunchEvent, IDamageable  -> combat.ts
 *   IDestructible, FractureChunk, DestructionMode                -> destruction.ts
 *   ClipName, BoneName, BodyProfile, ICharacterFactory           -> character.ts
 *   HeroClass, QuestState, DayPhase, IHeroRank                   -> gameplay.ts
 *   ILODLevel (render distance band)                             -> world.ts
 *   IAssetLOD (decimated mesh variant)                           -> assets.ts
 *   DeviceTier, SafeAreaInsets                                   -> platform.ts
 *   IQualityTier ('low'|'medium'|'high')                         -> engine.ts
 *   QualityTier  ('mobile'|'high'|'ultra')                       -> assets.ts
 */

// Foundation
export type * from './platform';
export type * from './game';
export type * from './engine';
export type * from './render';

// Content
export type * from './assets';
export type * from './character';

// Simulation
export type * from './entity';
export type * from './combat';
export type * from './destruction';
export type * from './physics';
export type * from './ai';

// World
export type * from './world';

// Systems
export type * from './gameplay';
export type * from './input';
export type * from './audio';
export type * from './vfx';
export type * from './ui';

// Cross-system communication
export type * from './events';
