import v8 from 'node:v8';
import vm from 'node:vm';
import type { GameEventPayload, GameEventType, IEventBus } from '@/types';
import { DestructionSystem } from '@/gameplay/destruction';
import { collapsingFloors } from '@/world/city';
import { FakeDebrisPool, makeTower } from '@/gameplay/destruction/__tests__/fixtures';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;

function nullBus(): IEventBus {
  return {
    on: () => () => {}, once: () => () => {}, off: () => {},
    emit: <T extends GameEventType>(_t: T, _p: GameEventPayload<T>) => {},
    onAny: () => () => {}, clear: () => {}, listenerCount: () => 0, setFrame: () => {},
  };
}

function build(n: number, debris?: FakeDebrisPool) {
  const system = new DestructionSystem({ bus: nullBus(), debris, collapsingFloors, seed: 'p' });
  const structures = [];
  for (let i = 0; i < n; i++) {
    const { layout, attribute } = makeTower({ floors: 12, footprint: 10 });
    structures.push(system.register({
      id: `t-${String(i).padStart(4,'0')}`, layout, target: { destroyed: attribute },
      position: { x: 12 + i * 14, y: 0, z: 0 },
    }));
  }
  return { system, structures };
}

function report(label: string, before: number, after: number, n: number) {
  const total = Math.max(0, after - before);
  console.log(`${label}: ${n} detaches, ${total} B, ${(total / n).toFixed(2)} B/detach`);
}

// 1. pure detach, no debris, no collapse evaluation
{
  const { system, structures } = build(240);
  for (let i = 0; i < 40; i++) for (let c = 0; c < 48; c++) system.detachChunk(structures[i]!, c, 'blast');
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  let n = 0;
  for (let i = 40; i < 240; i++) for (let c = 0; c < 48; c++) { if (system.detachChunk(structures[i]!, c, 'blast')) n++; }
  gc(); gc();
  report('pure detach          ', before, process.memoryUsage().heapUsed, n);
  system.dispose();
}

// 2. detach + debris
{
  const debris = new FakeDebrisPool(300);
  const { system, structures } = build(240, debris);
  for (let i = 0; i < 40; i++) { for (let c = 0; c < 48; c++) system.detachChunk(structures[i]!, c, 'blast'); debris.retire(debris.count); system.update(1/60); }
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  let n = 0;
  for (let i = 40; i < 240; i++) { for (let c = 0; c < 48; c++) { if (system.detachChunk(structures[i]!, c, 'blast')) n++; } debris.retire(debris.count); system.update(1/60); }
  gc(); gc();
  report('detach + debris      ', before, process.memoryUsage().heapUsed, n);
  system.dispose();
}

// 3. sweep only (no collapse: use minimal cone that takes few chunks) -> measure sweep cost
{
  const { system } = build(240);
  for (let k = 0; k < 50; k++) system.applyShockwave({x:-1e6,y:2,z:0},{x:1,y:0,z:0},10,0.05,2.5e6,'full');
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const iterations = 5000;
  for (let k = 0; k < iterations; k++) system.applyShockwave({x:-1e6,y:2,z:0},{x:1,y:0,z:0},10,0.05,2.5e6,'full');
  gc(); gc();
  report('empty sweep (per call)', before, process.memoryUsage().heapUsed, iterations);
  system.dispose();
}

// 4. full loop with collapse
{
  const debris = new FakeDebrisPool(300);
  const { system } = build(240, debris);
  for (let step = 0; step < 40; step++) {
    system.applyShockwave({ x: 12 + step * 14 - 40, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 140, 0.35, 2.5e6, 'full');
    for (let f = 0; f < 4; f++) { system.update(1/60); debris.retire(debris.count); }
  }
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  const start = system.diagnostics.chunksDestroyed;
  const pendBefore = system.diagnostics.pendingCollapseChunks;
  for (let step = 40; step < 240; step++) {
    system.applyShockwave({ x: 12 + step * 14 - 40, y: 2, z: 0 }, { x: 1, y: 0, z: 0 }, 140, 0.35, 2.5e6, 'full');
    for (let f = 0; f < 4; f++) { system.update(1/60); debris.retire(debris.count); }
  }
  gc(); gc();
  const n = system.diagnostics.chunksDestroyed - start;
  console.log(`pending before=${pendBefore} after=${system.diagnostics.pendingCollapseChunks}`);
  report('full loop            ', before, process.memoryUsage().heapUsed, n);
  system.dispose();
}
