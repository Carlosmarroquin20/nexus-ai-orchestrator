import { describe, expect, it } from 'vitest';

import type { ExecutionDescriptor } from '@/types/execution';
import type { EvalDataset } from '@/utils/evaluation/dataset';
import { datasetFingerprint, pipelineFingerprint } from '@/utils/evaluation/fingerprint';
import type { EvalCaseFrame, EvalSummaryFrame } from '@/utils/evaluation/protocol';
import {
  EVAL_REPORT_SCHEMA_VERSION,
  type EvalReport,
  buildEvalReport,
  escapeInline,
  fencedBlock,
  renderEvalReportMarkdown,
  reportFileStem,
  slugify,
} from '@/utils/evaluation/report';

const graph: ExecutionDescriptor = {
  nodes: [
    { id: 'classifier', kind: 'CLASSIFIER', params: {} },
    { id: 'agent', kind: 'AGENT', params: {} },
  ],
  edges: [{ source: 'classifier', target: 'agent' }],
};

const dataset: EvalDataset = {
  version: 1,
  name: 'Support triage',
  cases: [
    { id: 'refund', input: 'I want my money back', checks: [] },
    { id: 'login', input: 'I cannot sign in', checks: [] },
  ],
};

const summary: EvalSummaryFrame = {
  cases: { passed: 1, total: 2, rate: 0.5 },
  checks: { passed: 2, total: 3, rate: 2 / 3 },
  erroredChecks: 0,
  skippedChecks: 1,
  byNode: { classifier: { passed: 2, total: 2, rate: 1 }, agent: { passed: 0, total: 1, rate: 0 } },
  byScorer: { equals: { passed: 2, total: 3, rate: 2 / 3 } },
  judgeScore: null,
  duration: { meanMs: 900, p50Ms: 800, p95Ms: 1_000, maxMs: 1_000 },
  totalCostInUSD: 0.0021,
  meanCostInUSD: 0.00105,
  totalTokens: 1_234,
  judgeUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costInUSD: 0 },
};

const passedCase: EvalCaseFrame = {
  caseId: 'refund',
  index: 0,
  runOutcome: 'completed',
  verdict: 'passed',
  durationMs: 800,
  costInUSD: 0.001,
  totalTokens: 600,
  checks: [
    {
      nodeId: 'classifier',
      scorer: 'equals',
      status: 'passed',
      detail: 'Matched.',
      actual: 'billing',
      score: null,
    },
    {
      nodeId: 'agent',
      scorer: 'llm_judge',
      status: 'skipped',
      detail: 'No model.',
      actual: 'Hi',
      score: null,
    },
  ],
};

const failedCase: EvalCaseFrame = {
  caseId: 'login',
  index: 1,
  runOutcome: 'completed',
  verdict: 'failed',
  durationMs: 1_000,
  costInUSD: 0.0011,
  totalTokens: 634,
  checks: [
    {
      nodeId: 'classifier',
      scorer: 'equals',
      status: 'passed',
      detail: 'Matched.',
      actual: 'account',
      score: null,
    },
    {
      nodeId: 'agent',
      scorer: 'contains',
      status: 'failed',
      detail: 'Expected "reset link".',
      actual: 'Click [here](https://evil.test) ![x](https://evil.test/p.png)\n```\n<script>',
      score: null,
    },
  ],
};

const report = (overrides: Partial<EvalReport> = {}): EvalReport => ({
  ...buildEvalReport({
    evalId: 'eval_1',
    finishedAt: Date.UTC(2026, 10, 17, 22, 45, 3, 120),
    status: 'completed',
    model: null,
    dataset,
    graph,
    summary,
    cases: [passedCase, failedCase],
  }),
  ...overrides,
});

describe('buildEvalReport', () => {
  it('records what ran, with fingerprints, next to the metrics and cases', () => {
    const built = report();
    expect(built).toMatchObject({
      version: EVAL_REPORT_SCHEMA_VERSION,
      evalId: 'eval_1',
      finishedAt: '2026-11-17T22:45:03.120Z',
      status: 'completed',
      mode: 'simulated',
      model: null,
      dataset: { name: 'Support triage', fingerprint: datasetFingerprint(dataset), caseCount: 2 },
      pipeline: { fingerprint: pipelineFingerprint(graph), nodeCount: 2 },
      summary,
    });
    expect(built.cases).toEqual([passedCase, failedCase]);
  });

  it('reports real mode when a model ran', () => {
    const built = buildEvalReport({
      evalId: 'eval_2',
      finishedAt: 0,
      status: 'cancelled',
      model: 'gemini-2.0-flash',
      dataset,
      graph,
      summary,
      cases: [],
    });
    expect(built.mode).toBe('real');
    expect(built.model).toBe('gemini-2.0-flash');
  });
});

