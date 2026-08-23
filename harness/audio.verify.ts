/**
 * AUDIO HARNESS VERIFICATION
 *
 * Boots `harness/audio.html` in headless Chromium and drives every control on
 * it, so the audition page is exercised in CI rather than only by hand.
 *
 * ── WHAT THIS DOES *NOT* OWN ───────────────────────────────────────────────
 * The synthesis itself. `src/audio/__tests__/render.test.ts` renders every
 * voice through an `OfflineAudioContext` and asserts on the samples; that is
 * where a claim about how something SOUNDS belongs.
 *
 * ── WHAT THIS DOES OWN ─────────────────────────────────────────────────────
 * The live path, which an offline render cannot reach:
 *
 *   • a device-backed `AudioContext` resumed from a real gesture;
 *   • the `EventBus` -> `event-map.ts` -> `AudioSystem` wiring, driven the way
 *     gameplay drives it — every button on the page emits an event, none of
 *     them calls a voice directly;
 *   • the music director scheduling against a real `requestAnimationFrame`
 *     clock, so a state change that is queued to the next bar line is observed
 *     actually arriving;
 *   • the page's own `EVENT_SAMPLES` table. `harness/audio.ts` reads
 *     `EVENT_AUDIO_MAP[type]` at module load and `EVENT_SAMPLES[type]()` on
 *     click, so an event type added without a rule throws at boot and one added
 *     without a sample throws on click. Clicking every event button turns both
 *     into a CI failure instead of a comment nobody re-reads.
 *
 * No GL context is created by this page, so no SwiftShader flags are passed.
 *
 * Run: `npx tsx harness/audio.verify.ts`
 * Exit 0 = pass, 1 = fail.
 */

import { chromium, type Locator, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const SHOT = path.join(OUT_DIR, 'audio-audition.png');
const REPORT = path.join(OUT_DIR, 'audio-report.json');

/**
 * The first two are container requirements, matching
 * `src/audio/__tests__/browser-harness.ts`. The third is belt and braces: a
 * Playwright `click()` is already a trusted gesture, but headless Chromium has
 * no audio device and this removes the autoplay gate entirely.
 */
const CHROME_FLAGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--autoplay-policy=no-user-gesture-required',
];

const failures: string[] = [];

