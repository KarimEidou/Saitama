/**
 * MUSIC LAYERS AND PATTERNS
 *
 * The score is adaptive by ARRANGEMENT, not by mixing.
 *
 * The usual way to make game music react is to render several full stems and
 * crossfade between them. That approach has two problems this game cannot
 * live with: it needs the audio files this project does not ship, and a
 * crossfade always sounds like a crossfade — two complete pieces of music
 * fighting, with a smear in the middle.
 *
 * Instead, each intensity state is a SET OF PARTS over one shared harmonic and
 * rhythmic grid. Escalating from exploration to combat adds a bass line, a
 * kick and a stab; it does not fade anything up. Dropping back removes them.
 * Because every state shares the grid, transitions happen on a bar line and
 * are musically seamless without a single crossfade.
 *
 * ── THE BOREDOM STATE ──────────────────────────────────────────────────────
 * Boredom is the protagonist's actual problem and a real gameplay meter, so
 * the score responds to it structurally: as boredom rises, parts are REMOVED,
 * least essential first, until at the top of the range the entire score is one
 * sustained tone. Nothing is faded down; the arrangement is simply eaten away.
 * That is the audio half of the global desaturation.
 *
 * Everything in this file is pure data and pure functions — no Web Audio, no
 * state — which is what lets the arrangement logic be unit-tested without a
 * browser or an audio device.
 */

import type { InstrumentId } from './instruments';

/** Sixteenth notes per bar. */
export const STEPS_PER_BAR = 16;

/** Intensity states, in ascending energy (with `bored` as its own pole). */
export type MusicState = 'bored' | 'calm' | 'alert' | 'combat' | 'boss';

/** Every music state. */
export const MUSIC_STATES: readonly MusicState[] = ['bored', 'calm', 'alert', 'combat', 'boss'];

/** A named part in the arrangement. */
export type PartId =
  | 'drone'
  | 'pad'
  | 'pluck'
  | 'bass'
  | 'kick'
  | 'hat'
  | 'snare'
  | 'stab'
  | 'taiko'
  | 'lead';

/** A rest in a step pattern. */
export const REST = -1;

/** One part: an instrument plus a 16-step pattern of scale degrees. */
export interface IPart {
  readonly id: PartId;
  readonly instrument: InstrumentId;
  /**
   * 16 entries. `REST` is silence; any other value is an index into the
   * layer's scale, and indices beyond the scale length wrap up an octave.
   */
  readonly steps: readonly number[];
  /** Alternative pattern used on the last bar of every four-bar phrase. */
  readonly fill?: readonly number[];
  /** Base velocity 0..1. */
  readonly velocity: number;
  /** Octave offset applied to the layer root. */
  readonly octave: number;
  /** Note length in steps. */
  readonly gate: number;
  /**
   * How resistant this part is to boredom thinning. The score is eaten from
   * the lowest value upward, so the drone (100) is always the last survivor.
   */
  readonly essential: number;
}

/** One intensity state's complete arrangement. */
export interface IMusicLayer {
  readonly state: MusicState;
  readonly bpm: number;
  /** MIDI root note. */
  readonly root: number;
  /** Semitone offsets from the root. */
  readonly scale: readonly number[];
  readonly parts: readonly IPart[];
  /** One-line description, surfaced in the audition harness. */
  readonly description: string;
}

/* -------------------------------------------------------------------------- */
/* Scales                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The harmonic ladder. Each state's scale is the previous one with more
 * tension added, so escalation is audible in the PITCH material and not only
 * in the density:
 *
 *   minor pentatonic -> phrygian (flat 2) -> phrygian dominant (major 3
 *   against a flat 2) -> locrian (tritone). By the boss layer the scale has
 *   no stable fifth left.
 */
const PENTATONIC_MINOR = [0, 3, 5, 7, 10];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const PHRYGIAN_DOMINANT = [0, 1, 4, 5, 7, 8, 10];
const LOCRIAN = [0, 1, 3, 5, 6, 8, 10];

/** A (MIDI 45 = A2). Low enough for bass, high enough for a pad. */
const ROOT_A2 = 45;
const ROOT_A1 = 33;

/* -------------------------------------------------------------------------- */
/* Pattern helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Build a 16-step pattern from `[step, degree]` pairs. */
function pattern(...hits: readonly (readonly [number, number])[]): number[] {
  const steps = new Array<number>(STEPS_PER_BAR).fill(REST);
  for (const [index, degree] of hits) steps[index % STEPS_PER_BAR] = degree;
  return steps;
}

/** A degree on every `every` steps, starting at `from`. */
function repeat(degree: number, every: number, from = 0): number[] {
  const steps = new Array<number>(STEPS_PER_BAR).fill(REST);
  for (let i = from; i < STEPS_PER_BAR; i += every) steps[i] = degree;
  return steps;
}

/* -------------------------------------------------------------------------- */
/* Layers                                                                     */
/* -------------------------------------------------------------------------- */

