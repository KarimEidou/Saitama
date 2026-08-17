/**
 * LIGHTING STATE DERIVED FROM THE CLOCK
 *
 * Turns a normalised time of day into the two published states:
 *
 *   `ILightingState` (render.ts)  — what the renderer, shadows and fog read.
 *   `IDayNightState` (gameplay.ts) — the authoritative clock other systems read.
 *
 * ── WHAT IS DERIVED AND WHAT IS AUTHORED ───────────────────────────────────
 * DERIVED FROM DATA: sun and moon direction (real solar geometry), and every
 * COLOUR — ambient, ground bounce and fog hue all come from evaluating the
 * blended, exposure-normalised SH in the relevant direction. If the art team
 * swaps an HDRI, the fog follows automatically.
 *
 * AUTHORED: the brightness curve, because there is nothing in the source maps
 * to derive it from — that is the entire finding this system exists to handle.
 *
 * ── EXPOSURE IS PART OF THE LOOK, NOT A CORRECTION ─────────────────────────
 * The exposure curve is deliberately a PARTIAL adaptation (see
 * `EXPOSURE_ADAPTATION`). A full auto-exposure would cancel the luminance
 * curve exactly and hand back the "midnight looks like noon" bug wearing a
 * different hat. Net on-screen brightness at midnight is ~2.8% of noon.
 *
 * Pure: no GL, no assets, no globals. Vectors and colours are mutated in place.
 */

import * as THREE from 'three';
import type { DayPhase, IDayNightState, ILightingState } from '@/types';
import { clamp, clamp01, lerp, smoothstep } from '@/util';
import {
  AMBIENT_CHROMA_GAIN,
  EVENING_LENGTH,
  EVENING_START,
  EXPOSURE_ADAPTATION,
  EXPOSURE_MAX,
  EXPOSURE_MIN,
  EXPOSURE_REFERENCE,
  FOG_CHROMA_GAIN,
  FOG_DENSITY_DAY,
  FOG_DENSITY_NIGHT,
  MOON_COLOR,
  MOON_PEAK_INTENSITY,
  PHASE_BOUNDARIES,
  SCOTOPIC_BLEND,
  SCOTOPIC_TINT,
  SHADOW_RADIUS_DAY,
  SHADOW_RADIUS_NIGHT,
  STREET_LIGHT_ON_LUMINANCE,
  STREET_LIGHT_RAMP,
  SUN_COLOR_HORIZON,
  SUN_COLOR_ZENITH,
  SUN_EXTINCTION_ELEVATION,
  SUN_PEAK_INTENSITY,
  WINDOW_LIT_FRACTION_EVENING,
  WINDOW_LIT_FRACTION_NIGHT,
} from './constants';
import { boostChroma, irradianceTowards, normaliseHue, type ISkyBlend } from './environment-blend';
import { moonIllumination, moonPosition, sunPosition, type ISolarOptions } from './solar';

/** Named phase for a normalised time. `midnight` wraps through t = 0. */
export function phaseForTime(timeOfDay: number): DayPhase {
  const t = wrapUnit(timeOfDay);
  let phase: DayPhase = 'midnight';
  for (const boundary of PHASE_BOUNDARIES) {
    if (t >= boundary.start) phase = boundary.phase;
  }
  return phase;
}

/**
 * Extra signals the sky system publishes that neither contract has a field
 * for. Kept beside the states rather than smuggled into them, because
 * `ILightingState` and `IDayNightState` are shared contracts and this
 * workstream does not own them.
 */
export interface ISkyDerived {
  /** 0 by day, 1 at full night. THE single value the shared uniform carries. */
  readonly nightFactor: number;
  /** Fraction of window panes lit, 0..1. */
  readonly windowLitFraction: number;
  /** Target mean sky radiance for this time; also `envMapIntensity`. */
  readonly skyLuminance: number;
  /** Moon elevation in radians. */
  readonly moonElevation: number;
  /** Illuminated fraction of the lunar disc, 0..1. */
  readonly moonPhase: number;
  /** True while the moon, not the sun, is the directional light. */
  readonly moonIsKeyLight: boolean;
}

