/**
 * OFFLINE RENDER VERIFICATION
 *
 * Every voice in the game is rendered to PCM through a real
 * `OfflineAudioContext` in headless Chromium and measured. No mocks, no
 * stubs: the graph under test is the graph that ships.
 *
 * Four families of assertion, applied to all thirty-five voices:
 *
 *  1. NOT SILENT      — RMS and peak above a floor. A voice that produces
 *                       nothing is the failure mode this whole system exists
 *                       to make impossible.
 *  2. NOT CLIPPING    — peak strictly below full scale, zero samples at the
 *                       rail, and no meaningful DC offset. Checked BOTH after
 *                       the master limiter and with it bypassed, because a
 *                       voice that only behaves because the limiter caught it
 *                       is a badly balanced voice.
 *  3. RIGHT CHARACTER — band energy and spectral motion match the design
 *                       intent: the punch has weight below 100 Hz, the
 *                       shockwave's sweep descends, glass debris is bright,
 *                       the collapse is a rumble.
 *  4. DISTINGUISHABLE — octave-band fingerprints are far enough apart that no
 *                       two voices are the same sound with a different name.
 *
 * The suite renders once in `beforeAll` and shares the result.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { decodePcm, renderProbeSuite, type IProbeSuite } from './browser-harness';
import type { IProbeMetrics } from '../testing/offline-probe';
import { SOUND_KEYS, SOUND_SPECS } from '../voices/registry';
import { MUSIC_STATES } from '../music/patterns';
import { THREAT_TIERS } from '../voices/monster';
import * as A from '../testing/analysis';

/** Rendering the whole suite in Chromium takes tens of seconds. */
const RENDER_TIMEOUT = 300_000;

let suite: IProbeSuite;

beforeAll(async () => {
  suite = await renderProbeSuite();
}, RENDER_TIMEOUT);

/** Voices that are intentionally quiet relative to an impact. */
const QUIET_FLOOR_RMS = 0.008;
const QUIET_FLOOR_PEAK = 0.03;

describe('universal voice invariants', () => {
  it('renders every catalogued sound key', () => {
    for (const key of SOUND_KEYS) expect(suite.get(key).name).toBe(key);
  });

  it('produces audible output for every voice', () => {
    const failures: string[] = [];
    for (const key of SOUND_KEYS) {
      const m = suite.get(key);
      if (m.activeRms < QUIET_FLOOR_RMS || m.peak < QUIET_FLOOR_PEAK) {
        failures.push(`${key}: rms=${m.activeRms.toFixed(4)} peak=${m.peak.toFixed(4)}`);
      }
    }
    expect(failures, `voices below the audibility floor:\n${failures.join('\n')}`).toEqual([]);
  });

  it('never clips, before or after the master chain', () => {
    for (const key of SOUND_KEYS) {
      const wet = suite.get(key);
      const raw = suite.getRaw(key);
      // After the limiter and soft clipper: a hard mathematical ceiling.
      expect(wet.peak, `${key} peak`).toBeLessThanOrEqual(1);
      expect(wet.clipped, `${key} clipped samples`).toBe(0);
      // Before them: proof the voice is balanced on its own merits.
      expect(raw.peak, `${key} raw peak`).toBeLessThanOrEqual(1);
      expect(raw.clipped, `${key} raw clipped samples`).toBe(0);
    }
  });

  it('carries no meaningful DC offset', () => {
    for (const key of SOUND_KEYS) {
      expect(Math.abs(suite.get(key).dcOffset), `${key} DC`).toBeLessThan(0.02);
    }
  });

  it('is exactly silent before its trigger', () => {
    // Proves the envelope interruption logic anchors correctly: a missing
    // anchor would ramp the voice up from the start of the buffer.
    for (const key of SOUND_KEYS) {
      const m = suite.get(key);
      if (m.kind === 'ambience') continue; // beds start at t=0 by definition
      expect(m.preTriggerPeak, `${key} leaked before its trigger`).toBe(0);
    }
  });

  it('lasts roughly as long as its spec advertises', () => {
    for (const key of SOUND_KEYS) {
      const m = suite.get(key);
      const spec = SOUND_SPECS[key];
      if (!Number.isFinite(spec.maxSeconds)) continue;
      expect(m.activeDuration, `${key} is instantaneous`).toBeGreaterThan(0.01);
      expect(m.activeDuration, `${key} overran its declared tail`).toBeLessThanOrEqual(
        spec.maxSeconds + 0.2
      );
    }
  });

  it('produces a fingerprint that accounts for all of its energy', () => {
    for (const key of SOUND_KEYS) {
      const total = suite.get(key).fingerprint.reduce((a, b) => a + b, 0);
      expect(total, `${key} fingerprint sum`).toBeGreaterThan(0.9);
      expect(total, `${key} fingerprint sum`).toBeLessThan(1.0001);
    }
  });
});

