/**
 * EVENT → SOUND MAPPING
 *
 * This is the audio system's entire contact surface with the rest of the game.
 * Nothing in `src/audio` imports another system; every sound the game makes
 * originates from a `GameEvent` on the bus and is translated here.
 *
 * ── EXHAUSTIVENESS IS ENFORCED, NOT REMEMBERED ─────────────────────────────
 * `EVENT_AUDIO_MAP` is typed as `{ [T in GameEventType]: IEventAudioRule<T> }`,
 * so a new member added to the `GameEvent` union breaks this file at compile
 * time until it is given a rule. `ALL_GAME_EVENT_TYPES` is checked against the
 * union the same way. There is no path by which an event can be added and
 * silently produce no audio.
 *
 * ── POWER IS UNBOUNDED ─────────────────────────────────────────────────────
 * `ShockwaveFiredEvent.power` may exceed 1e6. Normalising it linearly would
 * make every ordinary punch round to zero. `normalisePower` maps it
 * logarithmically, which is also how loudness is perceived, so a punch at 100
 * and a punch at 1e6 land at usefully different intensities instead of at the
 * two ends of a clipped ramp.
 *
 * Every rule is a PURE function of its event. It returns a description of what
 * should be heard; `AudioSystem` is what actually plays it. That split is what
 * lets the whole mapping be tested without an audio device.
 */

import type {
  AudioCategory,
  GameEvent,
  GameEventOf,
  GameEventType,
  ThreatTier,
  Vec3,
} from '@/types';
import { clamp01 } from '@/util';
import { resolveMaterial } from './voices/debris';
import { THREAT_TIERS } from './voices/monster';
import type { SoundKey } from './voices/registry';
import type { MusicState } from './music/patterns';

/* -------------------------------------------------------------------------- */
/* Response shape                                                             */
/* -------------------------------------------------------------------------- */

/** One sound the system should play in response to an event. */
export interface IAudioCue {
  readonly key: SoundKey;
  /** Overrides the key's default variant (material, threat tier, surface). */
  readonly variant?: string;
  /** 0..1 "how hard". Overrides the key default. */
  readonly intensity?: number;
  /** Linear gain multiplier on top of the key default. */
  readonly gain?: number;
  /** Pitch multiplier. */
  readonly rate?: number;
  /** World position for 3D playback. Omitted for UI and 2D cues. */
  readonly position?: Vec3;
  /** Delay in seconds before the cue starts. */
  readonly delay?: number;
  /** Overrides the key's stealing priority. */
  readonly priority?: number;
}

/** A ducking request produced by an event. */
export interface IDuckRequest {
  readonly category: AudioCategory;
  readonly to: number;
  readonly attack: number;
  readonly hold: number;
  readonly release: number;
}

/** Ambience parameters an event can move. */
export interface IAmbienceRequest {
  /** 0..1 crowd density. */
  readonly crowdDensity?: number;
  /** 0..1 wind level. */
  readonly wind?: number;
  /** Normalised time of day 0..1, for day/night ambience shaping. */
  readonly timeOfDay?: number;
  /** True when the streaming set changed and density must be recomputed. */
  readonly recomputeDensity?: boolean;
}

/** Everything an event asks the audio system to do. */
export interface IAudioResponse {
  readonly cues: readonly IAudioCue[];
  /** Requested music intensity state. */
  readonly music?: MusicState;
  /** Requested boredom value 0..1 for the arrangement thinner. */
  readonly boredom?: number;
  readonly duck?: IDuckRequest;
  readonly ambience?: IAmbienceRequest;
}

/** What kind of non-cue effect a rule can have, for documentation and tests. */
export type EventEffectKind = 'music' | 'duck' | 'ambience' | 'boredom';

/** The rule for one event type. */
export interface IEventAudioRule<T extends GameEventType> {
  readonly type: T;
  /** One line, surfaced in the audition harness and the docs. */
  readonly summary: string;
  /** Every sound key this rule can possibly emit. */
  readonly sounds: readonly SoundKey[];
  /** Every non-cue effect this rule can possibly have. */
  readonly effects: readonly EventEffectKind[];
  /** Pure: event in, description of what to hear out. */
  readonly resolve: (event: GameEventOf<T>) => IAudioResponse;
}

