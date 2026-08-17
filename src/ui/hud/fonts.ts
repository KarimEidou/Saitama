/**
 * HUD WEBFONTS
 *
 * A side-effect module, imported by the app bootstrap and by the harness —
 * never by the HUD's own modules, so that unit tests and any headless consumer
 * can import the HUD without pulling a stylesheet through the bundler.
 *
 * ── WHY A CONDENSED DISPLAY FACE IS NOT DECORATION ─────────────────────────
 * The HUD has to fit "NOTHING FEELS LIKE ANYTHING" and "THREAT LEVEL DRAGON"
 * into a 200 px column on a phone. Bebas Neue is about 25% narrower than a
 * system UI face at the same optical size, which is the difference between one
 * line and two — and a mood label that wraps stops being a mood label.
 *
 * Both families are bundled from `node_modules` rather than fetched: a
 * Capacitor build runs off `file://` with no network guarantee, and a HUD that
 * reflows 400 ms after boot when a webfont finally lands looks broken.
 *
 * The stylesheet's font stack degrades to Inter and then to `system-ui`, so
 * skipping this import costs typography and nothing else.
 */

import '@fontsource/bebas-neue/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';

/** Families this module guarantees, in the order the stylesheet asks for them. */
export const HUD_FONT_FAMILIES = ['Bebas Neue', 'Inter'] as const;

/**
 * Resolve once the HUD's faces are ready.
 *
 * Screenshot tooling should await this: a shot taken during the fallback face
 * measures the fallback's metrics, and every "the label wraps" bug found that
 * way is a bug in the test rather than in the HUD.
 */
export async function hudFontsReady(doc: Document = document): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  await Promise.all([
    fonts.load('400 16px "Bebas Neue"'),
    fonts.load('400 14px "Inter"'),
    fonts.load('600 14px "Inter"'),
  ]).catch(() => undefined);
  await fonts.ready;
}
