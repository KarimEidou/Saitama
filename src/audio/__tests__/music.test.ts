/**
 * ADAPTIVE ARRANGEMENT
 *
 * The score reacts by adding and removing PARTS, not by crossfading stems.
 * That rule lives in `partsFor` and the layer tables, both of which are pure
 * data and pure functions — so the musical behaviour can be asserted exactly,
 * without an audio device, right down to which instruments are playing at a
 * given boredom level.
 */

import { describe, expect, it } from 'vitest';
import {
  BOREDOM_COLLAPSE,
  BOREDOM_THIN_START,
  degreeToMidi,
  LAYERS,
  MUSIC_STATES,
  partsFor,
  REST,
  secondsPerStep,
  STEPS_PER_BAR,
  type MusicState,
} from '../music/patterns';
import { chainInterval, chainSchedule } from '../voices/consecutive';
import { poissonOnsets } from '../dsp';
import { createRng } from '@/util';
import { intervalIrregularity, mean, stdDev } from '../testing/analysis';

describe('layer tables', () => {
  it('defines every intensity state', () => {
    for (const state of MUSIC_STATES) {
      expect(LAYERS[state]).toBeDefined();
      expect(LAYERS[state].state).toBe(state);
      expect(LAYERS[state].parts.length).toBeGreaterThan(0);
      expect(LAYERS[state].description.length).toBeGreaterThan(20);
    }
  });

  it('escalates by ADDING parts, not by raising a level', () => {
    const counts = (['bored', 'calm', 'alert', 'combat', 'boss'] as MusicState[]).map(
      (s) => LAYERS[s].parts.length
    );
    expect(counts).toEqual([1, 2, 4, 6, 8]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
  });

  it('raises the tempo with the intensity', () => {
    const tempos = (['calm', 'alert', 'combat', 'boss'] as MusicState[]).map((s) => LAYERS[s].bpm);
    for (let i = 1; i < tempos.length; i++) expect(tempos[i]!).toBeGreaterThan(tempos[i - 1]!);
    expect(LAYERS.bored.bpm).toBeLessThan(LAYERS.calm.bpm);
  });

  it('adds harmonic tension as it escalates', () => {
    // Each scale keeps or adds dissonance: pentatonic has no semitone at all,
    // phrygian adds the flat 2, locrian loses the perfect fifth.
    expect(LAYERS.calm.scale).not.toContain(1);
    expect(LAYERS.alert.scale).toContain(1);
    expect(LAYERS.combat.scale).toContain(1);
    expect(LAYERS.boss.scale).toContain(6); // tritone
    expect(LAYERS.boss.scale).not.toContain(7); // no perfect fifth to resolve to
  });

  it('gives every part a well-formed 16-step pattern', () => {
    for (const state of MUSIC_STATES) {
      const layer = LAYERS[state];
      for (const part of layer.parts) {
        expect(part.steps, `${state}/${part.id}`).toHaveLength(STEPS_PER_BAR);
        if (part.fill) expect(part.fill).toHaveLength(STEPS_PER_BAR);
        expect(part.steps.some((s) => s !== REST), `${state}/${part.id} is empty`).toBe(true);
        expect(part.velocity).toBeGreaterThan(0);
        expect(part.velocity).toBeLessThanOrEqual(1);
        expect(part.gate).toBeGreaterThan(0);
        for (const step of part.steps) {
          expect(Number.isInteger(step)).toBe(true);
          expect(step).toBeGreaterThanOrEqual(REST);
        }
      }
    }
  });

  it('gives every part a distinct id and essentialness within its layer', () => {
    for (const state of MUSIC_STATES) {
      const parts = LAYERS[state].parts;
      expect(new Set(parts.map((p) => p.id)).size).toBe(parts.length);
      expect(new Set(parts.map((p) => p.essential)).size).toBe(parts.length);
    }
  });
});

describe('boredom thinning', () => {
  it('leaves the arrangement alone below the threshold', () => {
    for (const state of ['calm', 'alert', 'combat', 'boss'] as MusicState[]) {
      expect(partsFor(state, 0)).toHaveLength(LAYERS[state].parts.length);
      expect(partsFor(state, BOREDOM_THIN_START)).toHaveLength(LAYERS[state].parts.length);
    }
  });

  it('eats the arrangement away as boredom rises', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const boredom of [0.35, 0.45, 0.55, 0.65, 0.75, 0.8]) {
      const n = partsFor('boss', boredom).length;
      expect(n).toBeLessThanOrEqual(previous);
      previous = n;
    }
    expect(partsFor('boss', 0.35)).toHaveLength(8);
    expect(partsFor('boss', 0.79).length).toBeLessThan(8);
  });

  it('collapses to a SINGLE SUSTAINED TONE at the top of the range', () => {
    for (const state of MUSIC_STATES) {
      const parts = partsFor(state, BOREDOM_COLLAPSE);
      expect(parts, `${state} did not collapse`).toHaveLength(1);
      expect(parts[0]!.id).toBe('drone');
      expect(parts[0]!.instrument).toBe('drone');
      // One note, held for a whole bar: a tone, not a rhythm.
      expect(parts[0]!.steps.filter((s) => s !== REST)).toHaveLength(1);
      expect(parts[0]!.gate).toBe(STEPS_PER_BAR);
    }
    expect(partsFor('boss', 1)).toHaveLength(1);
  });

  it('drops the least essential parts first and keeps the backbone longest', () => {
    const surviving = partsFor('combat', 0.65).map((p) => p.id);
    // Hats are decoration; the kick is the backbone.
    expect(surviving).toContain('kick');
    expect(surviving).not.toContain('hat');
  });

  it('never re-orders the arrangement', () => {
    const full = LAYERS.boss.parts.map((p) => p.id);
    const thinned = partsFor('boss', 0.6).map((p) => p.id);
    const expected = full.filter((id) => thinned.includes(id));
    expect(thinned).toEqual(expected);
  });

  it('treats a non-finite boredom value as zero', () => {
    expect(partsFor('combat', Number.NaN)).toHaveLength(6);
    expect(partsFor('combat', -5)).toHaveLength(6);
    expect(partsFor('combat', 99)).toHaveLength(1);
  });
});