/** The complete map. Exhaustive over the event union by construction. */
export type EventAudioMap = { readonly [T in GameEventType]: IEventAudioRule<T> };

/* -------------------------------------------------------------------------- */
/* Scaling helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Map an unbounded force value onto 0..1 logarithmically.
 *
 * `power` spans roughly 10 (a tap) to 1e6+ (a serious punch). A linear
 * normalisation would put every ordinary hit within 0.001 of zero. Six decades
 * of log range spread across the dial matches both the design intent and the
 * way loudness is actually perceived.
 */
export function normalisePower(power: number): number {
  if (!Number.isFinite(power) || power <= 1) return 0;
  return clamp01(Math.log10(power) / 6);
}

/** Map a metres-per-second impact speed onto 0..1. */
export function normaliseSpeed(speed: number, max = 60): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return clamp01(speed / max);
}

/** Map a chunk mass in kilograms onto 0..1. */
export function normaliseMass(mass: number): number {
  if (!Number.isFinite(mass) || mass <= 0) return 0;
  return clamp01(Math.log10(1 + mass) / 3.2);
}

/** Threat tier as an ascending 0..1 scalar. */
export function tierScalar(tier: ThreatTier | undefined): number {
  const index = tier ? THREAT_TIERS.indexOf(tier) : 2;
  return index < 0 ? 0.5 : index / (THREAT_TIERS.length - 1);
}

/** Music state implied by a threat tier. */
function musicForTier(tier: ThreatTier | undefined, isBoss: boolean): MusicState {
  if (isBoss) return 'boss';
  if (!tier) return 'alert';
  if (tier === 'dragon' || tier === 'god') return 'boss';
  if (tier === 'demon') return 'combat';
  return 'alert';
}

/** Debris key for a material string reported by the destruction system. */
function debrisKeyFor(material: string): SoundKey {
  switch (resolveMaterial(material)) {
    case 'glass':
      return 'debris.glass';
    case 'metal':
      return 'debris.metal';
    case 'glassAndSteel':
      return 'debris.glass';
    case 'wood':
      return 'debris.wood';
    default:
      return 'debris.impact';
  }
}

/** Ducking profile used whenever an impact needs the mix to get out of the way. */
const IMPACT_DUCK: IDuckRequest = {
  category: 'music',
  to: 0.25,
  attack: 0.02,
  hold: 0.35,
  release: 0.7,
};

/** A gentler duck for narrative stingers. */
const STINGER_DUCK: IDuckRequest = {
  category: 'music',
  to: 0.45,
  attack: 0.08,
  hold: 0.5,
  release: 0.9,
};

/* -------------------------------------------------------------------------- */
/* The map                                                                    */
/* -------------------------------------------------------------------------- */

