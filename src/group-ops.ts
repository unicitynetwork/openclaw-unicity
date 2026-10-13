/**
 * Group joins and creates in flight (the group tools). The SDK lists a group, and the relay streams its backlog,
 * before joinGroup/createGroup resolve and the tool records the group as approved: the channel's unapproved-group
 * check waits for these operations, so it does not take a group the owner is having it join for one a group admin
 * added it to.
 */

type GroupOps = { count: number; waiters: Set<() => void> };

/** Upper bound on waiting for group operations: a hung tool call must not hold the check back forever. */
const GROUP_OPS_MAX_WAIT_MS = 30_000;

/** Shared by every copy of this module (a plugin reload re-imports it while a tool call may still run). */
const OPS = ((globalThis as unknown as Record<symbol, GroupOps | undefined>)[Symbol.for("openclaw-unicity.groupOps")] ??= {
  count: 0,
  waiters: new Set(),
});

export function beginGroupOp(): void {
  OPS.count++;
}

/** Once per beginGroupOp, after the group's approval is recorded or the operation failed. */
export function endGroupOp(): void {
  OPS.count = Math.max(0, OPS.count - 1);
  if (OPS.count > 0) return;
  // Each wake deletes itself, which a Set's iteration allows.
  for (const wake of OPS.waiters) wake();
}

/** Resolves once no group operation is in flight, or after `maxMs` at the latest. */
export function groupOpsIdle(maxMs = GROUP_OPS_MAX_WAIT_MS): Promise<void> {
  if (OPS.count === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = (): void => {
      clearTimeout(timer);
      OPS.waiters.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, maxMs);
    timer.unref?.();
    OPS.waiters.add(wake);
  });
}