export const LAYERS: Record<MusicState, IMusicLayer> = {
  /**
   * BORED — one sustained tone and nothing else. Not quiet music: ABSENT
   * music. Held for a full bar and re-struck each bar so it never quite dies.
   */
  bored: {
    state: 'bored',
    bpm: 60,
    root: ROOT_A2,
    scale: PENTATONIC_MINOR,
    description: 'A single sustained tone. The score has given up, exactly as the character has.',
    parts: [
      {
        id: 'drone',
        instrument: 'drone',
        steps: pattern([0, 0]),
        velocity: 0.75,
        octave: 0,
        gate: 16,
        essential: 100,
      },
    ],
  },

  /** CALM — exploration. Two parts: air and the occasional thought. */
  calm: {
    state: 'calm',
    bpm: 82,
    root: ROOT_A2,
    scale: PENTATONIC_MINOR,
    description: 'Exploration: a slow pad and a sparse pluck over a minor pentatonic.',
    parts: [
      {
        id: 'pad',
        instrument: 'pad',
        steps: pattern([0, 0], [8, 2]),
        velocity: 0.55,
        octave: 1,
        gate: 8,
        essential: 60,
      },
      {
        id: 'pluck',
        instrument: 'pluck',
        steps: pattern([2, 4], [7, 2], [11, 3], [14, 1]),
        fill: pattern([2, 4], [6, 3], [9, 2], [12, 4], [14, 3]),
        velocity: 0.45,
        octave: 2,
        gate: 2,
        essential: 30,
      },
    ],
  },

  /**
   * ALERT — something is nearby. The flat second of the phrygian scale enters,
   * a pulse appears underneath, and an offbeat hat starts counting.
   */
  alert: {
    state: 'alert',
    bpm: 96,
    root: ROOT_A2,
    scale: PHRYGIAN,
    description: 'A monster is near: phrygian flat-2 tension, a low pulse and an offbeat hat.',
    parts: [
      {
        id: 'pad',
        instrument: 'pad',
        steps: pattern([0, 0], [8, 1]),
        velocity: 0.5,
        octave: 1,
        gate: 8,
        essential: 60,
      },
      {
        id: 'pluck',
        instrument: 'pluck',
        steps: pattern([3, 4], [10, 1], [13, 2]),
        fill: pattern([3, 4], [7, 5], [10, 1], [12, 2], [15, 4]),
        velocity: 0.42,
        octave: 2,
        gate: 2,
        essential: 30,
      },
      {
        id: 'bass',
        instrument: 'bass',
        steps: pattern([0, 0], [6, 0], [8, 1], [14, 0]),
        velocity: 0.6,
        octave: -1,
        gate: 3,
        essential: 70,
      },
      {
        id: 'hat',
        instrument: 'hat',
        steps: repeat(0, 4, 2),
        velocity: 0.4,
        octave: 0,
        gate: 1,
        essential: 20,
      },
    ],
  },

  /** COMBAT — the full band. Driving, tight, no room to think. */
  combat: {
    state: 'combat',
    bpm: 132,
    root: ROOT_A1,
    scale: PHRYGIAN_DOMINANT,
    description: 'Full band: driving bass, kick, hats, snare and a phrygian-dominant stab.',
    parts: [
      {
        id: 'bass',
        instrument: 'bass',
        steps: pattern(
          [0, 0],
          [3, 0],
          [4, 0],
          [6, 1],
          [8, 0],
          [10, 0],
          [11, 3],
          [14, 1]
        ),
        velocity: 0.75,
        octave: 0,
        gate: 2,
        essential: 70,
      },
      {
        id: 'kick',
        instrument: 'kick',
        steps: pattern([0, 0], [6, 0], [8, 0], [13, 0]),
        fill: pattern([0, 0], [4, 0], [6, 0], [8, 0], [11, 0], [13, 0], [15, 0]),
        velocity: 0.9,
        octave: 0,
        gate: 1,
        essential: 80,
      },
      {
        id: 'snare',
        instrument: 'snare',
        steps: pattern([4, 0], [12, 0]),
        fill: pattern([4, 0], [12, 0], [14, 0], [15, 0]),
        velocity: 0.8,
        octave: 0,
        gate: 1,
        essential: 50,
      },
      {
        id: 'hat',
        instrument: 'hat',
        steps: repeat(0, 2),
        velocity: 0.4,
        octave: 0,
        gate: 1,
        essential: 20,
      },
      {
        id: 'stab',
        instrument: 'stab',
        steps: pattern([0, 0], [3, 2], [8, 4], [11, 2]),
        velocity: 0.65,
        octave: 2,
        gate: 2,
        essential: 40,
      },
      {
        id: 'pluck',
        instrument: 'pluck',
        steps: pattern([5, 6], [9, 4], [15, 2]),
        velocity: 0.4,
        octave: 3,
        gate: 1,
        essential: 30,
      },
    ],
  },

  /**
   * BOSS — everything, plus taiko and a lead line, in locrian. The scale has
   * a tritone where its fifth should be, so nothing ever resolves.
   */
  boss: {
    state: 'boss',
    bpm: 148,
    root: ROOT_A1,
    scale: LOCRIAN,
    description: 'Everything, plus taiko and a locrian lead. Nothing in it resolves.',
    parts: [
      {
        id: 'bass',
        instrument: 'bass',
        steps: repeat(0, 2),
        fill: pattern(
          [0, 0],
          [2, 0],
          [4, 1],
          [6, 0],
          [8, 0],
          [10, 3],
          [12, 0],
          [13, 1],
          [14, 0],
          [15, 4]
        ),
        velocity: 0.8,
        octave: 0,
        gate: 1,
        essential: 70,
      },
      {
        id: 'kick',
        instrument: 'kick',
        steps: pattern([0, 0], [3, 0], [6, 0], [8, 0], [11, 0], [14, 0]),
        velocity: 0.95,
        octave: 0,
        gate: 1,
        essential: 80,
      },
      {
        id: 'taiko',
        instrument: 'taiko',
        steps: pattern([0, 0], [8, 0], [12, 2]),
        fill: pattern([0, 0], [4, 0], [8, 0], [10, 2], [12, 0], [14, 2]),
        velocity: 0.85,
        octave: 0,
        gate: 1,
        essential: 65,
      },
      {
        id: 'snare',
        instrument: 'snare',
        steps: pattern([4, 0], [12, 0], [15, 0]),
        velocity: 0.85,
        octave: 0,
        gate: 1,
        essential: 50,
      },
      {
        id: 'hat',
        instrument: 'hat',
        steps: repeat(0, 1),
        velocity: 0.32,
        octave: 0,
        gate: 1,
        essential: 20,
      },
      {
        id: 'stab',
        instrument: 'stab',
        steps: pattern([0, 0], [2, 3], [6, 5], [8, 0], [10, 3], [14, 6]),
        velocity: 0.7,
        octave: 2,
        gate: 1,
        essential: 40,
      },
      {
        id: 'lead',
        instrument: 'lead',
        steps: pattern([0, 7], [4, 6], [7, 4], [10, 5], [13, 8]),
        fill: pattern([0, 9], [2, 8], [5, 7], [8, 6], [10, 5], [12, 4], [14, 3]),
        velocity: 0.7,
        octave: 2,
        gate: 3,
        essential: 45,
      },
      {
        id: 'pluck',
        instrument: 'pluck',
        steps: pattern([1, 6], [5, 8], [9, 6], [13, 9]),
        velocity: 0.38,
        octave: 3,
        gate: 1,
        essential: 30,
      },
    ],
  },
};

