/**
 * SETTINGS
 *
 * Every control is a SEGMENTED CONTROL, never a slider.
 *
 * ── WHY NO SLIDERS ─────────────────────────────────────────────────────────
 * A slider on a phone is a 6 px-tall target dragged by a thumb that covers it
 * entirely, and the value it lands on is whatever the finger happened to be
 * over when it lifted. For resolution scale that is actively harmful:
 * continuous values put the framebuffer on non-integer device-pixel boundaries
 * and produce exactly the shimmer the player opened this screen to fix. Five
 * rungs, all clean fractions, all 44 px targets, all labelled with the number
 * they set.
 *
 * ── WHAT THIS SCREEN DOES NOT DO ───────────────────────────────────────────
 * It does not apply anything. It emits an `IHudSettings` and the bootstrap
 * hands the pieces to the renderer, the input layer and the platform adapter.
 * Nothing in `src/ui/hud/` imports a renderer, and a settings screen that
 * reached across three workstreams to set a pixel ratio would be the first
 * thing to break when any of them changed.
 */

import type { IQualityTier } from '@/types';
import { button, el } from '../dom';
import type { IHudModel } from '../model';
import { HudScreen, type HudScreenName } from '../screen';
import {
  HUD_SCALE_STEPS,
  QUALITY_BLURB,
  QUALITY_TIERS,
  RESOLUTION_STEPS,
  SENSITIVITY_STEPS,
  type IHudSettings,
} from '../settings-model';
import { PALETTES, PALETTE_LABELS, PALETTE_NAMES, type PaletteName } from '../tokens';

export interface ISettingsOptions {
  readonly onClose: () => void;
  readonly onChange: (settings: IHudSettings) => void;
}

/** One option in a segmented control. */
interface ISegOption<T> {
  readonly value: T;
  readonly label: string;
  /** Optional colour swatches, for the palette row. */
  readonly swatches?: readonly string[];
}

export class SettingsScreen extends HudScreen {
  readonly name: HudScreenName = 'settings';

  private readonly body: HTMLElement;
  private readonly onClose: () => void;
  private readonly onChange: (settings: IHudSettings) => void;
  private current: IHudSettings | null = null;
  /** Rebuilt on each render; maps a control to the option it should light. */
  private readonly groups: { readonly root: HTMLElement; readonly selected: () => string }[] = [];

  constructor(doc: Document, options: ISettingsOptions) {
    super(doc, 'hud-layer hud-layer--screen hud-screen hud-screen--centre', true);
    this.onClose = options.onClose;
    this.onChange = options.onChange;
    this.body = el(doc, 'div', { className: 'hud-sheet__body' });

    this.element.appendChild(
      el(doc, 'div', {
        className: 'hud-sheet hud-sheet--wide',
        attrs: { 'data-screen': 'settings' },
        children: [
          el(doc, 'div', {
            className: 'hud-sheet__head',
            children: [
              el(doc, 'div', { className: 'hud-sheet__title', text: 'Settings' }),
              el(doc, 'div', { className: 'hud-sheet__sub', text: 'Applied immediately' }),
            ],
          }),
          this.body,
          el(doc, 'div', {
            className: 'hud-sheet__foot',
            children: [
              button(doc, 'Close', () => this.onClose(), {
                className: 'hud-btn--primary',
                attrs: { 'data-hud': 'settings-close' },
              }),
            ],
          }),
        ],
      })
    );
  }

  override onBack(): boolean {
    this.onClose();
    return true;
  }

