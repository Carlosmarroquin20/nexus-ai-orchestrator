/**
 * Case-by-case comparison of two evaluation records (ADR 0010).
 *
 * The question a comparison answers is "what did my change break or fix?", so
 * its unit is the case, matched by id across the two records:
 *
 * - `regressed`: passed in the baseline, failed in the candidate.
 * - `fixed`: failed in the baseline, passed in the candidate.
 * - `unchanged`: the same verdict in both.
 * - `not_comparable`: only one side has a verdict (all of a case's checks were
 *   skipped on the other side, e.g. a judge without a model), so no direction
 *   can be claimed.
 * - `only_in_baseline` / `only_in_candidate`: the case ran on one side only,
 *   because the datasets differ or an evaluation was cancelled part-way.
 *
 * Within a case, check-level changes are reported only when both sides list the
 * same checks (same node and scorer at every position); otherwise positions do
 * not identify the same check and matching them would invent changes.
 *
 * The comparison also says whether the dataset, the pipeline, and the model are
 * the same on both sides. It never refuses to compare: it labels what differs,
 * and the reader decides what the difference means. Pure.
 */

import type { CheckStatus } from './scorers';
import type { CaseVerdict } from './summary';
import type { EvalCaseRecord, EvalRecord, EvalRecordMetrics } from './history';

export type CaseChange =
  | 'regressed'
  | 'fixed'
  | 'unchanged'
  | 'not_comparable'
  | 'only_in_baseline'
  | 'only_in_candidate';

export interface CheckChange {
  /** Position of the check within its case. */
  readonly position: number;
  readonly nodeId: string;
  readonly scorer: string;
  readonly baseline: CheckStatus;
  readonly candidate: CheckStatus;
  readonly baselineScore: number | null;
  readonly candidateScore: number | null;
}

export interface CaseComparison {
  readonly caseId: string;
  readonly change: CaseChange;
  readonly baseline: CaseVerdict | null;
  readonly candidate: CaseVerdict | null;
  /** Checks whose status or judge grade differs; empty when the checks do not align. */
  readonly checkChanges: readonly CheckChange[];
}

export interface MetricDelta {
  readonly baseline: number | null;
  readonly candidate: number | null;
  /** `candidate - baseline`; `null` unless both sides were measured. */
  readonly delta: number | null;
}

export interface ComparisonMetrics {
  readonly caseRate: MetricDelta;
  readonly checkRate: MetricDelta;
  readonly judgeMean: MetricDelta;
  readonly p50Ms: MetricDelta;
  readonly p95Ms: MetricDelta;
  readonly totalCostInUSD: MetricDelta;
}

export interface EvalComparison {
  readonly sameDataset: boolean;
  readonly samePipeline: boolean;
  /** Same execution mode and, in real mode, the same model. */
  readonly sameModel: boolean;
  readonly metrics: ComparisonMetrics;
  /** Candidate cases in their order, then the cases only the baseline ran. */
  readonly cases: readonly CaseComparison[];
  readonly counts: Readonly<Record<CaseChange, number>>;
}

const rate = (passed: number, total: number): number | null => (total === 0 ? null : passed / total);

const deltaOf = (baseline: number | null, candidate: number | null): MetricDelta => ({
  baseline,
  candidate,
  delta: baseline !== null && candidate !== null ? candidate - baseline : null,
});

const compareMetrics = (base: EvalRecordMetrics, next: EvalRecordMetrics): ComparisonMetrics => ({
  caseRate: deltaOf(rate(base.casesPassed, base.casesTotal), rate(next.casesPassed, next.casesTotal)),
  checkRate: deltaOf(rate(base.checksPassed, base.checksTotal), rate(next.checksPassed, next.checksTotal)),
  judgeMean: deltaOf(base.judgeMean, next.judgeMean),
  p50Ms: deltaOf(base.p50Ms, next.p50Ms),
  p95Ms: deltaOf(base.p95Ms, next.p95Ms),
  totalCostInUSD: deltaOf(base.totalCostInUSD, next.totalCostInUSD),
});

const classify = (baseline: CaseVerdict, candidate: CaseVerdict): CaseChange => {
  if (baseline === candidate) return 'unchanged';
  if (baseline === 'skipped' || candidate === 'skipped') return 'not_comparable';
  return candidate === 'failed' ? 'regressed' : 'fixed';
};

const checksAlign = (base: EvalCaseRecord, next: EvalCaseRecord): boolean =>
  base.checks.length === next.checks.length &&
  base.checks.every((check, position) => {
    const other = next.checks[position];
    return other !== undefined && other.nodeId === check.nodeId && other.scorer === check.scorer;
  });

const changedChecks = (base: EvalCaseRecord, next: EvalCaseRecord): CheckChange[] => {
  if (!checksAlign(base, next)) return [];
  const changes: CheckChange[] = [];
  base.checks.forEach((check, position) => {
    const other = next.checks[position]!;
    if (other.status === check.status && other.score === check.score) return;
    changes.push({
      position,
      nodeId: check.nodeId,
      scorer: check.scorer,
      baseline: check.status,
      candidate: other.status,
      baselineScore: check.score,
      candidateScore: other.score,
    });
  });
  return changes;
};

export const compareEvaluations = (baseline: EvalRecord, candidate: EvalRecord): EvalComparison => {
  const baselineCases = new Map(baseline.cases.map((entry) => [entry.caseId, entry]));
  const candidateIds = new Set(candidate.cases.map((entry) => entry.caseId));

  const cases: CaseComparison[] = candidate.cases.map((next) => {
    const base = baselineCases.get(next.caseId);
    if (base === undefined) {
      return {
        caseId: next.caseId,
        change: 'only_in_candidate',
        baseline: null,
        candidate: next.verdict,
        checkChanges: [],
      };
    }
    return {
      caseId: next.caseId,
      change: classify(base.verdict, next.verdict),
      baseline: base.verdict,
      candidate: next.verdict,
      checkChanges: changedChecks(base, next),
    };
  });
  for (const base of baseline.cases) {
    if (candidateIds.has(base.caseId)) continue;
    cases.push({
      caseId: base.caseId,
      change: 'only_in_baseline',
      baseline: base.verdict,
      candidate: null,
      checkChanges: [],
    });
  }

  const counts: Record<CaseChange, number> = {
    regressed: 0,
    fixed: 0,
    unchanged: 0,
    not_comparable: 0,
    only_in_baseline: 0,
    only_in_candidate: 0,
  };
  for (const entry of cases) counts[entry.change] += 1;

  return {
    sameDataset: baseline.datasetFingerprint === candidate.datasetFingerprint,
    samePipeline: baseline.pipelineFingerprint === candidate.pipelineFingerprint,
    sameModel: baseline.mode === candidate.mode && baseline.model === candidate.model,
    metrics: compareMetrics(baseline.metrics, candidate.metrics),
    cases,
    counts,
  };
};
