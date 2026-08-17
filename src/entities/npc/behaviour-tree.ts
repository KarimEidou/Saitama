/**
 * BEHAVIOUR TREES — the allies' brains, and the near civilian's
 *
 * `@/types/ai.ts` specifies a UTILITY brain (`IAIBrain`) and explains why:
 * reactions have to interleave cleanly with streaming and destruction. That
 * is the right call for a monster, whose job is to pick the best of several
 * roughly-equal options every moment.
 *
 * The allies are the opposite problem. Their behaviour is not "score the
 * options" — it is a POLICY, and each one's policy is their characterisation:
 *
 *   GENOS         engage at range, keep engaging, call for Saitama when it
 *                 stops going his way, die still facing forward.
 *   MUMEN RIDER   engage. Get up. Engage. Get up. Engage.
 *   TATSUMAKI     hold the whole fight at arm's length and be annoyed by it.
 *
 * A utility brain expresses "Mumen Rider never retreats" as a retreat action
 * that always scores zero — a rule stated by the absence of a number, which
 * the next person to tune the weights will delete by accident. A behaviour
 * tree expresses it as a tree with no retreat branch in it. The structure IS
 * the statement, and that is worth more here than the flexibility.
 *
 * ── DELIBERATELY SMALL ────────────────────────────────────────────────────
 * No blackboard indirection, no node pooling, no editor serialisation. Nodes
 * are closures over a typed context, ticked top-down each think. Three allies
 * and sixteen civilians tick these; the cost that matters is in the crowd, and
 * the crowd does not use trees at all.
 */

/** What a node reports back to its parent. */
export type BtStatus = 'success' | 'failure' | 'running';

/** A node. `dt` is the seconds since this tree last ticked. */
export interface BtNode<C> {
  readonly name: string;
  tick(context: C, dt: number): BtStatus;
  /** Called when a node that was running is abandoned. */
  reset?(context: C): void;
}

/* -------------------------------------------------------------------------- */
/* Leaves                                                                     */
/* -------------------------------------------------------------------------- */

/** A leaf that runs a function. */
export function action<C>(name: string, fn: (context: C, dt: number) => BtStatus): BtNode<C> {
  return { name, tick: fn };
}

/** A leaf that succeeds when a predicate holds. */
export function condition<C>(name: string, fn: (context: C) => boolean): BtNode<C> {
  return { name, tick: (context) => (fn(context) ? 'success' : 'failure') };
}

/** A leaf that runs a side effect and always succeeds. */
export function effect<C>(name: string, fn: (context: C, dt: number) => void): BtNode<C> {
  return {
    name,
    tick: (context, dt) => {
      fn(context, dt);
      return 'success';
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Composites                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Run children in order until one fails. A "do all of this" node.
 *
 * Memory: a sequence that returned `running` resumes at the child that was
 * running rather than restarting. Restarting is the classic behaviour-tree
 * bug — the first child re-fires its side effect every tick, so a hero
 * re-draws his weapon sixty times a second while walking to the target.
 */
export function sequence<C>(name: string, children: readonly BtNode<C>[]): BtNode<C> {
  let index = 0;
  return {
    name,
    tick(context, dt) {
      while (index < children.length) {
        const status = children[index]!.tick(context, dt);
        if (status === 'running') return 'running';
        if (status === 'failure') {
          index = 0;
          return 'failure';
        }
        index++;
      }
      index = 0;
      return 'success';
    },
    reset(context) {
      if (index < children.length) children[index]!.reset?.(context);
      index = 0;
    },
  };
}

/**
 * Run children in order until one succeeds. A "try these in priority order"
 * node.
 *
 * No memory, unlike `sequence`: a selector exists so a higher-priority branch
 * can PRE-EMPT a lower one, and a selector that remembered where it was could
 * not. Re-evaluating from the top every tick is the whole point.
 */
export function selector<C>(name: string, children: readonly BtNode<C>[]): BtNode<C> {
  let running = -1;
  return {
    name,
    tick(context, dt) {
      for (let i = 0; i < children.length; i++) {
        const status = children[i]!.tick(context, dt);
        if (status === 'failure') continue;
        if (status === 'running') {
          if (running !== i && running >= 0) children[running]!.reset?.(context);
          running = i;
          return 'running';
        }
        if (running >= 0 && running !== i) children[running]!.reset?.(context);
        running = -1;
        return 'success';
      }
      if (running >= 0) children[running]!.reset?.(context);
      running = -1;
      return 'failure';
    },
    reset(context) {
      if (running >= 0) children[running]!.reset?.(context);
      running = -1;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Decorators                                                                 */
/* -------------------------------------------------------------------------- */

/** Invert success and failure. `running` passes through. */
export function invert<C>(child: BtNode<C>): BtNode<C> {
  return {
    name: `not(${child.name})`,
    tick(context, dt) {
      const status = child.tick(context, dt);
      if (status === 'success') return 'failure';
      if (status === 'failure') return 'success';
      return 'running';
    },
    reset: (context) => child.reset?.(context),
  };
}

/** Gate a child behind a predicate. */
export function guard<C>(name: string, test: (context: C) => boolean, child: BtNode<C>): BtNode<C> {
  return {
    name,
    tick(context, dt) {
      if (!test(context)) return 'failure';
      return child.tick(context, dt);
    },
    reset: (context) => child.reset?.(context),
  };
}

/**
 * Refuse to run a child again until `seconds` have passed since it last
 * succeeded. Abilities with cooldowns, and callouts that must not machine-gun.
 */
export function cooldown<C>(name: string, seconds: number, child: BtNode<C>): BtNode<C> {
  let remaining = 0;
  return {
    name,
    tick(context, dt) {
      remaining -= dt;
      if (remaining > 0) return 'failure';
      const status = child.tick(context, dt);
      if (status === 'success') remaining = seconds;
      return status;
    },
    reset: (context) => child.reset?.(context),
  };
}

/** Succeed whatever the child does. Turns an optional step into a no-op. */
export function always<C>(child: BtNode<C>): BtNode<C> {
  return {
    name: `always(${child.name})`,
    tick(context, dt) {
      const status = child.tick(context, dt);
      return status === 'running' ? 'running' : 'success';
    },
    reset: (context) => child.reset?.(context),
  };
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

/** A tree plus the bookkeeping needed to inspect it in a debugger or a test. */
export class BehaviourTree<C> {
  readonly root: BtNode<C>;
  private lastStatus: BtStatus = 'failure';
  private ticks = 0;

  constructor(root: BtNode<C>) {
    this.root = root;
  }

  /** Status of the last tick. */
  get status(): BtStatus {
    return this.lastStatus;
  }

  /** Ticks since construction. */
  get tickCount(): number {
    return this.ticks;
  }

  tick(context: C, dt: number): BtStatus {
    this.ticks++;
    this.lastStatus = this.root.tick(context, dt);
    return this.lastStatus;
  }

  reset(context: C): void {
    this.root.reset?.(context);
    this.lastStatus = 'failure';
  }
}