export const EVENT_AUDIO_MAP: EventAudioMap = {
  /* ---- Combat --------------------------------------------------------- */

  ShockwaveFired: {
    type: 'ShockwaveFired',
    summary:
      'The punch itself. Kind selects the voice family; log-scaled power drives intensity; serious hits duck the music.',
    sounds: [
      'punch.normal',
      'punch.restrained',
      'punch.heavy',
      'punch.consecutive',
      'punch.barrage',
      'shockwave.serious',
      'shockwave.tableflip',
      'shockwave.blast',
      'impact.body',
    ],
    effects: ['duck'],
    resolve: (e) => {
      const power = normalisePower(e.power);
      const at = e.origin;
      switch (e.punchKind) {
        case 'serious':
          return {
            cues: [{ key: 'shockwave.serious', intensity: Math.max(power, 0.6), position: at }],
            duck: IMPACT_DUCK,
          };
        case 'seriousTableflip':
          return {
            cues: [{ key: 'shockwave.tableflip', intensity: 1, position: at }],
            duck: { ...IMPACT_DUCK, to: 0.12, hold: 1.2, release: 1.6 },
          };
        case 'consecutive':
          return {
            cues: [
              {
                key: power > 0.7 ? 'punch.barrage' : 'punch.consecutive',
                intensity: power,
                position: at,
              },
            ],
            duck: power > 0.7 ? IMPACT_DUCK : undefined,
          };
        case 'heavy':
        case 'slam':
        case 'uppercut':
          return {
            cues: [
              { key: 'punch.heavy', intensity: power, position: at },
              // A heavy hit above the halfway mark also displaces air.
              ...(power > 0.5
                ? [{ key: 'shockwave.blast' as SoundKey, intensity: power, position: at }]
                : []),
            ],
            duck: power > 0.65 ? IMPACT_DUCK : undefined,
          };
        case 'environmental':
          return { cues: [{ key: 'impact.body', intensity: power, position: at }] };
        case 'normal':
        default:
          return {
            cues: [
              {
                key: e.intent === 'restrained' ? 'punch.restrained' : 'punch.normal',
                intensity: power,
                position: at,
              },
            ],
          };
      }
    },
  },

  EntityDamaged: {
    type: 'EntityDamaged',
    summary:
      'Contact on a target: an impact sized by intent, plus a hurt vocalisation when the target is a monster.',
    sounds: ['punch.normal', 'punch.restrained', 'punch.heavy', 'impact.body', 'monster.hurt'],
    effects: [],
    resolve: (e) => {
      const hurtFraction = clamp01(e.amount / Math.max(e.maxHealth, 1));
      const impactKey: SoundKey =
        e.intent === 'restrained'
          ? 'punch.restrained'
          : e.intent === 'serious' || e.intent === 'full'
            ? 'punch.heavy'
            : 'punch.normal';
      const cues: IAudioCue[] = [
        {
          key: impactKey,
          intensity: clamp01(hurtFraction * 1.4 + (e.critical ? 0.25 : 0)),
          gain: e.critical ? 1.15 : 1,
          position: e.point,
        },
      ];
      if (e.entityType === 'monster' || e.faction === 'monster') {
        cues.push({
          key: 'monster.hurt',
          intensity: clamp01(0.35 + hurtFraction),
          position: e.point,
          // Offset so the reaction follows the hit rather than masking it.
          delay: 0.06,
        });
      } else if (e.entityType !== 'prop') {
        cues.push({ key: 'impact.body', intensity: hurtFraction, position: e.point, delay: 0.02 });
      }
      return { cues };
    },
  },

  EntityKilled: {
    type: 'EntityKilled',
    summary: 'A death: tier-scaled monster death cry, or a body impact for anything else.',
    sounds: ['monster.death', 'impact.body', 'crowd.gasp'],
    effects: ['duck'],
    resolve: (e) => {
      if (e.entityType === 'monster' || e.faction === 'monster') {
        const tier = e.threatTier ?? 'demon';
        return {
          cues: [
            { key: 'monster.death', variant: tier, intensity: 0.5 + tierScalar(tier) * 0.5, position: e.position },
            { key: 'impact.body', intensity: 0.5, position: e.position },
          ],
          duck: tierScalar(tier) > 0.6 ? STINGER_DUCK : undefined,
        };
      }
      return { cues: [{ key: 'impact.body', intensity: 0.55, position: e.position }] };
    },
  },

  ImpulseApplied: {
    type: 'ImpulseApplied',
    summary:
      'A physics impulse: a dull body contact scaled by impulse magnitude. Low priority and rate-limited, since ragdolls emit these in bursts.',
    sounds: ['impact.body'],
    effects: [],
    resolve: (e) => {
      const magnitude = Math.hypot(e.impulse.x, e.impulse.y, e.impulse.z);
      const intensity = clamp01(Math.log10(1 + magnitude) / 3);
      return {
        cues: [
          {
            key: 'impact.body',
            intensity,
            gain: 0.7,
            position: e.point,
            priority: 0.12,
          },
        ],
      };
    },
  },

  /* ---- Destruction ---------------------------------------------------- */

  ChunkDetached: {
    type: 'ChunkDetached',
    summary:
      'One fracture chunk. Material selects the grain character, mass drives density. Aggregated per frame by the audio system so a collapse becomes one grain cloud, never a hundred one-shots.',
    sounds: ['debris.impact', 'debris.glass', 'debris.metal', 'debris.wood'],
    effects: [],
    resolve: (e) => ({
      cues: [
        {
          key: debrisKeyFor(e.material),
          variant: resolveMaterial(e.material),
          intensity: normaliseMass(e.mass),
          position: e.position,
          priority: 0.35,
        },
      ],
    }),
  },

  /* ---- Civilians and allies ------------------------------------------- */

  CivilianSaved: {
    type: 'CivilianSaved',
    summary: 'Relief: a crowd cheer at the rescue, plus a confirmation chime when the player did it.',
    sounds: ['crowd.cheer', 'ui.confirm'],
    effects: [],
    resolve: (e) => ({
      cues: [
        { key: 'crowd.cheer', intensity: e.byPlayer ? 0.8 : 0.5, position: e.position },
        ...(e.byPlayer ? [{ key: 'ui.confirm' as SoundKey, intensity: 0.7 }] : []),
      ],
    }),
  },

  CivilianLost: {
    type: 'CivilianLost',
    summary:
      'A civilian died. A collective gasp, and — when the player caused it — the dark stinger that ducks the music. This is the game telling the player off.',
    sounds: ['crowd.gasp', 'ui.dark'],
    effects: ['duck'],
    resolve: (e) => ({
      cues: [
        { key: 'crowd.gasp', intensity: e.causedByPlayer ? 0.9 : 0.6, position: e.position },
        ...(e.causedByPlayer ? [{ key: 'ui.dark' as SoundKey, intensity: 0.9 }] : []),
      ],
      duck: e.causedByPlayer ? STINGER_DUCK : undefined,
    }),
  },

  AllyDowned: {
    type: 'AllyDowned',
    summary: 'A friendly hero fell: dark stinger plus a crowd gasp at the location.',
    sounds: ['ui.dark', 'crowd.gasp'],
    effects: ['duck'],
    resolve: (e) => ({
      cues: [
        { key: 'ui.dark', intensity: 0.8 },
        { key: 'crowd.gasp', intensity: 0.7, position: e.position, delay: 0.15 },
      ],
      duck: STINGER_DUCK,
    }),
  },

  /* ---- Encounters ----------------------------------------------------- */

  EncounterStarted: {
    type: 'EncounterStarted',
    summary:
      'A fight begins: an alert, a tier-scaled roar, and the music escalates to combat or boss on the next bar.',
    sounds: ['ui.alert', 'monster.roar', 'crowd.panic'],
    effects: ['music', 'duck'],
    resolve: (e) => ({
      cues: [
        { key: 'ui.alert', intensity: e.isBoss ? 1 : 0.7 },
        {
          key: 'monster.roar',
          variant: e.threatTier,
          intensity: 0.5 + tierScalar(e.threatTier) * 0.5,
          position: e.position,
          delay: 0.25,
        },
        // A serious threat sends the street running.
        ...(tierScalar(e.threatTier) >= 0.5
          ? [{ key: 'crowd.panic' as SoundKey, intensity: tierScalar(e.threatTier), position: e.position, delay: 0.5 }]
          : []),
      ],
      music: musicForTier(e.threatTier, e.isBoss),
      duck: e.isBoss ? STINGER_DUCK : undefined,
    }),
  },

  EncounterEnded: {
    type: 'EncounterEnded',
    summary: 'The fight is over: a victory or dark sting, and the music falls back to exploration.',
    sounds: ['ui.victory', 'ui.dark', 'crowd.cheer'],
    effects: ['music'],
    resolve: (e) => {
      if (e.outcome === 'victory') {
        return {
          cues: [
            { key: 'ui.victory', intensity: 0.9 },
            // Only cheer if the fight did not cost lives — the crowd knows.
            ...(e.civiliansLost === 0
              ? [{ key: 'crowd.cheer' as SoundKey, intensity: 0.6, delay: 0.4 }]
              : []),
          ],
          music: 'calm',
        };
      }
      if (e.outcome === 'defeat') {
        return { cues: [{ key: 'ui.dark', intensity: 1 }], music: 'calm' };
      }
      return { cues: [{ key: 'ui.tap', intensity: 0.5 }], music: 'calm' };
    },
  },

  BossPhaseChanged: {
    type: 'BossPhaseChanged',
    summary:
      'A boss escalates: a roar sized by how close it is to its final phase, a hard duck, and the boss layer.',
    sounds: ['monster.roar', 'ui.alert'],
    effects: ['music', 'duck'],
    resolve: (e) => ({
      cues: [
        {
          key: 'monster.roar',
          variant: e.isFinalPhase ? 'god' : 'dragon',
          intensity: e.isFinalPhase ? 1 : 0.7 + 0.3 * (1 - clamp01(e.healthFraction)),
        },
        ...(e.isFinalPhase ? [{ key: 'ui.alert' as SoundKey, intensity: 1 }] : []),
      ],
      music: 'boss',
      duck: { ...IMPACT_DUCK, to: 0.2, hold: 0.9, release: 1.2 },
    }),
  },

  /* ---- Progression ---------------------------------------------------- */

  QuestStateChanged: {
    type: 'QuestStateChanged',
    summary: 'Quest lifecycle: confirm on accept and completion, deny on failure, a tap otherwise.',
    sounds: ['ui.confirm', 'ui.deny', 'ui.tap', 'ui.victory'],
    effects: [],
    resolve: (e) => {
      switch (e.state) {
        case 'completed':
          return { cues: [{ key: 'ui.victory', intensity: 0.8 }] };
        case 'failed':
          return { cues: [{ key: 'ui.deny', intensity: 0.9 }] };
        case 'active':
          return { cues: [{ key: 'ui.confirm', intensity: 0.8 }] };
        case 'available':
          return { cues: [{ key: 'ui.tap', intensity: 0.7 }] };
        case 'locked':
        default:
          return { cues: [{ key: 'ui.tap', intensity: 0.4 }] };
      }
    },
  },

  RankChanged: {
    type: 'RankChanged',
    summary: 'Hero Association standing moved: the promotion fanfare, or the deny motif on demotion.',
    sounds: ['ui.rankUp', 'ui.deny'],
    effects: ['duck'],
    resolve: (e) =>
      e.promoted
        ? { cues: [{ key: 'ui.rankUp', intensity: 1 }], duck: STINGER_DUCK }
        : { cues: [{ key: 'ui.deny', intensity: 0.9 }] },
  },

  BoredomChanged: {
    type: 'BoredomChanged',
    summary:
      'Boredom drives the arrangement thinner. At the top of the range the score collapses to a single sustained tone — the audio half of the global desaturation.',
    sounds: [],
    effects: ['boredom', 'music'],
    resolve: (e) => {
      const value = clamp01(e.value);
      return {
        cues: [],
        boredom: value,
        // Crossing the collapse threshold is a real state change, not just a
        // thinner arrangement.
        music: value >= 0.8 ? 'bored' : undefined,
      };
    },
  },

  /* ---- World ---------------------------------------------------------- */

  ChunkStreamedIn: {
    type: 'ChunkStreamedIn',
    summary:
      'New geometry is resident, so the population around the listener changed: the crowd bed density is recomputed. No cue — streaming must be silent.',
    sounds: [],
    effects: ['ambience'],
    resolve: () => ({ cues: [], ambience: { recomputeDensity: true } }),
  },

  ChunkStreamedOut: {
    type: 'ChunkStreamedOut',
    summary: 'Geometry left residency: recompute crowd density. Silent by design.',
    sounds: [],
    effects: ['ambience'],
    resolve: () => ({ cues: [], ambience: { recomputeDensity: true } }),
  },

  TimeOfDayChanged: {
    type: 'TimeOfDayChanged',
    summary:
      'Day/night shapes the ambience: the street empties after dusk and the wind comes up, so crowd density falls and wind rises.',
    sounds: [],
    effects: ['ambience'],
    resolve: (e) => {
      // Population by phase. Night is not silent, it is sparse.
      const crowd: Record<string, number> = {
        dawn: 0.25,
        morning: 0.8,
        noon: 1,
        afternoon: 0.85,
        dusk: 0.5,
        night: 0.2,
        midnight: 0.08,
      };
      const wind: Record<string, number> = {
        dawn: 0.35,
        morning: 0.2,
        noon: 0.15,
        afternoon: 0.2,
        dusk: 0.3,
        night: 0.45,
        midnight: 0.5,
      };
      return {
        cues: [],
        ambience: {
          crowdDensity: crowd[e.phase] ?? 0.5,
          wind: wind[e.phase] ?? 0.3,
          timeOfDay: e.timeOfDay,
        },
      };
    },
  },

  /* ---- Player --------------------------------------------------------- */

  PlayerLanded: {
    type: 'PlayerLanded',
    summary:
      'Touchdown, scaled by impact speed. A crater landing also throws debris and pushes the mix down for a moment.',
    sounds: ['move.landing', 'debris.impact'],
    effects: ['duck'],
    resolve: (e) => {
      const speed = normaliseSpeed(e.impactSpeed);
      const intensity = clamp01(Math.max(speed, e.createsCrater ? 0.8 : 0));
      return {
        cues: [
          {
            key: 'move.landing',
            variant: e.createsCrater ? 'crater' : 'normal',
            intensity,
            position: e.position,
          },
          ...(e.createsCrater
            ? [
                {
                  key: 'debris.impact' as SoundKey,
                  intensity: clamp01(intensity * 0.9),
                  position: e.position,
                  delay: 0.05,
                },
              ]
            : []),
        ],
        duck: e.createsCrater ? { ...IMPACT_DUCK, to: 0.4, hold: 0.2, release: 0.5 } : undefined,
      };
    },
  },
};

