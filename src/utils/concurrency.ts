/**
 * Bounded-concurrency iteration. Pure scheduling logic, free of any I/O, so the
 * in-flight bound is unit-testable independently of the execution engine.
 */

/**
 * Runs `task` once per item with at most `limit` tasks in flight, starting items
 * in input order as slots free up. Resolves once every started task has settled.
 *
 * Tasks are expected to handle their own failures. If one rejects anyway, no
 * further items are started, tasks already in flight are left to settle, and the
 * returned promise rejects with the first error.
 *
 * A non-finite `limit` means unbounded; any finite value is floored to at least 1.
 */
export const forEachWithConcurrency = async <T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> => {
  const width = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : items.length;
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next]!;
      next += 1;
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  const workers = Array.from({ length: Math.min(width, items.length) }, () => worker());
  await Promise.all(workers);
};