  override render(model: IHudModel): void {
    const settings = model.settings;
    // Rebuild only when a value actually changed: the screen is small enough
    // that a full rebuild is cheaper than diffing, and it is modal, so the cost
    // lands while the game is paused.
    if (this.current && shallowEqual(this.current, settings)) return;
    this.current = settings;
    this.groups.length = 0;

    this.body.replaceChildren(
      this.section('Render', [
        this.segRow(
          'Quality',
          QUALITY_BLURB[settings.qualityTier],
          QUALITY_TIERS.map((tier) => ({ value: tier, label: tier })),
          settings.qualityTier,
          (tier) => this.patch({ qualityTier: tier as IQualityTier }),
          'quality'
        ),
        this.segRow(
          'Resolution scale',
          'Renders below native and upscales. The first thing to turn down.',
          RESOLUTION_STEPS.map((step) => ({ value: String(step), label: `${step * 100}%` })),
          String(settings.resolutionScale),
          (value) => this.patch({ resolutionScale: Number(value) }),
          'resolution'
        ),
      ]),

      this.section('Controls', [
        this.segRow(
          'Stick layout',
          'Floating puts the stick wherever your thumb lands. Fixed pins it.',
          [
            { value: 'floating', label: 'Floating' },
            { value: 'fixed', label: 'Fixed' },
          ],
          settings.stickLayout,
          (value) => this.patch({ stickLayout: value === 'fixed' ? 'fixed' : 'floating' }),
          'stick-layout'
        ),
        this.segRow(
          'Stick hand',
          'Mirrors the stick and the action arc.',
          [
            { value: 'left', label: 'Left' },
            { value: 'right', label: 'Right' },
          ],
          settings.stickHand,
          (value) => this.patch({ stickHand: value === 'right' ? 'right' : 'left' }),
          'stick-hand'
        ),
        this.segRow(
          'Invert look Y',
          'Drag down to look up.',
          [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ],
          settings.invertLookY ? 'on' : 'off',
          (value) => this.patch({ invertLookY: value === 'on' }),
          'invert-y'
        ),
        this.segRow(
          'Look sensitivity',
          'Multiplier on the camera rate.',
          SENSITIVITY_STEPS.map((step) => ({ value: String(step), label: `${step}×` })),
          String(settings.lookSensitivity),
          (value) => this.patch({ lookSensitivity: Number(value) }),
          'sensitivity'
        ),
        this.segRow(
          'Haptics',
          'Impact and charge-complete pulses.',
          [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ],
          settings.hapticsEnabled ? 'on' : 'off',
          (value) => this.patch({ hapticsEnabled: value === 'on' }),
          'haptics'
        ),
      ]),

      this.section('Display', [
        this.segRow(
          'Colour palette',
          'Saved and lost are the pair that has to survive. Each alternate moves them onto an axis that dichromacy keeps.',
          PALETTE_NAMES.map((name) => ({
            value: name,
            label: PALETTE_LABELS[name],
            swatches: [PALETTES[name].saved, PALETTES[name].lost, PALETTES[name].collateral],
          })),
          settings.palette,
          (value) => this.patch({ palette: value as PaletteName }),
          'palette'
        ),
        this.segRow(
          'HUD scale',
          'Type and control size.',
          HUD_SCALE_STEPS.map((step) => ({ value: String(step), label: `${Math.round(step * 100)}%` })),
          String(settings.hudScale),
          (value) => this.patch({ hudScale: Number(value) }),
          'hud-scale'
        ),
        this.segRow(
          'Reduced motion',
          'Stops the boredom breath, the alert throb and screen transitions.',
          [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ],
          settings.reducedMotion ? 'on' : 'off',
          (value) => this.patch({ reducedMotion: value === 'on' }),
          'reduced-motion'
        ),
        this.segRow(
          'Collateral ticker',
          'The running yen figure during a fight.',
          [
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ],
          settings.showCollateralTicker ? 'on' : 'off',
          (value) => this.patch({ showCollateralTicker: value === 'on' }),
          'collateral-ticker'
        ),
      ])
    );
  }

  private patch(patch: Partial<IHudSettings>): void {
    const next = { ...(this.current ?? {}), ...patch } as IHudSettings;
    this.onChange(next);
  }

  private section(title: string, rows: readonly HTMLElement[]): HTMLElement {
    return el(this.doc, 'div', {
      className: 'hud-section',
      children: [
        el(this.doc, 'div', { className: 'hud-section__title', text: title }),
        ...rows,
      ],
    });
  }

  private segRow<T extends string>(
    name: string,
    hint: string,
    options: readonly ISegOption<T>[],
    selected: string,
    onPick: (value: string) => void,
    testId: string
  ): HTMLElement {
    const seg = el(this.doc, 'div', {
      className: 'hud-seg',
      attrs: { role: 'group', 'data-setting': testId },
    });
    for (const option of options) {
      const opt = el(this.doc, 'button', {
        className: 'hud-seg__opt',
        attrs: {
          type: 'button',
          'aria-pressed': option.value === selected ? 'true' : 'false',
          'data-value': option.value,
        },
        children: [
          option.swatches
            ? el(this.doc, 'span', {
                className: 'hud-swatches',
                children: option.swatches.map((colour) =>
                  el(this.doc, 'span', {
                    className: 'hud-swatch',
                    vars: { 'background-color': colour },
                  })
                ),
              })
            : null,
          el(this.doc, 'span', { text: option.label }),
        ],
      });
      const handler = (event: Event): void => {
        event.preventDefault();
        onPick(option.value);
      };
      opt.addEventListener('pointerup', handler);
      opt.addEventListener('click', (event) => {
        if ((event as PointerEvent).pointerType) return;
        handler(event);
      });
      seg.appendChild(opt);
    }
    return el(this.doc, 'div', {
      className: 'hud-setting',
      children: [
        el(this.doc, 'div', {
          className: 'hud-setting__label',
          children: [
            el(this.doc, 'div', { className: 'hud-setting__name', text: name }),
            el(this.doc, 'div', { className: 'hud-setting__hint', text: hint }),
          ],
        }),
        seg,
      ],
    });
  }
}

function shallowEqual(a: IHudSettings, b: IHudSettings): boolean {
  return (Object.keys(a) as (keyof IHudSettings)[]).every((key) => a[key] === b[key]);
}
