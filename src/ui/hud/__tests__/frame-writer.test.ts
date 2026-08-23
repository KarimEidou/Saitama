/**
 * THE WRITE DISCIPLINE, TESTED WITHOUT A BROWSER
 *
 * `FrameWriter` is the single door every 60 Hz write goes through, so it is
 * worth testing on its own with a fake element rather than only observing it in
 * the harness. The three properties that matter:
 *
 *   1. It REFUSES anything that is not a custom property. If this stops
 *      throwing, the whole claim in `harness/hud.verify.ts` becomes a claim
 *      about a stylesheet rather than about the code.
 *   2. It DEDUPLICATES. Most frames of most HUD elements do not change, and
 *      skipping the write is what keeps style recalculation off the frame.
 *   3. It never emits a token CSS cannot parse — no exponent, and, for
 *      `setInteger`, no fraction where a declaration demands an `<integer>`.
 *
 * ── AND THE ONE THESE TESTS COULD NOT SEE ──────────────────────────────────
 * Every readout in the shipping build printed `0` while every assertion in this
 * file passed, because the digits were drawn by `counter-reset: ni var(--n-i)`
 * and the WebView would not substitute a `var()` there. A unit test cannot see
 * a style engine. What it CAN do is pin the shape of what is written and refuse
 * the mechanism that failed, which is what the `CssNumber` block below does:
 * the emitted token is a quoted CSS string over a closed alphabet, and the
 * stylesheet is asserted to contain no counter at all.
 */

import { describe, expect, it } from 'vitest';
import { FrameWriter, roundTo } from '../frame-writer';
import { CSS_NUMBER_STYLES, CssNumber, escapeCssString } from '../css-number';

/** The minimum `Element` surface `FrameWriter` touches. */
function fakeElement(): { element: Element; writes: [string, string][] } {
  const writes: [string, string][] = [];
  const element = {
    style: {
      setProperty(name: string, value: string): void {
        writes.push([name, value]);
      },
    },
  } as unknown as Element;
  return { element, writes };
}

describe('FrameWriter', () => {
  it('refuses a property that is not a custom property', () => {
    const writer = new FrameWriter();
    const { element } = fakeElement();
    expect(() => writer.set(element, 'width' as never, '10px')).toThrow(/custom property/);
    expect(() => writer.set(element, 'transform' as never, 'none')).toThrow(/custom property/);
  });

  it('writes once and then skips', () => {
    const writer = new FrameWriter();
    const { element, writes } = fakeElement();
    writer.set(element, '--x', '1');
    writer.set(element, '--x', '1');
    writer.set(element, '--x', '1');
    expect(writes).toEqual([['--x', '1']]);
    expect(writer.stats.writes).toBe(1);
    expect(writer.stats.skipped).toBe(2);
  });

  it('writes again when the value actually moves', () => {
    const writer = new FrameWriter();
    const { element, writes } = fakeElement();
    writer.setNumber(element, '--x', 0.5);
    writer.setNumber(element, '--x', 0.5004); // below the rounding threshold
    writer.setNumber(element, '--x', 0.51);
    expect(writes.map(([, v]) => v)).toEqual(['0.5', '0.51']);
  });

  it('tracks two elements independently', () => {
    const writer = new FrameWriter();
    const a = fakeElement();
    const b = fakeElement();
    writer.set(a.element, '--x', '1');
    writer.set(b.element, '--x', '1');
    expect(a.writes).toHaveLength(1);
    expect(b.writes).toHaveLength(1);
  });

  it('rounds a value CSS will only accept as an <integer>', () => {
    const writer = new FrameWriter();
    const { element, writes } = fakeElement();
    writer.setInteger(element, '--n', 1.5);
    writer.setInteger(element, '--n', Number.NaN);
    expect(writes).toEqual([
      ['--n', '2'],
      ['--n', '0'],
    ]);
  });

  it('never emits exponential notation', () => {
    // CSS number parsing does not accept "1e-21", and a value that small is
    // indistinguishable from zero on screen anyway.
    expect(roundTo(1e-21, 3)).toBe('0');
    expect(roundTo(0.0004, 3)).toBe('0');
    expect(roundTo(-0, 3)).toBe('0');
  });

  it('never emits exponential notation at the LARGE end either', () => {
    // `(1e21).toFixed(3)` is "1e+21" and `String(Math.round(1e21))` is "1e+21":
    // JS switches notation at 1e21 in BOTH, so fixed notation alone is not
    // enough and the magnitude has to be clamped first.
    expect(roundTo(1e21, 3)).toBe('100000000000000000000');
    expect(roundTo(-1e30, 3)).toBe('-100000000000000000000');
    expect(roundTo(1e21, 0)).not.toMatch(/e/i);

    const writer = new FrameWriter();
    const { element, writes } = fakeElement();
    writer.setInteger(element, '--n', 1e22);
    expect(writes[0]![1]).toBe('100000000000000000000');
    expect(writes[0]![1]).not.toMatch(/e/i);
  });

  it('trims trailing zeros without eating significant digits', () => {
    expect(roundTo(1.5, 3)).toBe('1.5');
    expect(roundTo(2, 3)).toBe('2');
    expect(roundTo(100, 3)).toBe('100');
    expect(roundTo(10.5, 1)).toBe('10.5');
    expect(roundTo(120, 0)).toBe('120');
  });

  it('reports the names it has ever written, for the harness assertion', () => {
    const writer = new FrameWriter();
    const { element } = fakeElement();
    writer.set(element, '--a', '1');
    writer.setPx(element, '--b', 4);
    expect([...writer.stats.names].sort()).toEqual(['--a', '--b']);
    expect(writer.stats.names.every((n) => n.startsWith('--'))).toBe(true);
  });
});