describe('musical arithmetic', () => {
  it('converts tempo to a sixteenth-note step', () => {
    expect(secondsPerStep(120)).toBeCloseTo(0.125, 9);
    expect(secondsPerStep(60)).toBeCloseTo(0.25, 9);
    // A whole bar at 132 bpm.
    expect(secondsPerStep(132) * STEPS_PER_BAR).toBeCloseTo((60 / 132) * 4, 9);
  });

  it('wraps scale degrees into higher octaves', () => {
    const scale = [0, 3, 5, 7, 10];
    expect(degreeToMidi(45, scale, 0, 0)).toBe(45);
    expect(degreeToMidi(45, scale, 4, 0)).toBe(55);
    // Degree 5 wraps to the root an octave up.
    expect(degreeToMidi(45, scale, 5, 0)).toBe(57);
    expect(degreeToMidi(45, scale, 0, 2)).toBe(69);
    expect(degreeToMidi(45, scale, -1, 0)).toBe(43);
  });

  it('keeps the notes of every layer inside a playable range', () => {
    for (const state of MUSIC_STATES) {
      const layer = LAYERS[state];
      for (const part of layer.parts) {
        for (const steps of [part.steps, part.fill ?? []]) {
          for (const degree of steps) {
            if (degree === REST) continue;
            const midi = degreeToMidi(layer.root, layer.scale, degree, part.octave);
            expect(midi, `${state}/${part.id}`).toBeGreaterThanOrEqual(20);
            expect(midi, `${state}/${part.id}`).toBeLessThanOrEqual(108);
          }
        }
      }
    }
  });
});

describe('punch chain scheduling', () => {
  it('lengthens the chain with intensity', () => {
    expect(chainSchedule('consecutive', 0).length).toBe(5);
    expect(chainSchedule('consecutive', 1).length).toBe(16);
    expect(chainSchedule('barrage', 1).length).toBe(32);
    expect(chainSchedule('flurry', 0).length).toBe(2);
  });

  it('tightens the spacing with intensity', () => {
    expect(chainInterval('consecutive', 1)).toBeLessThan(chainInterval('consecutive', 0));
    expect(chainInterval('barrage', 1)).toBeLessThan(chainInterval('consecutive', 1));
  });

  it('raises the pitch on every hit of the chain', () => {
    const hits = chainSchedule('consecutive', 0.6);
    const body = hits.slice(0, -1);
    for (let i = 1; i < body.length; i++) {
      expect(body[i]!.pitch).toBeGreaterThan(body[i - 1]!.pitch);
    }
    // A full chain rises by a musically meaningful amount, not a hair.
    expect(body[body.length - 1]!.pitch / body[0]!.pitch).toBeGreaterThan(1.2);
  });

  it('resolves the chain with a lower, harder, longer finisher', () => {
    const hits = chainSchedule('consecutive', 0.6);
    const finisher = hits[hits.length - 1]!;
    const previous = hits[hits.length - 2]!;
    expect(finisher.isFinisher).toBe(true);
    expect(finisher.pitch).toBeLessThan(previous.pitch);
    expect(finisher.gain).toBeGreaterThan(previous.gain);
    expect(finisher.decay).toBeGreaterThan(previous.decay * 2);
  });

  it('spaces hits evenly before humanisation', () => {
    const hits = chainSchedule('barrage', 0.9);
    const gaps: number[] = [];
    for (let i = 1; i < hits.length; i++) gaps.push(hits[i]!.offset - hits[i - 1]!.offset);
    expect(stdDev(gaps)).toBeLessThan(1e-9);
    expect(mean(gaps)).toBeCloseTo(chainInterval('barrage', 0.9), 9);
  });
});

describe('granular onset scheduler', () => {
  it('produces irregular, clustered arrivals rather than a grid', () => {
    const rng = createRng('debris-test');
    const onsets = poissonOnsets(60, 1.2, () => rng.next());
    expect(onsets.length).toBeGreaterThan(20);
    // A uniform grid scores ~0; a Poisson process scores near 1. Anything
    // above ~0.35 no longer reads as mechanical.
    expect(intervalIrregularity(onsets)).toBeGreaterThan(0.35);
  });

  it('is deterministic for a given seed and different for a different one', () => {
    const a = poissonOnsets(30, 1, (() => {
      const r = createRng(7);
      return () => r.next();
    })());
    const b = poissonOnsets(30, 1, (() => {
      const r = createRng(7);
      return () => r.next();
    })());
    const c = poissonOnsets(30, 1, (() => {
      const r = createRng(8);
      return () => r.next();
    })());
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('stays inside the requested window and respects the minimum gap', () => {
    const rng = createRng(3);
    const onsets = poissonOnsets(80, 0.5, () => rng.next(), 0.004);
    for (const t of onsets) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThanOrEqual(0.5);
    }
    for (let i = 1; i < onsets.length; i++) {
      expect(onsets[i]! - onsets[i - 1]!).toBeGreaterThanOrEqual(0.004);
    }
  });

  it('handles degenerate requests', () => {
    const rng = createRng(1);
    expect(poissonOnsets(0, 1, () => rng.next())).toEqual([]);
    expect(poissonOnsets(-3, 1, () => rng.next())).toEqual([]);
  });
});
