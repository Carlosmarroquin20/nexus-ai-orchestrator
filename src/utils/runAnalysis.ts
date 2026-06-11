/**
 * Run-level analysis that requires graph structure (vs. the structure-free totals
 * in `@/utils/telemetry`). Computes the critical path and assembles the full
 * `PipelineRunMetrics`. Pure and framework-agnostic.
 */

import type { NexusEdge, NexusNode, PipelineRunMetrics } from '@/types/graph';

import { buildAdjacency, topologicalOrder } from './graphValidation';
import { aggregateRunMetrics } from './telemetry';

/**
 * Critical-path latency: the longest dependency path weighted by per-node
 * latency. This is the minimum wall-clock latency achievable if independent
 * branches run in parallel — the fair pipeline-latency metric, as opposed to the
 * sum of all node latencies.
 *
 * Forward longest-path over the topological order: `finish(n) = start(n) +
 * latency(n)`, where `start(n)` is the max `finish` of its predecessors. The
 * critical path is the maximum `finish` across all nodes. Complexity O(V + E).
 *
 * `null` / negative latencies are treated as 0. Cyclic graphs (no topological
 * order) have no well-defined critical path and fall back to the cumulative sum.
 */
export const computeCriticalPathLatencyMs = (
  nodes: readonly NexusNode[],
  edges: readonly { source: string; target: string }[],
): number => {
  if (nodes.length === 0) return 0;

  const latencyById = new Map<string, number>();
  for (const node of nodes) {
    latencyById.set(node.id, Math.max(0, node.data.telemetry.latencyMs ?? 0));
  }

  const order = topologicalOrder(nodes, edges);
  if (order === null) {
    let sum = 0;
    for (const latency of latencyById.values()) sum += latency;
    return sum;
  }

  const adjacency = buildAdjacency(nodes, edges);
  const start = new Map<string, number>();
  for (const node of nodes) start.set(node.id, 0);

  let critical = 0;
  for (const id of order) {
    const finish = (start.get(id) ?? 0) + (latencyById.get(id) ?? 0);
    critical = Math.max(critical, finish);
    for (const next of adjacency.get(id) ?? []) {
      start.set(next, Math.max(start.get(next) ?? 0, finish));
    }
  }
  return critical;
};

/** Assembles the full run metrics: telemetry totals plus the critical path. */
export const computeRunMetrics = (
  nodes: readonly NexusNode[],
  edges: readonly NexusEdge[],
): PipelineRunMetrics => ({
  ...aggregateRunMetrics(nodes.map((node) => node.data.telemetry)),
  criticalPathLatencyMs: computeCriticalPathLatencyMs(nodes, edges),
});
