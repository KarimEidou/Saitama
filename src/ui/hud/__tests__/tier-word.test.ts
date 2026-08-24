/**
 * THE TIER WORD, ASSERTED ON THE ELEMENT THAT ACTUALLY PRINTS IT
 *
 * ── THE INVARIANT ──────────────────────────────────────────────────────────
 * The threat tier ALWAYS carries its word beside its colour. No five-hue ramp
 * survives dichromacy as colour alone — `palette.test.ts` measures exactly how
 * badly this one does not, with wolf and god landing ΔE 4.6 apart under
 * deuteranopia, which is "the same colour" — so the WORD is the message and the
 * colour is only the accelerator that makes it readable at a glance.
 *
 * `combat-hud.ts` does this correctly and has done since it was written. What
 * was missing is anything that would NOTICE if it stopped: `TIER_LABEL`
 * appeared in no test in this directory, so deleting the `textContent` write
 * and leaving the `--hud-tier` colour write behind was a green build. That is
 * the failure this file exists to catch, and the mutation is worth stating in
 * full because it is the plausible one: the colour is the line a refactor keeps
 * (it is the one that looks like the feature) and the word is the line it drops.
 *
 * ── WHY THE TIER WORD AND NOT THE TIER COLOUR IS THE SUBJECT ───────────────
 * The colour is asserted here too, in `writes the colour BESIDE the word`, and
 * only there — because the point is the conjunction. A test that checked the
 * colour alone would pass on precisely the build this file is here to fail.
 *
 * ── NO BROWSER, AND NO jsdom EITHER ────────────────────────────────────────
 * Vitest runs in the `node` environment and the repo carries neither jsdom nor
 * happy-dom (`settings-and-safe-area.test.ts` says so at the point where it
 * gives up trying). The document below is therefore the hand-rolled stub that
 * `frame-writer.test.ts` established and `objective-row.test.ts` follows,
 * widened to the surface `CombatHudScreen`'s constructor and `render()` touch.
 *
 * That stub is enough BECAUSE of what is being asserted. This is a test about
 * which string is written to which node, not about how that node is laid out —
 * no measurement, no style resolution, nothing a fake document could get wrong
 * in our favour. The pixels are the harness's job, in a real browser.
 */

import { describe, expect, it } from 'vitest';
import type { ThreatTier } from '@/types';
import { CombatHudScreen } from '../screens/combat-hud';
import { createHudModel, type IEncounterState, type IHudModel } from '../model';
import { TIER_COLOR, TIER_LABEL, TIER_ORDER } from '../tokens';

/* -------------------------------------------------------------------------- */
/* A document, hand-rolled                                                    */
/* -------------------------------------------------------------------------- */

/** The node surface `el()`, `svg()`, `button()` and `render()` touch. */
interface IStubNode {
  readonly tag: string;
  className: string;
  textContent: string;
  hidden: boolean;
  readonly dataset: Record<string, string>;
  readonly attributes: Record<string, string>;
  /** Custom properties, as written through `style.setProperty`. */
  readonly properties: Record<string, string>;
  readonly children: IStubNode[];
  readonly style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  appendChild(child: IStubNode): IStubNode;
  append(...nodes: IStubNode[]): void;
  addEventListener(): void;
  removeEventListener(): void;
  remove(): void;
}

function stubNode(tag: string): IStubNode {
  const dataset: Record<string, string> = {};
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  const children: IStubNode[] = [];
  return {
    tag,
    className: '',
    textContent: '',
    hidden: false,
    dataset,
    attributes,
    properties,
    children,
    style: {
      setProperty: (name: string, value: string): void => {
        properties[name] = value;
      },
    },
    setAttribute: (name: string, value: string): void => {
      attributes[name] = value;
    },
    appendChild: (child: IStubNode): IStubNode => {
      children.push(child);
      return child;
    },
    append: (...nodes: IStubNode[]): void => {
      children.push(...nodes);
    },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    remove: (): void => {},
  };
}

/**
 * No `defaultView`, on purpose.
 *
 * `render()` reaches for `doc.defaultView?.requestAnimationFrame` on the one
 * path that bumps the LOST counter, and every fixture below holds
 * `civiliansLost` at 0 so that path is never taken. Leaving the window off
 * means a fixture that drifts into taking it fails loudly here rather than
 * silently exercising a branch this file does not model.
 */
function fakeDocument(): Document {
  return {
    createElement: (tag: string): IStubNode => stubNode(tag),
    createElementNS: (_ns: string, tag: string): IStubNode => stubNode(tag),
    createTextNode: (text: string): IStubNode => {
      const node = stubNode('#text');
      node.textContent = text;
      return node;
    },
  } as unknown as Document;
}

