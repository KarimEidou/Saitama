/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  FOUR BOSS ENCOUNTERS — HAND-TUNED, EACH TESTING SOMETHING DIFFERENT     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A boss cannot be a difficulty spike. The player one-shots everything, so
 * "harder" is not available as a design tool and never will be. What IS
 * available is asking a different QUESTION each time:
 *
 *   MOSQUITO GIRL   can you hit something that never lands?
 *                   Flying, erratic, and she brings a swarm. 1.2 m of reach is
 *                   useless against a target at 5 m of altitude, so the player
 *                   either finds height or pays for a cone. The swarm makes
 *                   the cheap answer expensive: fourteen targets, one punch
 *                   each, or one serious punch and the block.
 *
 *   VACCINE MAN     can you cross open ground while the cover is being
 *                   deleted? He fires a 90 m beam every three seconds at
 *                   `serious` intent, which means the destruction system takes
 *                   whatever the player is hiding behind while they hide
 *                   behind it. Phase two only advances while the player is
 *                   within 18 m — the whole phase IS the approach.
 *
 *   DEEP SEA KING   can you get there in time? He is mechanically the dullest
 *                   boss in the game and that is deliberate: the test is
 *                   TRAVEL, not combat. He is already beating Mumen Rider when
 *                   the encounter opens, an 18-second wall clock is running,
 *                   and the fight afterwards is identical whether the player
 *                   made it or not. It is the only thing in the game that can
 *                   actually be lost.
 *
 *   BOROS           can you stand still? Four phases, and the second one is
 *                   nine seconds of Collapsing Star with nothing to do but be
 *                   in it. This is where the phase gate earns its existence:
 *                   if the burst could be cut short by punching harder, the
 *                   one moment the protagonist is asked to endure something
 *                   would evaporate — and the gate is a timer precisely so it
 *                   cannot be.
 *
 * ── HOW TO READ A PHASE ROW ───────────────────────────────────────────────
 * `durationSeconds` is ENGAGED time: it only advances while the player is
 * within `engageRadiusMetres`. `hitsToAdvance` counts hits, not damage, because
 * a gated boss takes zero damage by design. The last phase of every script is
 * a `finisher` with both at zero, so ENTERING it is the resolution — that
 * transition emits `BossPhaseChanged { isFinalPhase: true }`, which is the one
 * and only thing that makes a boss killable.
 */

import { DEG2RAD } from '@/util';
import type { IBossPhase, IBossScript } from './types';

/* -------------------------------------------------------------------------- */
/* Row helper                                                                 */
/* -------------------------------------------------------------------------- */

interface IPhasePatch {
  readonly id: string;
  readonly kind: IBossPhase['kind'];
  readonly title: string;
  readonly durationSeconds?: number;
  readonly hitsToAdvance?: number;
  readonly engageRadiusMetres: number;
  readonly summonArchetypeId?: string;
  readonly summonCount?: number;
  readonly requireSummonsCleared?: boolean;
  readonly pulsePeriodSeconds?: number;
  readonly pulseRangeMetres?: number;
  readonly pulseHalfAngleRad?: number;
  readonly pulsePower?: number;
  readonly allyDownAtSeconds?: number;
  readonly allyRescueRadiusMetres?: number;
}

function phase(patch: IPhasePatch): IBossPhase {
  return Object.freeze({
    id: patch.id,
    kind: patch.kind,
    title: patch.title,
    durationSeconds: patch.durationSeconds ?? 0,
    hitsToAdvance: patch.hitsToAdvance ?? 0,
    engageRadiusMetres: patch.engageRadiusMetres,
    summonArchetypeId: patch.summonArchetypeId,
    summonCount: patch.summonCount,
    requireSummonsCleared: patch.requireSummonsCleared,
    pulsePeriodSeconds: patch.pulsePeriodSeconds ?? 0,
    pulseRangeMetres: patch.pulseRangeMetres ?? 0,
    pulseHalfAngleRad: patch.pulseHalfAngleRad ?? Math.PI,
    pulsePower: patch.pulsePower ?? 0,
    allyDownAtSeconds: patch.allyDownAtSeconds,
    allyRescueRadiusMetres: patch.allyRescueRadiusMetres,
  });
}