function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${message}`);
}

/** A literal caption, anchored, for `hasText`. */
function exact(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/**
 * The button inside `container` whose `.k` caption is exactly `label`. Matching
 * on `.k` rather than the button keeps `stop` from also matching the `stop all
 * sfx` sibling through its description text.
 */
function labelled(page: Page, container: string, label: string): Locator {
  return page
    .locator(`${container} button`)
    .filter({ has: page.locator('.k', { hasText: exact(label) }) })
    .first();
}

async function readText(page: Page, selector: string): Promise<string> {
  return (await page.textContent(selector))?.trim() ?? '';
}

/**
 * Poll a status readout until `accept` is satisfied, or give up and return
 * whatever it says. The status bar repaints every 6 frames
 * (`harness/audio.ts`), so NOTHING here may be read once — a value that is
 * already correct in the system can still be a repaint away from the DOM.
 */
async function pollText(
  page: Page,
  selector: string,
  accept: (text: string) => boolean,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = await readText(page, selector);
  while (!accept(text) && Date.now() < deadline) {
    await page.waitForTimeout(100);
    text = await readText(page, selector);
  }
  return text;
}

/** Captions of every button in a container, in DOM order. */
async function labels(page: Page, container: string): Promise<string[]> {
  const found = await page.locator(`${container} button .k`).allTextContents();
  return found.map((text) => text.trim());
}

async function main(): Promise<void> {
  let server: ViteDevServer | undefined;
  const browser = await chromium.launch({ args: CHROME_FLAGS });

  try {
    server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.ts'),
      logLevel: 'warn',
      server: { port: 0, strictPort: false, host: '127.0.0.1' },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    if (url === undefined) throw new Error('vite dev server did not report a URL');

    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

    await page.goto(new URL('harness/audio.html', url).href, {
      waitUntil: 'load',
      timeout: 60_000,
    });
    // The tables are built at module load from the live registries, so a page
    // that threw on its way through them has no buttons at all.
    await page.waitForSelector('#events button', { timeout: 60_000 });

    const counts = {
      events: await page.locator('#events button').count(),
      voices: await page.locator('#voices button').count(),
      music: await page.locator('#music button').count(),
      environments: await page.locator('#environments button').count(),
    };

    // Floors, not equalities, except music where the shape is fixed: a floor
    // still fails when a type is DROPPED, and none of them fails when one is
    // added. 18 `ALL_GAME_EVENT_TYPES` + the `ChunkDetached x60` burst button,
    // 38 `SOUND_SPECS`, 5 `MUSIC_STATES` + `stop`, 7 `REVERB_PRESETS`.
    console.log('\ntables built from the live registries');
    check(counts.events >= 19, `${counts.events} event buttons (>= 19)`);
    check(counts.voices >= 38, `${counts.voices} voice buttons (>= 38)`);
    check(counts.music === 6, `${counts.music} music buttons (5 states + stop)`);
    check(counts.environments >= 7, `${counts.environments} reverb presets (>= 7)`);

    console.log('\nunlock');
    // `#unlock` is the one control outside a `section`; every section has
    // `pointer-events: none` while `body.locked` is set.
    await page.click('#unlock');
    await page.waitForSelector('body:not(.locked)', { timeout: 15_000 });
    const state = await pollText(page, '#s-state', (text) => text === 'running', 15_000);
    check(state === 'running', `context running after the gesture (readout "${state}")`);
    const rate = await pollText(
      page,
      '#s-rate',
      (text) => Number.parseInt(text, 10) > 8000,
      15_000
    );
    const sampleRate = Number.parseInt(rate, 10);
    check(sampleRate > 8000, `device-backed context, not a stub (${rate})`);

    console.log('\nevents and voices');
    // A missing `EVENT_SAMPLES` entry throws on click, and a missing
    // `EVENT_AUDIO_MAP` rule would already have thrown at boot. Both surface
    // here as a `pageerror`.
    const beforeEvents = consoleErrors.length;
    for (let i = 0; i < counts.events; i++) {
      await page.locator('#events button').nth(i).click();
      await page.waitForTimeout(60);
    }
    check(
      consoleErrors.length === beforeEvents,
      `all ${counts.events} event buttons emitted a payload ` +
        `(${consoleErrors.length - beforeEvents} threw)`
    );

    const beforeVoices = consoleErrors.length;
    for (let i = 0; i < counts.voices; i++) {
      await page.locator('#voices button').nth(i).click();
      await page.waitForTimeout(60);
    }
    check(
      consoleErrors.length === beforeVoices,
      `all ${counts.voices} voices played (${consoleErrors.length - beforeVoices} threw)`
    );

    // `voice storm` schedules 60 plays over 720 ms. A single one-shot can begin
    // and end between two repaints of the status bar; a storm cannot, so this
    // is the one place the live voice budget is observably non-empty.
    await labelled(page, '#mixer-actions', 'voice storm').click();
    let maxVoices = 0;
    for (let i = 0; i < 20; i++) {
      // "sounding/limit" — `parseInt` stops at the slash.
      const sounding = Number.parseInt(await readText(page, '#s-voices'), 10);
      if (Number.isFinite(sounding)) maxVoices = Math.max(maxVoices, sounding);
      await page.waitForTimeout(100);
    }
    check(maxVoices > 0, `voice storm put ${maxVoices} voices in the air at once`);

    console.log('\nmusic');
    const musicLabels = await labels(page, '#music');
    const barBefore = Number.parseInt(await readText(page, '#s-bar'), 10);
    const musicStatesReached: string[] = [];
    for (const label of musicLabels) {
      if (label === 'stop') continue;
      await labelled(page, '#music', label).click();
      // `MusicDirector.setState` queues to the next bar line, so this MUST be
      // polled. At 60 bpm a bar is 4 s.
      const reached = await pollText(page, '#s-music', (text) => text === label, 10_000);
      if (reached === label) musicStatesReached.push(label);
      check(reached === label, `music reached "${label}" on a bar line (readout "${reached}")`);
    }
    check(
      musicStatesReached.length === musicLabels.length - 1,
      `every music state reached (${musicStatesReached.length}/${musicLabels.length - 1})`
    );
    const barAfter = Number.parseInt(await readText(page, '#s-bar'), 10);
    // The offline tests cannot show this: the scheduler advancing on its own
    // against a real clock is the whole point of the live path.
    check(barAfter > barBefore, `bar counter advanced (${barBefore} -> ${barAfter})`);
    await labelled(page, '#music', 'stop').click();

    console.log('\nacoustics, ambience and mixer');
    const environments: string[] = [];
    for (const preset of await labels(page, '#environments')) {
      await labelled(page, '#environments', preset).click();
      // `setEnvironment` is immediate; the bound here is the repaint cadence.
      const shown = await pollText(page, '#s-env', (text) => text === preset, 2_000);
      if (shown === preset) environments.push(preset);
      check(shown === preset, `environment switched to "${preset}" (readout "${shown}")`);
    }

    await labelled(page, '#ambience', 'start beds').click();
    await page.waitForTimeout(300);

    await labelled(page, '#mixer-actions', 'duck music').click();
    // The unduck lands 1.5 s after the click.
    await page.waitForTimeout(2_000);
    const gainReduction = await readText(page, '#s-gr');
    check(
      Number.isFinite(Number.parseFloat(gainReduction)),
      `limiter reports a finite gain reduction ("${gainReduction}")`
    );

    // `suspend` is a toggle; leaving it on suspends the context for good.
    const suspend = labelled(page, '#mixer-actions', 'suspend');
    await suspend.click();
    await page.waitForTimeout(300);
    await suspend.click();
    const resumed = await pollText(page, '#s-state', (text) => text === 'running', 5_000);
    check(resumed === 'running', `context left running after the toggle (readout "${resumed}")`);

    // Deliberately unfiltered: a driver that filters its own console errors is
    // a driver that cannot fail.
    check(consoleErrors.length === 0, `no console errors (${consoleErrors.length})`);
    if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5).join('\n'));

    await mkdir(OUT_DIR, { recursive: true });
    await page.screenshot({ path: SHOT, type: 'png', fullPage: true });
    await writeFile(
      REPORT,
      JSON.stringify(
        {
          counts,
          unlocked: state === 'running',
          sampleRate,
          maxVoices,
          musicStatesReached,
          barBefore,
          barAfter,
          environments,
          consoleErrors,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`\nscreenshot -> ${path.relative(ROOT, SHOT)}`);
    console.log(`report     -> ${path.relative(ROOT, REPORT)}`);
  } finally {
    await browser.close();
    await server?.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} harness assertion(s) failed:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('\naudio harness PASS');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
