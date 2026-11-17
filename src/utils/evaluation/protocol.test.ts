import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EVAL_DATASET_SCHEMA_VERSION } from '@/utils/evaluation/dataset';
import {
  MAX_EVAL_ID_LENGTH,
  MAX_EVAL_MODEL_CALLS,
  countModelCalls,
  parseEvaluationRequest,
} from '@/utils/evaluation/protocol';

const graph = {
  nodes: [
    { id: 'cls', kind: 'CLASSIFIER', params: { labels: ['billing', 'technical'] } },
    { id: 'tpl', kind: 'PROMPT_TEMPLATE', params: { template: 'A: {{x}}' } },
  ],
  edges: [{ source: 'cls', target: 'tpl' }],
};

const cases = (count: number, nodeId = 'cls') =>
  Array.from({ length: count }, (_, i) => ({
    id: `c${i}`,
    input: `question ${i}`,
    checks: [{ nodeId, scorer: 'equals', expected: 'billing' }],
  }));

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  evalId: 'eval_1',
  graph,
  dataset: { version: EVAL_DATASET_SCHEMA_VERSION, name: 'Sample', cases: cases(2) },
  ...overrides,
});

const rejectionOf = (raw: unknown): { code: string; error: string } | null => {
  const result = parseEvaluationRequest(raw);
  return result.ok ? null : { code: result.code, error: result.error };
};

describe('parseEvaluationRequest', () => {
  it('accepts a dataset that fits the pipeline', () => {
    const result = parseEvaluationRequest(body());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.evalId).toBe('eval_1');
      expect(result.request.graph.nodes.map((node) => node.id)).toEqual(['cls', 'tpl']);
      expect(result.request.dataset.cases).toHaveLength(2);
    }
  });

  it('rejects a missing or oversized evaluation id', () => {
    expect(rejectionOf(null)?.code).toBe('MALFORMED');
    expect(rejectionOf(body({ evalId: '' }))?.code).toBe('MALFORMED');
    expect(rejectionOf(body({ evalId: 'x'.repeat(MAX_EVAL_ID_LENGTH + 1) }))?.code).toBe('MALFORMED');
  });

  it('applies the shared graph rules', () => {
    expect(rejectionOf(body({ graph: 'nope' }))?.code).toBe('MALFORMED');
    expect(rejectionOf(body({ graph: { nodes: [], edges: [] } }))?.code).toBe('EMPTY_GRAPH');
  });

  it('reports an invalid dataset with the parser message', () => {
    const rejection = rejectionOf(body({ dataset: { version: 9, name: 'x', cases: [] } }));
    expect(rejection?.code).toBe('INVALID_DATASET');
    expect(rejection?.error).toMatch(/^Invalid dataset: Unsupported dataset version/);
  });

  it('names the nodes a dataset checks but the pipeline lacks', () => {
    const rejection = rejectionOf(
      body({ dataset: { version: EVAL_DATASET_SCHEMA_VERSION, name: 'x', cases: cases(1, 'ghost') } }),
    );
    expect(rejection?.code).toBe('DATASET_MISMATCH');
    expect(rejection?.error).toContain('ghost');
  });

  it('refuses an evaluation over the model-call budget', () => {
    const wide = {
      nodes: Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, kind: 'AGENT' })),
      edges: [],
    };
    const dataset = { version: EVAL_DATASET_SCHEMA_VERSION, name: 'x', cases: cases(100, 'n0') };
    const rejection = rejectionOf(body({ graph: wide, dataset }));
    expect(rejection?.code).toBe('OVER_BUDGET');
    expect(rejection?.error).toContain(`limit is ${MAX_EVAL_MODEL_CALLS}`);
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(typeof parseEvaluationRequest(value).ok).toBe('boolean');
      }),
    );
  });
});

describe('countModelCalls', () => {
  it('counts only LLM-backed nodes, once per case', () => {
    const result = parseEvaluationRequest(body());
    expect(result.ok).toBe(true);
    if (result.ok) expect(countModelCalls(result.request.graph, result.request.dataset)).toBe(2);
  });

  it('adds one call per llm_judge check', () => {
    const judged = cases(3).map((evalCase, index) => ({
      ...evalCase,
      checks: [
        ...evalCase.checks,
        ...(index < 2 ? [{ nodeId: 'tpl', scorer: 'llm_judge', criteria: 'Is helpful.' }] : []),
      ],
    }));
    const result = parseEvaluationRequest(
      body({ dataset: { version: EVAL_DATASET_SCHEMA_VERSION, name: 'x', cases: judged } }),
    );
    expect(result.ok).toBe(true);
    // 1 classifier x 3 cases + 2 judge checks.
    if (result.ok) expect(countModelCalls(result.request.graph, result.request.dataset)).toBe(5);
  });

  it('counts judge calls toward the budget', () => {
    const judgedCases = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      input: 'q',
      checks: Array.from({ length: 3 }, () => ({ nodeId: 'tpl', scorer: 'llm_judge', criteria: 'x y' })),
    }));
    const dataset = { version: EVAL_DATASET_SCHEMA_VERSION, name: 'x', cases: judgedCases };
    // 100 classifier calls + 300 judge calls exceed the budget.
    expect(rejectionOf(body({ dataset }))?.code).toBe('OVER_BUDGET');
  });
});
