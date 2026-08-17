/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  COMBAT TUNING — EVERY NUMBER THE ONE-PUNCH SYSTEM READS                 ║
 * ║                                                                          ║
 * ║  Nothing else under `src/gameplay/combat/` may hard-code a reach, a      ║
 * ║  power, a radius or a boredom rate. If you need one, add it here.        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── THE DESIGN PROBLEM THESE NUMBERS SERVE ─────────────────────────────────
 * Saitama one-shots everything, so difficulty cannot be the challenge. The
 * contest is TIME, COLLATERAL and BOREDOM:
 *
 *   Normal Punch   1.2 m of reach. Free. Requires you to physically BE there.
 *   Serious Punch  40–180 m cone. Solves any encounter. Levels three blocks.
 *   Ground slam    a radial version of the same, paid for by traversal.
 *
 * The whole game is the player choosing between the first and the second, so
 * every number below is really an answer to "how much of City Z is this
 * worth?". Reach is deliberately punitive (1.2 m is arm's length — you must
 * close the distance) and the serious cone is deliberately absurd (180 m at
 * full charge is nine city blocks) because a choice between two similar
 * options is not a choice.
 *
 * ── UNITS ──────────────────────────────────────────────────────────────────
 * `Metres`, `Seconds`, `Radians`, `Ratio`, `PerSecond`, `Yen`, `Kg`.
 * `power` is UNITLESS and UNBOUNDED — see `IPunchEvent.power` in the contract.
 */

import type { DistrictType, LethalIntent, ThreatTier } from '@/types';
import { DEG2RAD } from '@/util';

/* -------------------------------------------------------------------------- */
/* Intent                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The intents that carry LETHAL INTENT.
 *
 * `restrained` is excluded ON PURPOSE: the contract defines it as "Pulled
 * punch. Non-lethal, minimal collateral. Used around civilians." Restraint is
 * the only way to swing near a crowd, so it must not be a rounding error away
 * from a massacre. Every other intent instantly kills any non-boss it touches,
 * regardless of health, tier or resistances.
 */
export const LETHAL_INTENTS: readonly LethalIntent[] = Object.freeze([
  'normal',
  'serious',
  'full',
]);

/** True when a hit at this intent instantly kills a non-boss. */
export function isLethalIntent(intent: LethalIntent): boolean {
  return intent !== 'restrained';
}

/* -------------------------------------------------------------------------- */
/* Threat weighting                                                           */
/* -------------------------------------------------------------------------- */

/** Ascending threat order, used for triviality weighting. */
export const THREAT_ORDER: readonly ThreatTier[] = Object.freeze([
  'wolf',
  'tiger',
  'demon',
  'dragon',
  'god',
]);

/**
 * Threat tier as an ascending 0..1 scalar. Absent tier (a civilian, a prop,
 * a vehicle) reads as the bottom of the scale — killing one is never an
 * achievement.
 */
export function tierScalar(tier: ThreatTier | undefined): number {
  if (tier === undefined) return 0;
  const index = THREAT_ORDER.indexOf(tier);
  return index < 0 ? 0 : index / (THREAT_ORDER.length - 1);
}

/* -------------------------------------------------------------------------- */
/* Zoning                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Yen of property value per kilogram of structure, by district.
 *
 * `propertyDamageYen` is `destroyed fracture-chunk mass × zoning value`, so
 * this table is the entire difference between flattening a warehouse and
 * flattening the Hero Association HQ. Wasteland is nearly free — which is
 * exactly why the tutorial fight should happen there and the boss fight
 * should not.
 */
export const ZONING_YEN_PER_KG: Readonly<Record<DistrictType, number>> = Object.freeze({
  downtown: 5200,
  heroAssociation: 4400,
  residential: 2600,
  waterfront: 1900,
  industrial: 1100,
  park: 700,
  wasteland: 40,
});

/** Fallback when no district lookup is wired in. Mid-range residential. */
export const DEFAULT_ZONING_YEN_PER_KG = ZONING_YEN_PER_KG.residential;

/**
 * Yen that maps to a `propertyDamageScore` of 0.5.
 *
 * ── WHY A COMPANION SCORE EXISTS AT ALL ────────────────────────────────────
 * `propertyDamageYen` is an INVOICE and it is enormous: one fully charged
 * serious punch through downtown bills about 1.5e10. That number is right,
 * and it is the joke — but any consumer that multiplies it by a per-unit rate
 * and adds it to a score will saturate on the first fight of the game.
 *
 * So the yen figure stays honest for the HUD and the end-of-mission card, and
 * `propertyDamageScore` is the number a linear consumer should read. The curve
 * is `saturate()` from `@/util`, the same compressor physics and audio use for
 * unbounded punch power, for the same reason: the magnitude has no ceiling, so
 * dividing by an assumed maximum is not available.
 *
 * At 2.5e9 the scale reads: a shopfront 0.29, a city block 0.63, three blocks
 * 0.86, an entire district 0.98.
 */
