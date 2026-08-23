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
    const stamp = alert.tier === undefined ? null : TIER_LABEL[alert.tier];
    // Case-insensitive because the store's wording is the store's business:
    // this only has to notice that the headline would be the third printing of
    // one word, not police how it is capitalised.
    const body = alert.body;
    const restatesStamp =
      stamp !== null && body !== undefined && alert.title.toUpperCase().endsWith(stamp);
    const headline = restatesStamp && body !== undefined ? body : alert.title;
    const caption = restatesStamp ? undefined : body;
    return el(this.doc, 'div', {
      className: 'hud-panel hud-alert',
      dataset: { kind: alert.kind, alert: String(alert.id) },
      vars: { '--hud-alert-color': colour },
      attrs: { role: 'alert' },
      children: [
        stamp === null
          ? null
          : el(this.doc, 'span', { className: 'hud-chip hud-alert__chip', text: stamp }),
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