describe('punch', () => {
  it('puts real weight below 100 Hz', () => {
    const m = suite.get('punch.normal');
    // The sub sweep is the point of the voice: most of the attack's energy
    // must actually be down there.
    expect(m.sub100Attack).toBeGreaterThan(0.4);
    expect(m.low).toBeGreaterThan(0.85); // 20-200 Hz
    expect(m.centroidAttack).toBeLessThan(400);
  });

  it('is dry: short, with a decaying tail and no ring', () => {
    const m = suite.get('punch.normal');
    expect(m.activeDuration).toBeGreaterThan(0.05);
    expect(m.activeDuration).toBeLessThan(0.5);
    // Energy moves DOWN and away, it does not sustain.
    const c = m.centroidOverTime;
    expect(c[3]!).toBeLessThan(c[0]!);
  });

  it('has a contact transient above the sub', () => {
    // The tick and click layers put a little energy up high at the very start,
    // which is what makes the punch sound close rather than muffled.
    const m = suite.get('punch.normal');
    expect(m.highOverTime[0]!).toBeGreaterThan(m.highOverTime[3]!);
  });

  it('scales: restrained < normal < heavy', () => {
    const restrained = suite.getRaw('punch.restrained');
    const normal = suite.getRaw('punch.normal');
    const heavy = suite.getRaw('punch.heavy');
    expect(restrained.peak).toBeLessThan(normal.peak);
    expect(normal.peak).toBeLessThan(heavy.peak);
    expect(suite.get('punch.restrained').activeDuration).toBeLessThan(
      suite.get('punch.heavy').activeDuration
    );
    // Heavier means lower, not just louder.
    expect(suite.get('punch.heavy').centroidOverTime[1]!).toBeLessThan(
      suite.get('punch.restrained').centroidOverTime[1]!
    );
  });
});

describe('shockwave (serious punch)', () => {
  it('sweeps its energy downwards over time', () => {
    const m = suite.get('shockwave.serious');
    const c = m.centroidOverTime;
    // Strictly falling across the first three quarters of the sound.
    expect(c[1]!).toBeLessThan(c[0]!);
    expect(c[2]!).toBeLessThan(c[1]!);
    expect(c[3]!).toBeLessThan(c[0]! * 0.5);
    // And the high band empties out as the resonant cutoff descends.
    expect(m.highOverTime[0]!).toBeGreaterThan(0.01);
    expect(m.highOverTime[3]!).toBeLessThan(m.highOverTime[0]! * 0.2);
  });

  it('lands as a sub-bass event with a long tail', () => {
    const m = suite.get('shockwave.serious');
    expect(m.sub100).toBeGreaterThan(0.4);
    expect(m.activeDuration).toBeGreaterThan(1.5);
    expect(m.onsetCount).toBeGreaterThanOrEqual(1);
  });

  it('escalates blast < serious < table flip', () => {
    const blast = suite.get('shockwave.blast');
    const serious = suite.get('shockwave.serious');
    const flip = suite.get('shockwave.tableflip');
    expect(blast.activeDuration).toBeLessThan(serious.activeDuration);
    expect(serious.activeDuration).toBeLessThan(flip.activeDuration);
    expect(suite.getRaw('shockwave.blast').peak).toBeLessThan(
      suite.getRaw('shockwave.tableflip').peak
    );
  });

  it('is clearly a different sound from an ordinary punch', () => {
    const distance = A.fingerprintDistance(
      suite.get('punch.normal').fingerprint,
      suite.get('shockwave.serious').fingerprint
    );
    expect(distance).toBeGreaterThan(0.15);
    expect(suite.get('shockwave.serious').activeDuration).toBeGreaterThan(
      suite.get('punch.normal').activeDuration * 4
    );
  });
});