/* -------------------------------------------------------------------------- */
/* Exhaustiveness                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every event type, as runtime data.
 *
 * TypeScript types are erased, so a runtime test cannot enumerate the union on
 * its own. This list is the bridge — and `AllTypesCovered` below makes the
 * compiler reject it the moment it falls out of sync with the union, in either
 * direction.
 */
export const ALL_GAME_EVENT_TYPES = [
  'ShockwaveFired',
  'EntityDamaged',
  'EntityKilled',
  'ImpulseApplied',
  'ChunkDetached',
  'CivilianSaved',
  'CivilianLost',
  'AllyDowned',
  'EncounterStarted',
  'EncounterEnded',
  'BossPhaseChanged',
  'QuestStateChanged',
  'RankChanged',
  'BoredomChanged',
  'ChunkStreamedIn',
  'ChunkStreamedOut',
  'TimeOfDayChanged',
  'PlayerLanded',
] as const satisfies readonly GameEventType[];

/** Compile-time proof that the runtime list covers the whole union. */
type MissingFromList = Exclude<GameEventType, (typeof ALL_GAME_EVENT_TYPES)[number]>;
/** If this line errors, an event type was added without an audio rule. */
export type AllTypesCovered = MissingFromList extends never ? true : MissingFromList;
const _allTypesCovered: AllTypesCovered = true;
void _allTypesCovered;

/**
 * Translate any event into its audio response. The single entry point used by
 * `AudioSystem`; the narrowing is done here so no caller needs a cast.
 */
export function resolveEventAudio(event: GameEvent): IAudioResponse {
  const rule = EVENT_AUDIO_MAP[event.type] as IEventAudioRule<GameEventType>;
  return rule.resolve(event);
}

/** The rule for a type, for documentation, the harness and tests. */
export function eventAudioRule<T extends GameEventType>(type: T): IEventAudioRule<T> {
  return EVENT_AUDIO_MAP[type];
}
