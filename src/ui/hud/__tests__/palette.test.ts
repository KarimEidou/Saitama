/**
 * COLOURBLIND PALETTES, VERIFIED RATHER THAN ASSERTED
 *
 * ── WHY THIS FILE IMPLEMENTS COLOUR SCIENCE ────────────────────────────────
 * "Deuteranopia-safe" is a claim, and the only honest way to make it is to
 * SIMULATE the dichromacy and MEASURE the separation that survives. Choosing
 * colours that look different to the person choosing them is how every
 * accessibility palette that does not work gets shipped.
 *
 * The pair under test is SAVED and LOST. They sit side by side in the civilian
 * ledger and the player reads them in under a second with something swinging at
 * them. If those two collapse together the setting is worse than useless — it
 * is a setting the player TRUSTS and that quietly does nothing.
 *
 * ── THE METHOD ─────────────────────────────────────────────────────────────
 *   1. sRGB -> linear.
 *   2. Machado, Oliveira & Fernandes (2009) severity-1.0 dichromacy matrices.
 *   3. OKLab, and Euclidean ΔE in it, scaled by 100.
 *
 * ΔE >= 8 (OKLab ×100) is the separation target; below 6 two marks are
 * indistinguishable. The pair is additionally required to separate in the
 * NORMAL-vision case, because a palette that only works for dichromats has
 * simply moved the problem.
 *
 * These numbers are cross-checked against an independent implementation of the
 * same checks; the values here reproduce it.
 */

import { describe, expect, it } from 'vitest';
import { INTENT_COLOR, PALETTES, PALETTE_NAMES, TIER_COLOR, TIER_ORDER } from '../tokens';

/* -------------------------------------------------------------------------- */
/* Colour maths                                                               */
/* -------------------------------------------------------------------------- */

type RGB = readonly [number, number, number];

function parseHex(hex: string): RGB {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

/** sRGB transfer function, inverted. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearise(rgb: RGB): RGB {
  return [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])];
}

/** Machado et al. (2009), severity 1.0, operating on LINEAR rgb. */
const CVD_MATRICES = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
} as const;

type CvdKind = keyof typeof CVD_MATRICES;

function simulate(linear: RGB, kind: CvdKind): RGB {
  const m = CVD_MATRICES[kind];
  return [
    m[0]! * linear[0] + m[1]! * linear[1] + m[2]! * linear[2],
    m[3]! * linear[0] + m[4]! * linear[1] + m[5]! * linear[2],
    m[6]! * linear[0] + m[7]! * linear[1] + m[8]! * linear[2],
  ];
}

/** Linear sRGB -> OKLab. */
function oklab(linear: RGB): RGB {
  const [r, g, b] = linear;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean OKLab distance, ×100. */
function deltaE(a: RGB, b: RGB): number {
  const A = oklab(a);
  const B = oklab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) * 100;
}

