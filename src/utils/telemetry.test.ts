import { describe, expect, it } from 'vitest';

import { FALLBACK_PRICING, MODEL_PRICING, createPristineTelemetry } from '@/config/telemetry';
import type { NodeTelemetry } from '@/types/graph';
import {
  aggregateRunMetrics,
  classifyLatency,
  computeTokenCost,
  reconcileTelemetry,
  resolvePricing,
} from '@/utils/telemetry';

const pristine = createPristineTelemetry();

describe('reconcileTelemetry', () => {
  it('recomputes totalTokens as input + output regardless of patch', () => {
    const next = reconcileTelemetry(pristine, 'completed', { inputTokens: 100, outputTokens: 40 }, 1, null);
    expect(next.totalTokens).toBe(140);
  });

  it('derives cost from pricing when the patch omits it', () => {
    const next = reconcileTelemetry(
      pristine,
      'completed',
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      1,
      { inputPerMillionUSD: 3, outputPerMillionUSD: 15 },
    );
    expect(next.costInUSD).toBeCloseTo(18);
  });

  it('prefers an explicit patch cost over the derived value', () => {
    const next = reconcileTelemetry(
      pristine,
      'completed',
      { inputTokens: 1_000_000, costInUSD: 2 },
      1,
      { inputPerMillionUSD: 3, outputPerMillionUSD: 15 },
    );
    expect(next.costInUSD).toBe(2);
  });

  it('retains the previous cost with neither pricing nor patch cost', () => {
    const next = reconcileTelemetry({ ...pristine, costInUSD: 5 }, 'running', {}, 1, null);
    expect(next.costInUSD).toBe(5);
  });

  it('clamps negative latency to 0 and preserves null', () => {
    expect(reconcileTelemetry(pristine, 'completed', { latencyMs: -10 }, 1, null).latencyMs).toBe(0);
    expect(reconcileTelemetry(pristine, 'running', {}, 1, null).latencyMs).toBeNull();
  });

  it('attaches an error iff the resulting state is failed', () => {
    expect(reconcileTelemetry(pristine, 'failed', {}, 1, null).error).not.toBeNull();
    const recovered = reconcileTelemetry(
      { ...pristine, error: { code: 'X', message: 'm', originNodeId: null } },
      'completed',
      {},
      1,
      null,
    );
    expect(recovered.error).toBeNull();
  });

  it('stamps lastUpdatedAt with the provided timestamp', () => {
    expect(reconcileTelemetry(pristine, 'running', {}, 123, null).lastUpdatedAt).toBe(123);
  });
});

describe('aggregateRunMetrics', () => {
  const withState = (over: Partial<NodeTelemetry>): NodeTelemetry => ({ ...createPristineTelemetry(), ...over });

  it('sums latency/tokens/cost and counts failed and skipped nodes', () => {
    const metrics = aggregateRunMetrics([
      withState({ state: 'completed', latencyMs: 100, inputTokens: 10, outputTokens: 5, totalTokens: 15, costInUSD: 1 }),
      withState({ state: 'failed', latencyMs: 50 }),
      withState({ state: 'skipped' }),
    ]);
    expect(metrics.totalLatencyMs).toBe(150);
    expect(metrics.aggregateTotalTokens).toBe(15);
    expect(metrics.aggregateCostInUSD).toBe(1);
    expect(metrics.nodeCount).toBe(3);
    expect(metrics.failedNodeCount).toBe(1);
    expect(metrics.skippedNodeCount).toBe(1);
  });

  it('returns zeros for empty input', () => {
    const metrics = aggregateRunMetrics([]);
    expect(metrics.nodeCount).toBe(0);
    expect(metrics.totalLatencyMs).toBe(0);
  });
});

describe('pricing and latency helpers', () => {
  it('computes cost per million tokens', () => {
    expect(computeTokenCost({ inputPerMillionUSD: 10, outputPerMillionUSD: 20 }, 500_000, 250_000)).toBeCloseTo(10);
  });

  it('resolves known model pricing and falls back otherwise', () => {
    expect(resolvePricing('claude-sonnet-4-6')).toBe(MODEL_PRICING['claude-sonnet-4-6']);
    expect(resolvePricing('unknown-model')).toBe(FALLBACK_PRICING);
  });

  it('buckets latency into bands', () => {
    expect(classifyLatency(null)).toBe('unknown');
    expect(classifyLatency(100)).toBe('nominal');
    expect(classifyLatency(2_000)).toBe('degraded');
    expect(classifyLatency(6_000)).toBe('critical');
  });
});
