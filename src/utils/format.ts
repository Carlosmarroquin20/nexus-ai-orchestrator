/**
 * Locale-aware display formatters for telemetry values. Centralized so numeric
 * presentation (precision, currency, compaction) is consistent across the canvas
 * and inspector. `Intl` instances are module-singletons to avoid per-render
 * allocation. Pure throughout.
 */

const EM_DASH = '—';

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const integerFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const formatCostUSD = (value: number): string => usdFormatter.format(value);

/** Compact token count (e.g. `12.3K`). Use {@link formatExactTokens} for precise figures. */
export const formatTokens = (value: number): string => compactFormatter.format(value);

export const formatExactTokens = (value: number): string => integerFormatter.format(value);

/** Renders latency with adaptive units; `null` (unmeasured) renders as an em dash. */
export const formatLatency = (ms: number | null): string => {
  if (ms === null) return EM_DASH;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
};

/** 24-hour wall-clock time for an epoch-ms timestamp; `null` renders as an em dash. */
export const formatTimestamp = (epochMs: number | null): string =>
  epochMs === null
    ? EM_DASH
    : new Date(epochMs).toLocaleTimeString('en-US', { hour12: false });
