/**
 * VOICE REGISTRY — the catalogue of every sound the game can make.
 *
 * Two levels, deliberately separated:
 *
 *  • VOICE CLASSES are the pooled DSP graphs. There is one pool per class, and
 *    a pool is expensive: every instance holds free-running oscillators for the
 *    lifetime of the session.
 *  • SOUND KEYS are what gameplay asks for. Many keys share one class —
 *    `punch.normal`, `punch.heavy` and `impact.body` are the same graph with a
 *    different variant — so adding a new sound is usually free.
 *
 * This is what keeps the node count fixed. Thirty-five distinct sounds run on
 * sixteen pools; the whole engine allocates its graph once, at unlock, and
 * never again.
 *
 * `maxSeconds` is the longest tail a key can produce. The offline render tests
 * use it to size their buffers, and the voice bank uses the reported duration
 * to know when a slot frees up.
 */

import type { AudioCategory } from '@/types';
import type { ISpatialSettings } from '../panner';
import { SynthVoice } from '../voice';
import { PunchVoice } from './punch';
import { ShockwaveVoice } from './shockwave';
import { ConsecutiveVoice } from './consecutive';
import { DebrisVoice } from './debris';
import { CollapseVoice } from './collapse';
import { MonsterVoice, type MonsterUtterance } from './monster';
import { FootstepVoice, LandingVoice, WhooshVoice, WindVoice } from './locomotion';
import { CrowdBedVoice, CrowdReactionVoice } from './crowd';
import { UiVoice } from './ui';

/* -------------------------------------------------------------------------- */
/* Voice classes                                                              */
/* -------------------------------------------------------------------------- */

/** Every pooled DSP graph. */
export type VoiceClassId =
  | 'punch'
  | 'consecutive'
  | 'shockwave'
  | 'debris'
  | 'collapse'
  | 'monsterRoar'
  | 'monsterScreech'
  | 'monsterHurt'
  | 'monsterDeath'
  | 'footstep'
  | 'landing'
  | 'whoosh'
  | 'wind'
  | 'crowdBed'
  | 'crowdReaction'
  | 'ui';

/** How a pool is built. */
export interface IVoiceClassSpec {
  readonly id: VoiceClassId;
  readonly category: AudioCategory;
  /**
   * Instances in the pool. Sized against how many of this sound can plausibly
   * overlap: eight punches can, but only one building collapses at a time.
   */
  readonly poolSize: number;
  /** Sustained voices are singletons steered by a parameter, not triggered. */
  readonly sustained: boolean;
  readonly create: (ctx: BaseAudioContext, destination: AudioNode, index: number) => SynthVoice;
}

/** `index` decorrelates pooled instances that share a noise buffer. */
const offset = (index: number): number => (index * 0.6180339887) % 1;

