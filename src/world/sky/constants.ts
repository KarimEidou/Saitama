/**
 * DAY / NIGHT TUNING CONSTANTS
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE MEASUREMENT THAT DRIVES THIS WHOLE FILE
 *
 *  The texture pipeline processed four Poly Haven HDRIs and measured them:
 *
 *      sky     peak luminance      MEAN luminance
 *      day        136 998              0.733
 *      night          555              0.712
 *      dawn             8              1.098
 *      dusk             4              0.904
 *
 *  The PEAKS span five orders of magnitude. The MEANS are all ~0.7-1.1.
 *  Poly Haven authors each capture to look good on its own in a viewer, not
 *  to sit on one absolute photometric scale with its siblings.
 *
 *  Consequence: swapping or cross-fading these maps by time of day, with no
 *  further work, produces a MIDNIGHT AS BRIGHT AS NOON. Ambient light comes
 *  from the mean of the environment, not its peak — the sun disc is a handful
 *  of texels and contributes almost nothing to the average.
 *
 *  The same trap sits in the baked SH: the L0 (DC) coefficients are
 *  day (2.52, 2.60, 2.80) against night (2.35, 2.57, 2.55) — night is 95% as
 *  bright as noon in irradiance terms.
 *
 *  So every environment is DIVIDED BY ITS OWN MEASURED MEAN before use, which
 *  flattens all four onto a common unit scale, and the time of day then
 *  supplies the absolute brightness through `TIME_KEYFRAMES[].luminance`.
 *  That is what `envMapIntensity` carries. Removing the division puts the bug
 *  straight back.
 * ══════════════════════════════════════════════════════════════════════════
 */

import type { DayPhase } from '@/types';

/* -------------------------------------------------------------------------- */
/* Cycle                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Real seconds for one full in-game day. 24 minutes = one real minute per
 * in-game hour, which is the classic open-world compromise: long enough that
 * a fight does not visibly slide through two phases, short enough that a
 * player who wants to see night does not have to wait for it.
 */
export const DAY_LENGTH_SECONDS = 24 * 60;

/**
 * City Z is unlocated in canon but unambiguously Japanese. 35.6°N puts the
 * solar arc where the art expects it: a high but not overhead summer noon, and
 * a sun that sets rather than dropping straight down as it would at 0°.
 */
export const CITY_LATITUDE_DEGREES = 35.6;

/** Longitude and the standard meridian of its time zone (JST, UTC+9). */
export const CITY_LONGITUDE_DEGREES = 139.7;
export const CITY_TIMEZONE_HOURS = 9;

/**
 * Day of the year the world sits on. Fixed rather than advancing, so the
 * solar arc is REPRODUCIBLE — a screenshot taken on in-game day 1 and one
 * taken on day 40 must be comparable. Day 172 is the June solstice: the
 * longest, highest arc, which is the look the source material has.
 */
export const WORLD_DAY_OF_YEAR = 172;

/** Synodic month in days, for the lunar-phase approximation. */
export const SYNODIC_MONTH_DAYS = 29.530588;

/**
 * Lunar age in days at world start. 14.0 ≈ full moon, which puts the moon on
 * the meridian at midnight and gives night a directional light to cast by. A
 * first-quarter moon (7.4) sets before midnight and leaves the deep-night
 * screenshots lit by ambient alone — correct, but it reads as a bug.
 */
export const INITIAL_LUNAR_AGE_DAYS = 14.0;

/* -------------------------------------------------------------------------- */
/* Phases                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Phase boundaries as normalised time, ASCENDING. `midnight` owns everything
 * outside the last boundary and the first, i.e. it wraps through t = 0.
 *
 * Times in the comments are the in-game clock (t * 24 h).
 */
export const PHASE_BOUNDARIES: readonly { readonly start: number; readonly phase: DayPhase }[] = [
  { start: 0.1875, phase: 'dawn' }, //  04:30
  { start: 0.2917, phase: 'morning' }, //  07:00
  { start: 0.4583, phase: 'noon' }, //  11:00
  { start: 0.5833, phase: 'afternoon' }, //  14:00
  { start: 0.7292, phase: 'dusk' }, //  17:30
  { start: 0.8125, phase: 'night' }, //  19:30
  { start: 0.9375, phase: 'midnight' }, //  22:30
];

/* -------------------------------------------------------------------------- */
/* Environment keyframes                                                      */
/* -------------------------------------------------------------------------- */

/** Manifest ids of the four baked skies. Never a file path — see the header. */
export const SKY_ASSET_IDS = {
  dawn: 'hdri.sky.dawn',
  day: 'hdri.sky.day',
  dusk: 'hdri.sky.dusk',
  night: 'hdri.sky.night',
} as const;

