import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { MAX_EXECUTION_NODES, MAX_RUN_ID_LENGTH, parseExecutionRequest } from '@/utils/executionRequest';

const node = (id: string, kind = 'LLM_CORE', params?: unknown): Record<string, unknown> => ({
  id,
  kind,
  ...(params !== undefined ? { params } : {}),
});

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: 'run_1',
  graph: { nodes: [node('a'), node('b')], edges: [{ source: 'a', target: 'b' }] },
  ...overrides,
});

describe('parseExecutionRequest', () => {
  it('accepts a well-formed request and defaults failRate to 0', () => {
    const result = parseExecutionRequest(body());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.runId).toBe('run_1');
      expect(result.request.failRate).toBe(0);
      expect(result.request.graph.nodes.map((n) => n.id)).toEqual(['a', 'b']);
      expect(result.request.graph.edges).toEqual([{ source: 'a', target: 'b' }]);
    }
  });

  it('clamps failRate to [0, 1] and ignores a non-numeric value', () => {
    const parsed = (failRate: unknown): number => {
      const result = parseExecutionRequest(body({ failRate }));
      return result.ok ? result.request.failRate : Number.NaN;
    };
    expect(parsed(5)).toBe(1);
    expect(parsed(-2)).toBe(0);
    expect(parsed(0.25)).toBe(0.25);
    expect(parsed('0.5')).toBe(0);
  });

  it('keeps only well-typed node parameters', () => {
    const result = parseExecutionRequest(
      body({
        graph: {
          nodes: [
            node('a', 'AGENT', {
              systemPrompt: 'be brief',
              temperature: 'hot',
              labels: ['x', 3, 'y'],
              unknown: true,
            }),
          ],
          edges: [],
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.graph.nodes[0]!.params).toEqual({
        systemPrompt: 'be brief',
        labels: ['x', 'y'],
      });
    }
  });

  it('drops edges that reference an absent node', () => {
    const result = parseExecutionRequest(
      body({ graph: { nodes: [node('a')], edges: [{ source: 'a', target: 'ghost' }] } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.request.graph.edges).toEqual([]);
  });

  it('rejects malformed bodies', () => {
    const codeOf = (raw: unknown): string => {
      const result = parseExecutionRequest(raw);
      return result.ok ? 'ok' : result.code;
    };
    expect(codeOf(null)).toBe('MALFORMED');
    expect(codeOf('text')).toBe('MALFORMED');
    expect(codeOf(body({ runId: '' }))).toBe('MALFORMED');
    expect(codeOf(body({ runId: 'x'.repeat(MAX_RUN_ID_LENGTH + 1) }))).toBe('MALFORMED');
    expect(codeOf(body({ graph: 'nope' }))).toBe('MALFORMED');
    expect(codeOf(body({ graph: { nodes: [node('a', 'NOT_A_KIND')], edges: [] } }))).toBe('MALFORMED');
    expect(codeOf(body({ graph: { nodes: [node('a'), node('a')], edges: [] } }))).toBe('MALFORMED');
    expect(codeOf(body({ graph: { nodes: [node('a')], edges: [{ source: 'a' }] } }))).toBe('MALFORMED');
  });

  it('rejects an empty graph and one over the node limit with distinct codes', () => {
    const empty = parseExecutionRequest(body({ graph: { nodes: [], edges: [] } }));
    expect(empty.ok ? 'ok' : empty.code).toBe('EMPTY_GRAPH');

    const nodes = Array.from({ length: MAX_EXECUTION_NODES + 1 }, (_, i) => node(`n${i}`));
    const oversized = parseExecutionRequest(body({ graph: { nodes, edges: [] } }));
    expect(oversized.ok ? 'ok' : oversized.code).toBe('TOO_MANY_NODES');

    const atLimit = parseExecutionRequest(body({ graph: { nodes: nodes.slice(1), edges: [] } }));
    expect(atLimit.ok).toBe(true);
  });

  it('never throws and yields a well-formed result for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = parseExecutionRequest(value);
        if (result.ok) {
          expect(result.request.failRate).toBeGreaterThanOrEqual(0);
          expect(result.request.failRate).toBeLessThanOrEqual(1);
          expect(result.request.graph.nodes.length).toBeGreaterThan(0);
        } else {
          expect(typeof result.error).toBe('string');
        }
      }),
    );
  });
});
