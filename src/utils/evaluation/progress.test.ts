import { describe, expect, it } from 'vitest';

import {
  CONNECTING_PROGRESS,
  type EvalProgress,
  IDLE_PROGRESS,
  applyEvalEvent,
  cancelProgress,
  failProgress,
} from '@/utils/evaluation/progress';
import type { EvalCaseFrame, EvalStartedFrame, EvalSummaryFrame } from '@/utils/evaluation/protocol';
import type { SseEvent } from '@/utils/sseParser';

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

const event = (name: string, data: unknown): SseEvent => ({ event: name, data: JSON.stringify(data) });
const fold = (events: readonly SseEvent[], from: EvalProgress = CONNECTING_PROGRESS): EvalProgress =>
  events.reduce(applyEvalEvent, from);

describe('applyEvalEvent', () => {
  it('follows a full evaluation from start to done', () => {
    const progress = fold([
      event('started', started),
      event('case_started', { caseId: 'c0', index: 0 }),
    ]);
    expect(progress.phase).toBe('running');
    expect(progress.started).toEqual(started);
    expect(progress.currentCase).toEqual({ caseId: 'c0', index: 0 });

    const finished = fold(
      [
        event('case', caseFrame(0)),
        event('case_started', { caseId: 'c1', index: 1 }),
        event('case', caseFrame(1, 'failed')),
        event('summary', summary),
        event('done', { status: 'completed' }),
      ],
      progress,
    );
    expect(finished.phase).toBe('completed');
    expect(finished.currentCase).toBeNull();
    expect(finished.cases.map((entry) => entry.verdict)).toEqual(['passed', 'failed']);
    expect(finished.summary).toEqual(summary);
  });

  it('keeps cases in dataset order and replaces a repeated case', () => {
    const progress = fold([
      event('started', started),
      event('case', caseFrame(1)),
      event('case', caseFrame(0)),
      event('case', caseFrame(1, 'failed')),
    ]);
    expect(progress.cases.map((entry) => [entry.index, entry.verdict])).toEqual([
      [0, 'passed'],
      [1, 'failed'],
    ]);
  });

  it('ignores malformed and unknown events', () => {
    const progress = fold([event('started', started)]);
    expect(applyEvalEvent(progress, { event: 'case', data: '{not json' })).toBe(progress);
    expect(applyEvalEvent(progress, event('case', { caseId: 'x' }))).toBe(progress);
    expect(applyEvalEvent(progress, event('heartbeat', {}))).toBe(progress);
  });

  it('ignores events after the evaluation has ended', () => {
    const done = fold([event('started', started), event('done', { status: 'cancelled' })]);
    expect(done.phase).toBe('cancelled');
    expect(applyEvalEvent(done, event('case', caseFrame(0)))).toBe(done);
  });
});

describe('failProgress and cancelProgress', () => {
  it('end an evaluation in progress and keep its scored cases', () => {
    const running = fold([event('started', started), event('case', caseFrame(0))]);

    const failed = failProgress(running, 'The stream closed.');
    expect(failed).toMatchObject({ phase: 'failed', error: 'The stream closed.' });
    expect(failed.cases).toHaveLength(1);

    expect(cancelProgress(running)).toMatchObject({ phase: 'cancelled', currentCase: null });
  });

  it('leave finished and idle evaluations untouched', () => {
    const done = fold([event('started', started), event('done', { status: 'completed' })]);
    expect(failProgress(done, 'late')).toBe(done);
    expect(cancelProgress(done)).toBe(done);
    expect(cancelProgress(IDLE_PROGRESS)).toBe(IDLE_PROGRESS);
  });
});
