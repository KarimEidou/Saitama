/**
 * AUDIO SYSTEM — public surface.
 *
 * Every sound in this game is SYNTHESISED AT RUNTIME with the Web Audio API.
 * There are no audio files in the repository, none in the bundle, and none
 * fetched at runtime: punches, monsters, collapsing buildings, the crowd, the
 * interface and the entire adaptive score are built from oscillators, filters
 * and procedurally generated noise. The shipped cost of all game audio is
 * zero bytes.
 *
 * That is a design decision, not a fallback. It buys three things:
 *
 *  1. No licensing surface at all. Nothing to audit, attribute or re-clear.
 *  2. Genuinely adaptive audio. Intensity, threat tier, material, debris
 *     count, crowd density and boredom are synthesis PARAMETERS, so the sound
 *     responds continuously instead of crossfading between fixed recordings.
 *  3. A download budget spent entirely on geometry and textures.
 *
 * Usage:
 *
 *   const audio = new AudioSystem();
 *   audio.attach(bus);              // all gameplay audio flows from events
 *   button.addEventListener('pointerdown', () => void audio.unlock());
 *   // each frame:
 *   audio.setListener(camera.position, forward, up);
 *   audio.update(dt);
 */

export { AudioSystem, type IAudioSystemOptions, type ISynthPlayOptions } from './audio-system';

export { Mixer, AUDIO_CATEGORIES, type IMixerOptions } from './mixer';

export {
  SOUND_KEYS,
  SOUND_SPECS,
  VOICE_CLASSES,
  isSoundKey,
  soundSpec,
  type ISoundSpec,
  type IVoiceClassSpec,
  type SoundKey,
  type VoiceClassId,
} from './voices/registry';

export {
  EVENT_AUDIO_MAP,
  ALL_GAME_EVENT_TYPES,
  eventAudioRule,
  resolveEventAudio,
  normalisePower,
  normaliseSpeed,
  normaliseMass,
  tierScalar,
  type EventAudioMap,
  type EventEffectKind,
  type IAudioCue,
  type IAudioResponse,
  type IDuckRequest,
  type IEventAudioRule,
} from './event-map';

export {
  LAYERS,
  MUSIC_STATES,
  BOREDOM_COLLAPSE,
  BOREDOM_THIN_START,
  STEPS_PER_BAR,
  partsFor,
  secondsPerStep,
  degreeToMidi,
  type IMusicLayer,
  type IPart,
  type MusicState,
  type PartId,
} from './music/patterns';

export { MusicDirector, type IMusicDirectorOptions, type IScheduledNote } from './music/director';

export { SynthVoice, SustainedVoice, VoiceBank, type ITriggerParams } from './voice';

export { SPATIAL_DEFAULTS, type ISpatialSettings } from './panner';

export { getNoiseBuffer, createNoiseSource, type NoiseKind } from './noise';

export {
  dbToGain,
  gainToDb,
  midiToFreq,
  semitoneRatio,
  centRatio,
  softClipCurve,
  growlCurve,
  poissonOnsets,
  SILENCE,
} from './dsp';

export { THREAT_TIERS, MONSTER_UTTERANCES, type MonsterUtterance } from './voices/monster';
export { DEBRIS_MATERIALS, resolveMaterial } from './voices/debris';
export { FOOTSTEP_SURFACES, WHOOSH_VARIANTS } from './voices/locomotion';
export { CROWD_REACTIONS } from './voices/crowd';
export { UI_VARIANTS } from './voices/ui';
export { PUNCH_VARIANTS } from './voices/punch';
export { SHOCKWAVE_VARIANTS } from './voices/shockwave';
export { CONSECUTIVE_VARIANTS } from './voices/consecutive';
export { COLLAPSE_VARIANTS } from './voices/collapse';
