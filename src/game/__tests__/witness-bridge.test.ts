/**
 * THE WITNESS REGISTER HAS TO COVER THE CROWD IT IS DRAWN FROM
 *
 * `WitnessField` is the single source of truth for rank: `corroboration` gates
 * credit and `collateralReportRate` gates blame, and both are computed from
 * whoever is registered within `WITNESS_RADIUS` of an incident. The crowd
 * simulates `NEAR_CAP + MID_CAP` people out to 150 m — so a register capped
 * well below that does not merely track fewer people, it answers "nobody saw
 * it" for a civilian killed in a full street. The cut is nearest-to-the-PLAYER,
 * which drops precisely the bystanders around an incident somewhere else.
 *
 * A real `CrowdAgents` behind a stub `CrowdSystem`: the SoA's spawn/idOf
 * semantics are what the bridge walks, and nothing else about the crowd is.
 */

import { describe, expect, it } from 'vitest';
import { CrowdAgents, TIER_MID, type CrowdSystem } from '@/entities/npc';
import { ProgressionCoordinator } from '@/gameplay/progression';
import { EventBus } from '@/util';
import { MAX_TRACKED_WITNESSES } from '../config';
import { WitnessBridge } from '../bridges';

const FOCUS = { x: 0, y: 0.9, z: 0 };

function stubCrowd(agents: CrowdAgents, allies: unknown[] = []): CrowdSystem {
  return { agents, allies } as unknown as CrowdSystem;
}

/** Fill a ring of civilians out to the crowd's own simulated radius. */
function populate(agents: CrowdAgents, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const radius = 6 + (i / count) * 140;
    const index = agents.spawn(
      0x51a1 + i,
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      0,
      TIER_MID
    );
    expect(index).toBeGreaterThanOrEqual(0);
    ids.push(String(agents.idOf(index)));
  }
  return ids;
}

describe('WitnessBridge', () => {
  it('registers every simulated civilian, not just the ones nearest the player', () => {
    const agents = new CrowdAgents();
    const ids = populate(agents, 250);
    const progression = new ProgressionCoordinator({ bus: new EventBus() });
    const bridge = new WitnessBridge(stubCrowd(agents), progression);

    bridge.sync(FOCUS);

    expect(ids.length).toBeLessThanOrEqual(MAX_TRACKED_WITNESSES);
    const missing = ids.filter((id) => !progression.witnesses.has(id));
    expect(missing).toEqual([]);
  });

  it('drops a civilian the crowd has despawned', () => {
    const agents = new CrowdAgents();
    const ids = populate(agents, 8);
    const progression = new ProgressionCoordinator({ bus: new EventBus() });
    const bridge = new WitnessBridge(stubCrowd(agents), progression);
    bridge.sync(FOCUS);
    expect(progression.witnesses.size).toBe(8);

    agents.despawn(0);
    bridge.sync(FOCUS);

    expect(progression.witnesses.size).toBe(7);
    expect(progression.witnesses.has(ids[0]!)).toBe(false);
  });
});
