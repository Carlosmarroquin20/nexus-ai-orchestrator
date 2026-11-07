import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { forEachWithConcurrency } from '@/utils/concurrency';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a scripted workload and records the start order and the peak in-flight count. */
const observe = async (
  durations: readonly number[],
  limit: number,
): Promise<{ started: number[]; finished: number[]; peak: number }> => {
  const started: number[] = [];
  const finished: number[] = [];
  let inFlight = 0;
  let peak = 0;
  await forEachWithConcurrency(
    durations.map((duration, index) => ({ duration, index })),
    limit,
    async ({ duration, index }) => {
      started.push(index);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(duration);
      inFlight -= 1;
      finished.push(index);
    },
  );
  return { started, finished, peak };
};

describe('forEachWithConcurrency', () => {
  it('never exceeds the limit and runs every item exactly once, in start order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat(3), { maxLength: 12 }),
        fc.integer({ min: 1, max: 5 }),
        async (durations, limit) => {
          const { started, finished, peak } = await observe(durations, limit);
          const indices = durations.map((_, index) => index);
          expect(started).toEqual(indices);
          expect([...finished].sort((a, b) => a - b)).toEqual(indices);
          expect(peak).toBeLessThanOrEqual(limit);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('saturates the limit when enough work is available', async () => {
    const { peak } = await observe([5, 5, 5, 5, 5, 5], 4);
    expect(peak).toBe(4);
  });

  it('treats a non-finite limit as unbounded and a sub-one limit as one', async () => {
    expect((await observe([2, 2, 2], Number.POSITIVE_INFINITY)).peak).toBe(3);
    expect((await observe([1, 1, 1], 0)).peak).toBe(1);
  });

  it('resolves immediately for an empty list', async () => {
    await expect(forEachWithConcurrency([], 3, async () => undefined)).resolves.toBeUndefined();
  });

  it('stops starting items after a task rejects and rejects with that error', async () => {
    const started: number[] = [];
    const run = forEachWithConcurrency([0, 1, 2, 3, 4], 1, async (item) => {
      started.push(item);
      if (item === 1) throw new Error('boom');
    });
    await expect(run).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });
});