describe('consecutive punches', () => {
  it('schedules the whole chain from one trigger', () => {
    expect(suite.get('punch.consecutive').extras.hitCount).toBe(12);
    expect(suite.get('punch.barrage').extras.hitCount).toBe(30);
    expect(suite.get('punch.flurry').extras.hitCount).toBe(4);
  });

  it('raises the pitch as the chain progresses', () => {
    // Measured from the rendered audio: the chain's low-band centre of
    // gravity migrates upward between its middle and its final third.
    for (const name of ['chain.consecutive', 'chain.barrage']) {
      const chain = suite.get(name);
      expect(chain.extras.pitchEarly, `${name} early`).toBeGreaterThan(0);
      expect(chain.extras.pitchLate, `${name} late`).toBeGreaterThan(chain.extras.pitchEarly!);
      expect(chain.extras.pitchRise, `${name} rise`).toBeGreaterThan(1.08);
    }
  });

  it('schedules a rise the audio can reflect', () => {
    // Cross-check against the pure schedule the voice actually used.
    const chain = suite.get('chain.consecutive');
    expect(chain.extras.scheduledLastPitch!).toBeGreaterThan(
      chain.extras.scheduledFirstPitch! * 1.2
    );
    // ...and the finisher drops back against that rise, so the chain resolves.
    expect(chain.extras.finisherPitch!).toBeLessThan(chain.extras.scheduledLastPitch!);
  });

  it('reads as a rapid repeat, not one long sound', () => {
    const m = suite.get('punch.barrage');
    expect(m.onsetCount).toBeGreaterThanOrEqual(4);
    expect(m.activeDuration).toBeGreaterThan(0.8);
    expect(m.low).toBeGreaterThan(0.7);
  });
});

describe('debris', () => {
  it('scales grain density with the debris count', () => {
    const sparse = suite.get('debris.impact');
    const dense = suite.get('debris.density.debris.impact');
    expect(sparse.extras.grainCount).toBeGreaterThan(2);
    expect(dense.extras.grainCount).toBeGreaterThan(40);
    expect(dense.extras.grainCount!).toBeGreaterThan(sparse.extras.grainCount! * 3);
  });

  it('is NOT machine-gun regular', () => {
    // The measurement that matters: a uniform grid scores near zero.
    const glass = suite.get('debris.density.debris.glass');
    expect(glass.extras.detectedOnsets).toBeGreaterThan(8);
    expect(glass.extras.irregularity).toBeGreaterThan(0.35);
    const concrete = suite.get('debris.density.debris.impact');
    expect(concrete.extras.irregularity).toBeGreaterThan(0.35);
  });

  it('spreads grains across the stereo field', () => {
    expect(suite.get('debris.density.debris.glass').stereoWidth).toBeGreaterThan(0.15);
    expect(suite.get('debris.impact').stereoWidth).toBeGreaterThan(0.03);
  });

  it('gives each material its own spectral identity', () => {
    const glass = suite.get('debris.glass');
    const concrete = suite.get('debris.impact');
    const metal = suite.get('debris.metal');
    const wood = suite.get('debris.wood');
    // Glass rings high; concrete thuds low.
    expect(glass.centroid).toBeGreaterThan(1000);
    expect(concrete.centroid).toBeLessThan(400);
    expect(wood.centroid).toBeLessThan(glass.centroid);
    expect(metal.centroid).toBeGreaterThan(concrete.centroid);
    expect(glass.sub100).toBeLessThan(0.05);
    expect(concrete.sub100).toBeGreaterThan(0.4);
    // All four must be mutually distinguishable.
    const prints = [glass, concrete, metal, wood].map((m) => m.fingerprint);
    for (let i = 0; i < prints.length; i++) {
      for (let j = i + 1; j < prints.length; j++) {
        expect(A.fingerprintDistance(prints[i]!, prints[j]!)).toBeGreaterThan(0.2);
      }
    }
  });
});

