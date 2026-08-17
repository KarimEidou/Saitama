/**
 * SOLAR AND LUNAR POSITION
 *
 * A real astronomical approximation rather than "rotate a light around X".
 *
 * ── WHY IT IS WORTH THE ARITHMETIC ─────────────────────────────────────────
 * A light on a simple X-axis rotation rises due east, passes through the
 * zenith and sets due west, every day of the year, at every latitude. The
 * result reads as wrong in a way players cannot name: shadows sweep the wrong
 * way through the afternoon, and noon shadows vanish underneath everything
 * instead of pointing north. The NOAA low-precision formulae below are about
 * thirty lines of algebra and give a genuinely correct arc — at 35.6°N the
 * midsummer sun tops out around 78°, not 90°, and the shadow rotates through
 * roughly 240° of azimuth across the day.
 *
 * Accuracy is ~0.1° for the sun, which is far beyond what a shadow map can
 * resolve. The moon model is much cruder and says so.
 *
 * ── COORDINATE CONVENTION ──────────────────────────────────────────────────
 * three.js is Y-up. This module maps compass directions as:
 *
 *      -Z = north      +X = east      +Z = south      -X = west
 *
 * Azimuth is measured clockwise from north, as a compass reads. Everything
 * here is PURE: no three.js objects, no allocation, no global state, so it is
 * trivially unit-testable and identical on every platform.
 */

import { DEG2RAD, clamp } from '@/util';
import {
  CITY_LATITUDE_DEGREES,
  CITY_LONGITUDE_DEGREES,
  CITY_TIMEZONE_HOURS,
  SYNODIC_MONTH_DAYS,
  WORLD_DAY_OF_YEAR,
} from './constants';

/** A body's position on the local sky dome. */
export interface ICelestialPosition {
  /** Radians above the horizon. Negative is below it. */
  readonly elevation: number;
  /** Radians clockwise from north. */
  readonly azimuth: number;
  /** Unit vector FROM the observer TOWARDS the body. */
  readonly toBodyX: number;
  readonly toBodyY: number;
  readonly toBodyZ: number;
}

export interface ISolarOptions {
  readonly latitudeDegrees?: number;
  readonly longitudeDegrees?: number;
  readonly timezoneHours?: number;
  readonly dayOfYear?: number;
}

/**
 * Solar declination and the equation of time, from the fractional year.
 *
 * The equation of time is the reason solar noon is not clock noon: the Earth's
 * orbit is elliptical and its axis is tilted, so the sun runs up to ~16 minutes
 * fast or slow against a uniform clock. Dropping it would bias the whole arc by
 * a quarter of an hour, which is visible as an asymmetric sunrise/sunset.
 *
 * @returns declination in radians, equation of time in MINUTES.
 */
export function solarDeclination(dayOfYear: number): {
  declination: number;
  equationOfTimeMinutes: number;
} {
  // Fractional year, radians. NOAA's low-precision form.
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1);

  const equationOfTimeMinutes =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));

  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  return { declination, equationOfTimeMinutes };
}

/**
 * Convert an equatorial hour angle + declination into a local horizon position.
 *
 * @param hourAngle   Radians; 0 is the body on the meridian (due south here).
 * @param declination Radians.
 * @param latitude    Radians.
 */
function horizonFrom(
  hourAngle: number,
  declination: number,
  latitude: number
): ICelestialPosition {
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);

  const sinElevation = clamp(sinLat * sinDec + cosLat * cosDec * Math.cos(hourAngle), -1, 1);
  const elevation = Math.asin(sinElevation);

  // Azimuth from the standard spherical-triangle solution, measured clockwise
  // from NORTH. atan2 keeps it continuous through the meridian, where the
  // acos-based form flips sign and produces a visible shadow snap at noon.
  const y = Math.sin(hourAngle);
  const x = Math.cos(hourAngle) * sinLat - (sinDec / cosDec) * cosLat;
  // atan2(y, x) here is the azimuth measured from SOUTH, increasing westwards;
  // adding π rotates the origin to north.
  let azimuth = Math.atan2(y, x) + Math.PI;
  if (azimuth < 0) azimuth += Math.PI * 2;
  if (azimuth >= Math.PI * 2) azimuth -= Math.PI * 2;

  const cosElevation = Math.cos(elevation);
  return {
    elevation,
    azimuth,
    toBodyX: Math.sin(azimuth) * cosElevation,
    toBodyY: sinElevation,
    toBodyZ: -Math.cos(azimuth) * cosElevation,
  };
}