describe('report file names', () => {
  it('slugs dataset names into safe file names', () => {
    expect(slugify('Support triage')).toBe('support-triage');
    expect(slugify('Clasificación (v2)')).toBe('clasificacion-v2');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('***')).toBe('dataset');
    expect(slugify('a'.repeat(100))).toHaveLength(60);
  });

  it('starts with a sortable UTC timestamp without reserved characters', () => {
    expect(reportFileStem(report())).toBe('2026-11-17T22-45-03Z-support-triage');
  });
});

describe('markdown escaping', () => {
  it('keeps untrusted inline text on one line and inert', () => {
    expect(escapeInline('a|b\n*c* [d](e) <img> &')).toBe(
      'a\\|b \\*c\\* \\[d\\](e) &lt;img&gt; &amp;',
    );
  });

  it('fences text with a fence longer than any backtick run inside it', () => {
    expect(fencedBlock('plain')).toBe('```text\nplain\n```');
    expect(fencedBlock('a ```` b')).toBe('`````text\na ```` b\n`````');
  });
});

describe('renderEvalReportMarkdown', () => {
  it('renders the setup, metrics, breakdowns, and cases', () => {
    const markdown = renderEvalReportMarkdown(report());
    expect(markdown).toContain('# Evaluation: Support triage');
    expect(markdown).toContain('- Status: Completed, 2 of 2 cases scored');
    expect(markdown).toContain('- Mode: Simulated');
    expect(markdown).toContain(`- Pipeline fingerprint: \`${pipelineFingerprint(graph)}\` (2 nodes)`);
    expect(markdown).toContain('| Cases passed | 1/2 · 50% |');
    expect(markdown).toContain('| Latency p50 / p95 | 800 ms / 1.00 s |');
    expect(markdown).toContain('| Judge mean | — |');
    expect(markdown).toContain('| agent | 0/1 · 0% |');
    expect(markdown).toContain('| equals | 2/3 · 66.7% |');
    // Skipped checks are left out of a case's count, as in the rates.
    expect(markdown).toContain('| 1 | refund | passed | 1/1 | 800 ms |');
    expect(markdown).toContain('| 2 | login | failed | 1/2 | 1.00 s |');
  });

  it('names the model and judge grades in real mode', () => {
    const markdown = renderEvalReportMarkdown(
      report({
        mode: 'real',
        model: 'gemini-2.0-flash',
        summary: { ...summary, judgeScore: { mean: 4.5, count: 2 } },
      }),
    );
    expect(markdown).toContain('- Mode: Real model (gemini-2.0-flash)');
    expect(markdown).toContain('| Judge mean | 4.50 / 5 (2 grades) |');
  });

  it('lists failing checks with their output fenced so it cannot render as markup', () => {
    const markdown = renderEvalReportMarkdown(report());
    const failures = markdown.slice(markdown.indexOf('## Failures'));
    expect(failures).toContain('### login');
    expect(failures).toContain('- agent · contains: failed. Expected "reset link".');
    expect(failures).toContain(
      '````text\nClick [here](https://evil.test) ![x](https://evil.test/p.png)\n```\n<script>\n````',
    );
    // Passing checks are not repeated among the failures.
    expect(failures).not.toContain('classifier');
    expect(failures).not.toContain('### refund');
  });

  it('says when a cancelled evaluation scored no case and omits empty sections', () => {
    const markdown = renderEvalReportMarkdown(
      report({
        status: 'cancelled',
        cases: [],
        summary: { ...summary, byNode: {}, byScorer: {} },
      }),
    );
    expect(markdown).toContain('- Status: Cancelled, 0 of 2 cases scored');
    expect(markdown).toContain('No case was scored.');
    expect(markdown).not.toContain('## By node');
    expect(markdown).not.toContain('## Failures');
  });

  it('notes a pipeline run that did not complete', () => {
    const markdown = renderEvalReportMarkdown(
      report({ cases: [{ ...failedCase, runOutcome: 'failed' }] }),
    );
    expect(markdown).toContain('The pipeline run failed.');
  });
});
