/**
 * AUDIO AUDITION HARNESS
 *
 * A page for LISTENING to the synthesis engine — the one thing the offline
 * render tests cannot do. Run `npm run dev` and open `/harness/audio.html`.
 *
 * It wires up the real `AudioSystem` against a real `EventBus` and drives it
 * exactly the way the game does:
 *   • Game events are emitted onto the bus and reach audio only through
 *     `event-map.ts`. No button here calls a voice directly.
 *   • Continuous state (civilian count, player speed, boredom) is pushed
 *     through the same parameter setters the frame loop uses.
 *   • `update(dt)` runs on a rAF loop, so the music and crowd schedulers work
 *     against a real clock rather than the offline shortcut the tests take.
 */

import { AudioSystem } from '@/audio';
import { SOUND_KEYS, SOUND_SPECS, type SoundKey } from '@/audio';
import { MUSIC_STATES, type MusicState } from '@/audio';
import { REVERB_PRESET_NAMES, REVERB_PRESETS, type ReverbPreset } from '@/audio';
import { EVENT_AUDIO_MAP, ALL_GAME_EVENT_TYPES } from '@/audio';
import type { GameEventPayload, GameEventType, Vec3 } from '@/types';
import { createEventBus } from '@/util';

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

const bus = createEventBus();
const audio = new AudioSystem({ autoStartAmbience: true });
audio.attach(bus);

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

let frame = 0;
let intensity = 0.7;
let distance = 0;
let azimuth = 0;

/** Source position derived from the distance/azimuth sliders. */
function sourcePosition(): Vec3 | undefined {
  if (distance <= 0) return undefined;
  const rad = (azimuth * Math.PI) / 180;
  return { x: Math.sin(rad) * distance, y: 0, z: -Math.cos(rad) * distance };
}

/* -------------------------------------------------------------------------- */
/* Unlock                                                                     */
/* -------------------------------------------------------------------------- */