export const PROPERTY_DAMAGE_HALF_YEN = 2.5e9;

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

/** Every tunable the combat system reads. */
export interface ICombatTuning {
  /* ---- normal punch (tap) ---- */
  /**
   * Reach of the tap punch, in metres, measured from the fist socket.
   * Arm's length. This single number is why Normal Punch is a decision and
   * not a formality: to use it you must cross the street with your body.
   */
  readonly normalReachMetres: number;
  /**
   * Contact cone half-angle for the tap. Generous (55°) because a jab that
   * whiffs on a monster the player is visibly touching reads as a bug, not as
   * skill. The single-target cap does the discriminating instead.
   */
  readonly normalHalfAngleRad: number;
  /** Victims a single tap may claim. 1 — a jab is a jab. */
  readonly normalMaxTargets: number;
  /** `power` of an uncharged tap. Contract band for normal hits is 10–1000. */
  readonly normalPower: number;
  /**
   * Intent stamped on a tap. `'normal'`, and it stays `'normal'`.
   *
   * ── ON RECORD, BECAUSE IT WAS DECIDED RATHER THAN DEFAULTED ──────────────
   * The renderer's `ImpactFreeze` used to qualify on `['serious', 'full']`, so
   * a tap kill produced no hit-stop — and one jab deleting a demon-tier
   * monster is the signature moment of the whole premise, so it cannot pass
   * silently. The fix was NOT to stamp `'serious'` on a punch that was not
   * serious. The freeze is a reaction to SOMETHING DYING TO A PUNCH, not to
   * how long a button was held, so it is keyed on lethality, and that belongs
   * on the renderer's side. `ImpactFreeze` now qualifies on `['normal',
   * 'serious', 'full']` and scales the result by intent instead of gating on
   * it, so both verbs read correctly and this field stays honest.
   *
   * Do not "fix" a missing hit-stop by raising this.
   */
  readonly normalPunchIntent: LethalIntent;
  /** Knockback delta-v applied to a tap victim, m/s. */
  readonly normalKnockbackMps: number;
  /**
   * Fire the tap on the PRESS edge (true) or discriminate tap from hold on
   * RELEASE (false). SHIPS AS `false`.
   *
   * ── WHY NOT THE PRESS EDGE, WHICH IS WHAT THE INPUT CONTRACT SUGGESTS ────
   * `true` matches `buttons.punch.pressed` = "throw the light punch NOW" and
   * has zero latency, which normally wins on a phone. It also means BEGINNING
   * A CHARGE THROWS A FREE JAB: stand next to a monster, hold to charge, and
   * the jab kills it before the wind-up finishes — so the serious punch lands
   * on a corpse and levels three blocks for nothing. The most important
   * decision in the game gets made for the player, wrongly, by a button they
   * were still pressing. (It also let the wind-up jab inherit the chain
   * multiplier and come out LOUDER than the punch before it.)
   *
   * So the tap waits for release, and `tapMaxHoldSeconds` tells the two
   * gestures apart. It costs ~140 ms on the light attack, which is inside the
   * band players read as responsive and is what every charge-attack game
   * does — and it is nowhere near the full charge time, which is what a naive
   * deferral would have cost.
   */
  readonly normalPunchOnPress: boolean;
  /**
   * The tap/hold discriminator, in seconds. THE only threshold that separates
   * the two verbs.
   *
   * Released at or before this: a tap, and the normal punch fires immediately
   * on release. Still held past it: a charge, committed — the jab is never
   * thrown, whatever happens next.
   *
   * 140 ms. Below ~100 ms a deliberate short hold reads as a tap and players
   * cannot start a charge reliably; above ~180 ms the light attack starts to
   * feel like it is lagging behind the thumb.
   */
  readonly tapMaxHoldSeconds: number;

  /* ---- consecutive normal punches ---- */
  /**
   * Seconds after a tap during which the next tap continues the chain.
   * 0.42 s is roughly two taps per second at the slow end — fast enough to
   * read as deliberate machine-gunning, slow enough that ordinary combat
   * tapping does not accidentally escalate.
   */
  readonly chainWindowSeconds: number;
  /**
   * Multiplier applied to `power` per additional link in the chain. Must be
   * > 1: the audio system keys `punch.consecutive` → `punch.barrage` off the
   * log-normalised power, so the rise has to be monotonic to make its pitch
   * ramp monotonic.
   */
  readonly chainPowerGrowth: number;
  /** Hard ceiling on chained power, so a held-down finger cannot reach 1e9. */
  readonly chainPowerCeiling: number;
  /** Chain length at which the kind switches from `normal` to `consecutive`. */
  readonly chainKindThreshold: number;
  /** Camera trauma added per chain link, accumulating into `cameraShake`. */
  readonly chainShakePerLink: number;

