import { describe, it } from 'vitest';
import { makeBrain, makeTarget, recordingBus } from '@/entities/monster/__tests__/fixtures';
import type { IMonsterWorld } from '@/entities/monster';

describe('probe', () => {
  it('finds the watchdog state', () => {
    const { bus } = recordingBus();
    const brain = makeBrain('mob.wolf.pest', bus, { x: 0, y: 0, z: 0 }, 'probe#1');
    const player = makeTarget('player', 0, 20);
    const view: IMonsterWorld = { time: 0, targets: [player] };
    let trips = 0;
    for (let t = 0; t < 300; t += 1 / 30) {
      player.position.z = 20 + Math.sin(t * 0.4) * 90;
      (view as { time: number }).time += 1 / 30;
      const before = brain.state;
      const beforeTrips = brain.fsm.watchdogTrips;
      brain.update(1 / 30, view);
      if (brain.fsm.watchdogTrips > beforeTrips) {
        trips++;
        console.log(`TRIP #${trips} at t=${t.toFixed(2)} from ${before} -> ${brain.state}, targetId=${brain.currentTargetId}, dist=${brain.distanceToTarget}`);
      }
    }
  });
});