/**
 * Sun position for a normalised time of day.
 *
 * @param timeOfDay 0..1 where 0 is local clock midnight and 0.5 is clock noon.
 */
export function sunPosition(timeOfDay: number, options: ISolarOptions = {}): ICelestialPosition {
  const latitude = (options.latitudeDegrees ?? CITY_LATITUDE_DEGREES) * DEG2RAD;
  const longitude = options.longitudeDegrees ?? CITY_LONGITUDE_DEGREES;
  const timezone = options.timezoneHours ?? CITY_TIMEZONE_HOURS;
  const dayOfYear = options.dayOfYear ?? WORLD_DAY_OF_YEAR;

  const { declination, equationOfTimeMinutes } = solarDeclination(dayOfYear);

  // Clock minutes since local midnight.
  const clockMinutes = timeOfDay * 1440;
  // True solar time: correct the clock for the observer's offset from the
  // standard meridian, then for the equation of time.
  const trueSolarMinutes = clockMinutes + equationOfTimeMinutes + 4 * longitude - 60 * timezone;
  // Hour angle: 0 at solar noon, +π/12 rad per hour after it.
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG2RAD;

  return horizonFrom(hourAngle, declination, latitude);
}

/**
 * Moon position — a DELIBERATELY crude approximation.
 *
 * The moon is modelled as a body that shares the sun's declination band but
 * trails it by the lunar phase: new moon rises with the sun, full moon rises
 * as the sun sets. That is the property the lighting actually needs (a moon
 * that is up at night and in a believable part of the sky), and it costs three
 * lines. A real lunar ephemeris needs the moon's own 5° inclined orbit, its
 * evection and variation terms, and parallax — hundreds of lines to move a
 * dim blue light by a few degrees. Not worth it.
 *
 * @param lunarAgeDays Days since new moon, 0..29.53.
 */
export function moonPosition(
  timeOfDay: number,
  lunarAgeDays: number,
  options: ISolarOptions = {}
): ICelestialPosition {
  const latitude = (options.latitudeDegrees ?? CITY_LATITUDE_DEGREES) * DEG2RAD;
  const dayOfYear = options.dayOfYear ?? WORLD_DAY_OF_YEAR;
  const { declination } = solarDeclination(dayOfYear);

  const phase = (lunarAgeDays % SYNODIC_MONTH_DAYS) / SYNODIC_MONTH_DAYS;
  // Sun's hour angle, then lag it by the phase: half a cycle at full moon.
  const sunHourAngle = (timeOfDay - 0.5) * Math.PI * 2;
  let moonHourAngle = sunHourAngle - phase * Math.PI * 2;
  moonHourAngle = ((moonHourAngle + Math.PI) % (Math.PI * 2)) - Math.PI;

  // The moon rides roughly the opposite declination band to the sun across a
  // month; -0.85 keeps a summer full moon low in the south, which is correct
  // and is what makes moonlit shadows long.
  return horizonFrom(moonHourAngle, declination * -0.85, latitude);
}

/**
 * Illuminated fraction of the lunar disc, 0 at new and 1 at full.
 * Drives moonlight intensity.
 */
export function moonIllumination(lunarAgeDays: number): number {
  const phase = (lunarAgeDays % SYNODIC_MONTH_DAYS) / SYNODIC_MONTH_DAYS;
  return (1 - Math.cos(phase * Math.PI * 2)) * 0.5;
}
