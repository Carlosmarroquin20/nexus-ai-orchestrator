/**
 * Pure telemetry computation: cost derivation, latency classification, run-level
 * aggregation, and the canonical telemetry reconciliation reducer.
 *
 * Every export is referentially transparent. The store delegates all telemetry
 * arithmetic here so the reducer can be unit-tested in isolation from Zustand
 * and React Flow, and so the additive token invariant is enforced in exactly one
 * place.
 */

import {
  FALLBACK_PRICING,
  LATENCY_THRESHOLDS_MS,
  MODEL_PRICING,
  type TokenPricing,
} from '@/config/telemetry';
import type {
  NodeExecutionState,
  NodeTelemetry,
  NodeTelemetryPatch,
  PipelineRunMetrics,
  TelemetryError,
} from '@/types/graph';

const TOKENS_PER_PRICING_UNIT = 1_000_000;

/** Returns the configured pricing for a model id, or the conservative fallback. */
export const resolvePricing = (model: string): TokenPricing =>
  MODEL_PRICING[model] ?? FALLBACK_PRICING;

/** Computes cost in USD for a token split under the supplied pricing. */
export const computeTokenCost = (
  pricing: TokenPricing,
  inputTokens: number,
  outputTokens: number,
): number =>
  (inputTokens / TOKENS_PER_PRICING_UNIT) * pricing.inputPerMillionUSD +
  (outputTokens / TOKENS_PER_PRICING_UNIT) * pricing.outputPerMillionUSD;

export type LatencyBand = 'unknown' | 'nominal' | 'degraded' | 'critical';

/** Buckets a latency reading against the configured thresholds. */
export const classifyLatency = (latencyMs: number | null): LatencyBand => {
  if (latencyMs === null) return 'unknown';
  if (latencyMs >= LATENCY_THRESHOLDS_MS.critical) return 'critical';
  if (latencyMs >= LATENCY_THRESHOLDS_MS.degraded) return 'degraded';
  return 'nominal';
};

/** Coalescing helper: take the incoming value unless absent, then keep prior. */
const coalesce = <T>(next: T | undefined, previous: T): T =>
  next !== undefined ? next : previous;

/** Synthesized error for a `failed` transition that carried no structured payload. */
const UNSPECIFIED_FAILURE: TelemetryError = {
  code: 'UNSPECIFIED',
  message: 'Node failed without a structured error payload.',
  originNodeId: null,
};

/**
 * Canonical telemetry reducer. Produces the next immutable telemetry snapshot
 * while enforcing the type's documented invariants:
 *
 * - `totalTokens` is always recomputed as `inputTokens + outputTokens`; the patch
 *   cannot set it directly.
 * - `costInUSD` honors an explicit patch value (backend-authoritative) and
 *   otherwise derives from tokens under `pricing`; with no pricing it is retained.
 * - `latencyMs` is clamped to be non-negative, or remains `null`.
 * - `error` is non-null iff the resulting `state` is `'failed'`.
 *
 * @param pricing Resolved pricing for the node's model, or `null` for nodes
 *                whose cost is not token-derived (e.g. vector stores).
 */
export const reconcileTelemetry = (
  previous: NodeTelemetry,
  state: NodeExecutionState,
  patch: NodeTelemetryPatch,
  timestamp: number,
  pricing: TokenPricing | null,
): NodeTelemetry => {
  const inputTokens = coalesce(patch.inputTokens, previous.inputTokens);
  const outputTokens = coalesce(patch.outputTokens, previous.outputTokens);
  const totalTokens = inputTokens + outputTokens;

  const costInUSD =
    patch.costInUSD !== undefined
      ? patch.costInUSD
      : pricing !== null
        ? computeTokenCost(pricing, inputTokens, outputTokens)
        : previous.costInUSD;

  const rawLatency = coalesce(patch.latencyMs, previous.latencyMs);
  const latencyMs = rawLatency === null ? null : Math.max(0, rawLatency);

  const error: TelemetryError | null =
    state === 'failed' ? (coalesce(patch.error, previous.error) ?? UNSPECIFIED_FAILURE) : null;

  return {
    state,
    latencyMs,
    inputTokens,
    outputTokens,
    totalTokens,
    costInUSD,
    inputPayload: coalesce(patch.inputPayload, previous.inputPayload),
    outputPayload: coalesce(patch.outputPayload, previous.outputPayload),
    lastUpdatedAt: timestamp,
    error,
  };
};

const EMPTY_METRICS: PipelineRunMetrics = {
  totalLatencyMs: 0,
  aggregateInputTokens: 0,
  aggregateOutputTokens: 0,
  aggregateTotalTokens: 0,
  aggregateCostInUSD: 0,
  nodeCount: 0,
  failedNodeCount: 0,
};

/**
 * Rolls a collection of per-node telemetries into run-level metrics.
 *
 * `totalLatencyMs` is the arithmetic sum of node latencies (cumulative compute
 * time), NOT the wall-clock critical path. Critical-path latency requires a
 * topological traversal and is computed separately by the run analyzer.
 */
export const aggregateRunMetrics = (
  telemetries: readonly NodeTelemetry[],
): PipelineRunMetrics =>
  telemetries.reduce<PipelineRunMetrics>(
    (acc, t) => ({
      totalLatencyMs: acc.totalLatencyMs + (t.latencyMs ?? 0),
      aggregateInputTokens: acc.aggregateInputTokens + t.inputTokens,
      aggregateOutputTokens: acc.aggregateOutputTokens + t.outputTokens,
      aggregateTotalTokens: acc.aggregateTotalTokens + t.totalTokens,
      aggregateCostInUSD: acc.aggregateCostInUSD + t.costInUSD,
      nodeCount: acc.nodeCount + 1,
      failedNodeCount: acc.failedNodeCount + (t.state === 'failed' ? 1 : 0),
    }),
    EMPTY_METRICS,
  );
