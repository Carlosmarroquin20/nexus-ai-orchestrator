import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { EvalCheck } from '@/utils/evaluation/dataset';
import type { CheckResult, CheckStatus } from '@/utils/evaluation/scorers';
import { type CaseScore, isCasePassed, summarizeEvaluation } from '@/utils/evaluation/summary';

const result = (status: CheckStatus, nodeId = 'n', scorer: EvalCheck['scorer'] = 'equals'): CheckResult => ({
  check:
    scorer === 'regex'
      ? { scorer, nodeId, pattern: 'x', flags: '' }
      : scorer === 'oneOf'
        ? { scorer, nodeId, expected: ['x'] }
        : { scorer, nodeId, expected: 'x' },
  status,
  actual: status === 'error' ? null : 'x',
  detail: '',
});

const score = (
  caseId: string,
  checks: CheckResult[],
  durationMs = 100,
  costInUSD = 0.001,
  totalTokens = 50,
): CaseScore => ({ caseId, checks, durationMs, costInUSD, totalTokens });

describe('summarizeEvaluation', () => {
  it('counts a case as passed only when all of its checks pass', () => {
    const scores = [
      score('a', [result('passed'), result('passed')]),
      score('b', [result('passed'), result('failed')]),
      score('c', [result('error')]),
    ];
    expect(scores.map(isCasePassed)).toEqual([true, false, false]);

    const summary = summarizeEvaluation(scores);
    expect(summary.cases).toEqual({ passed: 1, total: 3, rate: 1 / 3 });
    expect(summary.checks).toEqual({ passed: 3, total: 5, rate: 3 / 5 });
    expect(summary.erroredChecks).toBe(1);
  });

  it('breaks the check rate down by node and by scorer', () => {
    const summary = summarizeEvaluation([
      score('a', [result('passed', 'classifier'), result('failed', 'answer', 'contains')]),
      score('b', [result('failed', 'classifier'), result('passed', 'answer', 'contains')]),
      score('c', [result('passed', 'classifier', 'oneOf')]),
    ]);
    expect(summary.byNode).toEqual({
      classifier: { passed: 2, total: 3, rate: 2 / 3 },
      answer: { passed: 1, total: 2, rate: 0.5 },
    });
    expect(summary.byScorer).toEqual({
      equals: { passed: 1, total: 2, rate: 0.5 },
      contains: { passed: 1, total: 2, rate: 0.5 },
      oneOf: { passed: 1, total: 1, rate: 1 },
    });
  });

  it('reports duration percentiles, cost, and tokens', () => {
    const durations = [500, 100, 300, 200, 400, 1_000, 900, 800, 700, 600];
    const summary = summarizeEvaluation(
      durations.map((durationMs, index) => score(`c${index}`, [result('passed')], durationMs, 0.002, 10)),
    );
    expect(summary.duration).toEqual({ meanMs: 550, p50Ms: 500, p95Ms: 1_000, maxMs: 1_000 });
    expect(summary.totalCostInUSD).toBeCloseTo(0.02, 10);
    expect(summary.meanCostInUSD).toBeCloseTo(0.002, 10);
    expect(summary.totalTokens).toBe(100);
  });

  it('reports nothing measured as null rather than as a result', () => {
    const summary = summarizeEvaluation([]);
    expect(summary.cases).toEqual({ passed: 0, total: 0, rate: null });
    expect(summary.checks.rate).toBeNull();
    expect(summary.duration).toBeNull();
    expect(summary.meanCostInUSD).toBeNull();
    expect(summary.byNode).toEqual({});
  });

  it('keeps every rate within [0, 1] and consistent with its counts', () => {
    const statusArb = fc.constantFrom<CheckStatus>('passed', 'failed', 'error');
    const scoresArb = fc.array(
      fc.record({
        statuses: fc.array(statusArb, { minLength: 1, maxLength: 5 }),
        durationMs: fc.nat(10_000),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(scoresArb, (raw) => {
        const scores = raw.map(({ statuses, durationMs }, index) =>
          score(`c${index}`, statuses.map((status) => result(status)), durationMs),
        );
        const summary = summarizeEvaluation(scores);
        const allStatuses = raw.flatMap((entry) => entry.statuses);

        for (const rate of [summary.cases, summary.checks, ...Object.values(summary.byNode)]) {
          expect(rate.passed).toBeLessThanOrEqual(rate.total);
          if (rate.total === 0) expect(rate.rate).toBeNull();
          else expect(rate.rate).toBeCloseTo(rate.passed / rate.total, 12);
        }
        expect(summary.checks.total).toBe(allStatuses.length);
        expect(summary.erroredChecks).toBe(allStatuses.filter((status) => status === 'error').length);
        expect(summary.cases.passed).toBe(
          raw.filter((entry) => entry.statuses.every((status) => status === 'passed')).length,
        );
        if (summary.duration !== null) {
          expect(summary.duration.p50Ms).toBeLessThanOrEqual(summary.duration.p95Ms);
          expect(summary.duration.p95Ms).toBeLessThanOrEqual(summary.duration.maxMs);
        }
      }),
    );
  });
});