/**
 * A writable `ILightingState`.
 *
 * Structurally satisfies the read-only contract, so it can be handed straight
 * to `IRenderer.setLightingState()` and to the shadow system without a copy.
 */
export class MutableSkyLightingState implements ILightingState {
  readonly sunDirection = new THREE.Vector3(0, -1, 0);
  readonly sunColor = new THREE.Color(0xffffff);
  sunIntensity = 0;
  readonly ambientColor = new THREE.Color(0xffffff);
  ambientIntensity = 0;
  readonly groundColor = new THREE.Color(0x000000);
  readonly fogColor = new THREE.Color(0x000000);
  fogDensity = FOG_DENSITY_DAY;
  envMapIntensity = 1;
  exposure = 1;
  streetLightsOn = false;
  shadowRadius = SHADOW_RADIUS_DAY;
}

/** A writable `IDayNightState`. */
export class MutableDayNightState implements IDayNightState {
  timeOfDay = 0;
  phase: DayPhase = 'midnight';
  dayCount = 0;
  dayLengthSeconds = 0;
  readonly sunDirection = new THREE.Vector3(0, -1, 0);
  sunElevation = 0;
  sunIntensity = 0;
  moonIntensity = 0;
  readonly ambientColor = new THREE.Color(0xffffff);
  readonly sunColor = new THREE.Color(0xffffff);
  streetLightsOn = false;
}

/* Scratch. This runs every frame; it must not allocate. --------------------- */
const SCRATCH_UP = new THREE.Vector3(0, 1, 0);
const SCRATCH_HORIZON = new THREE.Vector3(0, 0, 1);

/**
 * Diffuse albedo of City Z's streets, as a tint. Weathered asphalt and
 * concrete: mid grey, very slightly warm. The magnitude does not matter — only
 * the ratio survives `normaliseHue`.
 */
const CITY_ALBEDO = new THREE.Color(0.46, 0.42, 0.36);
const SUN_ZENITH = new THREE.Color(SUN_COLOR_ZENITH);
const SUN_HORIZON = new THREE.Color(SUN_COLOR_HORIZON);
const MOON_TINT = new THREE.Color(MOON_COLOR);
const SCOTOPIC = new THREE.Color(SCOTOPIC_TINT);

/** Wrap into [0, 1). Shared by the phase lookup and the evening ramp. */
function wrapUnit(t: number): number {
  const w = t % 1;
  return w < 0 ? w + 1 : w;
}

export interface IDeriveLightingInput {
  readonly timeOfDay: number;
  readonly lunarAgeDays: number;
  readonly blend: ISkyBlend;
  /**
   * Blended, exposure-NORMALISED SH for the current time. Colours are read out
   * of it. Pass undefined before the environments have loaded; neutral greys
   * are used instead, and the scene is lit but colourless.
   */
  readonly sh: THREE.SphericalHarmonics3 | undefined;
  readonly solar?: ISolarOptions;
}

/**
 * Fill `lighting` and `derived` from the clock. Allocation-free.
 *
 * @returns the same `derived` object, for convenience.
 */