describe('building collapse', () => {
  it('is dominated by low rumble', () => {
    const m = suite.get('collapse.building');
    expect(m.low).toBeGreaterThan(0.7); // 20-200 Hz
    expect(m.centroid).toBeLessThan(250);
  });

  it('still carries audible mid-frequency crackle', () => {
    // Without this a collapse is inaudible on a phone speaker, which
    // reproduces almost nothing below 150 Hz.
    const m = suite.get('collapse.building');
    expect(m.highOverTime[0]!).toBeGreaterThan(0.01);
    expect(m.mid).toBeGreaterThan(0.005);
  });

  it('is a long event with a shape, not a single hit', () => {
    const m = suite.get('collapse.building');
    expect(m.activeDuration).toBeGreaterThan(3);
    expect(m.onsetCount).toBeGreaterThanOrEqual(2);
    // Crackle first, rumble last: the centroid falls as material settles.
    expect(m.centroidOverTime[2]!).toBeLessThan(m.centroidOverTime[0]!);
  });

  it('scales facade < building < tower', () => {
    expect(suite.get('collapse.facade').activeDuration).toBeLessThan(
      suite.get('collapse.building').activeDuration
    );
    expect(suite.get('collapse.building').activeDuration).toBeLessThan(
      suite.get('collapse.tower').activeDuration
    );
  });
});

describe('monster vocalisations', () => {
  it('renders every threat tier', () => {
    for (const tier of THREAT_TIERS) {
      const m = suite.get(`monster.roar.${tier}`);
      expect(m.activeRms).toBeGreaterThan(QUIET_FLOOR_RMS);
      expect(m.peak).toBeLessThanOrEqual(1);
    }
  });

  it('makes bigger creatures spectrally lower', () => {
    // Formant frequency is what the ear reads as body size, so the tiers must
    // come out ordered.
    const centroids = THREAT_TIERS.map((t) => suite.get(`monster.roar.${t}`).centroid);
    expect(centroids[0]!).toBeGreaterThan(centroids[4]! * 1.5);
    const wolf = suite.get('monster.roar.wolf');
    const god = suite.get('monster.roar.god');
    expect(god.low).toBeGreaterThan(wolf.low);
    expect(wolf.high).toBeGreaterThan(god.high);
  });

  it('makes bigger creatures last longer', () => {
    const wolf = suite.get('monster.roar.wolf');
    const god = suite.get('monster.roar.god');
    expect(god.activeDuration).toBeGreaterThan(wolf.activeDuration * 2);
  });

  it('separates the four utterances', () => {
    const roar = suite.get('monster.roar');
    const screech = suite.get('monster.screech');
    const hurt = suite.get('monster.hurt');
    const death = suite.get('monster.death');
    // A screech is high and short; a death cry is low and long.
    expect(screech.centroid).toBeGreaterThan(roar.centroid * 2);
    expect(death.activeDuration).toBeGreaterThan(hurt.activeDuration * 2);
    expect(A.fingerprintDistance(screech.fingerprint, death.fingerprint)).toBeGreaterThan(0.4);
  });

  it('is inharmonic and rough, not a filtered sawtooth', () => {
    // FM at a non-integer ratio plus growl AM spreads energy across many
    // bands rather than concentrating it in one.
    const fp = suite.get('monster.roar').fingerprint;
    const occupied = fp.filter((v) => v > 0.01).length;
    expect(occupied).toBeGreaterThanOrEqual(4);
  });
});

