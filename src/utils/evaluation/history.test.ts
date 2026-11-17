import { describe, expect, it } from 'vitest';

import {
  EVAL_HISTORY_SCHEMA_VERSION,
  type EvalRecord,
  MAX_EVAL_HISTORY,
  appendEvalRecord,
  parseEvalHistory,
  serializeEvalHistory,
  toEvalRecord,
} from '@/utils/evaluation/history';
import type { EvalCaseFrame, EvalSummaryFrame } from '@/utils/evaluation/protocol';

const caseFrame: EvalCaseFrame = {
  caseId: 'refund',
  index: 0,
  runOutcome: 'completed',
  verdict: 'failed',
  durationMs: 340,
  costInUSD: 0.0002,
  totalTokens: 80,
  checks: [
    { nodeId: 'cls', scorer: 'equals', status: 'passed', detail: 'Matched.', actual: 'billing', score: null },
    {
      nodeId: 'out',
      scorer: 'llm_judge',
      status: 'failed',
      detail: 'Score 2/5 (needs 4): Vague.',
      actual: 'A long answer.',
      score: 2,
    },
  ],
};

const summary: EvalSummaryFrame = {
  cases: { passed: 0, total: 1, rate: 0 },
  checks: { passed: 1, total: 2, rate: 0.5 },
  erroredChecks: 0,
  skippedChecks: 0,
  byNode: {},
  byScorer: {},
  judgeScore: { mean: 2, count: 1 },
  duration: { meanMs: 340, p50Ms: 340, p95Ms: 340, maxMs: 340 },
  totalCostInUSD: 0.0002,
  meanCostInUSD: 0.0002,
  totalTokens: 80,
  judgeUsage: { calls: 1, inputTokens: 300, outputTokens: 20, costInUSD: 0.00003 },
};

const record = (id = 'eval_1', overrides: Partial<EvalRecord> = {}): EvalRecord => ({
  ...toEvalRecord({
    started: { evalId: id, datasetName: 'Smoke', caseCount: 3, mode: 'real', model: 'gemini-2.0-flash' },
    cases: [caseFrame],
    summary,
    status: 'cancelled',
    finishedAt: 1_700_000_000_000,
    datasetFingerprint: 'd'.repeat(16),
    pipelineFingerprint: 'p'.repeat(16),
  }),
  ...overrides,
});

const roundTrip = (records: readonly EvalRecord[]): EvalRecord[] =>
  parseEvalHistory(JSON.parse(serializeEvalHistory(records)));

describe('toEvalRecord', () => {
  it('keeps verdicts, statuses, grades, and metrics but not outputs or details', () => {
    const result = record();
    expect(result).toMatchObject({ id: 'eval_1', status: 'cancelled', caseCount: 3, model: 'gemini-2.0-flash' });
    expect(result.cases).toEqual([
      {
        caseId: 'refund',
        verdict: 'failed',
        durationMs: 340,
        costInUSD: 0.0002,
        checks: [
          { nodeId: 'cls', scorer: 'equals', status: 'passed', score: null },
          { nodeId: 'out', scorer: 'llm_judge', status: 'failed', score: 2 },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('A long answer.');
    expect(result.metrics).toEqual({
      casesPassed: 0,
      casesTotal: 1,
      checksPassed: 1,
      checksTotal: 2,
      erroredChecks: 0,
      skippedChecks: 0,
      judgeMean: 2,
      judgeCount: 1,
      p50Ms: 340,
      p95Ms: 340,
      totalCostInUSD: 0.0002,
      judgeCostInUSD: 0.00003,
      totalTokens: 80,
    });
  });

  it('records unmeasured metrics as null', () => {
    const empty = toEvalRecord({
      started: { evalId: 'e', datasetName: 'x', caseCount: 1, mode: 'simulated', model: null },
      cases: [],
      summary: { ...summary, judgeScore: null, duration: null },
      status: 'cancelled',
      finishedAt: 1,
      datasetFingerprint: 'd',
      pipelineFingerprint: 'p',
    });
    expect(empty.metrics).toMatchObject({ judgeMean: null, judgeCount: 0, p50Ms: null, p95Ms: null });
  });
});

describe('appendEvalRecord', () => {
  it('puts the newest first and keeps at most the cap', () => {
    let history: EvalRecord[] = [];
    for (let i = 0; i < MAX_EVAL_HISTORY + 3; i += 1) history = appendEvalRecord(history, record(`e${i}`));
    expect(history).toHaveLength(MAX_EVAL_HISTORY);
    expect(history[0]!.id).toBe(`e${MAX_EVAL_HISTORY + 2}`);
    expect(history.at(-1)!.id).toBe('e3');
  });

  it('replaces a record with the same id instead of duplicating it', () => {
    const history = appendEvalRecord([record('a'), record('b')], record('b', { status: 'completed' }));
    expect(history.map((entry) => [entry.id, entry.status])).toEqual([
      ['b', 'completed'],
      ['a', 'cancelled'],
    ]);
  });
});

describe('parseEvalHistory', () => {
  it('round-trips serialized records', () => {
    const history = [record('a'), record('b', { mode: 'simulated', model: null })];
    expect(roundTrip(history)).toEqual(history);
  });

  it('returns an empty history for missing, foreign, or other-version data', () => {
    expect(parseEvalHistory(null)).toEqual([]);
    expect(parseEvalHistory({ version: EVAL_HISTORY_SCHEMA_VERSION + 1, records: [record()] })).toEqual([]);
    expect(parseEvalHistory({ version: EVAL_HISTORY_SCHEMA_VERSION, records: 'x' })).toEqual([]);
  });

  it('drops invalid records individually and keeps the rest', () => {
    const valid = record('ok');
    const invalid: unknown[] = [
      { ...record('bad-status'), status: 'running' },
      { ...record('bad-mode'), mode: 'live' },
      { ...record('bad-metrics'), metrics: { ...valid.metrics, casesPassed: 5 } },
      { ...record('bad-cost'), metrics: { ...valid.metrics, totalCostInUSD: -1 } },
      { ...record('bad-check'), cases: [{ ...valid.cases[0], checks: [{ nodeId: 'n' }] }] },
      { ...record('bad-verdict'), cases: [{ ...valid.cases[0], verdict: 'maybe' }] },
      'not a record',
    ];
    const history = parseEvalHistory({ version: EVAL_HISTORY_SCHEMA_VERSION, records: [...invalid, valid] });
    expect(history.map((entry) => entry.id)).toEqual(['ok']);
  });

  it('re-applies the cap and drops duplicate ids from edited storage', () => {
    const records = Array.from({ length: MAX_EVAL_HISTORY + 5 }, (_, i) => record(`e${i}`));
    expect(parseEvalHistory({ version: EVAL_HISTORY_SCHEMA_VERSION, records })).toHaveLength(MAX_EVAL_HISTORY);
    const duplicated = parseEvalHistory({
      version: EVAL_HISTORY_SCHEMA_VERSION,
      records: [record('a'), record('a')],
    });
    expect(duplicated).toHaveLength(1);
  });
});
