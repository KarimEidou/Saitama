/**
 * DOM HELPERS
 *
 * Twenty lines that remove several hundred of `document.createElement` +
 * `className =` + `appendChild`. Nothing clever, no virtual DOM, no template
 * engine — the HUD builds its tree once and then only writes custom properties,
 * so a diffing layer would be pure overhead.
 *
 * Everything takes an explicit `Document`. The HUD must be constructible
 * against a detached document (the harness builds several viewports' worth of
 * HUD in one page) and must never reach for a global.
 */

/** Attributes and children accepted by {@link el}. */
export interface IElementSpec {
  readonly className?: string;
  readonly text?: string;
  readonly html?: never;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly dataset?: Readonly<Record<string, string>>;
  /** Custom properties set once at build time. Never in the 60 Hz path. */
  readonly vars?: Readonly<Record<string, string>>;
  readonly children?: readonly (Node | null | undefined)[];
}

/** Build an element. */
export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  spec: IElementSpec = {}
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (spec.className !== undefined) node.className = spec.className;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.attrs) {
    for (const [key, value] of Object.entries(spec.attrs)) node.setAttribute(key, value);
  }
  if (spec.dataset) {
    for (const [key, value] of Object.entries(spec.dataset)) node.dataset[key] = value;
  }
  if (spec.vars) {
    for (const [key, value] of Object.entries(spec.vars)) node.style.setProperty(key, value);
  }
  if (spec.children) {
    for (const child of spec.children) if (child) node.appendChild(child);
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build an SVG element. Attributes only — SVG has no `className` setter. */
export function svg<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Readonly<Record<string, string>> = {},
  children: readonly (Node | null | undefined)[] = []
): SVGElementTagNameMap[K] {
  const node = doc.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

/**
 * A button that behaves like a button on a phone.
 *
 * `pointerup` rather than `click`: on a touch WebView `click` arrives up to
 * 300 ms late behind the synthetic-mouse dance, and a pause menu that responds
 * a third of a second after the thumb lifts feels broken in a way players
 * describe as "laggy" and never as "the button".
 *
 * `touch-action: none` plus `pointerdown` `preventDefault` stops the tap
 * turning into a scroll or a text selection on the way.
 */
export function button(
  doc: Document,
  label: string,
  onPress: () => void,
  spec: IElementSpec = {}
): HTMLButtonElement {
  const node = el(doc, 'button', {
    ...spec,
    className: `hud-btn ${spec.className ?? ''}`.trim(),
    attrs: { type: 'button', ...spec.attrs },
  });
  if (spec.text === undefined) node.textContent = label;
  node.setAttribute('aria-label', label);
  /**
   * A real tap produces BOTH `pointerup` and a following synthetic `click`, and
   * the handler must run exactly once.
   *
   * The guard is a FLAG CONSUMED BY THE NEXT CLICK, not a time window. A time
   * window looks equivalent and is not: it also swallows the second of two
   * genuinely separate presses made a few milliseconds apart, which is exactly
   * what a scripted test does and is a real thing an impatient thumb does too.
   * The flag has a lazy timeout only so a `pointerup` with no following click —
   * the pointer left the element mid-gesture — cannot leave it armed forever.
   */
  let swallowNextClick = false;
  let disarm: ReturnType<typeof setTimeout> | undefined;
  node.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    node.dataset.pressed = 'true';
  });
  const release = (): void => {
    delete node.dataset.pressed;
  };
  node.addEventListener('pointerup', (event) => {
    event.preventDefault();
    release();
    swallowNextClick = true;
    clearTimeout(disarm);
    disarm = setTimeout(() => {
      swallowNextClick = false;
    }, 400);
    onPress();
  });
  node.addEventListener('pointercancel', release);
  node.addEventListener('pointerleave', release);
  // Keyboard activation (Enter/Space) and `element.click()` from a test arrive
  // here; a real tap's synthetic click arrives here too and is swallowed.
  node.addEventListener('click', () => {
    if (swallowNextClick) {
      swallowNextClick = false;
      clearTimeout(disarm);
      return;
    }
    onPress();
  });
  return node;
}

/** Remove every child without touching layout more than once. */
export function clear(node: Element): void {
  node.replaceChildren();
}