describe('CssNumber', () => {
  /** A document stub sufficient for `CssNumber`'s constructor. */
  function fakeDocument(): Document {
    return {
      createElement(): unknown {
        const attrs = new Map<string, string>();
        return {
          className: '',
          dataset: {} as Record<string, string>,
          textContent: '',
          style: {
            setProperty(name: string, value: string): void {
              attrs.set(name, value);
            },
          },
          setAttribute(name: string, value: string): void {
            attrs.set(name, value);
          },
          appendChild(): void {},
          __attrs: attrs,
        };
      },
    } as unknown as Document;
  }

  /** Everything currently set on a readout's inline style. */
  function varsOf(number: CssNumber): Map<string, string> {
    return (number.element as unknown as { __attrs: Map<string, string> }).__attrs;
  }

  /** Build a readout, push one value, and return what the writer set. */
  function render(spec: ConstructorParameters<typeof CssNumber>[1], value: number): string {
    const number = new CssNumber(fakeDocument(), spec);
    number.write(new FrameWriter(), value);
    return varsOf(number).get('--n-text') ?? '(unwritten)';
  }

  it('writes the digits as ONE quoted string, not as a counter operand', () => {
    // The counter mechanism this replaced wrote `--n-i`/`--n-f` for
    // `counter-reset` to pick up, and the shipping WebView would not substitute
    // a var() there — every readout in the game printed 0. Nothing may go back
    // to writing an unquoted number for a counter to reset from.
    const number = new CssNumber(fakeDocument(), { decimals: 1 });
    number.write(new FrameWriter(), 9.97);
    const vars = varsOf(number);
    // Rounded ONCE, on the scaled value: 9.97 at one decimal is 10.0, never the
    // 9.10 that rounding the two halves independently produces.
    expect([...vars]).toEqual([['--n-text', "'10.0'"]]);
  });

  it('formats every shape the HUD asks for', () => {
    expect(render({}, 388)).toBe("'388'");
    expect(render({ pad2: true }, 7)).toBe("'07'"); // clock seconds
    expect(render({ pad2: true }, 138)).toBe("'138'"); // and never truncated
    expect(render({ decimals: 2 }, 0)).toBe("'0.00'");
    expect(render({ decimals: 2 }, 1.5)).toBe("'1.50'"); // trailing zero KEPT
    expect(render({ decimals: 2 }, 0.07)).toBe("'0.07'"); // leading zero KEPT
    expect(render({ decimals: 1 }, 0.96)).toBe("'1.0'");
    // Unsigned readouts print the magnitude, as they always have: the minus is
    // `signed`'s job and renders as `−`, not as a hyphen.
    expect(render({}, -12)).toBe("'12'");
  });

  it('renders the sign as a string too, and only when asked', () => {
    const plain = new CssNumber(fakeDocument(), {});
    plain.write(new FrameWriter(), -3);
    expect(varsOf(plain).has('--n-sign')).toBe(false);

    const signed = new CssNumber(fakeDocument(), { signed: true });
    signed.write(new FrameWriter(), -3);
    expect(varsOf(signed).get('--n-sign')).toBe("'−'");
    signed.write(new FrameWriter(), 3);
    expect(varsOf(signed).get('--n-sign')).toBe("'+'");
  });

  it('emits a CLOSED ALPHABET, whatever it is handed', () => {
    // `content` takes a quoted <string>. An apostrophe, a backslash or a raw
    // newline inside one ends the token and drops the declaration — the exact
    // silent degradation this module refuses everywhere else. The digits are
    // machine-made and cannot contain any of the three; this is the assertion
    // that keeps that true rather than assumed.
    const hostile = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
      1e-9,
      -1e30,
      1e22,
      0.5,
      Number.MAX_SAFE_INTEGER,
    ];
    for (const spec of [{}, { pad2: true }, { decimals: 1 }, { decimals: 2 }]) {
      for (const value of hostile) {
        expect(render(spec, value), `${JSON.stringify(spec)} <- ${value}`).toMatch(
          /^'[0-9]+(\.[0-9]+)?'$/
        );
      }
    }
  });

  it('never prints an exponent at either end', () => {
    // `String(1e21)` is "1e+21". As a counter operand that was invalid CSS; as
    // generated content it is a display face rendering "1e+21" at 11 px, which
    // is worse. The magnitude is clamped before it is ever stringified.
    expect(render({}, 1e22)).toBe(`'${'1'.padEnd(21, '0')}'`);
    expect(render({ decimals: 2 }, -1e30)).toBe(`'${'1'.padEnd(21, '0')}.00'`);
    expect(render({}, 1e-9)).toBe("'0'");
    expect(render({}, Number.NaN)).toBe("'0'");
  });

  it('dedupes a string write exactly as cheaply as a numeric one', () => {
    // The readouts are idle most frames. Dedupe lives in `FrameWriter` — one
    // Map lookup and a string compare — so the harness's writes-vs-skips count
    // still sees every skip. A second cache in `CssNumber` would be faster and
    // would make that number a lie.
    const number = new CssNumber(fakeDocument(), { decimals: 2 });
    const writer = new FrameWriter();
    for (let i = 0; i < 5; i++) number.write(writer, 4.2);
    number.write(writer, 4.21);
    expect(writer.stats.writes).toBe(2);
    expect(writer.stats.skipped).toBe(4);
    expect(writer.stats.names).toEqual(['--n-text']);
  });

  it('caps decimals at two', () => {
    const doc = fakeDocument();
    const number = new CssNumber(doc, { decimals: 5 });
    number.write(new FrameWriter(), 1.234567);
    expect(varsOf(number).get('--n-text')).toBe("'1.23'");
    // The class list still carries the decimal treatment, for anything reading
    // this HUD from the outside.
    expect(number.element.className).toContain('hud-num--dec2');
    expect(number.element.className).not.toContain('hud-num--dec5');
  });

  it('escapes a prefix that would break out of a CSS string', () => {
    const doc = fakeDocument();
    const number = new CssNumber(doc, { prefix: "it's" });
    expect(varsOf(number).get('--n-prefix')).toBe("'it\\'s'");
  });

  it('quotes a suffix whose leading space is the point', () => {
    // ` PIECES` — the space is inside the string token, so `content:
    // var(--n-text) var(--n-suffix)` prints "1412 PIECES" and not "1412PIECES".
    const number = new CssNumber(fakeDocument(), { suffix: ' PIECES' });
    expect(varsOf(number).get('--n-suffix')).toBe("' PIECES'");
    const backslash = new CssNumber(fakeDocument(), { suffix: 'a\\b\nc' });
    expect(varsOf(backslash).get('--n-suffix')).toBe("'a\\\\b\\A c'");
    const yen = new CssNumber(fakeDocument(), { prefix: '¥', suffix: 'B' });
    expect(varsOf(yen).get('--n-prefix')).toBe("'¥'");
    expect(varsOf(yen).get('--n-suffix')).toBe("'B'");
  });

  it('keeps the stylesheet off the mechanism that failed on the device', () => {
    // A counter is invisible to every test here: it renders 0 and nothing
    // throws. The only cheap guard is to refuse the construct outright.
    expect(CSS_NUMBER_STYLES).not.toMatch(/counter-reset|counter\s*\(/);
    // And `contain: layout` strips this box of its baseline, which is what
    // floated the digits above every label they are aligned with.
    expect(CSS_NUMBER_STYLES).toMatch(/contain:style/);
    expect(CSS_NUMBER_STYLES.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/contain:[^;}]*layout/);
    expect(CSS_NUMBER_STYLES).toContain("content:var(--n-text,'0') var(--n-suffix,'')");
  });

  it('escapes everything that can terminate a CSS string token', () => {
    // A CSS string cannot span lines: a raw newline terminates the token and
    // the whole declaration is DROPPED, which is the silent degradation this
    // module refuses everywhere else.
    expect(escapeCssString("it's")).toBe("it\\'s"); // unchanged behaviour
    expect(escapeCssString('a\\b')).toBe('a\\\\b'); // unchanged behaviour
    expect(escapeCssString('\n')).toBe('\\A ');
    expect(escapeCssString('SALE\r\nENDS')).toBe('SALE\\D \\A ENDS');
    // The backslash pass runs FIRST, so the escape it introduces is not re-escaped.
    expect(escapeCssString('\n')).not.toContain('\\\\');
    expect(escapeCssString('¥億')).toBe('¥億');
  });

  it('refuses pad2 combined with decimals', () => {
    // It used to be unimplementable: `.hud-num--dec1/2::after` followed
    // `.hud-num--pad2::after` at equal specificity, so the zero-pad vanished
    // with no diagnostic anywhere but devtools. Now that JS formats the string
    // it would be four characters to support, and it stays refused: `07.50` is
    // not a readout this HUD has, and the one that looks like it wants one —
    // the encounter clock — needs two boxes so its colon can be styled.
    const doc = fakeDocument();
    expect(() => new CssNumber(doc, { pad2: true, decimals: 1 })).toThrow(/pad2/);
    expect(() => new CssNumber(doc, { pad2: true, decimals: 2 })).toThrow(/pad2/);
    expect(() => new CssNumber(doc, { pad2: true })).not.toThrow();
    expect(() => new CssNumber(doc, { decimals: 2 })).not.toThrow();
    expect(() => new CssNumber(doc, { pad2: true, decimals: 0 })).not.toThrow();
  });
});