export const VOICE_CLASSES: Record<VoiceClassId, IVoiceClassSpec> = {
  punch: {
    id: 'punch',
    category: 'sfx',
    poolSize: 8,
    sustained: false,
    create: (ctx, dest, i) => new PunchVoice(ctx, dest, 'punch', 'sfx', offset(i)),
  },
  consecutive: {
    id: 'consecutive',
    category: 'sfx',
    poolSize: 2,
    sustained: false,
    create: (ctx, dest, i) => new ConsecutiveVoice(ctx, dest, 'consecutive', 'sfx', offset(i)),
  },
  shockwave: {
    id: 'shockwave',
    category: 'sfx',
    poolSize: 3,
    sustained: false,
    create: (ctx, dest, i) => new ShockwaveVoice(ctx, dest, 'shockwave', 'sfx', offset(i)),
  },
  debris: {
    id: 'debris',
    category: 'sfx',
    poolSize: 4,
    sustained: false,
    create: (ctx, dest, i) => new DebrisVoice(ctx, dest, 'debris', 'sfx', offset(i)),
  },
  collapse: {
    id: 'collapse',
    category: 'sfx',
    poolSize: 2,
    sustained: false,
    create: (ctx, dest, i) => new CollapseVoice(ctx, dest, 'collapse', 'sfx', offset(i)),
  },
  monsterRoar: {
    id: 'monsterRoar',
    category: 'voice',
    poolSize: 3,
    sustained: false,
    create: (ctx, dest, i) => monster(ctx, dest, 'roar', i),
  },
  monsterScreech: {
    id: 'monsterScreech',
    category: 'voice',
    poolSize: 3,
    sustained: false,
    create: (ctx, dest, i) => monster(ctx, dest, 'screech', i),
  },
  monsterHurt: {
    id: 'monsterHurt',
    category: 'voice',
    poolSize: 4,
    sustained: false,
    create: (ctx, dest, i) => monster(ctx, dest, 'hurt', i),
  },
  monsterDeath: {
    id: 'monsterDeath',
    category: 'voice',
    poolSize: 2,
    sustained: false,
    create: (ctx, dest, i) => monster(ctx, dest, 'death', i),
  },
  footstep: {
    id: 'footstep',
    category: 'sfx',
    poolSize: 4,
    sustained: false,
    create: (ctx, dest, i) => new FootstepVoice(ctx, dest, 'footstep', 'sfx', offset(i)),
  },
  landing: {
    id: 'landing',
    category: 'sfx',
    poolSize: 2,
    sustained: false,
    create: (ctx, dest, i) => new LandingVoice(ctx, dest, 'landing', 'sfx', offset(i)),
  },
  whoosh: {
    id: 'whoosh',
    category: 'sfx',
    poolSize: 3,
    sustained: false,
    create: (ctx, dest, i) => new WhooshVoice(ctx, dest, 'whoosh', 'sfx', offset(i)),
  },
  wind: {
    id: 'wind',
    category: 'ambience',
    poolSize: 1,
    sustained: true,
    create: (ctx, dest, i) => new WindVoice(ctx, dest, 'wind', 'ambience', offset(i)),
  },
  crowdBed: {
    id: 'crowdBed',
    category: 'ambience',
    poolSize: 1,
    sustained: true,
    create: (ctx, dest, i) => new CrowdBedVoice(ctx, dest, 'crowdBed', 'ambience', offset(i)),
  },
  crowdReaction: {
    id: 'crowdReaction',
    category: 'ambience',
    poolSize: 2,
    sustained: false,
    create: (ctx, dest, i) => new CrowdReactionVoice(ctx, dest, 'crowdReaction', 'ambience', offset(i)),
  },
  ui: {
    id: 'ui',
    category: 'ui',
    poolSize: 3,
    sustained: false,
    create: (ctx, dest, i) => new UiVoice(ctx, dest, 'ui', 'ui', offset(i)),
  },
};

function monster(
  ctx: BaseAudioContext,
  dest: AudioNode,
  utterance: MonsterUtterance,
  index: number
): SynthVoice {
  return new MonsterVoice(ctx, dest, utterance, `monster.${utterance}`, 'voice', offset(index));
}

/* -------------------------------------------------------------------------- */
/* Sound keys                                                                 */
/* -------------------------------------------------------------------------- */

/** Every sound gameplay can ask for by name. */
export type SoundKey =
  | 'punch.normal'
  | 'punch.restrained'
  | 'punch.heavy'
  | 'punch.consecutive'
  | 'punch.flurry'
  | 'punch.barrage'
  | 'impact.body'
  | 'shockwave.serious'
  | 'shockwave.tableflip'
  | 'shockwave.blast'
  | 'debris.impact'
  | 'debris.glass'
  | 'debris.metal'
  | 'debris.wood'
  | 'collapse.building'
  | 'collapse.tower'
  | 'collapse.facade'
  | 'monster.roar'
  | 'monster.screech'
  | 'monster.hurt'
  | 'monster.death'
  | 'move.footstep'
  | 'move.landing'
  | 'move.jump'
  | 'move.dash'
  | 'move.leap'
  | 'move.wind'
  | 'ambience.crowd'
  | 'crowd.cheer'
  | 'crowd.gasp'
  | 'crowd.panic'
  | 'ui.tap'
  | 'ui.confirm'
  | 'ui.deny'
  | 'ui.alert'
  | 'ui.rankUp'
  | 'ui.victory'
  | 'ui.dark';