/** First node in tree order carrying `className` as a whole class token. */
function findByClass(root: IStubNode, className: string): IStubNode | undefined {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The encounter row's two nodes, off a real `CombatHudScreen`.
 *
 * Found by WALKING the built tree from `screen.element` rather than by reading
 * the private fields, so a tier element that is constructed but never attached
 * fails here — which is the same bug from the player's side.
 */
function buildEncounterRow(): {
  render: (encounter: IEncounterState) => void;
  tier: IStubNode;
  card: IStubNode;
} {
  const doc = fakeDocument();
  const screen = new CombatHudScreen(doc, { onPause: (): void => {} });
  const root = screen.element as unknown as IStubNode;
  const tier = findByClass(root, 'hud-encounter__tier');
  const card = findByClass(root, 'hud-encounter');
  if (!tier || !card) {
    throw new Error('the encounter row is not in the combat HUD tree at all');
  }
  const model: IHudModel = createHudModel();
  return {
    render: (encounter: IEncounterState): void => {
      model.encounter = encounter;
      screen.render(model);
    },
    tier,
    card,
  };
}

/** One live encounter of the given tier. A fresh `id` each time, as a new fight has. */
function encounterOf(tier: ThreatTier): IEncounterState {
  return {
    id: `enc.${tier}`,
    name: 'Mosquito Girl',
    tier,
    isBoss: false,
    elapsed: 12,
    civiliansSaved: 3,
    // Zero, and it must stay zero: see `fakeDocument`.
    civiliansLost: 0,
    collateralYen: 0,
    collateralScore: 0,
    debrisPieces: 0,
    debrisMassKg: 0,
    witnesses: 4,
  };
}

/** Every tier's word, read off one screen rendering them in ramp order. */
function wordsAcrossTheRamp(): Map<ThreatTier, string> {
  const row = buildEncounterRow();
  const words = new Map<ThreatTier, string>();
  for (const tier of TIER_ORDER) {
    row.render(encounterOf(tier));
    words.set(tier, row.tier.textContent);
  }
  return words;
}

/* -------------------------------------------------------------------------- */

describe('the threat tier always carries its word beside its colour', () => {
  it('has an element for the word, attached to the band', () => {
    // The guard on every other assertion in this file: they all read
    // `row.tier`, and a `findByClass` that silently returned the wrong node
    // would make each of them a claim about some other span.
    const row = buildEncounterRow();
    expect(row.tier.tag).toBe('span');
    expect(row.tier.className).toContain('hud-encounter__tier');
  });

  it('prints a NON-EMPTY word for every tier in the ramp', () => {
    for (const [tier, word] of wordsAcrossTheRamp()) {
      expect(word.trim(), `${tier} printed no word`).not.toBe('');
    }
  });

  it('prints exactly the TIER_LABEL word for each tier', () => {
    // Not "some word": the Association's own shorthand, which is what the
    // alert banner, the quest log and the invoice all print for the same tier.
    for (const [tier, word] of wordsAcrossTheRamp()) {
      expect(word, `${tier} word`).toBe(TIER_LABEL[tier]);
    }
  });

  it('gives every tier a DIFFERENT word, so the word alone identifies the tier', () => {
    // This is the half the colour cannot do. Five distinct words survive every
    // dichromacy, greyscale, and a phone screen in sunlight.
    const words = [...wordsAcrossTheRamp().values()];
    expect(words).toHaveLength(TIER_ORDER.length);
    expect(new Set(words).size, `printed words: ${words.join(', ')}`).toBe(TIER_ORDER.length);
  });

  it('writes the colour BESIDE the word, never instead of it', () => {
    // The conjunction is the invariant. A build that kept the `--hud-tier`
    // write and dropped the `textContent` write passes every colour test in
    // `palette.test.ts` and fails here, which is the whole point.
    const row = buildEncounterRow();
    for (const tier of TIER_ORDER) {
      row.render(encounterOf(tier));
      expect(row.card.properties['--hud-tier'], `${tier} colour`).toBe(TIER_COLOR[tier]);
      expect(row.tier.textContent, `${tier} word`).toBe(TIER_LABEL[tier]);
    }
  });

  it('replaces the word when the next fight is a different tier', () => {
    // `render()` gates the encounter block on `encounter.id !== lastEncounterId`
    // so it is not rewriting three strings on every model change. A gate keyed
    // on the wrong field — the tier, say, or nothing at all — leaves the
    // PREVIOUS fight's word over the new fight's colour, which is worse than
    // printing neither.
    const row = buildEncounterRow();
    row.render(encounterOf('wolf'));
    expect(row.tier.textContent).toBe(TIER_LABEL.wolf);
    row.render(encounterOf('god'));
    expect(row.tier.textContent).toBe(TIER_LABEL.god);
  });
});
