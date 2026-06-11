import { describe, expect, it } from 'vitest';

import { makeEdge, makeNode } from '@/test/factories';
import { computeCriticalPathLatencyMs, computeRunMetrics } from '@/utils/runAnalysis';

describe('computeCriticalPathLatencyMs', () => {
  it('equals the single node latency', () => {
    expect(computeCriticalPathLatencyMs([makeNode({ id: 'a', latencyMs: 120 })], [])).toBe(120);
  });

  it('sums along a linear chain', () => {
    const nodes = [
      makeNode({ id: 'a', latencyMs: 100 }),
      makeNode({ id: 'b', latencyMs: 50 }),
      makeNode({ id: 'c', latencyMs: 25 }),
    ];
    expect(computeCriticalPathLatencyMs(nodes, [makeEdge('a', 'b'), makeEdge('b', 'c')])).toBe(175);
  });

  it('takes the longest of parallel branches, not their sum', () => {
    // a -> b (100), a -> c (300): critical path = a(10) + max(b, c) = 310.
    const nodes = [
      makeNode({ id: 'a', latencyMs: 10 }),
      makeNode({ id: 'b', latencyMs: 100 }),
      makeNode({ id: 'c', latencyMs: 300 }),
    ];
    expect(computeCriticalPathLatencyMs(nodes, [makeEdge('a', 'b'), makeEdge('a', 'c')])).toBe(310);
  });

  it('treats null latency as zero', () => {
    expect(computeCriticalPathLatencyMs([makeNode({ id: 'a', latencyMs: null })], [])).toBe(0);
  });

  it('falls back to the cumulative sum on a cyclic graph', () => {
    const nodes = [makeNode({ id: 'a', latencyMs: 100 }), makeNode({ id: 'b', latencyMs: 50 })];
    expect(computeCriticalPathLatencyMs(nodes, [makeEdge('a', 'b'), makeEdge('b', 'a')])).toBe(150);
  });
});

describe('computeRunMetrics', () => {
  it('combines sum-based totals with the critical path', () => {
    const nodes = [
      makeNode({ id: 'a', latencyMs: 10, state: 'completed' }),
      makeNode({ id: 'b', latencyMs: 100, state: 'completed' }),
      makeNode({ id: 'c', latencyMs: 300, state: 'completed' }),
    ];
    const metrics = computeRunMetrics(nodes, [makeEdge('a', 'b'), makeEdge('a', 'c')]);
    expect(metrics.totalLatencyMs).toBe(410);
    expect(metrics.criticalPathLatencyMs).toBe(310);
    expect(metrics.nodeCount).toBe(3);
  });
});