/** The finisher every script ends with. Zero conditions: entering it IS the gate. */
function finisher(id: string, title: string, engageRadiusMetres = 200): IBossPhase {
  return phase({ id, kind: 'finisher', title, engageRadiusMetres });
}

/* -------------------------------------------------------------------------- */
/* Mosquito Girl — the flying-target test                                     */
/* -------------------------------------------------------------------------- */

const MOSQUITO_GIRL: IBossScript = Object.freeze({
  encounterId: 'boss.mosquitoGirl',
  archetypeId: 'boss.mosquitoGirl',
  title: 'Mosquito Girl',
  arenaRadiusMetres: 70,
  tests: 'A flying, erratic target plus a swarm: reach, not power.',
  phases: Object.freeze([
    phase({
      id: 'swarm',
      kind: 'swarm',
      title: 'The Swarm',
      // The swarm is the phase. She hangs back at 9 m of standoff and 5.2 m of
      // altitude and lets fourteen 4-HP pests do the work — each of which dies
      // to anything at all, including her own dive wave and any collateral in
      // the street, which is what keeps the hard `requireSummonsCleared` gate
      // from being a stall in practice.
      durationSeconds: 5,
      engageRadiusMetres: 55,
      summonArchetypeId: 'mob.swarm.mosquito',
      summonCount: 14,
      requireSummonsCleared: true,
    }),
    phase({
      id: 'dive',
      kind: 'arena',
      title: 'Erratic Flight',
      // Two hits. Two, not ten: the difficulty is CONNECTING, and asking for
      // ten would just be asking the player to do the hard thing five times.
      durationSeconds: 5,
      hitsToAdvance: 2,
      engageRadiusMetres: 42,
      pulsePeriodSeconds: 2.6,
      pulseRangeMetres: 9,
      pulseHalfAngleRad: 70 * DEG2RAD,
      pulsePower: 2200,
    }),
    finisher('swatted', 'Swatted'),
  ]),
});

/* -------------------------------------------------------------------------- */
/* Vaccine Man — the cover-and-destruction test                                */
/* -------------------------------------------------------------------------- */

const VACCINE_MAN: IBossScript = Object.freeze({
  encounterId: 'boss.vaccineMan',
  archetypeId: 'boss.vaccineMan',
  title: 'Vaccine Man',
  arenaRadiusMetres: 120,
  tests: 'Ranged beams that delete the cover the player is using. Approach under fire.',
  phases: Object.freeze([
    phase({
      id: 'bombardment',
      kind: 'bombardment',
      title: 'Beam Sweep',
      durationSeconds: 9,
      // Generous: he is shooting from 46 m of standoff at 14 m of altitude, so
      // "engaged" here only means the player is in the fight at all.
      engageRadiusMetres: 110,
      pulsePeriodSeconds: 3.2,
      pulseRangeMetres: 92,
      pulseHalfAngleRad: 11 * DEG2RAD,
      // 52 000 reads as `serious`, which is the threshold at which the
      // destruction system takes structures. The cover is consumable — that is
      // the entire phase, expressed as one number.
      pulsePower: 52000,
    }),
    phase({
      id: 'descent',
      kind: 'arena',
      title: 'Descent',
      // 18 m. THE test: the clock only runs while the player is inside melee
      // range of something that is trying very hard to keep them out of it.
      durationSeconds: 4,
      hitsToAdvance: 3,
      engageRadiusMetres: 18,
      pulsePeriodSeconds: 2.4,
      pulseRangeMetres: 28,
      pulsePower: 96000,
    }),
    finisher('inoculated', 'Inoculated'),
  ]),
});

/* -------------------------------------------------------------------------- */
/* Deep Sea King — the emotional core                                          */
/* -------------------------------------------------------------------------- */