export function deriveLighting(
  input: IDeriveLightingInput,
  lighting: MutableSkyLightingState
): ISkyDerived {
  const { timeOfDay, lunarAgeDays, blend, sh } = input;
  const sun = sunPosition(timeOfDay, input.solar);
  const moon = moonPosition(timeOfDay, lunarAgeDays, input.solar);
  const moonPhase = moonIllumination(lunarAgeDays);

  /* Direct sun ----------------------------------------------------------- */

  // Ramp direct sunlight out between the horizon and civil twilight rather
  // than snapping it off at elevation 0: the sun is a disc, the atmosphere
  // refracts it, and a hard cut is the single most obvious "this is a game"
  // tell in a day/night cycle.
  const sunAbove = smoothstep(SUN_EXTINCTION_ELEVATION, 0.12, sun.elevation);
  // Airmass reddening: near the horizon the path length through the
  // atmosphere is long and short wavelengths scatter out.
  const horizonMix = 1 - smoothstep(0.0, 0.5, Math.max(0, sun.elevation));
  const sunIntensity = SUN_PEAK_INTENSITY * sunAbove * (0.35 + 0.65 * Math.sin(Math.max(0, sun.elevation)) ** 0.5);

  /* Moon ----------------------------------------------------------------- */

  const moonAbove = smoothstep(-0.05, 0.15, moon.elevation);
  const moonIntensity = MOON_PEAK_INTENSITY * moonAbove * moonPhase * (1 - sunAbove);
  const moonIsKeyLight = moonIntensity > sunIntensity;

  /* Key light: sun by day, moon by night --------------------------------- */

  // `ILightingState` carries ONE directional light. Whichever body is
  // brighter owns it, so night still casts real shadows instead of going
  // flat. `IDayNightState` below keeps the true sun vector for gameplay.
  if (moonIsKeyLight) {
    lighting.sunDirection.set(-moon.toBodyX, -moon.toBodyY, -moon.toBodyZ).normalize();
    lighting.sunColor.copy(MOON_TINT);
    lighting.sunIntensity = moonIntensity;
  } else {
    lighting.sunDirection.set(-sun.toBodyX, -sun.toBodyY, -sun.toBodyZ).normalize();
    lighting.sunColor.copy(SUN_ZENITH).lerp(SUN_HORIZON, horizonMix);
    lighting.sunIntensity = sunIntensity;
  }

  /* Ambient, ground and fog colour — read out of the sky itself ---------- */

  const nightFactor = clamp01(
    1 -
      smoothstep(
        STREET_LIGHT_ON_LUMINANCE - STREET_LIGHT_RAMP,
        STREET_LIGHT_ON_LUMINANCE + STREET_LIGHT_RAMP,
        blend.luminance
      )
  );

  if (sh) {
    normaliseHue(
      boostChroma(irradianceTowards(sh, SCRATCH_UP, lighting.ambientColor), AMBIENT_CHROMA_GAIN)
    );
    normaliseHue(
      boostChroma(irradianceTowards(sh, SCRATCH_HORIZON, lighting.fogColor), FOG_CHROMA_GAIN)
    );

    // GROUND BOUNCE IS NOT READ FROM THE SH's DOWNWARD LOBE, on purpose.
    // These are `_puresky` captures: the lower hemisphere is empty, so what
    // the downward lobe actually measures at noon is (0.089, 0.187, 0.366) —
    // 4% of the upward lobe and violently blue, because with no ground in the
    // image the only thing lighting a downward-facing surface is scattered
    // sky. Normalising that to a usable magnitude produces a saturated cyan
    // bounce under a white sun, which is unmistakably wrong.
    //
    // Bounce light is sky light reflected off the CITY, so it is derived that
    // way below, once ambient has its final hue.
  } else {
    lighting.ambientColor.setRGB(0.62, 0.72, 0.92);
    lighting.fogColor.setRGB(0.6, 0.68, 0.8);
  }

  // Rod-dominated vision is blue-shifted. Applying it to the DERIVED ambient
  // hue (never to the radiance) is what makes a moonlit street read as
  // moonlit rather than as an underexposed afternoon.
  lighting.ambientColor.lerp(SCOTOPIC, nightFactor * SCOTOPIC_BLEND);
  lighting.fogColor.lerp(SCOTOPIC, nightFactor * SCOTOPIC_BLEND * 0.8);

  // Ground bounce: the finished ambient hue, filtered through concrete and
  // asphalt, so it inherits both the sky's colour and the night shift.
  lighting.groundColor.copy(lighting.ambientColor).multiply(CITY_ALBEDO);
  normaliseHue(lighting.groundColor).multiplyScalar(0.45);
  // Near the horizon the sun paints the haze it is shining through. This is
  // the sunset glow, and deriving it from the sun colour keeps it in step with
  // the reddening above instead of drifting into a separate palette. The
  // exponent concentrates it into the last hour, where it belongs — a linear
  // ramp tints the fog orange from mid-afternoon.
  lighting.fogColor.lerp(lighting.sunColor, Math.pow(horizonMix, 1.6) * sunAbove * 0.8);

  // Fog must not be a bright band across a dark skyline: scale it by the same
  // curve everything else uses, with a floor so distant geometry still reads.
  const fogLift = clamp01(0.3 + 0.7 * blend.luminance);
  lighting.fogColor.multiplyScalar(fogLift);

  /* Magnitudes ----------------------------------------------------------- */

  lighting.envMapIntensity = blend.luminance;
  // The hemisphere/ambient term is a fallback for paths without IBL. It tracks
  // the same curve so those paths darken at night too.
  lighting.ambientIntensity = clamp(blend.luminance * 0.55, 0.004, 0.9);

  lighting.exposure = clamp(
    EXPOSURE_REFERENCE * Math.pow(Math.max(1e-5, blend.luminance), -EXPOSURE_ADAPTATION),
    EXPOSURE_MIN,
    EXPOSURE_MAX
  );

  lighting.streetLightsOn = nightFactor > 0.5;
  lighting.fogDensity = lerp(FOG_DENSITY_DAY, FOG_DENSITY_NIGHT, nightFactor);
  lighting.shadowRadius = lerp(SHADOW_RADIUS_DAY, SHADOW_RADIUS_NIGHT, nightFactor);

  // Evening windows are busy; by the small hours most of the city is asleep.
  // The ramp is measured FORWARD FROM SUNSET and wrapped, because it crosses
  // t = 0 — a plain `smoothstep(0.79, 0.99, t)` reads 03:00 as "early evening"
  // and lights the whole city up at four in the morning.
  const sinceEvening = wrapUnit(timeOfDay - EVENING_START);
  const eveningness = 1 - smoothstep(0, EVENING_LENGTH, sinceEvening);
  const windowLitFraction =
    nightFactor * lerp(WINDOW_LIT_FRACTION_NIGHT, WINDOW_LIT_FRACTION_EVENING, eveningness);

  return {
    nightFactor,
    windowLitFraction,
    skyLuminance: blend.luminance,
    moonElevation: moon.elevation,
    moonPhase,
    moonIsKeyLight,
  };
}

