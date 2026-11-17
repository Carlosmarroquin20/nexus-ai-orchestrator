/**
 * Aggregation of scored evaluation cases into the metrics an evaluation report
 * shows (ADR 0010). Pure and framework-agnostic.
 *
 * Counting rules:
 * - A check passes only with status `passed`; an `error` (the check could not be
 *   evaluated) counts against the rate and is also reported on its own.
 * - A case passes only when every one of its checks passes.
 * - A rate over zero items is `null`, never 0% or 100%: "nothing measured" must
 *   not read as a result.
 * - Duration percentiles use the nearest-rank method, so they are always one of
 *   the observed durations.
 */

import type { ScorerKind } from './dataset';
import type { CheckResult } from './scorers';

/** One evaluated case: its check verdicts plus the cost of running it. */
export interface CaseScore {
  readonly caseId: string;
  readonly checks: readonly CheckResult[];
  /** Wall-clock duration of the case's pipeline run. */
  readonly durationMs: number;
  readonly costInUSD: number;
  readonly totalTokens: number;
}

export interface PassRate {
  readonly passed: number;
  readonly total: number;
  /** `passed / total`, or `null` when `total` is 0. */
  readonly rate: number | null;
}

export interface DurationStats {
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface EvalSummary {
  readonly cases: PassRate;
  readonly checks: PassRate;
  readonly erroredChecks: number;
  /** Check pass rate per inspected node. */
  readonly byNode: Readonly<Record<string, PassRate>>;
  /** Check pass rate per scorer kind present in the evaluation. */
  readonly byScorer: Readonly<Partial<Record<ScorerKind, PassRate>>>;
  /** `null` when no case was evaluated. */
  readonly duration: DurationStats | null;
  readonly totalCostInUSD: number;
  /** `null` when no case was evaluated. */
  readonly meanCostInUSD: number | null;
  readonly totalTokens: number;
}

const rateOf = (passed: number, total: number): PassRate => ({
  passed,
  total,
  rate: total === 0 ? null : passed / total,
});

/** Nearest-rank percentile of an ascending, non-empty list. */
const percentile = (sortedAscending: readonly number[], p: number): number => {
  const rank = Math.max(1, Math.ceil((p / 100) * sortedAscending.length));
  return sortedAscending[rank - 1]!;
};

export const isCasePassed = (score: CaseScore): boolean =>
  score.checks.every((result) => result.status === 'passed');

export const summarizeEvaluation = (scores: readonly CaseScore[]): EvalSummary => {
  const allChecks = scores.flatMap((score) => score.checks);
  const passedChecks = allChecks.filter((result) => result.status === 'passed').length;

  const tally = (keyOf: (result: CheckResult) => string): Record<string, PassRate> => {
    const counts = new Map<string, { passed: number; total: number }>();
    for (const result of allChecks) {
      const key = keyOf(result);
      const entry = counts.get(key) ?? { passed: 0, total: 0 };
      entry.total += 1;
      if (result.status === 'passed') entry.passed += 1;
      counts.set(key, entry);
    }
    return Object.fromEntries(
      [...counts].map(([key, { passed, total }]) => [key, rateOf(passed, total)]),
    );
  };

  const durations = scores.map((score) => score.durationMs).sort((a, b) => a - b);
  const totalCostInUSD = scores.reduce((sum, score) => sum + score.costInUSD, 0);

  return {
    cases: rateOf(scores.filter(isCasePassed).length, scores.length),
    checks: rateOf(passedChecks, allChecks.length),
    erroredChecks: allChecks.filter((result) => result.status === 'error').length,
    byNode: tally((result) => result.check.nodeId),
    byScorer: tally((result) => result.check.scorer),
    duration:
      durations.length === 0
        ? null
        : {
            meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
            p50Ms: percentile(durations, 50),
            p95Ms: percentile(durations, 95),
            maxMs: durations[durations.length - 1]!,
          },
    totalCostInUSD,
    meanCostInUSD: scores.length === 0 ? null : totalCostInUSD / scores.length,
    totalTokens: scores.reduce((sum, score) => sum + score.totalTokens, 0),
  };
};