const DEEP_SEA_KING: IBossScript = Object.freeze({
  encounterId: 'boss.deepSeaKing',
  archetypeId: 'boss.deepSeaKing',
  title: 'Deep Sea King',
  arenaRadiusMetres: 90,
  tests: 'A rain set piece with a wall clock on an ally. The only losable thing in the game.',
  phases: Object.freeze([
    phase({
      id: 'rain',
      kind: 'rescue',
      title: 'Rain',
      // Three seconds of ENGAGED time so the phase cannot be skipped by
      // sprinting past — but the ally clock below is WALL time and does not
      // care about any of that.
      durationSeconds: 3,
      engageRadiusMetres: 34,
      pulsePeriodSeconds: 4,
      pulseRangeMetres: 26,
      pulsePower: 61000,
      /* ── THE NUMBER THE WHOLE ENCOUNTER IS ABOUT ────────────────────────
         Eighteen seconds from the encounter opening. Long enough to cross
         two blocks at a run, short enough that stopping to clear the street
         costs it. There is no difficulty setting here and no second chance:
         either the player was already on their way, or they were not. */
      allyDownAtSeconds: 18,
      allyRescueRadiusMetres: 14,
    }),
    phase({
      id: 'duel',
      kind: 'arena',
      title: 'The Duel',
      // Identical whether the ally lived or died. That is not laziness — it is
      // the statement. The player's choice changed who is standing there
      // afterwards, and changed nothing about the fight, because a fight this
      // protagonist can lose does not exist.
      durationSeconds: 6,
      hitsToAdvance: 3,
      engageRadiusMetres: 28,
      pulsePeriodSeconds: 5,
      pulseRangeMetres: 26,
      pulsePower: 61000,
    }),
    finisher('one-punch-in-the-rain', 'One Punch, In The Rain'),
  ]),
});

/* -------------------------------------------------------------------------- */
/* Boros — where the gate matters most                                         */
/* -------------------------------------------------------------------------- */

const BOROS: IBossScript = Object.freeze({
  encounterId: 'boss.boros',
  archetypeId: 'boss.boros',
  title: 'Boros',
  arenaRadiusMetres: 160,
  tests: 'Multi-phase: arena, a survival burst that must be endured, then the finisher.',
  phases: Object.freeze([
    phase({
      id: 'arena',
      kind: 'arena',
      title: 'The Arena',
      durationSeconds: 6,
      hitsToAdvance: 2,
      engageRadiusMetres: 70,
      pulsePeriodSeconds: 3.4,
      pulseRangeMetres: 20,
      pulsePower: 180000,
    }),
    phase({
      id: 'collapsing-star',
      kind: 'survival',
      title: 'Collapsing Star Roaring Cannon',
      /* ── THE SURVIVAL PHASE ────────────────────────────────────────────
         Nine seconds. No hits required, nothing to clear, nothing to solve —
         the player simply has to be there while it happens. Every 1.1 s a
         1.4e6-power cone comes down the arena, which is `full` intent and
         therefore takes buildings, vehicles, debris and anyone standing in
         the street with it.

         This is THE reason the gate is a timer. If nine seconds could be
         shortened by punching harder, the one sustained moment in this game
         where the protagonist is asked to endure rather than to end
         something would not exist — and the finisher after it would land on
         a boss the player had merely out-damaged. */
      durationSeconds: 9,
      // Wide: the beam reaches 130 m, so being "engaged" during a
      // bombardment means being anywhere it can find you.
      engageRadiusMetres: 140,
      pulsePeriodSeconds: 1.1,
      pulseRangeMetres: 130,
      pulseHalfAngleRad: 18 * DEG2RAD,
      pulsePower: 1400000,
    }),
    phase({
      id: 'meteoric-burst',
      kind: 'arena',
      title: 'Meteoric Burst',
      durationSeconds: 4,
      hitsToAdvance: 4,
      engageRadiusMetres: 55,
      pulsePeriodSeconds: 1.6,
      pulseRangeMetres: 20,
      pulsePower: 180000,
    }),
    finisher('serious-punch', 'Serious Punch'),
  ]),
});

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

/** Every boss encounter, in intended play order. */
export const BOSS_SCRIPTS: readonly IBossScript[] = Object.freeze([
  MOSQUITO_GIRL,
  VACCINE_MAN,
  DEEP_SEA_KING,
  BOROS,
]);

const BY_ID: ReadonlyMap<string, IBossScript> = new Map(
  BOSS_SCRIPTS.map((script) => [script.encounterId, script])
);

/** Look up a script. Throws on an unknown id — a typo is a bug, not data. */
export function bossScript(encounterId: string): IBossScript {
  const found = BY_ID.get(encounterId);
  if (found === undefined) throw new Error(`[monster] unknown boss script '${encounterId}'`);
  return found;
}

/** Look up without throwing. */
export function findBossScript(encounterId: string): IBossScript | undefined {
  return BY_ID.get(encounterId);
}
