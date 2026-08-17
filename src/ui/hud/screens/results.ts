/**
 * THE INVOICE
 *
 * The end-of-encounter screen, and it is not a score screen. There is no
 * accuracy, no combo rating, no letter grade — none of that means anything when
 * every hit is fatal and every fight is won. What is left is what the player
 * actually controlled: how long it took, who lived, who did not, what it cost,
 * and whether anybody saw.
 *
 * So it is laid out as a BILL, printed by an institution that has already made
 * up its mind:
 *
 *   RESOLVED IN                1.4s
 *   CIVILIANS SAVED            6
 *   CIVILIANS LOST             0
 *   WITNESSES                  0            <- the line that decides everything
 *   PROPERTY DAMAGE            ¥15,000,000,000
 *                              150.00億円
 *   ────────────────────────────────────────
 *   HERO POINTS AWARDED        +0.0
 *
 * ── WHY THE YEN IS PRINTED IN FULL HERE AND NOWHERE ELSE ───────────────────
 * `propertyDamageYen` is unbounded and enormous — a single fully-charged
 * serious punch bills about ¥15,000,000,000. Every live meter in this HUD reads
 * `propertyDamageScore`, the bounded 0..1 companion field, precisely so nothing
 * saturates. This screen prints every digit on purpose. The absurdity is the
 * content.
 *
 * ── AND WHY GENOS IS ON IT ─────────────────────────────────────────────────
 * The rival credit lines are the payoff of the whole ranking design: the same
 * incident, the same fight, and a disciple who gave a clear statement banks
 * 2.4× what the man who ended it did. Printed on the same page, under the same
 * heading, with both numbers visible. Nothing else in the build says it as
 * plainly.
 */

import { button, el } from '../dom';
import {
  formatDuration,
  formatPercent,
  formatPoints,
  formatSeatDelta,
  formatYenFull,
  formatYenOku,
  groupDigits,
} from '../format';
import type { IEncounterInvoice, IHudModel } from '../model';
import { HudScreen, type HudScreenName } from '../screen';
import { TIER_COLOR, TIER_LABEL } from '../tokens';

export interface IResultsOptions {
  readonly onDismiss: () => void;
}

export class ResultsScreen extends HudScreen {
  readonly name: HudScreenName = 'results';

  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly lines: HTMLElement;
  private readonly verdict: HTMLElement;
  private readonly onDismiss: () => void;
  private lastRendered: string | null = null;

  constructor(doc: Document, options: IResultsOptions) {
    super(doc, 'hud-layer hud-layer--screen hud-screen hud-screen--centre', true);
    this.onDismiss = options.onDismiss;

    this.title = el(doc, 'div', { className: 'hud-sheet__title', text: 'Incident report' });
    this.subtitle = el(doc, 'div', { className: 'hud-sheet__sub', text: '' });
    this.lines = el(doc, 'div', { className: 'hud-invoice' });
    this.verdict = el(doc, 'div', { className: 'hud-verdict', text: '' });

    this.element.appendChild(
      el(doc, 'div', {
        className: 'hud-sheet',
        attrs: { 'data-screen': 'results' },
        children: [
          el(doc, 'div', {
            className: 'hud-sheet__head',
            children: [this.title, this.subtitle],
          }),
          el(doc, 'div', {
            className: 'hud-sheet__body',
            children: [this.lines, this.verdict],
          }),
          el(doc, 'div', {
            className: 'hud-sheet__foot',
            children: [
              button(doc, 'File it', () => this.onDismiss(), {
                className: 'hud-btn--primary',
                attrs: { 'data-hud': 'results-dismiss' },
              }),
            ],
          }),
        ],
      })
    );
  }

  override onBack(): boolean {
    this.onDismiss();
    return true;
  }

