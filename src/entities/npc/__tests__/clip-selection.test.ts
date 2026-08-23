/**
 * WHAT 250 INSTANCED CIVILIANS ARE VISIBLY DOING
 *
 * `clipForMood` decides the VAT clip for every mid-tier body in the city, and
 * the rule its own doc-comment states is the one worth pinning: foot sliding is
 * the single most obvious crowd artefact and it is entirely caused by playing a
 * locomotion clip on a body that is not moving.
 *
 * That applies to a FLEEING civilian as much as a commuting one. Someone
 * pinned against a façade by the containment pass, or wedged in the knot the
 * separation pass is holding apart, is at ~0 m/s — and the flee cycle is the
 * fastest clip in the bake, playing in the mood that is most populated during
 * the only sequences anyone watches.
 */

import { describe, it, expect } from 'vitest';
import {
  CROWD_CLIP_COWER,
  CROWD_CLIP_FLEE,
  CROWD_CLIP_GAWK,
  CROWD_CLIP_IDLE,
  CROWD_CLIP_RUN,
  CROWD_CLIP_WALK,
  clipForMood,
} from '../crowd-renderer';
import { MOOD_COMMUTE, MOOD_COWER, MOOD_DOWN, MOOD_FLEE, MOOD_GAWK } from '../crowd-agents';
import { SPEED_FLEE, SPEED_WALK } from '../constants';

describe('clipForMood', () => {
  it('gives the stationary moods their own clips, whatever the velocity says', () => {
    // A gawker's residual creep must not turn them into a walker, and a body
    // on the pavement is frozen on the cower pose by the renderer's rate-0
    // path rather than by a different clip.
    expect(clipForMood(MOOD_GAWK, 0, 0)).toBe(CROWD_CLIP_GAWK);
    expect(clipForMood(MOOD_GAWK, 4, 0)).toBe(CROWD_CLIP_GAWK);
    expect(clipForMood(MOOD_COWER, 0, 0)).toBe(CROWD_CLIP_COWER);
    expect(clipForMood(MOOD_COWER, 4, 0)).toBe(CROWD_CLIP_COWER);
    expect(clipForMood(MOOD_DOWN, 0, 0)).toBe(CROWD_CLIP_COWER);
  });

  it('splits a commuter on measured speed rather than on intent', () => {
    expect(clipForMood(MOOD_COMMUTE, 0, 0)).toBe(CROWD_CLIP_IDLE);
    expect(clipForMood(MOOD_COMMUTE, 0.2, 0)).toBe(CROWD_CLIP_IDLE);
    // The threshold is 0.3 m/s, and it is a floor rather than a ceiling.
    expect(clipForMood(MOOD_COMMUTE, 0.3, 0)).toBe(CROWD_CLIP_WALK);
    expect(clipForMood(MOOD_COMMUTE, SPEED_WALK, 0)).toBe(CROWD_CLIP_WALK);
    expect(clipForMood(MOOD_COMMUTE, 3, 0)).toBe(CROWD_CLIP_RUN);
  });

  it('stands a blocked fleer still instead of running them on the spot', () => {
    expect(clipForMood(MOOD_FLEE, SPEED_FLEE, 0)).toBe(CROWD_CLIP_FLEE);
    expect(clipForMood(MOOD_FLEE, 0, SPEED_FLEE)).toBe(CROWD_CLIP_FLEE);
    // Pinned against a façade, or wedged in a jam: the same guard as `commute`,
    // for the same reason. `chooseMood` already promotes a genuinely cornered
    // civilian to `MOOD_COWER`, so idle is the honest "blocked, not yet
    // cowering" pose.
    expect(clipForMood(MOOD_FLEE, 0, 0)).toBe(CROWD_CLIP_IDLE);
    expect(clipForMood(MOOD_FLEE, 0.2, 0.1)).toBe(CROWD_CLIP_IDLE);
    // And the same 0.3 m/s floor, so a fleer who is moving at all still runs.
    expect(clipForMood(MOOD_FLEE, 0.3, 0)).toBe(CROWD_CLIP_FLEE);
  });
});
