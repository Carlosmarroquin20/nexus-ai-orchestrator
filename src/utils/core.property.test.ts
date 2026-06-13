import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { makeEdge, makeNode } from '@/test/factories';
import {
  NODE_KIND,
  type NexusNodeKind,
  type NodeExecutionState,
} from '@/types/graph';
import { createPristineTelemetry } from '@/config/telemetry';
import { detectCycle, isAdmissibleConnection, topologicalOrder } from '@/utils/graphValidation';
import { GRAPH_SCHEMA_VERSION, parseGraph, serializeGraph } from '@/utils/graphSerialization';
import { computeCriticalPathLatencyMs } from '@/utils/runAnalysis';
import { reconcileTelemetry } from '@/utils/telemetry';
import { parseTelemetryEvent } from '@/utils/telemetryEvent';

/**
 * Property-based tests: instead of fixed examples, these assert universal
 * invariants over many generated inputs (and fuzz the wire parser with arbitrary
 * values). They encode the correctness contracts of the graph algorithms and
 * telemetry reducer rather than a handful of cases.
 */

const NODE_KINDS = Object.values(NODE_KIND);
const EXECUTION_STATES: readonly NodeExecutionState[] = [
  'idle',
  'running',
  'completed',
  'failed',
  'skipped',
];

const idsOf = (count: number): string[] => Array.from({ length: count }, (_, i) => `n${i}`);

const upperTrianglePairs = (count: number): Array<[number, number]> => {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) pairs.push([i, j]);
  }
  return pairs;
};

/** Acyclic graph by construction: edges only point from a lower to a higher index. */
const dagArb = fc.integer({ min: 1, max: 8 }).chain((count) => {
  const ids = idsOf(count);
  return fc.subarray(upperTrianglePairs(count)).map((picked) => ({
    nodes: ids.map((id) => ({ id })),
    edges: picked.map(([a, b]) => ({ source: ids[a]!, target: ids[b]! })),
  }));
});

/** Arbitrary directed graph: self-loops and back-edges allowed (cycles possible). */
const graphArb = fc.integer({ min: 1, max: 6 }).chain((count) => {
  const ids = idsOf(count);
  return fc
    .array(fc.tuple(fc.nat(count - 1), fc.nat(count - 1)), { maxLength: count * 2 })
    .map((pairs) => ({
      nodes: ids.map((id) => ({ id })),
      edges: pairs.map(([a, b]) => ({ source: ids[a]!, target: ids[b]! })),
    }));
});

describe('reconcileTelemetry invariants', () => {
  const pristine = createPristineTelemetry();

  it('always recomputes totalTokens and ties error to the failed state', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...EXECUTION_STATES),
        fc.nat(1_000_000),
        fc.nat(1_000_000),
        (state, inputTokens, outputTokens) => {
          const next = reconcileTelemetry(pristine, state, { inputTokens, outputTokens }, 1, null);
          expect(next.totalTokens).toBe(inputTokens + outputTokens);
          expect(next.error !== null).toBe(state === 'failed');
        },
      ),
    );
  });

  it('clamps latency to be non-negative', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), (latencyMs) => {
        const next = reconcileTelemetry(pristine, 'completed', { latencyMs }, 1, null);
        expect(next.latencyMs).toBe(Math.max(0, latencyMs));
      }),
    );
  });
});

describe('graph topology invariants', () => {
  it('topological order respects every edge in a DAG', () => {
    fc.assert(
      fc.property(dagArb, ({ nodes, edges }) => {
        const order = topologicalOrder(nodes, edges);
        expect(order).not.toBeNull();
        const position = new Map(order!.map((id, index) => [id, index]));
        for (const edge of edges) {
          expect(position.get(edge.source)!).toBeLessThan(position.get(edge.target)!);
        }
      }),
    );
  });

  it('detectCycle is exactly the absence of a topological order', () => {
    fc.assert(
      fc.property(graphArb, ({ nodes, edges }) => {
        expect(detectCycle(nodes, edges)).toBe(topologicalOrder(nodes, edges) === null);
      }),
    );
  });

  it('an admissible connection never introduces a cycle', () => {
    fc.assert(
      fc.property(dagArb, fc.nat(7), fc.nat(7), ({ nodes, edges }, sourceIndex, targetIndex) => {
        const ids = nodes.map((node) => node.id);
        const source = ids[sourceIndex % ids.length]!;
        const target = ids[targetIndex % ids.length]!;
        if (isAdmissibleConnection(nodes, edges, source, target)) {
          expect(detectCycle(nodes, [...edges, { source, target }])).toBe(false);
        }
      }),
    );
  });
});

describe('critical-path bounds', () => {
  const dagWithLatencyArb = fc.integer({ min: 1, max: 7 }).chain((count) => {
    const ids = idsOf(count);
    return fc
      .tuple(
        fc.subarray(upperTrianglePairs(count)),
        fc.array(fc.nat(5_000), { minLength: count, maxLength: count }),
      )
      .map(([picked, latencies]) => ({
        nodes: ids.map((id, i) => makeNode({ id, latencyMs: latencies[i]!, state: 'completed' })),
        edges: picked.map(([a, b]) => makeEdge(ids[a]!, ids[b]!)),
        latencies,
      }));
  });

  it('is bounded below by the max node latency and above by their sum', () => {
    fc.assert(
      fc.property(dagWithLatencyArb, ({ nodes, edges, latencies }) => {
        const critical = computeCriticalPathLatencyMs(nodes, edges);
        const sum = latencies.reduce((acc, value) => acc + value, 0);
        expect(critical).toBeGreaterThanOrEqual(Math.max(...latencies));
        expect(critical).toBeLessThanOrEqual(sum);
      }),
    );
  });
});

describe('serialization round-trip', () => {
  const graphArbForSerialize = fc.integer({ min: 1, max: 6 }).chain((count) => {
    const ids = idsOf(count);
    return fc
      .tuple(
        fc.array(fc.constantFrom<NexusNodeKind>(...NODE_KINDS), { minLength: count, maxLength: count }),
        fc.subarray(upperTrianglePairs(count)),
      )
      .map(([kinds, picked]) => ({
        nodes: ids.map((id, i) => makeNode({ id, kind: kinds[i]! })),
        edges: picked.map(([a, b]) => makeEdge(ids[a]!, ids[b]!)),
      }));
  });

  it('preserves node ids/kinds and valid edges', () => {
    fc.assert(
      fc.property(graphArbForSerialize, ({ nodes, edges }) => {
        const result = parseGraph(JSON.parse(serializeGraph(nodes, edges)) as unknown);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.snapshot.nodes.map((node) => node.id)).toEqual(nodes.map((node) => node.id));
          expect(result.snapshot.nodes.map((node) => node.data.kind)).toEqual(
            nodes.map((node) => node.data.kind),
          );
          expect(result.snapshot.edges).toHaveLength(edges.length);
        }
      }),
    );
  });

  it('rejects any payload whose version is not the current schema', () => {
    fc.assert(
      fc.property(
        fc.integer().filter((version) => version !== GRAPH_SCHEMA_VERSION),
        (version) => {
          expect(parseGraph({ version, nodes: [], edges: [] }).ok).toBe(false);
        },
      ),
    );
  });
});

describe('telemetry event parser robustness', () => {
  it('never throws and yields null or a well-formed event for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = parseTelemetryEvent(value);
        expect(result === null || typeof result.runId === 'string').toBe(true);
      }),
    );
  });
});