  /* ---- serious punch (hold) ---- */
  /**
   * Seconds of hold to reach charge 1.0, measured from the press.
   *
   * Note there is no minimum: any hold past `tapMaxHoldSeconds` is a serious
   * punch, and the weakest one still opens a 40 m cone. That is deliberate —
   * the two verbs must not blur into each other at the boundary, so the
   * cheapest serious punch is still enormous.
   */
  readonly seriousChargeSeconds: number;
  /** Cone half-angle of the released shockwave. ~22°. */
  readonly seriousHalfAngleRad: number;
  /** Cone length at charge 0, metres. */
  readonly seriousRangeMinMetres: number;
  /** Cone length at charge 1, metres. */
  readonly seriousRangeMaxMetres: number;
  /** `power` at charge 0. */
  readonly seriousPowerMin: number;
  /** `power` at charge 1. Comfortably past 1e6, as the contract warns. */
  readonly seriousPowerMax: number;
  /** Charge at or above which the intent escalates from `serious` to `full`. */
  readonly seriousFullIntentCharge: number;
  /** Knockback delta-v at the cone origin, m/s. Falls off with distance. */
  readonly seriousKnockbackMps: number;
  /** Seconds the wave takes to travel its full range. 0 is instantaneous. */
  readonly seriousTravelSeconds: number;

  /* ---- ground slam ---- */
  /** Base lethal radius of a crater landing, metres. */
  readonly slamKillRadiusBaseMetres: number;
  /** Extra lethal radius per metre fallen. */
  readonly slamKillRadiusPerFallMetre: number;
  /** Ceiling on the lethal radius, metres. */
  readonly slamKillRadiusMaxMetres: number;
  /**
   * Multiplier from lethal radius to PRESSURE radius. The slam shoves much
   * further than it kills — that gap is where "I knocked the crowd over
   * instead of through a wall" lives.
   */
  readonly slamPressureRadiusFactor: number;
  /** `power` per m/s of impact speed. */
  readonly slamPowerPerImpactSpeed: number;
  /** Intent stamped on a crater landing. */
  readonly slamIntent: LethalIntent;
  /** Knockback delta-v at the crater centre, m/s. */
  readonly slamKnockbackMps: number;

  /* ---- restraint ---- */
  /**
   * Real damage a `restrained` hit applies. Not zero: a pulled punch from
   * Saitama still puts a person in hospital, and a restrained hit finishing a
   * wounded civilian is a lesson the player should be allowed to learn.
   */
  readonly restrainedDamage: number;
  /** Fraction of normal knockback a restrained hit imparts. */
  readonly restrainedKnockbackRatio: number;

  /* ---- bosses ---- */
  /**
   * Damage a lethal hit applies to a boss whose scripted phase has not
   * resolved. The boss visibly loses, but health is floored at 1 — the gate is
   * NARRATIVE, never HP, so no amount of punching can skip the encounter.
   */
  readonly bossPhaseChipDamage: number;

  /* ---- scoring ---- */
  /** Metres within which a civilian may witness a kill. */
  readonly witnessRadiusMetres: number;
  /** Yen per kilogram used when no district lookup is supplied. */
  readonly defaultZoningYenPerKg: number;
  /**
   * Seconds after which reaching a target counts as a CHALLENGE rather than a
   * formality. Above this, the kill lowers boredom instead of raising it.
   */
  readonly challengeSeconds: number;
  /**
   * Seconds to wait after the last hostile dies before closing the scorecard.
   *
   * NOT cosmetic. Collapses are STAGGERED across frames — the destruction
   * system deliberately spreads a 300-body building over several frames to
   * stay inside the debris budget — so the chunks a serious punch knocked
   * loose are still falling when the monster hits the ground. Closing the
   * books on the kill frame would bill the player for the first tenth of the
   * damage they caused and quietly forgive the rest.
   */
  readonly encounterSettleSeconds: number;

