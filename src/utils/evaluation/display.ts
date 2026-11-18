/**
 * Display formatting for evaluation metrics. Pure; components never format
 * rates or deltas inline, so "nothing measured" reads the same everywhere.
 */

import type { PassRate } from './summary';

const EM_DASH = '—';
const MINUS = '−';

/** Percentage with at most one decimal (`83.3%`, `100%`); `null` renders as an em dash. */
export const formatRate = (rate: number | null): string => {
  if (rate === null) return EM_DASH;
  const tenths = Math.round(rate * 1_000) / 10;
  return `${tenths}%`;
};

/** `5/6 · 83.3%`; an empty rate renders as an em dash instead of `0/0`. */
export const formatPassRate = ({ passed, total, rate }: PassRate): string =>
  total === 0 ? EM_DASH : `${passed}/${total} · ${formatRate(rate)}`;

/** Mean judge grade on the 1-5 scale, e.g. `4.25 / 5`. */
export const formatJudgeMean = (mean: number | null): string =>
  mean === null ? EM_DASH : `${mean.toFixed(2)} / 5`;

/**
 * Signed difference with an explicit sign and a true minus sign, formatted by
 * `format` (which receives the absolute value). Zero renders as `±0`.
 */
export const formatSigned = (delta: number | null, format: (magnitude: number) => string): string => {
  if (delta === null) return EM_DASH;
  if (delta === 0) return `±${format(0)}`;
  return `${delta > 0 ? '+' : MINUS}${format(Math.abs(delta))}`;
};

/** A rate difference in percentage points, e.g. `+16.7 pts`. */
export const formatRateDelta = (delta: number | null): string =>
  formatSigned(delta, (magnitude) => `${Math.round(magnitude * 1_000) / 10} pts`);

export type DeltaTone = 'better' | 'worse' | 'neutral';

/**
 * Whether a difference is an improvement. `higherIsBetter` is true for pass
 * rates and grades, false for latency and cost. Differences within `epsilon`
 * (floating-point noise in summed costs, for one) are neutral.
 */
export const deltaTone = (delta: number | null, higherIsBetter: boolean, epsilon = 1e-9): DeltaTone => {
  if (delta === null || Math.abs(delta) <= epsilon) return 'neutral';
  return delta > 0 === higherIsBetter ? 'better' : 'worse';
};