  override render(model: IHudModel): void {
    const invoice = model.invoice;
    if (!invoice) {
      if (this.lastRendered !== null) {
        this.lastRendered = null;
        this.lines.replaceChildren();
      }
      return;
    }
    const signature = `${invoice.encounterId}:${invoice.awardedPoints}:${invoice.propertyDamageYen}`;
    if (signature === this.lastRendered) return;
    this.lastRendered = signature;

    this.title.textContent = invoice.victory ? 'Incident resolved' : 'Incident report';
    this.subtitle.textContent = `${invoice.name} · threat ${TIER_LABEL[invoice.tier]}`;
    this.subtitle.style.setProperty('color', TIER_COLOR[invoice.tier]);

    const rows: HTMLElement[] = [
      this.line('Resolved in', formatDuration(invoice.timeToKill)),
      this.line('Hostiles down', String(invoice.kills)),
      this.line('Civilians saved', String(invoice.civiliansSaved), 'saved'),
      this.line('Civilians lost', String(invoice.civiliansLost), invoice.civiliansLost > 0 ? 'lost' : undefined),
    ];
    if (invoice.alliesSaved + invoice.alliesDowned > 0) {
      rows.push(
        this.line(
          'Allies standing',
          `${invoice.alliesSaved} of ${invoice.alliesSaved + invoice.alliesDowned}`,
          invoice.alliesDowned > 0 ? 'lost' : 'saved'
        )
      );
    }
    rows.push(
      this.line(
        'Witnesses',
        String(invoice.witnessed),
        undefined,
        invoice.witnessed === 0
          ? 'Nobody saw it. The Association scores what is reported.'
          : undefined
      ),
      this.line(
        'Property damage',
        formatYenFull(invoice.propertyDamageYen),
        'collateral',
        `${formatYenOku(invoice.propertyDamageYen)} · reported severity ${formatPercent(
          invoice.propertyDamageScore
        )}`
      ),
      this.line(
        'Force committed',
        `${invoice.seriousPunches} serious · ${invoice.normalPunches} normal`,
        undefined,
        invoice.longestChain > 1 ? `longest chain ${invoice.longestChain}` : undefined
      ),
      this.line(
        'Boredom',
        `${invoice.boredomBefore.toFixed(2)} → ${invoice.boredomAfter.toFixed(2)}`,
        invoice.boredomAfter > invoice.boredomBefore ? 'lost' : 'saved'
      )
    );

    /* The rival lines: same fight, different arithmetic. */
    for (const rival of invoice.rivalCredit) {
      rows.push(
        this.line(`Credited — ${rival.name}`, formatPoints(rival.points), 'collateral')
      );
    }

    rows.push(
      this.line(
        'Assessed',
        formatPoints(invoice.basePoints),
        undefined,
        invoice.basePoints !== invoice.awardedPoints
          ? `before the enthusiasm adjustment`
          : undefined
      )
    );

    const total = el(this.doc, 'div', {
      className: 'hud-invoice__line hud-invoice__line--total',
      attrs: { 'data-hud': 'invoice-total' },
      children: [
        el(this.doc, 'span', { className: 'hud-invoice__key', text: 'Hero points awarded' }),
        el(this.doc, 'div', {
          children: [
            el(this.doc, 'span', {
              className: `hud-invoice__val ${invoice.awardedPoints >= 0 ? 'hud-invoice__val--saved' : 'hud-invoice__val--lost'}`,
              text: formatPoints(invoice.awardedPoints),
            }),
            el(this.doc, 'div', {
              className: 'hud-invoice__sub',
              text: `${formatSeatDelta(invoice.seats > 900 ? 1 : invoice.seats)} on the ladder`,
            }),
          ],
        }),
      ],
    });
    rows.push(total);

    this.lines.replaceChildren(...rows);
    this.renderVerdict(invoice);
  }

  /**
   * The one editorial line on the screen.
   *
   * Every branch here is a real outcome the systems can produce, and the order
   * is the priority the Association would apply: what was destroyed first, who
   * was lost second, who got the credit third, and only then whether it was any
   * good.
   */
  private renderVerdict(invoice: IEncounterInvoice): void {
    let text: string;
    let colour: string;
    if (invoice.propertyDamageYen > 5e9 && invoice.civiliansLost === 0) {
      text =
        `Every civilian accounted for. ${groupDigits(Math.round(invoice.propertyDamageYen))} ` +
        `yen of the district is not. The public statement will lead with the second figure.`;
      colour = 'var(--hud-collateral)';
    } else if (invoice.civiliansLost > 0) {
      text = `${invoice.civiliansLost} not accounted for. The report will say so.`;
      colour = 'var(--hud-lost)';
    } else if (invoice.witnessed === 0 && invoice.awardedPoints < 1) {
      text =
        'Resolved without a single witness. Filed as unverified. ' +
        'Credit requires an audience; blame does not.';
      colour = 'var(--hud-ink-muted)';
    } else if (invoice.rivalCredit.length > 0 && invoice.rivalCredit[0]!.points > invoice.awardedPoints) {
      text =
        `${invoice.rivalCredit[0]!.name} filed a full statement with recordings. ` +
        `You said you punched it. The committee scored both accounts.`;
      colour = 'var(--hud-rival)';
    } else if (invoice.boredomAfter > invoice.boredomBefore + 0.05) {
      text = 'Resolved in one hit. Again.';
      colour = 'var(--hud-ink-muted)';
    } else {
      text = 'Clean. Filed without comment.';
      colour = 'var(--hud-saved)';
    }
    this.verdict.textContent = text;
    this.verdict.style.setProperty('--hud-verdict', colour);
  }

  private line(key: string, value: string, tone?: string, sub?: string): HTMLElement {
    return el(this.doc, 'div', {
      className: 'hud-invoice__line',
      dataset: { line: key.toLowerCase().replace(/[^a-z]+/g, '-') },
      children: [
        el(this.doc, 'span', { className: 'hud-invoice__key', text: key }),
        el(this.doc, 'div', {
          children: [
            el(this.doc, 'span', {
              className: `hud-invoice__val${tone ? ` hud-invoice__val--${tone}` : ''}`,
              text: value,
            }),
            sub ? el(this.doc, 'div', { className: 'hud-invoice__sub', text: sub }) : null,
          ],
        }),
      ],
    });
  }
}