  /* ---- boredom ---- */
  /** Boredom added by the most trivial kill imaginable (a wolf-tier mob). */
  readonly boredomPerTrivialKill: number;
  /**
   * Fraction of `boredomPerTrivialKill` still added for a god-tier kill.
   * Killing something legendary in one punch is still boring — just less so.
   */
  readonly boredomTopTierRetention: number;
  /** Boredom removed by saving a civilian. */
  readonly boredomPerCivilianSaved: number;
  /** Boredom removed by body-blocking a hit aimed at an ally. */
  readonly boredomPerBodyBlock: number;
  /** Boredom removed by catching debris over a crowd. */
  readonly boredomPerDebrisCaught: number;
  /** Boredom removed by finishing an encounter with no collateral at all. */
  readonly boredomPerCleanVictory: number;
  /** Boredom removed by a fight that actually took time. */
  readonly boredomPerChallenge: number;
  /** Seconds of no combat and no heroism before boredom starts drifting up. */
  readonly boredomIdleAfterSeconds: number;
  /** Boredom added per second while idle. */
  readonly boredomIdleRatePerSecond: number;
  /** Value boredom drifts back toward once heroism stops. */
  readonly boredomBaseline: number;
  /** Boredom drift per second back toward the baseline. */
  readonly boredomDecayRatePerSecond: number;
  /**
   * Report threshold. The meter's VALUE always moves; the BUS only hears
   * about it once the accumulated move passes this.
   *
   * The idle rise is 2.5e-3 per second, which at 60 fps is 4e-5 per frame.
   * Emitting that would put an event on the bus every frame forever and make
   * the audio system re-derive its arrangement sixty times a second to hear
   * the same number — while a threshold that DISCARDED the sub-epsilon delta
   * instead of banking it would mean boredom never rises from idling at all.
   * So the delta is always applied and only the reporting is quantised.
   */
  readonly boredomEmitEpsilon: number;
}

/**
 * The shipped tuning.
 *
 * Every value here has been chosen against the loop described at the top of
 * the file, not against a damage spreadsheet — there are no damage numbers in
 * this game.
 */
export const DEFAULT_COMBAT_TUNING: ICombatTuning = Object.freeze({
  /* normal */
  normalReachMetres: 1.2,
  normalHalfAngleRad: 55 * DEG2RAD,
  normalMaxTargets: 1,
  normalPower: 120,
  normalPunchIntent: 'normal',
  normalKnockbackMps: 34,
  normalPunchOnPress: false,
  tapMaxHoldSeconds: 0.14,

  /* chain */
  chainWindowSeconds: 0.42,
  chainPowerGrowth: 1.9,
  chainPowerCeiling: 8e5,
  chainKindThreshold: 2,
  chainShakePerLink: 0.06,

  /* serious */
  seriousChargeSeconds: 1.2,
  seriousHalfAngleRad: 22 * DEG2RAD,
  seriousRangeMinMetres: 40,
  seriousRangeMaxMetres: 180,
  seriousPowerMin: 1.0e5,
  seriousPowerMax: 2.5e6,
  seriousFullIntentCharge: 0.5,
  seriousKnockbackMps: 190,
  seriousTravelSeconds: 0,

  /* slam */
  slamKillRadiusBaseMetres: 4,
  slamKillRadiusPerFallMetre: 0.35,
  slamKillRadiusMaxMetres: 18,
  slamPressureRadiusFactor: 2.5,
  slamPowerPerImpactSpeed: 900,
  slamIntent: 'serious',
  slamKnockbackMps: 70,

  /* restraint */
  restrainedDamage: 8,
  restrainedKnockbackRatio: 0.12,

  /* bosses */
  bossPhaseChipDamage: 0,

  /* scoring */
  witnessRadiusMetres: 60,
  defaultZoningYenPerKg: DEFAULT_ZONING_YEN_PER_KG,
  challengeSeconds: 12,
  encounterSettleSeconds: 2.5,

  /* boredom */
  boredomPerTrivialKill: 0.045,
  boredomTopTierRetention: 0.18,
  boredomPerCivilianSaved: 0.06,
  boredomPerBodyBlock: 0.11,
  boredomPerDebrisCaught: 0.07,
  boredomPerCleanVictory: 0.09,
  boredomPerChallenge: 0.13,
  boredomIdleAfterSeconds: 45,
  boredomIdleRatePerSecond: 0.0025,
  boredomBaseline: 0.55,
  boredomDecayRatePerSecond: 0.004,
  boredomEmitEpsilon: 5e-3,
} satisfies ICombatTuning);

/** Partial override, resolved against the defaults. */
export type ICombatTuningPatch = Partial<ICombatTuning>;

/** Merge a patch over the shipped tuning. */
export function resolveCombatTuning(patch?: ICombatTuningPatch): ICombatTuning {
  if (patch === undefined) return DEFAULT_COMBAT_TUNING;
  return Object.freeze({ ...DEFAULT_COMBAT_TUNING, ...patch });
}