/** Short key for one of the four baked environments. */
export type SkyKey = keyof typeof SKY_ASSET_IDS;

/**
 * One point on the environment/brightness curve.
 *
 * `luminance` is the TARGET mean radiance of the sky at this time, on an
 * arbitrary but self-consistent scale where clear noon is 1.0. It is the
 * number that actually makes night dark, because the source maps carry no
 * usable absolute scale of their own (see the header).
 *
 * The ratios are perceptual, not photometric. True midnight is ~1e-5 of noon;
 * rendering that literally gives a black screen, because a screen has ~2.5
 * orders of magnitude of range and the eye's own adaptation is not simulated.
 * 0.014 is a moonlit-night ratio that survives ACES and still reads as night
 * once the partial-adaptation exposure curve below has had its say.
 */
export interface ISkyKeyframe {
  /** Normalised time of day, 0..1 ascending. */
  readonly t: number;
  readonly sky: SkyKey;
  /** Target mean sky radiance; noon is 1.0. */
  readonly luminance: number;
}

/**
 * The cycle, as keyframes. Consecutive entries with DIFFERENT `sky` values are
 * the cross-fades; consecutive entries with the same `sky` just ramp
 * brightness. First and last must both be at the same sky so the loop is
 * seamless across midnight.
 */
/**
 * The times below are pinned to the SOLAR MODEL, not to intuition. At 35.6°N
 * on day 172 the sun rises at 04:30 (t = 0.1875) and sets at 18:58
 * (t = 0.790) — see `solar.ts`. Authoring a 06:00 sunrise here would put a
 * bright directional light in a twilight-dark sky for ninety minutes, which is
 * a subtler version of exactly the mismatch this system exists to prevent.
 */
export const TIME_KEYFRAMES: readonly ISkyKeyframe[] = [
  { t: 0.0, sky: 'night', luminance: 0.014 }, // 00:00 deep night
  { t: 0.145, sky: 'night', luminance: 0.015 }, // 03:29 nautical twilight
  { t: 0.175, sky: 'dawn', luminance: 0.055 }, // 04:12 civil twilight
  { t: 0.2, sky: 'dawn', luminance: 0.2 }, // 04:48 just past sunrise
  { t: 0.235, sky: 'dawn', luminance: 0.42 }, // 05:38 low golden light
  { t: 0.3, sky: 'day', luminance: 0.72 }, // 07:12 morning
  { t: 0.42, sky: 'day', luminance: 0.94 }, // 10:05
  { t: 0.5, sky: 'day', luminance: 1.0 }, // 12:00 noon reference
  { t: 0.62, sky: 'day', luminance: 0.9 }, // 14:53
  { t: 0.7, sky: 'dusk', luminance: 0.55 }, // 16:48 golden hour
  { t: 0.755, sky: 'dusk', luminance: 0.22 }, // 18:07 low sun
  { t: 0.795, sky: 'dusk', luminance: 0.06 }, // 19:05 just past sunset
  { t: 0.825, sky: 'night', luminance: 0.022 }, // 19:48 nightfall
  { t: 0.87, sky: 'night', luminance: 0.016 }, // 20:53
  { t: 1.0, sky: 'night', luminance: 0.014 }, // 24:00 wraps to the first entry
];

/* -------------------------------------------------------------------------- */
/* Exposure                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * PARTIAL eye adaptation.
 *
 * A real observer at midnight is not seeing a scene 70x darker than noon; the
 * pupil opens and the rods take over. A camera-style auto-exposure that
 * cancelled the difference completely, however, is exactly the bug this whole
 * file exists to avoid — it would make midnight as bright as noon by a
 * different route.
 *
 *   exposure = EXPOSURE_REFERENCE * luminance^(-ADAPTATION)
 *
 * so the net on-screen brightness goes as `luminance^(1 - ADAPTATION)`.
 * At 0.16, midnight (0.014) lands at 2.8% of noon on screen while exposure
 * itself only doubles. Set ADAPTATION to 0 for no adaptation at all, or to 1
 * to reintroduce the bug.
 */
export const EXPOSURE_ADAPTATION = 0.16;

/** Exposure at the reference luminance of 1.0 (clear noon). */
export const EXPOSURE_REFERENCE = 1.0;

/** Hard bounds. ACES loses its shoulder outside roughly this band. */
export const EXPOSURE_MIN = 0.8;
export const EXPOSURE_MAX = 2.2;

/* -------------------------------------------------------------------------- */
/* Direct light                                                               */
/* -------------------------------------------------------------------------- */

/** Direct sun intensity at the top of its arc, in three's physical units. */
export const SUN_PEAK_INTENSITY = 3.1;

/** Moonlight intensity at lunar zenith with a full moon. */
export const MOON_PEAK_INTENSITY = 0.085;

