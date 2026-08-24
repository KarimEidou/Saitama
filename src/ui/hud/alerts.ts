/**
 * THREAT ALERTS
 *
 * The banner that appears when the Association classifies something.
 *
 * ── WHY THE TIER WORD IS ALWAYS THERE ──────────────────────────────────────
 * A five-step severity ramp cannot survive dichromacy as colour alone, and a
 * player who cannot tell DEMON from DRAGON at a glance is a player who fights a
 * dragon the way they fought a demon. So a tiered alert prints the word as a
 * CLASSIFICATION STAMP — an outlined chip, the one place in this HUD where an
 * all-round hairline survives, because a stamp is what it is — and the tier
 * colour only ever appears beside it.
 *
 * ── AND WHY EVERY BULLETIN HAS ONE NOW ─────────────────────────────────────
 * The stamp used to be emitted only for a tiered alert, which made the stack's
 * left text edge a function of what happened to be in it: a three-letter tier
 * word, a six-letter one, and — for a quest or rank notice — no stamp and no
 * gap at all, so that headline started a whole stamp further left than the two
 * above it. The plates are stretched to one width and line up to the pixel; the
 * words inside them ragged by up to ~60 px at 130 % HUD scale.
 * The fix is not an empty reserved box. An outlined stamp with nothing in it is
 * a missing element, and it would be the only object in this HUD that exists to
 * hold a space. Every bulletin is a filed notice, so every bulletin says what
 * kind of notice it is: the tier where there is one, the KIND word where there
 * is not. `.hud-alert__chip` in `styles.ts` gives that stamp a fixed column, and
 * between the two the stack has one text edge whatever is in it.
 * The kind words are the Association's own vocabulary for these five channels,
 * and they are short on purpose — the column is sized for the longest of them
 * (DANGER) beside the longest tier word (DRAGON), and every pixel of it is
 * taken off the bulletin's reading width.
 *
 * ── AND WHY THE TITLE OFTEN IS NOT ─────────────────────────────────────────
 * `HudStore` raises a threat as title "THREAT LEVEL DEMON" with the
 * Association's advisory as the body. Printed under a chip that already says
 * DEMON, that title is the same word a third time in one box — and the banner
 * used to be laid over an encounter card that said "THREAT DEMON" as well.
 * So when the stamp already carries the tier and the title only restates it,
 * the ADVISORY becomes the headline and the title is dropped. When it does not
 * — "FINAL PHASE" carries a tier and says something else entirely — the title
 * stays. The rule is about redundancy, not about threats.
 *
 * ── WHY THREE, AND WHY THE OLDEST GOES ─────────────────────────────────────
 * Three stacked banners is already more than anyone reads mid-fight. When a
 * fourth arrives the OLDEST is dropped rather than the newest being refused: a
 * god-level warning arriving behind three quest toasts has to win, and a queue
 * that drops the newest is how a player misses the only message that mattered.
 *
 * ── NOT ON THE 60 Hz PATH ──────────────────────────────────────────────────
 * Alerts appear and disappear a handful of times per fight, so they are rebuilt
 * in `render` and the entry animation is a CSS keyframe. Nothing here is
 * touched per frame.
 */

import { el } from './dom';
import type { IHudAlert, IHudModel } from './model';
import { TIER_COLOR, TIER_LABEL } from './tokens';

/** Colour per alert kind, resolved against the active palette. */
const KIND_COLOR: Readonly<Record<IHudAlert['kind'], string>> = {
  threat: 'var(--hud-lost)',
  rank: 'var(--hud-accent)',
  quest: 'var(--hud-commit)',
  info: 'var(--hud-ink-muted)',
  danger: 'var(--hud-lost)',
};

/**
 * The stamp an UNTIERED bulletin carries.
 *
 * One word each, because the stamp is a column and every character in it is
 * taken off the headline beside it. DUTY rather than QUEST because that is what
 * the strip in the band is called and what the log calls its rows; NOTICE
 * rather than INFO because INFO is the channel's name in the code and not a
 * word the Association would print on paper.
 */
const KIND_STAMP: Readonly<Record<IHudAlert['kind'], string>> = {
  threat: 'THREAT',
  rank: 'RANK',
  quest: 'DUTY',
  info: 'NOTICE',
  danger: 'DANGER',
};

export class AlertLayer {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private rendered = '';

  constructor(doc: Document) {
    this.doc = doc;
    this.element = el(doc, 'div', {
      className: 'hud-layer hud-layer--alerts',
      children: [el(doc, 'div', { className: 'hud-alerts', attrs: { 'data-hud': 'alerts' } })],
    });
  }

  private get list(): HTMLElement {
    return this.element.firstElementChild as HTMLElement;
  }

  render(model: IHudModel): void {
    // Keyed by id, so an unchanged stack is not rebuilt and its entry animation
    // does not restart every time something else on the HUD moves.
    const signature = model.alerts.map((a) => a.id).join(',');
    if (signature === this.rendered) return;
    this.rendered = signature;
    this.list.replaceChildren(...model.alerts.map((alert) => this.node(alert)));
  }

  private node(alert: IHudAlert): HTMLElement {
    const colour = alert.tier ? TIER_COLOR[alert.tier] : KIND_COLOR[alert.kind];
    const stamp = alert.tier === undefined ? KIND_STAMP[alert.kind] : TIER_LABEL[alert.tier];
    // Case-insensitive because the store's wording is the store's business:
    // this only has to notice that the headline would be the third printing of
    // one word, not police how it is capitalised.
    const body = alert.body;
    const restatesStamp = body !== undefined && alert.title.toUpperCase().endsWith(stamp);
    const headline = restatesStamp && body !== undefined ? body : alert.title;
    const caption = restatesStamp ? undefined : body;
    return el(this.doc, 'div', {
      className: 'hud-panel hud-alert',
      dataset: { kind: alert.kind, alert: String(alert.id) },
      vars: { '--hud-alert-color': colour },
      attrs: { role: 'alert' },
      children: [
        el(this.doc, 'span', { className: 'hud-chip hud-alert__chip', text: stamp }),
        el(this.doc, 'div', {
          className: 'hud-alert__main',
          children: [
            el(this.doc, 'div', { className: 'hud-alert__title', text: headline }),
            caption === undefined
              ? null
              : el(this.doc, 'div', { className: 'hud-alert__body', text: caption }),
          ],
        }),
      ],
    });
  }

  dispose(): void {
    this.element.remove();
  }
}
