/**
 * THE PANEL KIT'S DISPATCH TABLE
 *
 * `emitPanel` is a switch over a union with no default, so a kind that loses its
 * case emits nothing and reads as a blank wall rather than as an error. Every
 * kind is therefore driven through the emitter once here.
 */
import { describe, expect, it } from 'vitest';
import { createRng } from '@/util';
import { MeshBuilder } from '../mesh-builder';
import { PANEL_KINDS, emitPanel, panelSupport, type IPanelContext } from '../facade';

function context(builder: MeshBuilder, over: Partial<IPanelContext> = {}): IPanelContext {
  return {
    builder,
    origin: [0, 0, 0],
    right: [1, 0, 0],
    normal: [0, 0, -1],
    width: 2.4,
    height: 3.3,
    uStart: 0,
    facadeUv: 1,
    glassUv: 1 / 2.4,
    roofUv: 1 / 20,
    tint: [1, 1, 1],
    shade: 1,
    glassTint: [0.2, 0.2, 0.2],
    rng: createRng(1234),
    detail: 'full',
    attachments: [],
    isGround: true,
    isTop: false,
    signage: 1,
    ...over,
  };
}

describe('panel kit', () => {
  it('lists every kind once', () => {
    expect(new Set(PANEL_KINDS).size).toBe(PANEL_KINDS.length);
  });

  it('emits geometry for every kind at both detail levels', () => {
    for (const detail of ['full', 'reduced'] as const) {
      for (const kind of PANEL_KINDS) {
        const builder = new MeshBuilder();
        builder.beginChunk();
        emitPanel(kind, context(builder, { detail }));
        const span = builder.endChunk();
        expect(builder.triangleCount, `${kind}/${detail}`).toBeGreaterThan(0);
        expect(span.vertexCount, `${kind}/${detail}`).toBeGreaterThan(0);
      }
    }
  });

  it('gives every kind a structural weight in (0, 1]', () => {
    for (const kind of PANEL_KINDS) {
      expect(panelSupport(kind), kind).toBeGreaterThan(0);
      expect(panelSupport(kind), kind).toBeLessThanOrEqual(1);
    }
  });
});
