import { describe, expect, it } from 'vitest';

import { toCaseFrame } from '@/server/evaluation/caseFrame';
import type { EvaluatedCase } from '@/server/evaluation/runEvaluation';

const evaluated = (actual: string | null): EvaluatedCase => ({
  index: 2,
  runOutcome: 'completed',
  score: {
    caseId: 'refund',
    durationMs: 840,
    costInUSD: 0.0012,
    totalTokens: 310,
    checks: [
      {
        check: { nodeId: 'classifier', scorer: 'equals', expected: 'billing' },
        status: 'passed',
        actual,
        detail: 'Matched "billing".',
        score: null,
      },
      {
        check: { nodeId: 'agent', scorer: 'llm_judge', criteria: 'Polite.', minScore: 4 },
        status: 'failed',
        actual,
        detail: 'Graded 2/5: curt.',
        score: 2,
      },
    ],
  },
});

describe('toCaseFrame', () => {
  it('projects a scored case with its verdict and every check', () => {
    expect(toCaseFrame(evaluated('billing'))).toEqual({
      caseId: 'refund',
      index: 2,
      runOutcome: 'completed',
      verdict: 'failed',
      durationMs: 840,
      costInUSD: 0.0012,
      totalTokens: 310,
      checks: [
        {
          nodeId: 'classifier',
          scorer: 'equals',
          status: 'passed',
          detail: 'Matched "billing".',
          actual: 'billing',
          score: null,
        },
        {
          nodeId: 'agent',
          scorer: 'llm_judge',
          status: 'failed',
          detail: 'Graded 2/5: curt.',
          actual: 'billing',
          score: 2,
        },
      ],
    });
  });

  it('cuts outputs at the given length and keeps them whole otherwise', () => {
    const long = 'x'.repeat(30);
    expect(toCaseFrame(evaluated(long), { maxOutputLength: 10 }).checks[0]?.actual).toBe(
      `${'x'.repeat(10)}…`,
    );
    expect(toCaseFrame(evaluated(long), { maxOutputLength: 30 }).checks[0]?.actual).toBe(long);
    expect(toCaseFrame(evaluated(long)).checks[0]?.actual).toBe(long);
    expect(toCaseFrame(evaluated(null), { maxOutputLength: 10 }).checks[0]?.actual).toBeNull();
  });
});