/** Everything the system needs to play one key. */
export interface ISoundSpec {
  readonly key: SoundKey;
  readonly voiceClass: VoiceClassId;
  /** Variant passed to the voice. */
  readonly variant: string;
  /**
   * Priority 0..1 for voice stealing. A serious punch or a boss roar must
   * never lose to a footstep, so the ordering here is load-bearing.
   */
  readonly priority: number;
  /** Default linear gain for this key. */
  readonly gain: number;
  /** Default 0..1 intensity when the caller does not supply one. */
  readonly intensity: number;
  /** Longest possible duration in seconds, including the tail. */
  readonly maxSeconds: number;
  /** Random pitch spread applied per instance, as a fraction. */
  readonly pitchVariation: number;
  /** Distance model override. Big sounds carry much further. */
  readonly spatial?: ISpatialSettings;
  /** One-line description, surfaced in the audition harness. */
  readonly description: string;
}

/** Distance profiles, in metres. */
const NEAR: ISpatialSettings = { refDistance: 4, maxDistance: 90, rolloffFactor: 1.2 };
const MID: ISpatialSettings = { refDistance: 8, maxDistance: 260, rolloffFactor: 1 };
const FAR: ISpatialSettings = { refDistance: 25, maxDistance: 1200, rolloffFactor: 0.7 };
const HUGE: ISpatialSettings = { refDistance: 60, maxDistance: 3000, rolloffFactor: 0.55 };