/** Separation of two hexes under a given vision model. */
function separation(hexA: string, hexB: string, kind?: CvdKind): number {
  const a = linearise(parseHex(hexA));
  const b = linearise(parseHex(hexB));
  return kind ? deltaE(simulate(a, kind), simulate(b, kind)) : deltaE(a, b);
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = linearise(parseHex(hex));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA: string, hexB: string): number {
  const a = luminance(hexA);
  const b = luminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The HUD's panel sits on this. Matches `--hud-panel`'s darker stop. */
const SURFACE = '#060a0f';

/** OKLab ×100. Below 6 is indistinguishable; 8 is the target. */
const SEPARATION_TARGET = 8;

/* -------------------------------------------------------------------------- */
/* The maths itself                                                           */
/* -------------------------------------------------------------------------- */

describe('the colour model used to make these claims', () => {
  it('collapses a red/green pair under deuteranopia', () => {
    // The sanity check for the whole file: if this does NOT collapse, the
    // simulation is broken and every assertion below is vacuous.
    const normal = separation('#00ff00', '#ff0000');
    const deutan = separation('#00ff00', '#ff0000', 'deutan');
    expect(normal).toBeGreaterThan(50);
    expect(deutan).toBeLessThan(normal / 2);
  });

  it('leaves a blue/orange pair standing under deuteranopia', () => {
    expect(separation('#4fb3ff', '#ffd24a', 'deutan')).toBeGreaterThan(20);
  });

  it('collapses a blue/green pair under tritanopia specifically', () => {
    const deutan = separation('#00b0ff', '#00e08a', 'deutan');
    const tritan = separation('#00b0ff', '#00e08a', 'tritan');
    expect(tritan).toBeLessThan(deutan);
  });
});

/* -------------------------------------------------------------------------- */
/* The palettes                                                               */
/* -------------------------------------------------------------------------- */

describe('every palette separates SAVED from LOST', () => {
  for (const name of PALETTE_NAMES) {
    const palette = PALETTES[name];

    it(`${name}: normal vision`, () => {
      expect(separation(palette.saved, palette.lost)).toBeGreaterThan(15);
    });

    it(`${name}: under the dichromacy it targets`, () => {
      // Every palette must hold under the vision it is named for; the standard
      // one is only required to hold for trichromats, which is what it is for.
      const kinds: CvdKind[] =
        name === 'deuteranopia'
          ? ['deutan']
          : name === 'protanopia'
            ? ['protan']
            : name === 'tritanopia'
              ? ['tritan']
              : name === 'highContrast'
                ? ['deutan', 'protan', 'tritan']
                : [];
      for (const kind of kinds) {
        const value = separation(palette.saved, palette.lost, kind);
        expect(
          value,
          `${name} saved/lost under ${kind} = ${value.toFixed(1)}`
        ).toBeGreaterThan(SEPARATION_TARGET);
      }
    });

    it(`${name}: readable on the panel`, () => {
      for (const [slot, hex] of Object.entries(palette)) {
        if (!hex.startsWith('#')) continue; // surface and line are rgba()
        const ratio = contrastRatio(hex, SURFACE);
        expect(ratio, `${name}.${slot} contrast ${ratio.toFixed(2)}:1`).toBeGreaterThan(3);
      }
    });
  }
});

describe('the standard palette is why the alternates exist', () => {
  it('collapses saved/lost under deuteranopia, as red/green does', () => {
    const standard = PALETTES.default;
    const normal = separation(standard.saved, standard.lost);
    const deutan = separation(standard.saved, standard.lost, 'deutan');
    expect(normal).toBeGreaterThan(30);
    expect(deutan).toBeLessThan(normal * 0.5);
  });

  it('and the deuteranopia palette fixes exactly that', () => {
    const fixed = PALETTES.deuteranopia;
    expect(separation(fixed.saved, fixed.lost, 'deutan')).toBeGreaterThan(
      separation(PALETTES.default.saved, PALETTES.default.lost, 'deutan')
    );
  });

  it('keeps red/green for TRITANOPIA, which retains that axis', () => {
    // The mistake this guards against is applying the blue/orange fix
    // universally: for tritanopes blue/orange is the axis that is GONE.
    expect(PALETTES.tritanopia.saved).toBe(PALETTES.default.saved);
    expect(separation(PALETTES.tritanopia.saved, PALETTES.tritanopia.lost, 'tritan'))
      .toBeGreaterThan(SEPARATION_TARGET);
  });
});

/** OKLab chroma — how far a colour is from grey. */
function chroma(hex: string): number {
  const [, a, b] = oklab(linearise(parseHex(hex)));
  return Math.hypot(a, b) * 100;
}

describe('the threat ramp is ordered, and never carries meaning alone', () => {
  /**
   * The ramp is NOT claimed to be monotonic in hue, and the tests do not
   * pretend otherwise: it runs calm grey-blue -> yellow -> orange -> red and
   * then steps OFF the warm scale entirely for `god`, exactly the way real
   * hazard scales reserve an off-scale colour for the case that has no ordinary
   * comparison. What is asserted is what the player actually relies on: wolf
   * reads as "not really a threat", and no two adjacent tiers can be confused.
   */
  it('makes wolf visibly calmer than everything above it', () => {
    const wolf = chroma(TIER_COLOR.wolf);
    for (const tier of TIER_ORDER.slice(1)) {
      expect(chroma(TIER_COLOR[tier]), `${tier} vs wolf`).toBeGreaterThan(wolf * 2);
    }
  });

  it('separates every adjacent pair', () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      const previous = TIER_ORDER[i - 1]!;
      const tier = TIER_ORDER[i]!;
      const value = separation(TIER_COLOR[previous], TIER_COLOR[tier]);
      expect(value, `${previous} vs ${tier} = ${value.toFixed(1)}`).toBeGreaterThan(
        SEPARATION_TARGET
      );
    }
  });

  it('separates the two tiers a player must never confuse', () => {
    // Demon (a city) and dragon (several cities) are the decision boundary.
    expect(separation(TIER_COLOR.demon, TIER_COLOR.dragon)).toBeGreaterThan(SEPARATION_TARGET);
  });

  it('has every tier readable on the panel', () => {
    for (const tier of TIER_ORDER) {
      expect(contrastRatio(TIER_COLOR[tier], SURFACE)).toBeGreaterThan(3);
    }
  });
});

describe('intent colours', () => {
  it('separates restrained from full — the only pair that matters', () => {
    expect(separation(INTENT_COLOR.restrained, INTENT_COLOR.full)).toBeGreaterThan(20);
  });

  it('separates serious from normal, which is the threshold being crossed', () => {
    expect(separation(INTENT_COLOR.normal, INTENT_COLOR.serious)).toBeGreaterThan(
      SEPARATION_TARGET
    );
  });
});
