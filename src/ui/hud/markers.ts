/**
 * WORLD-SPACE MARKERS
 *
 * Diegetic pins — a threat diamond over a monster, a ring over an objective,
 * the supermarket — positioned by `CSS2DRenderer` and drawn by the browser.
 *
 * ── WHY DOM AND NOT SPRITES ────────────────────────────────────────────────
 * A marker is mostly TEXT: a name and a distance. Text in the canvas means an
 * SDF atlas, a text shader, and a program — and the renderer's MEDIUM tier has
 * five spare programs, which VFX is already spending. A DOM marker costs zero
 * draw calls, zero programs, stays crisp at any device pixel ratio, and is a
 * real node Playwright can assert on.
 *
 * ── WHAT CSS2DRenderer DOES, PRECISELY ─────────────────────────────────────
 * It projects each `CSS2DObject`'s world position through the camera and writes
 * `transform: translate(-50%,-50%) translate(Xpx,Ypx)` on its element, plus
 * `display:none` for anything behind the camera. Both writes come from three,
 * not from this module: the HUD's own custom-property discipline covers what
 * the HUD writes, and this is documented as the one place a per-frame `display`
 * write happens, by a library, on elements that are `position:absolute` inside
 * an `overflow:hidden` container and therefore cannot reflow anything else.
 *
 * It performs NO layout reads per frame — the viewport size comes from
 * `setSize`, which the resize handler calls. That is the property that matters
 * for the forced-reflow assertion, and it is why the addon is usable here at
 * all.
 *
 * ── DISTANCE CULLING ───────────────────────────────────────────────────────
 * Beyond `labelRange` the label is hidden and only the pip remains, so a city
 * block of civilians does not become a wall of text. Beyond `maxRange` the
 * object is removed from the scene entirely rather than merely hidden, because
 * a hidden CSS2DObject still costs a matrix multiply and a style write every
 * frame, and there can be hundreds.
 */

import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { el } from './dom';
import { formatDistance } from './format';
import type { IHudModel, IWorldMarker, MarkerKind } from './model';
import { TIER_COLOR } from './tokens';

/** Colour per marker kind, when a threat tier is not supplying one. */
const KIND_COLOR: Readonly<Record<MarkerKind, string>> = {
  threat: 'var(--hud-lost)',
  objective: 'var(--hud-accent)',
  civilian: 'var(--hud-saved)',
  ally: 'var(--hud-commit)',
  errand: 'var(--hud-commit)',
};

export interface IMarkerLayerOptions {
  /** Metres beyond which the text label is dropped and only the pip shows. */
  readonly labelRange?: number;
  /** Metres beyond which the marker leaves the scene entirely. */
  readonly maxRange?: number;
}

interface IMarkerNode {
  readonly object: CSS2DObject;
  readonly root: HTMLElement;
  readonly label: HTMLElement;
  readonly distance: HTMLElement;
  lastLabel: string;
  lastDistance: string;
  lastFar: boolean;
  attached: boolean;
}

export class MarkerLayer {
  readonly element: HTMLElement;
  /**
   * A standalone scene, not a child of the game's.
   *
   * Markers carry WORLD positions, so they need no parent transform, and
   * keeping them out of the render scene means the WebGL renderer never walks
   * them: `CSS2DObject` is invisible to it, but it is still an `Object3D` in
   * the traversal, and there can be hundreds.
   */
  readonly scene = new THREE.Scene();

  private readonly doc: Document;
  private readonly renderer: CSS2DRenderer;
  private readonly nodes = new Map<string, IMarkerNode>();
  private readonly labelRange: number;
  private readonly maxRange: number;
  private readonly cameraPosition = new THREE.Vector3();

  constructor(doc: Document, options: IMarkerLayerOptions = {}) {
    this.doc = doc;
    this.labelRange = options.labelRange ?? 140;
    this.maxRange = options.maxRange ?? 400;
    this.scene.name = 'hud.markers';

    this.element = el(doc, 'div', { className: 'hud-layer hud-layer--world' });
    const host = el(doc, 'div', {
      className: 'hud-markers',
      attrs: { 'data-hud': 'markers' },
    });
    this.element.appendChild(host);
    this.renderer = new CSS2DRenderer({ element: host });
    // `CSS2DRenderer` sets `overflow:hidden` on its element and positions
    // children absolutely; the size is only ever read from `setSize`.
    this.renderer.setSize(1, 1);
  }

  /** Call on viewport resize. Never called per frame. */
  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  /**
   * Reconcile the DOM against the model and project.
   *
   * Called once per frame. The reconcile half only touches the DOM when a
   * marker was added, removed, or crossed the label range; the project half is
   * `CSS2DRenderer.render`, which writes transforms.
   */
  update(model: IHudModel, camera: THREE.Camera): void {
    camera.getWorldPosition(this.cameraPosition);

    for (const [id, node] of this.nodes) {
      if (!model.markers.has(id)) {
        this.scene.remove(node.object);
        node.root.remove();
        this.nodes.delete(id);
      }
    }

    for (const marker of model.markers.values()) {
      const node = this.nodes.get(marker.id) ?? this.create(marker);
      node.object.position.set(marker.x, marker.y, marker.z);
      const distance = this.cameraPosition.distanceTo(node.object.position);
      marker.distance = distance;

      const inRange = distance <= this.maxRange;
      if (inRange !== node.attached) {
        node.attached = inRange;
        if (inRange) this.scene.add(node.object);
        else this.scene.remove(node.object);
      }
      if (!inRange) continue;

      const far = distance > this.labelRange;
      if (far !== node.lastFar) {
        node.lastFar = far;
        node.root.dataset.far = far ? 'true' : 'false';
      }
      if (marker.label !== node.lastLabel) {
        node.lastLabel = marker.label;
        node.label.textContent = marker.label;
      }
      // Distance text is quantised to 5 m so a walking player does not rewrite
      // every marker's text node on every frame.
      const text = formatDistance(Math.round(distance / 5) * 5);
      if (text !== node.lastDistance) {
        node.lastDistance = text;
        node.distance.textContent = text;
      }
    }

    this.renderer.render(this.scene, camera);
  }

  private create(marker: IWorldMarker): IMarkerNode {
    const label = el(this.doc, 'span', { className: 'hud-marker__label', text: marker.label });
    const distance = el(this.doc, 'span', { className: 'hud-marker__dist', text: '' });
    const root = el(this.doc, 'div', {
      className: 'hud-marker',
      dataset: { kind: marker.kind, marker: marker.id, far: 'false' },
      vars: {
        '--hud-marker-color': marker.tier ? TIER_COLOR[marker.tier] : KIND_COLOR[marker.kind],
      },
      children: [
        el(this.doc, 'span', { className: 'hud-marker__pip' }),
        label,
        distance,
      ],
    });
    const object = new CSS2DObject(root);
    object.name = `marker:${marker.id}`;
    const node: IMarkerNode = {
      object,
      root,
      label,
      distance,
      lastLabel: marker.label,
      lastDistance: '',
      lastFar: false,
      attached: false,
    };
    this.nodes.set(marker.id, node);
    return node;
  }

  dispose(): void {
    for (const node of this.nodes.values()) {
      this.scene.remove(node.object);
      node.root.remove();
    }
    this.nodes.clear();
    this.element.remove();
  }
}