export const SOUND_SPECS: Record<SoundKey, ISoundSpec> = {
  'punch.normal': {
    key: 'punch.normal',
    voiceClass: 'punch',
    variant: 'normal',
    priority: 0.6,
    gain: 0.9,
    intensity: 0.55,
    maxSeconds: 0.5,
    pitchVariation: 0.06,
    spatial: MID,
    description: 'Ordinary punch: sub sweep, noise body, contact tick.',
  },
  'punch.restrained': {
    key: 'punch.restrained',
    voiceClass: 'punch',
    variant: 'restrained',
    priority: 0.45,
    gain: 0.75,
    intensity: 0.3,
    maxSeconds: 0.35,
    pitchVariation: 0.06,
    spatial: NEAR,
    description: 'Pulled punch used around civilians. Less sub, softer contact.',
  },
  'punch.heavy': {
    key: 'punch.heavy',
    voiceClass: 'punch',
    variant: 'heavy',
    priority: 0.7,
    gain: 1,
    intensity: 0.85,
    maxSeconds: 0.7,
    pitchVariation: 0.05,
    spatial: MID,
    description: 'Committed strike: uppercut or slam. Deeper and longer.',
  },
  'punch.consecutive': {
    key: 'punch.consecutive',
    voiceClass: 'consecutive',
    variant: 'consecutive',
    priority: 0.75,
    gain: 0.9,
    intensity: 0.6,
    maxSeconds: 2.2,
    pitchVariation: 0.03,
    spatial: MID,
    description: 'Consecutive Normal Punches: a chain with rising pitch per hit.',
  },
  'punch.flurry': {
    key: 'punch.flurry',
    voiceClass: 'consecutive',
    variant: 'flurry',
    priority: 0.65,
    gain: 0.85,
    intensity: 0.5,
    maxSeconds: 1.2,
    pitchVariation: 0.04,
    spatial: MID,
    description: 'A short two-to-four hit combo.',
  },
  'punch.barrage': {
    key: 'punch.barrage',
    voiceClass: 'consecutive',
    variant: 'barrage',
    priority: 0.8,
    gain: 0.9,
    intensity: 0.9,
    maxSeconds: 2.6,
    pitchVariation: 0.02,
    spatial: MID,
    description: 'The fastest chain the character throws.',
  },
  'impact.body': {
    key: 'impact.body',
    voiceClass: 'punch',
    variant: 'body',
    priority: 0.25,
    gain: 0.55,
    intensity: 0.4,
    maxSeconds: 0.4,
    pitchVariation: 0.12,
    spatial: NEAR,
    description: 'Dull body/ragdoll contact for physics impulses.',
  },
  'shockwave.serious': {
    key: 'shockwave.serious',
    voiceClass: 'shockwave',
    variant: 'serious',
    priority: 1,
    gain: 1,
    intensity: 0.85,
    maxSeconds: 4,
    pitchVariation: 0.02,
    spatial: HUGE,
    description: 'Serious punch. Resonant lowpass sweep, sub drop, long air tail.',
  },
  'shockwave.tableflip': {
    key: 'shockwave.tableflip',
    voiceClass: 'shockwave',
    variant: 'tableflip',
    priority: 1,
    gain: 1,
    intensity: 1,
    maxSeconds: 6.5,
    pitchVariation: 0,
    spatial: HUGE,
    description: 'Serious Series: Table Flip. Longer, lower, apocalyptic.',
  },
  'shockwave.blast': {
    key: 'shockwave.blast',
    voiceClass: 'shockwave',
    variant: 'blast',
    priority: 0.8,
    gain: 0.9,
    intensity: 0.6,
    maxSeconds: 2,
    pitchVariation: 0.04,
    spatial: FAR,
    description: 'The smaller blast wake of a heavy strike.',
  },
  'debris.impact': {
    key: 'debris.impact',
    voiceClass: 'debris',
    variant: 'concrete',
    priority: 0.4,
    gain: 0.8,
    intensity: 0.4,
    maxSeconds: 2,
    pitchVariation: 0.15,
    spatial: MID,
    description: 'Granular concrete debris cloud, density driven by chunk count.',
  },
  'debris.glass': {
    key: 'debris.glass',
    voiceClass: 'debris',
    variant: 'glass',
    priority: 0.45,
    gain: 0.7,
    intensity: 0.4,
    maxSeconds: 2,
    pitchVariation: 0.15,
    spatial: MID,
    description: 'Glass debris: bright, high-Q, long ringing grains.',
  },
  'debris.metal': {
    key: 'debris.metal',
    voiceClass: 'debris',
    variant: 'metal',
    priority: 0.45,
    gain: 0.75,
    intensity: 0.4,
    maxSeconds: 2.2,
    pitchVariation: 0.15,
    spatial: MID,
    description: 'Metal debris: resonant, clanging grains.',
  },
  'debris.wood': {
    key: 'debris.wood',
    voiceClass: 'debris',
    variant: 'wood',
    priority: 0.4,
    gain: 0.75,
    intensity: 0.4,
    maxSeconds: 1.8,
    pitchVariation: 0.15,
    spatial: MID,
    description: 'Wood debris: short, mid-range, dry grains.',
  },
  'collapse.building': {
    key: 'collapse.building',
    voiceClass: 'collapse',
    variant: 'building',
    priority: 0.95,
    gain: 1,
    intensity: 0.7,
    maxSeconds: 8,
    pitchVariation: 0.05,
    spatial: HUGE,
    description: 'Mid-rise collapse: groan, brown-noise rumble, crackle, settle.',
  },
  'collapse.tower': {
    key: 'collapse.tower',
    voiceClass: 'collapse',
    variant: 'tower',
    priority: 1,
    gain: 1,
    intensity: 0.9,
    maxSeconds: 12,
    pitchVariation: 0.03,
    spatial: HUGE,
    description: 'Tower collapse. Longer, lower, far more material.',
  },
  'collapse.facade': {
    key: 'collapse.facade',
    voiceClass: 'collapse',
    variant: 'facade',
    priority: 0.7,
    gain: 0.85,
    intensity: 0.5,
    maxSeconds: 4,
    pitchVariation: 0.08,
    spatial: FAR,
    description: 'A facade shedding: short, material-dominated.',
  },
  'monster.roar': {
    key: 'monster.roar',
    voiceClass: 'monsterRoar',
    variant: 'demon',
    priority: 0.9,
    gain: 0.95,
    intensity: 0.7,
    maxSeconds: 6,
    pitchVariation: 0.05,
    spatial: FAR,
    description: 'Threat-tiered roar. FM source, formant body, growl roughness.',
  },
  'monster.screech': {
    key: 'monster.screech',
    voiceClass: 'monsterScreech',
    variant: 'tiger',
    priority: 0.85,
    gain: 0.85,
    intensity: 0.7,
    maxSeconds: 4,
    pitchVariation: 0.07,
    spatial: FAR,
    description: 'High, inharmonic shriek.',
  },
  'monster.hurt': {
    key: 'monster.hurt',
    voiceClass: 'monsterHurt',
    variant: 'demon',
    priority: 0.55,
    gain: 0.75,
    intensity: 0.5,
    maxSeconds: 2,
    pitchVariation: 0.1,
    spatial: MID,
    description: 'Took a hit and survived. Short, clipped, falling.',
  },
  'monster.death': {
    key: 'monster.death',
    voiceClass: 'monsterDeath',
    variant: 'demon',
    priority: 0.85,
    gain: 0.9,
    intensity: 0.8,
    maxSeconds: 7,
    pitchVariation: 0.06,
    spatial: FAR,
    description: 'Pitch collapses, growl slows, throat rattles out.',
  },
  'move.footstep': {
    key: 'move.footstep',
    voiceClass: 'footstep',
    variant: 'concrete',
    priority: 0.15,
    gain: 0.55,
    intensity: 0.5,
    maxSeconds: 0.6,
    pitchVariation: 0.1,
    spatial: NEAR,
    description: 'Surface-dependent footstep: scuff plus body thump.',
  },
  'move.landing': {
    key: 'move.landing',
    voiceClass: 'landing',
    variant: 'normal',
    priority: 0.55,
    gain: 0.85,
    intensity: 0.5,
    maxSeconds: 3,
    pitchVariation: 0.07,
    spatial: MID,
    description: 'Touchdown. Becomes a crater at high impact speed.',
  },
  'move.jump': {
    key: 'move.jump',
    voiceClass: 'whoosh',
    variant: 'jump',
    priority: 0.3,
    gain: 0.8,
    intensity: 0.5,
    maxSeconds: 0.8,
    pitchVariation: 0.09,
    spatial: NEAR,
    description: 'Rising air whoosh on the way up.',
  },
  'move.dash': {
    key: 'move.dash',
    voiceClass: 'whoosh',
    variant: 'dash',
    priority: 0.35,
    gain: 0.85,
    intensity: 0.6,
    maxSeconds: 0.8,
    pitchVariation: 0.08,
    spatial: NEAR,
    description: 'Fall-then-rise pass-by whoosh with a bent tone.',
  },
  'move.leap': {
    key: 'move.leap',
    voiceClass: 'whoosh',
    variant: 'leap',
    priority: 0.45,
    gain: 0.8,
    intensity: 0.8,
    maxSeconds: 1.4,
    pitchVariation: 0.06,
    spatial: MID,
    description: 'A leap big enough to crack the ground it left.',
  },
  'move.wind': {
    key: 'move.wind',
    voiceClass: 'wind',
    variant: 'default',
    priority: 0.2,
    gain: 0.8,
    intensity: 0,
    maxSeconds: Number.POSITIVE_INFINITY,
    pitchVariation: 0,
    description: 'Sustained wind. Three bands, centre frequency rises with speed.',
  },
  'ambience.crowd': {
    key: 'ambience.crowd',
    voiceClass: 'crowdBed',
    variant: 'default',
    priority: 0.2,
    gain: 0.9,
    intensity: 0.3,
    maxSeconds: Number.POSITIVE_INFINITY,
    pitchVariation: 0,
    description: 'Sustained crowd bed with sparse vocal blips; density-driven.',
  },
  'crowd.cheer': {
    key: 'crowd.cheer',
    voiceClass: 'crowdReaction',
    variant: 'cheer',
    priority: 0.5,
    gain: 0.85,
    intensity: 0.6,
    maxSeconds: 2.5,
    pitchVariation: 0.05,
    spatial: FAR,
    description: 'Relief and applause when a civilian is saved.',
  },
  'crowd.gasp': {
    key: 'crowd.gasp',
    voiceClass: 'crowdReaction',
    variant: 'gasp',
    priority: 0.5,
    gain: 0.95,
    intensity: 0.6,
    maxSeconds: 1.6,
    pitchVariation: 0.05,
    spatial: FAR,
    description: 'A collective intake of breath.',
  },
  'crowd.panic': {
    key: 'crowd.panic',
    voiceClass: 'crowdReaction',
    variant: 'panic',
    priority: 0.6,
    gain: 0.9,
    intensity: 0.8,
    maxSeconds: 3.5,
    pitchVariation: 0.05,
    spatial: FAR,
    description: 'Screaming and scattering: a fight going wrong.',
  },
  'ui.tap': {
    key: 'ui.tap',
    voiceClass: 'ui',
    variant: 'tap',
    priority: 0.4,
    gain: 0.7,
    intensity: 0.6,
    maxSeconds: 0.2,
    pitchVariation: 0.02,
    description: 'Button press. As small as a sound can be and still register.',
  },
  'ui.confirm': {
    key: 'ui.confirm',
    voiceClass: 'ui',
    variant: 'confirm',
    priority: 0.5,
    gain: 0.75,
    intensity: 0.7,
    maxSeconds: 0.5,
    pitchVariation: 0,
    description: 'Accepted: a rising perfect fifth.',
  },
  'ui.deny': {
    key: 'ui.deny',
    voiceClass: 'ui',
    variant: 'deny',
    priority: 0.5,
    gain: 0.75,
    intensity: 0.7,
    maxSeconds: 0.6,
    pitchVariation: 0,
    description: 'Rejected: a falling, bending minor third with grit.',
  },
  'ui.alert': {
    key: 'ui.alert',
    voiceClass: 'ui',
    variant: 'alert',
    priority: 0.8,
    gain: 0.8,
    intensity: 0.9,
    maxSeconds: 1,
    pitchVariation: 0,
    description: 'Threat detected. Two repeated falling pulses.',
  },
  'ui.rankUp': {
    key: 'ui.rankUp',
    voiceClass: 'ui',
    variant: 'rankUp',
    priority: 0.9,
    gain: 0.85,
    intensity: 1,
    maxSeconds: 2.5,
    pitchVariation: 0,
    description: 'Promotion: ascending arpeggio over a rising shimmer.',
  },
  'ui.victory': {
    key: 'ui.victory',
    voiceClass: 'ui',
    variant: 'victory',
    priority: 0.85,
    gain: 0.8,
    intensity: 0.9,
    maxSeconds: 2,
    pitchVariation: 0,
    description: 'Encounter won. Shorter and warmer than a promotion.',
  },
  'ui.dark': {
    key: 'ui.dark',
    voiceClass: 'ui',
    variant: 'dark',
    priority: 0.85,
    gain: 0.8,
    intensity: 0.9,
    maxSeconds: 3,
    pitchVariation: 0,
    description: 'Something went wrong. Beating semitone, sinking, uncomfortable.',
  },
};

/** Every sound key, in declaration order. */
export const SOUND_KEYS = Object.keys(SOUND_SPECS) as SoundKey[];

/** True when `key` names a real sound. */
export function isSoundKey(key: string): key is SoundKey {
  return Object.prototype.hasOwnProperty.call(SOUND_SPECS, key);
}

/** Look up a spec, or undefined for an unknown key. */
export function soundSpec(key: string): ISoundSpec | undefined {
  return isSoundKey(key) ? SOUND_SPECS[key] : undefined;
}
