import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { EvalCheck } from '@/utils/evaluation/dataset';
import type { CheckResult, CheckStatus } from '@/utils/evaluation/scorers';
import { type CaseScore, caseVerdict, summarizeEvaluation } from '@/utils/evaluation/summary';

const result = (
  status: CheckStatus,
  nodeId = 'n',
  scorer: EvalCheck['scorer'] = 'equals',
  score: number | null = null,
): CheckResult => ({
  check:
    scorer === 'regex'
      ? { scorer, nodeId, pattern: 'x', flags: '' }
      : scorer === 'oneOf'
        ? { scorer, nodeId, expected: ['x'] }
        : scorer === 'llm_judge'
          ? { scorer, nodeId, criteria: 'x', minScore: 4 }
          : { scorer, nodeId, expected: 'x' },
  status,
  actual: status === 'error' ? null : 'x',
  detail: '',
  score,
});

const score = (
  caseId: string,
  checks: CheckResult[],
  durationMs = 100,
  costInUSD = 0.001,
  totalTokens = 50,
): CaseScore => ({ caseId, checks, durationMs, costInUSD, totalTokens });

describe('caseVerdict', () => {
  it('passes a case only when every evaluated check passes', () => {
    expect(caseVerdict(score('a', [result('passed'), result('passed')]))).toBe('passed');
    expect(caseVerdict(score('b', [result('passed'), result('failed')]))).toBe('failed');
    expect(caseVerdict(score('c', [result('error')]))).toBe('failed');
  });

  it('ignores skipped checks, and has no verdict when all were skipped', () => {
    expect(caseVerdict(score('a', [result('passed'), result('skipped')]))).toBe('passed');
    expect(caseVerdict(score('b', [result('skipped'), result('skipped')]))).toBe('skipped');
  });
});

describe('summarizeEvaluation', () => {
  it('counts passed cases and checks, with errors against the rate', () => {
    const summary = summarizeEvaluation([
      score('a', [result('passed'), result('passed')]),
      score('b', [result('passed'), result('failed')]),
      score('c', [result('error')]),
    ]);
    expect(summary.cases).toEqual({ passed: 1, total: 3, rate: 1 / 3 });
    expect(summary.checks).toEqual({ passed: 3, total: 5, rate: 3 / 5 });
    expect(summary.erroredChecks).toBe(1);
    expect(summary.skippedChecks).toBe(0);
  });

  it('leaves skipped checks and all-skipped cases out of every rate', () => {
    const summary = summarizeEvaluation([
      score('a', [result('passed'), result('skipped', 'n', 'contains')]),
      score('b', [result('skipped')]),
    ]);
    expect(summary.cases).toEqual({ passed: 1, total: 1, rate: 1 });
    expect(summary.checks).toEqual({ passed: 1, total: 1, rate: 1 });
    expect(summary.skippedChecks).toBe(2);
    expect(summary.byScorer).toEqual({ equals: { passed: 1, total: 1, rate: 1 } });
  });

  it('averages the grades the judge produced, ignoring checks without one', () => {
    const summary = summarizeEvaluation([
      score('a', [result('passed', 'n', 'equals', 5), result('failed', 'n', 'equals', 2)]),
      score('b', [result('passed', 'n', 'equals', 5), result('error'), result('skipped')]),
    ]);
    expect(summary.judgeScore).toEqual({ mean: 4, count: 3 });
    expect(summarizeEvaluation([score('a', [result('passed')])]).judgeScore).toBeNull();
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
    expect(summary.judgeScore).toBeNull();
    expect(summary.duration).toBeNull();
    expect(summary.meanCostInUSD).toBeNull();
    expect(summary.byNode).toEqual({});
  });

  it('keeps every rate within [0, 1] and consistent with its counts', () => {
    const statusArb = fc.constantFrom<CheckStatus>('passed', 'failed', 'error', 'skipped');
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
        const evaluated = allStatuses.filter((status) => status !== 'skipped');

        for (const rate of [summary.cases, summary.checks, ...Object.values(summary.byNode)]) {
          expect(rate.passed).toBeLessThanOrEqual(rate.total);
          if (rate.total === 0) expect(rate.rate).toBeNull();
          else expect(rate.rate).toBeCloseTo(rate.passed / rate.total, 12);
        }
        expect(summary.checks.total).toBe(evaluated.length);
        expect(summary.skippedChecks).toBe(allStatuses.length - evaluated.length);
        expect(summary.erroredChecks).toBe(evaluated.filter((status) => status === 'error').length);

        const decided = raw.filter((entry) => entry.statuses.some((status) => status !== 'skipped'));
        expect(summary.cases.total).toBe(decided.length);
        expect(summary.cases.passed).toBe(
          decided.filter((entry) =>
            entry.statuses.every((status) => status === 'passed' || status === 'skipped'),
          ).length,
        );
        if (summary.duration !== null) {
          expect(summary.duration.p50Ms).toBeLessThanOrEqual(summary.duration.p95Ms);
          expect(summary.duration.p95Ms).toBeLessThanOrEqual(summary.duration.maxMs);
        }
      }),
    );
  });
});
