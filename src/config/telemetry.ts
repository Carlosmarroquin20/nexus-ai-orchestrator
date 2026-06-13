/**
 * Immutable telemetry parameters and pricing registry.
 *
 * This module holds constants only. All derivation logic (cost computation,
 * aggregation) lives in `@/utils/telemetry` to keep configuration values free of
 * behavior and trivially tree-shakeable.
 */

import type { NodeTelemetry } from '@/types/graph';

/**
 * Pristine telemetry assigned to every newly instantiated node. A fresh object
 * is returned per call so that no two nodes ever share a telemetry reference —
 * shared references would defeat React Flow's per-node referential memoization
 * and cause unrelated nodes to re-render on any single telemetry update.
 */
export const createPristineTelemetry = (): NodeTelemetry => ({
  state: 'idle',
  latencyMs: null,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costInUSD: 0,
  inputPayload: {},
  outputPayload: {},
  lastUpdatedAt: null,
  error: null,
});

export interface TokenPricing {
  readonly inputPerMillionUSD: number;
  readonly outputPerMillionUSD: number;
}

/**
 * Baseline token pricing keyed by model id, expressed in USD per 1,000,000
 * tokens. These are operator-configurable defaults and are NOT an authoritative
 * billing source. Reconcile against the provider's published rate card (or a
 * billing-export feed) before surfacing cost figures as anything but estimates.
 */
export const MODEL_PRICING: Readonly<Record<string, TokenPricing>> = {
  'claude-opus-4-8': { inputPerMillionUSD: 15, outputPerMillionUSD: 75 },
  'claude-sonnet-4-6': { inputPerMillionUSD: 3, outputPerMillionUSD: 15 },
  'claude-haiku-4-5': { inputPerMillionUSD: 1, outputPerMillionUSD: 5 },
};

/** Conservative rate applied when a model id has no entry in {@link MODEL_PRICING}. */
export const FALLBACK_PRICING: TokenPricing = {
  inputPerMillionUSD: 3,
  outputPerMillionUSD: 15,
};

/**
 * Estimated Gemini pricing (USD per 1M tokens) used by the real execution
 * backend. An estimate — reconcile with the configured model's published rate
 * card before treating run costs as anything but approximate.
 */
export const GEMINI_PRICING: TokenPricing = {
  inputPerMillionUSD: 0.1,
  outputPerMillionUSD: 0.4,
};

/**
 * Latency classification thresholds in milliseconds. The inspector buckets a
 * node's `latencyMs` into nominal (< degraded), degraded ([degraded, critical)),
 * and critical (>= critical) bands for color coding.
 */
export const LATENCY_THRESHOLDS_MS = {
  degraded: 1_500,
  critical: 5_000,
} as const;