describe('locomotion', () => {
  it('varies the footstep by surface', () => {
    const concrete = suite.get('move.footstep#concrete');
    const metal = suite.get('move.footstep#metal');
    const grass = suite.get('move.footstep#grass');
    const water = suite.get('move.footstep#water');
    expect(metal.centroid).toBeGreaterThan(concrete.centroid);
    expect(grass.centroid).toBeLessThan(metal.centroid);
    // Metal rings; grass does not.
    expect(metal.activeDuration).toBeGreaterThan(grass.activeDuration);
    for (const m of [concrete, metal, grass, water]) {
      expect(m.peak).toBeGreaterThan(QUIET_FLOOR_PEAK);
      expect(m.peak).toBeLessThan(0.6); // a footstep must never dominate
    }
  });

  it('makes a landing much bigger than a footstep', () => {
    const step = suite.get('move.footstep');
    const landing = suite.get('move.landing');
    expect(landing.peak).toBeGreaterThan(step.peak * 2);
    expect(landing.activeDuration).toBeGreaterThan(step.activeDuration * 2);
    expect(landing.sub100Attack).toBeGreaterThan(0.1);
  });

  it('sweeps the jump upward and the dash through a dip', () => {
    const jump = suite.get('move.jump');
    // Rising bandpass: the high band fills up over the sound.
    expect(jump.highOverTime[3]!).toBeGreaterThan(jump.highOverTime[0]!);
    const dash = suite.get('move.dash');
    // Fall-then-rise: the middle is the darkest part.
    expect(dash.centroidOverTime[1]!).toBeLessThan(dash.centroidOverTime[0]!);
    expect(dash.centroidOverTime[3]!).toBeGreaterThan(dash.centroidOverTime[1]!);
  });

  it('brightens and loudens the wind with speed', () => {
    const slow = suite.get('move.wind@4');
    const fast = suite.get('move.wind@42');
    expect(fast.activeRms).toBeGreaterThan(slow.activeRms * 1.5);
    // Rising centre frequency is what actually conveys speed.
    expect(fast.centroid).toBeGreaterThan(slow.centroid * 1.3);
    expect(fast.high).toBeGreaterThan(slow.high);
  });
});

describe('crowd', () => {
  it('scales the bed with civilian density', () => {
    const empty = suite.get('ambience.crowd@0.05');
    const packed = suite.get('ambience.crowd@0.9');
    expect(packed.activeRms).toBeGreaterThan(empty.activeRms * 2);
    expect(packed.extras.blipCount!).toBeGreaterThan(empty.extras.blipCount!);
  });

  it('is not a flat noise bed: it has vocal events in it', () => {
    const packed = suite.get('ambience.crowd@0.9');
    expect(packed.extras.blipCount).toBeGreaterThan(5);
    expect(packed.onsetCount).toBeGreaterThan(1);
    expect(packed.stereoWidth).toBeGreaterThan(0.05);
  });

  it('separates cheer, gasp and panic', () => {
    const cheer = suite.get('crowd.cheer');
    const gasp = suite.get('crowd.gasp');
    const panic = suite.get('crowd.panic');
    expect(gasp.activeDuration).toBeLessThan(cheer.activeDuration);
    expect(panic.activeDuration).toBeGreaterThan(gasp.activeDuration);
    // A gasp is a sharp intake: brighter at the front than a cheer.
    expect(gasp.centroidOverTime[0]!).toBeGreaterThan(cheer.centroidOverTime[0]!);
  });
});

describe('interface sounds', () => {
  it('keeps UI out of the sub, where the game lives', () => {
    for (const key of ['ui.tap', 'ui.confirm', 'ui.deny', 'ui.alert', 'ui.rankUp'] as const) {
      expect(suite.get(key).sub100, `${key} sub content`).toBeLessThan(0.05);
    }
  });

  it('sizes each sound to its importance', () => {
    const tap = suite.get('ui.tap');
    const confirm = suite.get('ui.confirm');
    const rankUp = suite.get('ui.rankUp');
    expect(tap.activeDuration).toBeLessThan(confirm.activeDuration);
    expect(confirm.activeDuration).toBeLessThan(rankUp.activeDuration);
    expect(tap.peak).toBeLessThan(rankUp.peak);
  });

  it('makes the alert repeat and the rank-up rise', () => {
    expect(suite.get('ui.alert').onsetCount).toBeGreaterThanOrEqual(2);
    const rankUp = suite.get('ui.rankUp');
    // The shimmer sweeps upward behind the arpeggio.
    expect(rankUp.highOverTime[3]!).toBeGreaterThan(rankUp.highOverTime[0]!);
  });

  it('makes the dark stinger genuinely dark', () => {
    const dark = suite.get('ui.dark');
    const victory = suite.get('ui.victory');
    expect(dark.centroid).toBeLessThan(victory.centroid);
    expect(dark.activeDuration).toBeGreaterThan(1);
  });
});

