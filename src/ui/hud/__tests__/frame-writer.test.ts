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
 *   3. `setInteger` ROUNDS. `counter-reset: n var(--n)` is invalid — silently,
 *      permanently — for a non-integer, and the readout prints 0 forever while
 *      the variable reads correct in devtools.
 */

import { describe, expect, it } from 'vitest';
import { FrameWriter, roundTo } from '../frame-writer';
import { CssNumber } from '../css-number';

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

  it('rounds integers destined for counter-reset', () => {
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

  it('rounds the scaled value once so 9.97 becomes 10.0 and never 9.10', () => {
    const doc = fakeDocument();
    const number = new CssNumber(doc, { decimals: 1 });
    const writer = new FrameWriter();
    const seen: [string, string][] = [];
    const original = (number.element as unknown as { style: { setProperty: unknown } }).style;
    (number.element as unknown as { style: { setProperty: (n: string, v: string) => void } }).style =
      {
        setProperty(name: string, value: string): void {
          seen.push([name, value]);
        },
      };
    number.write(writer, 9.97);
    (number.element as unknown as { style: unknown }).style = original;
    expect(seen).toEqual([
      ['--n-i', '10'],
      ['--n-f', '0'],
    ]);
  });

  it('caps decimals at what CSS can zero-pad', () => {
    const doc = fakeDocument();
    const number = new CssNumber(doc, { decimals: 5 });
    // Class list carries the decimal treatment; anything above 2 would print a
    // fraction with the wrong number of digits.
    expect(number.element.className).toContain('hud-num--dec2');
    expect(number.element.className).not.toContain('hud-num--dec5');
  });

  it('escapes a prefix that would break out of a CSS string', () => {
    const doc = fakeDocument();
    const number = new CssNumber(doc, { prefix: "it's" });
    const attrs = (number.element as unknown as { __attrs: Map<string, string> }).__attrs;
    expect(attrs.get('--n-prefix')).toBe("'it\\'s'");
  });
});