/**
 * Sun elevation (radians) at which direct sunlight is fully extinguished.
 * Slightly below the horizon: the disc is still refracted into view at 0, and
 * the last of the direct light survives a little past geometric sunset.
 */
export const SUN_EXTINCTION_ELEVATION = -0.105; // ≈ -6°, civil twilight

/** Sun colour at zenith and at the horizon. Rayleigh reddening, approximated. */
export const SUN_COLOR_ZENITH = 0xfff4e2;
export const SUN_COLOR_HORIZON = 0xff8c3a;
export const MOON_COLOR = 0xa8c4ff;

/* -------------------------------------------------------------------------- */
/* Fog and shadows                                                            */
/* -------------------------------------------------------------------------- */

/** Fog density at noon and at midnight. Night air reads thicker and closer. */
export const FOG_DENSITY_DAY = 0.0014;
export const FOG_DENSITY_NIGHT = 0.0032;

/**
 * Cascade half-extent in metres, day and night. Tightened at night because the
 * moon casts a far weaker, softer shadow that gains nothing from covering
 * 200 m, and the resolution is better spent close to the player.
 */
export const SHADOW_RADIUS_DAY = 200;
export const SHADOW_RADIUS_NIGHT = 60;

/* -------------------------------------------------------------------------- */
/* Street lights                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sky luminance at which the street lights switch on, and the width of the
 * ramp. Photocell behaviour: lamps come on during dusk, well before it is
 * actually dark, and go off after dawn has clearly arrived.
 */
export const STREET_LIGHT_ON_LUMINANCE = 0.115;
export const STREET_LIGHT_RAMP = 0.085;

/** Fraction of window panes lit at deep night. The rest of the city sleeps. */
export const WINDOW_LIT_FRACTION_NIGHT = 0.3;
/** Fraction lit during the evening, when everyone is still up. */
export const WINDOW_LIT_FRACTION_EVENING = 0.66;

/**
 * Normalised time the evening begins, and how long the city takes to go to
 * bed. Used to ramp window occupancy DOWN through the small hours; the ramp
 * has to be wrap-aware because it crosses t = 0.
 */
export const EVENING_START = 0.79; // 18:58, sunset
export const EVENING_LENGTH = 0.28; // ~6.7 h, so ~01:40 before the city sleeps

/* -------------------------------------------------------------------------- */
/* Colour derivation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Chroma gain applied to colours read out of the sky's spherical harmonics.
 *
 * Irradiance integrated over a hemisphere is nearly achromatic even under a
 * strongly coloured sky — the night map's SH DC term is (2.35, 2.57, 2.55),
 * which is 9% off neutral. Rendered literally, ambient light carries no time
 * of day at all. The gain expands chroma about the luminance axis, keeping the
 * HUE the measurement gives and making it legible.
 */
export const AMBIENT_CHROMA_GAIN = 2.8;
export const FOG_CHROMA_GAIN = 2.2;

/**
 * Scotopic (Purkinje) tint, and how far ambient is pushed towards it at full
 * night. Rod-dominated vision genuinely is blue-shifted — this is a real
 * perceptual effect, not a colour grade, and it is why moonlight "looks blue"
 * despite being reflected sunlight.
 */
export const SCOTOPIC_TINT = 0x6f8cff;
export const SCOTOPIC_BLEND = 0.55;

/* -------------------------------------------------------------------------- */
/* Environment blending                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ceiling applied to the normalised blend, in radiance units.
 *
 * The day map's sun disc is stored CLAMPED at the half-float ceiling of 65504
 * (its true peak was 136 998). Dividing by its mean of 0.733 would push that
 * to ~89 000, which overflows a half-float render target to +Infinity, and an
 * Infinity anywhere in a PMREM convolution poisons the whole mip chain with
 * NaN. The disc is already clamped, so clamping it slightly harder costs
 * nothing real.
 *
 * The SH data is unaffected: it was projected from full-precision floats
 * BEFORE the half-float conversion, so its sun energy is correct.
 */
export const MAX_BLEND_RADIANCE = 50000;

/**
 * Rebuild the pre-filtered radiance map when the blend parameters have moved
 * this far (0..1 over the whole cycle).
 *
 * PMREM convolution is tens of milliseconds; doing it per frame for a
 * continuously moving cycle would be absurd. The visible sky and the ambient
 * SH both update EVERY frame — only the specular pre-filter steps, and at
 * 1/64 of a 24-minute cycle that is one rebuild every 22 seconds, on a signal
 * that is by construction low frequency.
 */
export const ENVIRONMENT_REBUILD_THRESHOLD = 1 / 64;

/** Equirect resolution of the blend target, per IBL path. */
export const BLEND_TARGET_WIDTH_PMREM = 1024;
export const BLEND_TARGET_WIDTH_SH9 = 512;