describe('music', () => {
  it('renders every intensity layer audibly', () => {
    for (const state of MUSIC_STATES) {
      const m = suite.get(`music.${state}`);
      expect(m.activeRms, `music.${state}`).toBeGreaterThan(0.01);
      expect(m.peak, `music.${state}`).toBeLessThanOrEqual(1);
      expect(m.clipped, `music.${state}`).toBe(0);
    }
  });

  it('adds PARTS as it escalates, and plays more notes', () => {
    const parts = MUSIC_STATES.map((s) => suite.get(`music.${s}`).extras.partCount!);
    expect(parts).toEqual([1, 2, 4, 6, 8]);
    const notes = (['calm', 'alert', 'combat', 'boss'] as const).map(
      (s) => suite.get(`music.${s}`).extras.noteCount!
    );
    for (let i = 1; i < notes.length; i++) expect(notes[i]!).toBeGreaterThan(notes[i - 1]!);
  });

  it('raises the tempo with the intensity', () => {
    const bpm = (['calm', 'alert', 'combat', 'boss'] as const).map(
      (s) => suite.get(`music.${s}`).extras.bpm!
    );
    for (let i = 1; i < bpm.length; i++) expect(bpm[i]!).toBeGreaterThan(bpm[i - 1]!);
  });

  it('gets denser and heavier with intensity', () => {
    const calm = suite.get('music.calm');
    const combat = suite.get('music.combat');
    expect(combat.onsetCount).toBeGreaterThan(calm.onsetCount);
    expect(combat.activeRms).toBeGreaterThan(calm.activeRms * 2);
    // The bass and kick arrive: combat has a low end, exploration does not.
    expect(combat.sub100).toBeGreaterThan(0.3);
    expect(calm.sub100).toBeLessThan(0.1);
  });

  it('reduces the BOREDOM state to a single sustained tone', () => {
    const bored = suite.get('music.bored');
    expect(bored.extras.partCount).toBe(1);
    // Three note events in ten seconds, and each is a whole-bar drone.
    expect(bored.extras.noteCount).toBeLessThanOrEqual(4);
    expect(bored.activeRms).toBeGreaterThan(0.01);
    // A sustained tone: essentially no high-frequency content and a fixed
    // spectral centre.
    for (const h of bored.highOverTime) expect(h).toBeLessThan(0.01);
    const c = bored.centroidOverTime;
    expect(Math.max(...c) - Math.min(...c)).toBeLessThan(20);
    // And far fewer events than any playing layer.
    expect(bored.onsetCount).toBeLessThan(suite.get('music.combat').onsetCount / 4);
  });

  it('eats a full arrangement down to the drone as boredom rises', () => {
    const m = suite.get('music.boredomCollapse');
    expect(m.extras.partsBefore).toBe(6);
    expect(m.extras.partsAfter).toBe(1);
    // The tail of the render is the drone alone: much simpler than the start.
    expect(m.centroidOverTime[3]!).toBeLessThan(m.centroidOverTime[0]! * 0.5);
    expect(m.highOverTime[3]!).toBeLessThan(0.005);
  });
});

