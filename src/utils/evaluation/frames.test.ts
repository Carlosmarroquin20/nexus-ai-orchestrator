import { describe, expect, it } from 'vitest';

import { parseCaseFrame, parseStartedFrame, parseSummaryFrame } from '@/utils/evaluation/frames';
import type { EvalCaseFrame, EvalStartedFrame, EvalSummaryFrame } from '@/utils/evaluation/protocol';

const started: EvalStartedFrame = {
  evalId: 'eval_1',
  datasetName: 'Smoke',
  caseCount: 2,
  mode: 'simulated',
  model: null,
};

const caseFrame = (index: number, verdict: EvalCaseFrame['verdict'] = 'passed'): EvalCaseFrame => ({
  caseId: `c${index}`,
  index,
  runOutcome: 'completed',
  verdict,
  durationMs: 120,
  costInUSD: 0.0001,
  totalTokens: 42,
  checks: [
    { nodeId: 'cls', scorer: 'equals', status: 'passed', detail: 'Matched.', actual: 'billing', score: null },
    { nodeId: 'out', scorer: 'llm_judge', status: 'skipped', detail: 'Not evaluated.', actual: 'x', score: null },
  ],
});

const summary: EvalSummaryFrame = {
  cases: { passed: 1, total: 2, rate: 0.5 },
  checks: { passed: 3, total: 4, rate: 0.75 },
  erroredChecks: 0,
  skippedChecks: 2,
  byNode: { cls: { passed: 2, total: 2, rate: 1 } },
  byScorer: { equals: { passed: 3, total: 4, rate: 0.75 } },
  judgeScore: { mean: 4.5, count: 2 },
  duration: { meanMs: 120, p50Ms: 120, p95Ms: 120, maxMs: 120 },
  totalCostInUSD: 0.0002,
  meanCostInUSD: 0.0001,
  totalTokens: 84,
  judgeUsage: { calls: 2, inputTokens: 20, outputTokens: 4, costInUSD: 0.00001 },
};

describe('frame parsers', () => {
  it('round-trip every frame the server sends', () => {
    expect(parseStartedFrame(JSON.parse(JSON.stringify(started)))).toEqual(started);
    expect(parseCaseFrame(JSON.parse(JSON.stringify(caseFrame(0))))).toEqual(caseFrame(0));
    expect(parseSummaryFrame(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
  });

  it('accept the empty summary of an evaluation that scored nothing', () => {
    const empty: EvalSummaryFrame = {
      ...summary,
      cases: { passed: 0, total: 0, rate: null },
      byNode: {},
      byScorer: {},
      judgeScore: null,
      duration: null,
      meanCostInUSD: null,
    };
    expect(parseSummaryFrame(empty)).toEqual(empty);
  });

  it('read a missing model as unknown rather than rejecting the frame', () => {
    const { model: _model, ...legacy } = started;
    expect(parseStartedFrame(legacy)?.model).toBeNull();
  });

  it('reject frames with missing, mistyped, or out-of-range fields', () => {
    expect(parseStartedFrame({ ...started, mode: 'live' })).toBeNull();
    expect(parseStartedFrame({ ...started, caseCount: -1 })).toBeNull();
    expect(parseCaseFrame({ ...caseFrame(0), verdict: 'maybe' })).toBeNull();
    expect(parseCaseFrame({ ...caseFrame(0), durationMs: Number.NaN })).toBeNull();
    // One malformed check invalidates the whole case.
    expect(
      parseCaseFrame({ ...caseFrame(0), checks: [{ ...caseFrame(0).checks[0], status: 'unknown' }] }),
    ).toBeNull();
    expect(parseSummaryFrame({ ...summary, cases: { passed: 3, total: 2, rate: 1.5 } })).toBeNull();
    expect(parseSummaryFrame({ ...summary, judgeUsage: undefined })).toBeNull();
    expect(parseSummaryFrame({ ...summary, duration: { meanMs: 1 } })).toBeNull();
    expect(parseSummaryFrame('summary')).toBeNull();
  });

  it('drop scorer kinds the client does not know', () => {
    const parsed = parseSummaryFrame({
      ...summary,
      byScorer: { ...summary.byScorer, semantic: { passed: 1, total: 1, rate: 1 } },
    });
    expect(parsed?.byScorer).toEqual(summary.byScorer);
  });
});