/** Mirror the derived values into the gameplay-facing clock state. */
export function fillDayNightState(
  state: MutableDayNightState,
  input: { timeOfDay: number; dayCount: number; dayLengthSeconds: number; lunarAgeDays: number },
  lighting: MutableSkyLightingState,
  derived: ISkyDerived,
  solar?: ISolarOptions
): void {
  const sun = sunPosition(input.timeOfDay, solar);
  state.timeOfDay = input.timeOfDay;
  state.phase = phaseForTime(input.timeOfDay);
  state.dayCount = input.dayCount;
  state.dayLengthSeconds = input.dayLengthSeconds;
  // The TRUE sun vector, even when the moon is the key light: gameplay asks
  // "is it daytime" and must not be answered with a moon.
  state.sunDirection.set(-sun.toBodyX, -sun.toBodyY, -sun.toBodyZ).normalize();
  state.sunElevation = sun.elevation;
  state.sunIntensity = derived.moonIsKeyLight ? 0 : clamp01(lighting.sunIntensity / SUN_PEAK_INTENSITY);
  state.moonIntensity = clamp01(
    (moonIllumination(input.lunarAgeDays) * smoothstep(-0.05, 0.15, derived.moonElevation)) *
      derived.nightFactor
  );
  state.ambientColor.copy(lighting.ambientColor);
  state.sunColor.copy(lighting.sunColor);
  state.streetLightsOn = lighting.streetLightsOn;
}