describe('mixer', () => {
  it('ducks the music under a serious punch', () => {
    const control = suite.get('mix.duck.control');
    const ducked = suite.get('mix.duck.ducked');
    // Both renders contain ONLY the music bus; the sfx bus is muted, so the
    // difference after the impact is ducking and nothing else.
    expect(control.extras.duckRatio).toBeGreaterThan(0.8);
    expect(ducked.extras.duckRatio).toBeLessThan(0.5);
    expect(ducked.extras.rmsAfter!).toBeLessThan(control.extras.rmsAfter! * 0.6);
    // The music is ducked, not muted: it must still be there.
    expect(ducked.extras.rmsAfter!).toBeGreaterThan(0.01);
  });

  it('survives a dense combat scene without clipping', () => {
    const m = suite.get('mix.combatScene');
    expect(m.peak).toBeLessThanOrEqual(1);
    expect(m.clipped).toBe(0);
    // And it is genuinely loud: the limiter is working, not just headroom.
    expect(m.activeRms).toBeGreaterThan(0.2);
  });

  it('handles pooled voices re-triggered mid-tail', () => {
    const m = suite.get('mix.retrigger');
    // Eight punches at 55 ms, closer together than the voice's own decay.
    expect(m.onsetCount).toBeGreaterThanOrEqual(6);
    expect(m.peak).toBeLessThanOrEqual(1);
    expect(m.clipped).toBe(0);
    // A broken envelope interruption would freeze a voice at full level and
    // the render would be near-constant; it is not.
    expect(m.onsetIrregularity).toBeLessThan(0.35);
  });

  it('enforces the voice budget with priority stealing', () => {
    const m = suite.get('mix.budget');
    expect(m.extras.voicesAfterFlood!).toBeLessThanOrEqual(m.extras.maxVoices!);
    expect(m.extras.voiceCount!).toBeLessThanOrEqual(m.extras.maxVoices!);
    // Some requests must have been refused: that is the budget doing its job.
    expect(m.extras.granted!).toBeLessThan(m.extras.requested!);
    // The most important sound still gets in...
    expect(m.extras.seriousGranted).toBe(1);
    // ...and the least important one does not.
    expect(m.extras.lowPriorityGranted).toBe(0);
  });
});

describe('voice distinguishability', () => {
  /** One representative from each family. */
  const REPRESENTATIVES = [
    'punch.normal',
    'shockwave.serious',
    'debris.glass',
    'collapse.building',
    'monster.screech',
    'move.footstep',
    'move.wind',
    'crowd.panic',
    'ui.alert',
  ] as const;

  it('keeps every family spectrally distinct', () => {
    const failures: string[] = [];
    for (let i = 0; i < REPRESENTATIVES.length; i++) {
      for (let j = i + 1; j < REPRESENTATIVES.length; j++) {
        const a = REPRESENTATIVES[i]!;
        const b = REPRESENTATIVES[j]!;
        const d = A.fingerprintDistance(suite.get(a).fingerprint, suite.get(b).fingerprint);
        if (d < 0.25) failures.push(`${a} vs ${b}: ${d.toFixed(3)}`);
      }
    }
    expect(failures, `families too similar:\n${failures.join('\n')}`).toEqual([]);
  });

  it('has no two voices that are effectively the same sound', () => {
    const worst: { pair: string; distance: number } = { pair: '', distance: Infinity };
    for (let i = 0; i < SOUND_KEYS.length; i++) {
      for (let j = i + 1; j < SOUND_KEYS.length; j++) {
        const a = SOUND_KEYS[i]!;
        const b = SOUND_KEYS[j]!;
        const d = A.fingerprintDistance(suite.get(a).fingerprint, suite.get(b).fingerprint);
        if (d < worst.distance) {
          worst.distance = d;
          worst.pair = `${a} vs ${b}`;
        }
      }
    }
    expect(worst.distance, `closest pair: ${worst.pair}`).toBeGreaterThan(0.01);
  });
});

describe('measurement chain', () => {
  it('agrees between the browser-side and Node-side analysis', () => {
    // The metrics above are computed in the browser, next to the render. This
    // decodes the raw PCM a few probes shipped back and re-derives them here,
    // proving the numbers are a property of the audio and not of where the
    // analyser happened to run.
    const withPcm = suite.all.filter((m: IProbeMetrics) => typeof m.pcm === 'string');
    expect(withPcm.length).toBeGreaterThanOrEqual(5);
    for (const m of withPcm) {
      const pcm = decodePcm(m.pcm!);
      expect(pcm.length, `${m.name} pcm length`).toBe(Math.ceil(m.seconds * m.sampleRate));
      // 16-bit quantisation costs about 1/32768 of absolute accuracy.
      expect(Math.abs(A.peak(pcm) - m.peak), `${m.name} peak`).toBeLessThan(0.002);
      expect(Math.abs(A.rms(pcm) - m.rms), `${m.name} rms`).toBeLessThan(0.002);
      const centroid = A.spectralCentroid(pcm, m.sampleRate);
      expect(
        Math.abs(centroid - m.centroid) / Math.max(m.centroid, 1),
        `${m.name} centroid ${centroid.toFixed(1)} vs ${m.centroid.toFixed(1)}`
      ).toBeLessThan(0.1);
    }
  });
});
