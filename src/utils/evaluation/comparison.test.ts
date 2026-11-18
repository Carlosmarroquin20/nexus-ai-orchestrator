import { describe, expect, it } from 'vitest';

import { compareEvaluations } from '@/utils/evaluation/comparison';
import type { EvalCaseRecord, EvalCheckRecord, EvalRecord } from '@/utils/evaluation/history';
import type { CaseVerdict } from '@/utils/evaluation/summary';

const check = (
  status: EvalCheckRecord['status'],
  score: number | null = null,
  nodeId = 'cls',
): EvalCheckRecord => ({
  nodeId,
  scorer: score === null ? 'equals' : 'llm_judge',
  status,
  score,
});

const caseRecord = (
  caseId: string,
  verdict: CaseVerdict,
  checks: EvalCheckRecord[] = [],
): EvalCaseRecord => ({
  caseId,
  verdict,
  durationMs: 100,
  costInUSD: 0.001,
  checks,
});

const record = (cases: EvalCaseRecord[], overrides: Partial<EvalRecord> = {}): EvalRecord => ({
  id: 'e',
  finishedAt: 1,
  status: 'completed',
  datasetName: 'Smoke',
  datasetFingerprint: 'dataset',
  pipelineFingerprint: 'pipeline',
  mode: 'real',
  model: 'gemini-2.0-flash',
  caseCount: cases.length,
  cases,
  metrics: {
    casesPassed: cases.filter((entry) => entry.verdict === 'passed').length,
    casesTotal: cases.filter((entry) => entry.verdict !== 'skipped').length,
    checksPassed: 0,
    checksTotal: 0,
    erroredChecks: 0,
    skippedChecks: 0,
    judgeMean: null,
    judgeCount: 0,
    p50Ms: 100,
    p95Ms: 200,
    totalCostInUSD: 0.01,
    judgeCostInUSD: 0,
    totalTokens: 10,
  },
  ...overrides,
});

describe('compareEvaluations', () => {
  it('classifies each case by how its verdict moved', () => {
    const baseline = record([
      caseRecord('a', 'passed'),
      caseRecord('b', 'failed'),
      caseRecord('c', 'passed'),
      caseRecord('d', 'passed'),
      caseRecord('e', 'skipped'),
    ]);
    const candidate = record([
      caseRecord('a', 'failed'),
      caseRecord('b', 'passed'),
      caseRecord('c', 'passed'),
      caseRecord('d', 'skipped'),
      caseRecord('e', 'skipped'),
    ]);
    const comparison = compareEvaluations(baseline, candidate);
    expect(comparison.cases.map((entry) => [entry.caseId, entry.change])).toEqual([
      ['a', 'regressed'],
      ['b', 'fixed'],
      ['c', 'unchanged'],
      ['d', 'not_comparable'],
      ['e', 'unchanged'],
    ]);
    expect(comparison.counts).toMatchObject({ regressed: 1, fixed: 1, unchanged: 2, not_comparable: 1 });
  });

  it('lists cases that ran on one side only, candidate order first', () => {
    const comparison = compareEvaluations(
      record([caseRecord('a', 'passed'), caseRecord('gone', 'failed')]),
      record([caseRecord('new', 'passed'), caseRecord('a', 'passed')]),
    );
    const rows = comparison.cases.map((entry) => [entry.caseId, entry.change, entry.baseline, entry.candidate]);
    expect(rows).toEqual([
      ['new', 'only_in_candidate', null, 'passed'],
      ['a', 'unchanged', 'passed', 'passed'],
      ['gone', 'only_in_baseline', 'failed', null],
    ]);
    expect(comparison.counts).toMatchObject({ only_in_baseline: 1, only_in_candidate: 1 });
  });

  it('reports the checks that changed status or grade within aligned cases', () => {
    const comparison = compareEvaluations(
      record([caseRecord('a', 'passed', [check('passed'), check('passed', 5, 'out')])]),
      record([caseRecord('a', 'failed', [check('passed'), check('failed', 3, 'out')])]),
    );
    expect(comparison.cases[0]!.checkChanges).toEqual([
      {
        position: 1,
        nodeId: 'out',
        scorer: 'llm_judge',
        baseline: 'passed',
        candidate: 'failed',
        baselineScore: 5,
        candidateScore: 3,
      },
    ]);
  });

  it('lists changed cases in reading order, including held verdicts whose checks moved', () => {
    const comparison = compareEvaluations(
      record([
        caseRecord('steady', 'failed', [check('failed'), check('failed', null, 'out')]),
        caseRecord('quiet', 'passed', [check('passed')]),
        caseRecord('up', 'failed'),
        caseRecord('down', 'passed'),
      ]),
      record([
        caseRecord('steady', 'failed', [check('failed'), check('passed', null, 'out')]),
        caseRecord('quiet', 'passed', [check('passed')]),
        caseRecord('up', 'passed'),
        caseRecord('down', 'failed'),
      ]),
    );
    expect(comparison.changed.map((entry) => entry.caseId)).toEqual(['down', 'up', 'steady']);
    expect(comparison.checksMovedCount).toBe(1);
  });

  it('does not match checks by position when the case checks differ', () => {
    const comparison = compareEvaluations(
      record([caseRecord('a', 'passed', [check('passed', null, 'cls')])]),
      record([caseRecord('a', 'failed', [check('failed', null, 'other')])]),
    );
    expect(comparison.cases[0]!.change).toBe('regressed');
    expect(comparison.cases[0]!.checkChanges).toEqual([]);
  });

  it('reports metric deltas, and null where a side was not measured', () => {
    const baseline = record([caseRecord('a', 'passed'), caseRecord('b', 'passed')]);
    const candidate = record([caseRecord('a', 'passed'), caseRecord('b', 'failed')], {
      metrics: { ...baseline.metrics, casesPassed: 1, judgeMean: 4, p50Ms: 150, totalCostInUSD: 0.015 },
    });
    const { metrics } = compareEvaluations(baseline, candidate);
    expect(metrics.caseRate).toEqual({ baseline: 1, candidate: 0.5, delta: -0.5 });
    expect(metrics.judgeMean).toEqual({ baseline: null, candidate: 4, delta: null });
    expect(metrics.p50Ms.delta).toBe(50);
    expect(metrics.totalCostInUSD.delta).toBeCloseTo(0.005, 10);
  });

  it('says whether dataset, pipeline, and model match', () => {
    const base = record([]);
    expect(compareEvaluations(base, record([]))).toMatchObject({
      sameDataset: true,
      samePipeline: true,
      sameModel: true,
    });
    expect(
      compareEvaluations(base, record([], { pipelineFingerprint: 'edited', model: 'gemini-2.5-flash' })),
    ).toMatchObject({ sameDataset: true, samePipeline: false, sameModel: false });
    expect(compareEvaluations(base, record([], { mode: 'simulated', model: null })).sameModel).toBe(false);
    expect(compareEvaluations(base, record([], { datasetFingerprint: 'other' })).sameDataset).toBe(false);
  });
});