const unlockButton = $<HTMLButtonElement>('unlock');
unlockButton.addEventListener('click', () => {
  void audio.unlock().then(() => {
    document.body.classList.remove('locked');
    unlockButton.textContent = 'Audio unlocked — click anything below';
    unlockButton.disabled = true;
    audio.playMusic('calm');
    // Listener at the origin, looking down -Z, which is the three.js default.
    audio.setListener({ x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

function addButton(
  parent: HTMLElement,
  title: string,
  detail: string,
  onClick: (button: HTMLButtonElement) => void
): HTMLButtonElement {
  const button = document.createElement('button');
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = title;
  const d = document.createElement('span');
  d.className = 'd';
  d.textContent = detail;
  button.append(k, d);
  button.addEventListener('click', () => onClick(button));
  parent.append(button);
  return button;
}

/* -------------------------------------------------------------------------- */
/* Voices                                                                     */
/* -------------------------------------------------------------------------- */

const voicesEl = $('voices');
for (const key of SOUND_KEYS) {
  const spec = SOUND_SPECS[key];
  addButton(voicesEl, key, spec.description, () => {
    audio.play(key, { intensity, position: sourcePosition() });
  });
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Representative payloads. Every event type in the union appears here, so the
 * harness doubles as a manual check that the mapping really is exhaustive.
 */
const EVENT_SAMPLES: { [T in GameEventType]: () => GameEventPayload<T> } = {
  ShockwaveFired: () => ({
    origin: sourcePosition() ?? { x: 0, y: 1, z: -4 },
    direction: { x: 0, y: 0, z: -1 },
    power: Math.pow(10, 2 + intensity * 4),
    range: 200,
    angle: Math.PI / 3,
    intent: intensity > 0.75 ? 'serious' : 'normal',
    punchKind: intensity > 0.75 ? 'serious' : 'normal',
  }),
  EntityDamaged: () => ({
    entityId: 1 as never,
    entityType: 'monster',
    faction: 'monster',
    amount: 30 * intensity + 5,
    damageType: 'blunt',
    intent: 'normal',
    healthRemaining: 60,
    maxHealth: 100,
    point: sourcePosition() ?? { x: 0, y: 1, z: -3 },
    critical: intensity > 0.8,
  }),
  EntityKilled: () => ({
    entityId: 1 as never,
    entityType: 'monster',
    faction: 'monster',
    position: sourcePosition() ?? { x: 0, y: 1, z: -3 },
    threatTier: intensity > 0.7 ? 'dragon' : 'tiger',
    intent: 'serious',
    rewardPoints: 50,
  }),
  ImpulseApplied: () => ({
    targetId: 2 as never,
    impulse: { x: 300 * intensity, y: 100, z: 0 },
    point: sourcePosition() ?? { x: 1, y: 1, z: -2 },
  }),
  ChunkDetached: () => ({
    structureId: 'demo-tower',
    chunkIndex: Math.floor(Math.random() * 100),
    position: sourcePosition() ?? { x: 2, y: 6, z: -6 },
    mass: 50 + 600 * intensity,
    impulse: { x: 0, y: -20, z: 0 },
    material: 'concrete',
    collateralCost: 20,
  }),
  CivilianSaved: () => ({
    entityId: 3 as never,
    position: sourcePosition() ?? { x: -2, y: 0, z: -5 },
    byPlayer: true,
    reputationDelta: 5,
  }),
  CivilianLost: () => ({
    entityId: 3 as never,
    position: sourcePosition() ?? { x: -2, y: 0, z: -5 },
    causedByPlayer: true,
    reputationDelta: -25,
  }),
  AllyDowned: () => ({
    entityId: 4 as never,
    displayName: 'Mumen Rider',
    position: sourcePosition() ?? { x: 3, y: 0, z: -7 },
  }),
  EncounterStarted: () => ({
    encounterId: 'demo',
    threatTier: intensity > 0.7 ? 'dragon' : 'demon',
    position: sourcePosition() ?? { x: 0, y: 0, z: -10 },
    radius: 60,
    participantIds: [],
    isBoss: intensity > 0.85,
  }),
  EncounterEnded: () => ({
    encounterId: 'demo',
    outcome: 'victory',
    duration: 42,
    civiliansLost: 0,
    collateralCost: 120,
  }),
  BossPhaseChanged: () => ({
    entityId: 5 as never,
    specId: 'demo-boss',
    previousPhase: 1,
    phase: 2,
    healthFraction: 0.35,
    isFinalPhase: intensity > 0.7,
  }),
  QuestStateChanged: () => ({
    questId: 'demo-quest',
    previous: 'active',
    state: 'completed',
    title: 'Sale at the supermarket',
  }),
  RankChanged: () => ({
    previousClass: 'C',
    heroClass: 'B',
    previousRank: 388,
    rank: 122,
    points: 1200,
    promoted: true,
  }),
  BoredomChanged: () => ({
    value: intensity,
    previous: 0,
    reason: 'trivialVictory',
  }),
  ChunkStreamedIn: () => ({
    key: '0,0' as never,
    coord: { x: 0, z: 0 } as never,
    loadTimeMs: 14,
    memoryBytes: 4096,
  }),
  ChunkStreamedOut: () => ({
    key: '0,0' as never,
    coord: { x: 0, z: 0 } as never,
    evictedForMemory: false,
  }),
  TimeOfDayChanged: () => ({
    timeOfDay: intensity,
    phase: intensity > 0.5 ? 'night' : 'noon',
    previousPhase: 'afternoon',
    dayCount: 2,
  }),
  PlayerLanded: () => ({
    position: sourcePosition() ?? { x: 0, y: 0, z: -1 },
    impactSpeed: 60 * intensity,
    fallHeight: 90 * intensity,
    createsCrater: intensity > 0.7,
    intent: 'normal',
  }),
};

const eventsEl = $('events');
for (const type of ALL_GAME_EVENT_TYPES) {
  addButton(eventsEl, type, EVENT_AUDIO_MAP[type].summary, () => {
    bus.emit(type, EVENT_SAMPLES[type]());
  });
}

// A burst of chunk detachments, which is what the debris aggregator and the
// collapse heuristic actually see during a building failure.
addButton(eventsEl, 'ChunkDetached x60', 'A whole structure failing in one frame.', () => {
  for (let i = 0; i < 60; i++) {
    bus.emit('ChunkDetached', {
      structureId: 'demo-tower',
      chunkIndex: i,
      position: { x: (Math.random() - 0.5) * 12, y: Math.random() * 20, z: -8 },
      mass: 40 + Math.random() * 800,
      impulse: { x: 0, y: -30, z: 0 },
      material: ['concrete', 'glass', 'metal', 'wood'][i % 4]!,
      collateralCost: 40,
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Music                                                                      */
/* -------------------------------------------------------------------------- */

const musicEl = $('music');
const musicButtons = new Map<MusicState | 'off', HTMLButtonElement>();
for (const state of MUSIC_STATES) {
  const button = addButton(musicEl, state, `Switch to the "${state}" layer on the next bar.`, () => {
    audio.playMusic(state);
  });
  musicButtons.set(state, button);
}
musicButtons.set(
  'off',
  addButton(musicEl, 'stop', 'Fade the score out entirely.', () => audio.playMusic(undefined))
);

/* -------------------------------------------------------------------------- */
/* Ambience and mixer                                                         */
/* -------------------------------------------------------------------------- */

const ambienceEl = $('ambience');
addButton(ambienceEl, 'start beds', 'Crowd murmur and wind.', () =>
  audio.playAmbience('ambience.city')
);
addButton(ambienceEl, 'stop beds', 'Fade both ambience beds out.', () =>
  audio.playAmbience(undefined)
);

const envEl = $('environments');
const envButtons = new Map<ReverbPreset, HTMLButtonElement>();
for (const preset of REVERB_PRESET_NAMES) {
  envButtons.set(
    preset,
    addButton(envEl, preset, REVERB_PRESETS[preset].description, () => {
      audio.setEnvironment(preset);
    })
  );
}

const busesEl = $('buses');
for (const category of ['sfx', 'music', 'ambience', 'voice', 'ui'] as const) {
  const label = document.createElement('label');
  label.className = 'slider';
  const caption = document.createElement('span');
  const value = document.createElement('b');
  const strip = audio.bus(category);
  value.textContent = strip.volume.toFixed(2);
  caption.append(`${category} `, value);
  const range = document.createElement('input');
  range.type = 'range';
  range.min = '0';
  range.max = '1';
  range.step = '0.01';
  range.value = String(strip.volume);
  range.addEventListener('input', () => {
    strip.volume = Number(range.value);
    value.textContent = strip.volume.toFixed(2);
  });
  label.append(caption, range);
  busesEl.append(label);
}

const masterLabel = document.createElement('label');
masterLabel.className = 'slider';
const masterCaption = document.createElement('span');
const masterValue = document.createElement('b');
masterValue.textContent = audio.masterVolume.toFixed(2);
masterCaption.append('master ', masterValue);
const masterRange = document.createElement('input');
masterRange.type = 'range';
masterRange.min = '0';
masterRange.max = '1';
masterRange.step = '0.01';
masterRange.value = String(audio.masterVolume);
masterRange.addEventListener('input', () => {
  audio.masterVolume = Number(masterRange.value);
  masterValue.textContent = audio.masterVolume.toFixed(2);
});
masterLabel.append(masterCaption, masterRange);
busesEl.append(masterLabel);

const mixerActions = $('mixer-actions');
addButton(mixerActions, 'duck music', 'Pull the music down for 1.5 s, as an impact does.', () => {
  audio.duck('music', 0.2, 0.05);
  window.setTimeout(() => audio.unduck('music', 0.6), 1500);
});
addButton(mixerActions, 'stop all sfx', 'Cut every sounding effect.', () => audio.stopAll('sfx'));
addButton(mixerActions, 'suspend', 'Simulate the app being backgrounded.', (button) => {
  const on = button.classList.toggle('on');
  audio.setSuspended(on);
});
addButton(mixerActions, 'voice storm', '60 overlapping impacts: watch the budget hold.', () => {
  for (let i = 0; i < 60; i++) {
    const key = SOUND_KEYS[i % SOUND_KEYS.length]!;
    window.setTimeout(() => audio.play(key as SoundKey, { intensity }), i * 12);
  }
});

/* -------------------------------------------------------------------------- */
/* Sliders                                                                    */
/* -------------------------------------------------------------------------- */

function bindSlider(id: string, onChange: (value: number) => void, format: (v: number) => string) {
  const input = $<HTMLInputElement>(id);
  const readout = $(`${id}-v`);
  const apply = (): void => {
    const value = Number(input.value);
    readout.textContent = format(value);
    onChange(value);
  };
  input.addEventListener('input', apply);
  apply();
}

bindSlider(
  'intensity',
  (v) => {
    intensity = v;
  },
  (v) => v.toFixed(2)
);
bindSlider(
  'distance',
  (v) => {
    distance = v;
  },
  (v) => `${v.toFixed(0)} m`
);
bindSlider(
  'azimuth',
  (v) => {
    azimuth = v;
  },
  (v) => `${v.toFixed(0)}°`
);
bindSlider(
  'boredom',
  (v) => audio.music.setBoredom(v),
  (v) => v.toFixed(2)
);
bindSlider(
  'civilians',
  (v) => audio.setNearbyCivilians(v),
  (v) => v.toFixed(0)
);
bindSlider(
  'speed',
  (v) => audio.setPlayerSpeed(v),
  (v) => `${v.toFixed(0)} m/s`
);
bindSlider(
  'wind',
  (v) => audio.setAmbientWind(v),
  (v) => v.toFixed(2)
);

/* -------------------------------------------------------------------------- */
/* Frame loop                                                                 */
/* -------------------------------------------------------------------------- */

const statusState = $('s-state');
const statusVoices = $('s-voices');
const statusMusic = $('s-music');
const statusParts = $('s-parts');
const statusBar = $('s-bar');
const statusGr = $('s-gr');
const statusRate = $('s-rate');
const statusEnv = $('s-env');

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  frame++;
  bus.setFrame(frame, now / 1000);
  audio.update(dt);

  if (frame % 6 === 0) {
    statusState.textContent = audio.unlocked ? 'running' : 'locked';
    statusVoices.textContent = `${audio.voiceCount}/${audio.maxVoices}`;
    statusMusic.textContent = audio.music.isRunning ? audio.music.state : 'stopped';
    statusParts.textContent = audio.music.parts.join(', ') || '—';
    statusBar.textContent = String(audio.music.bar);
    statusGr.textContent = `${audio.mixer.gainReductionDb.toFixed(1)} dB`;
    statusEnv.textContent = audio.environment;
    for (const [preset, button] of envButtons) {
      button.classList.toggle('on', audio.environment === preset);
    }
    statusRate.textContent = `${audio.ctx.sampleRate} Hz`;
    for (const [state, button] of musicButtons) {
      button.classList.toggle('on', audio.music.isRunning && audio.music.state === state);
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