/* -------------------------------------------------------------------------- */
/* Boredom thinning                                                           */
/* -------------------------------------------------------------------------- */

/** Below this, boredom does not touch the arrangement at all. */
export const BOREDOM_THIN_START = 0.35;
/** At or above this, the arrangement has been eaten down to the drone. */
export const BOREDOM_COLLAPSE = 0.8;

/**
 * The parts that should actually be playing, given a state and a boredom
 * level.
 *
 * Pure function of its inputs — this is the whole adaptive-arrangement rule,
 * and it is unit-tested directly without any audio context.
 */
export function partsFor(state: MusicState, boredom: number): readonly IPart[] {
  const clamped = Number.isFinite(boredom) ? Math.min(Math.max(boredom, 0), 1) : 0;
  if (state === 'bored' || clamped >= BOREDOM_COLLAPSE) return LAYERS.bored.parts;

  const layer = LAYERS[state];
  if (clamped <= BOREDOM_THIN_START) return layer.parts;

  // Linearly eat the arrangement from the least essential part upward.
  const t = (clamped - BOREDOM_THIN_START) / (BOREDOM_COLLAPSE - BOREDOM_THIN_START);
  const keep = Math.max(1, Math.round(layer.parts.length * (1 - t)));
  const ranked = [...layer.parts].sort((a, b) => b.essential - a.essential);
  const kept = new Set(ranked.slice(0, keep).map((p) => p.id));
  // Preserve declaration order so the arrangement never re-orders itself.
  return layer.parts.filter((p) => kept.has(p.id));
}

/** Seconds per sixteenth-note step at a given tempo. */
export function secondsPerStep(bpm: number): number {
  return 60 / bpm / 4;
}

/**
 * Resolve a scale degree to a MIDI note. Degrees beyond the scale wrap into
 * the next octave, which is what lets one pattern language cover a bass line
 * and a lead.
 */
export function degreeToMidi(
  root: number,
  scale: readonly number[],
  degree: number,
  octave: number
): number {
  const n = scale.length;
  const wrapped = ((degree % n) + n) % n;
  const octaveShift = Math.floor(degree / n);
  return root + scale[wrapped]! + 12 * (octave + octaveShift);
}
