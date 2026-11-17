/**
 * Evaluation records and their capped local history (ADR 0010).
 *
 * A record is the part of a finished evaluation worth keeping for comparison:
 * what ran (dataset, pipeline fingerprint, mode, model), each case's verdict and
 * per-check status, and the headline metrics. Outputs and check details are
 * left out on purpose. They are the bulk of an evaluation (up to 2,000
 * characters per check), comparisons do not need them, and keeping them would
 * let ten records of a 100-case dataset exceed the browser's storage quota.
 *
 * Only evaluations the server finished (completed, or cancelled with a summary)
 * become records; one interrupted or stopped from the client has no summary and
 * is not recorded. The history is newest first and capped, and it is parsed
 * defensively: storage is user-editable, so a record that does not validate is
 * dropped instead of reaching the panel.
 */

import type { ExecutionMode } from '@/types/execution';

import { isFiniteNumber, isRecord, isString } from '../guards';
import type { EvalCaseFrame, EvalDoneFrame, EvalStartedFrame, EvalSummaryFrame } from './protocol';
import type { CheckStatus } from './scorers';
import type { CaseVerdict } from './summary';

export const EVAL_HISTORY_SCHEMA_VERSION = 1 as const;
export const EVAL_HISTORY_STORAGE_KEY = 'nexus:evals:v1';

/** Evaluations kept for comparison; older ones are dropped first. */
export const MAX_EVAL_HISTORY = 10;

export interface EvalCheckRecord {
  readonly nodeId: string;
  readonly scorer: string;
  readonly status: CheckStatus;
  /** Judge grade (1-5); `null` for deterministic or ungraded checks. */
  readonly score: number | null;
}

export interface EvalCaseRecord {
  readonly caseId: string;
  readonly verdict: CaseVerdict;
  readonly durationMs: number;
  readonly costInUSD: number;
  readonly checks: readonly EvalCheckRecord[];
}

/** Headline metrics, flattened from the summary frame. */
export interface EvalRecordMetrics {
  readonly casesPassed: number;
  readonly casesTotal: number;
  readonly checksPassed: number;
  readonly checksTotal: number;
  readonly erroredChecks: number;
  readonly skippedChecks: number;
  /** `null` when the judge produced no grade. */
  readonly judgeMean: number | null;
  readonly judgeCount: number;
  /** `null` when no case was evaluated. */
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  /** Pipeline cost only; grading is `judgeCostInUSD`. */
  readonly totalCostInUSD: number;
  readonly judgeCostInUSD: number;
  readonly totalTokens: number;
}

export interface EvalRecord {
  readonly id: string;
  readonly finishedAt: number;
  readonly status: EvalDoneFrame['status'];
  readonly datasetName: string;
  readonly datasetFingerprint: string;
  readonly pipelineFingerprint: string;
  readonly mode: ExecutionMode;
  readonly model: string | null;
  /** Cases in the dataset; more than `cases.length` when the evaluation was cancelled. */
  readonly caseCount: number;
  readonly cases: readonly EvalCaseRecord[];
  readonly metrics: EvalRecordMetrics;
}

export interface EvalRecordSource {
  readonly started: EvalStartedFrame;
  readonly cases: readonly EvalCaseFrame[];
  readonly summary: EvalSummaryFrame;
  readonly status: EvalDoneFrame['status'];
  readonly finishedAt: number;
  readonly datasetFingerprint: string;
  readonly pipelineFingerprint: string;
}

/** Projects a finished evaluation onto the record kept in the history. */
export const toEvalRecord = (source: EvalRecordSource): EvalRecord => {
  const { started, summary } = source;
  return {
    id: started.evalId,
    finishedAt: source.finishedAt,
    status: source.status,
    datasetName: started.datasetName,
    datasetFingerprint: source.datasetFingerprint,
    pipelineFingerprint: source.pipelineFingerprint,
    mode: started.mode,
    model: started.model,
    caseCount: started.caseCount,
    cases: source.cases.map((entry) => ({
      caseId: entry.caseId,
      verdict: entry.verdict,
      durationMs: entry.durationMs,
      costInUSD: entry.costInUSD,
      checks: entry.checks.map(({ nodeId, scorer, status, score }) => ({ nodeId, scorer, status, score })),
    })),
    metrics: {
      casesPassed: summary.cases.passed,
      casesTotal: summary.cases.total,
      checksPassed: summary.checks.passed,
      checksTotal: summary.checks.total,
      erroredChecks: summary.erroredChecks,
      skippedChecks: summary.skippedChecks,
      judgeMean: summary.judgeScore?.mean ?? null,
      judgeCount: summary.judgeScore?.count ?? 0,
      p50Ms: summary.duration?.p50Ms ?? null,
      p95Ms: summary.duration?.p95Ms ?? null,
      totalCostInUSD: summary.totalCostInUSD,
      judgeCostInUSD: summary.judgeUsage.costInUSD,
      totalTokens: summary.totalTokens,
    },
  };
};

/** Adds `record` as the newest entry, replacing one with the same id, within the cap. */
export const appendEvalRecord = (history: readonly EvalRecord[], record: EvalRecord): EvalRecord[] =>
  [record, ...history.filter((entry) => entry.id !== record.id)].slice(0, MAX_EVAL_HISTORY);

export const serializeEvalHistory = (records: readonly EvalRecord[]): string =>
  JSON.stringify({ version: EVAL_HISTORY_SCHEMA_VERSION, records });

/* --------------------------------- parsing -------------------------------- */

const CHECK_STATUSES: readonly string[] = ['passed', 'failed', 'error', 'skipped'];
const VERDICTS: readonly string[] = ['passed', 'failed', 'skipped'];

const isCount = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && Number.isInteger(value);
const isAmount = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;
const isNullableAmount = (value: unknown): value is number | null => value === null || isAmount(value);

const parseCheck = (raw: unknown): EvalCheckRecord | null => {
  if (!isRecord(raw)) return null;
  const nodeId = raw['nodeId'];
  const scorer = raw['scorer'];
  const status = raw['status'];
  const score = raw['score'];
  if (!isString(nodeId) || !isString(scorer)) return null;
  if (!isString(status) || !CHECK_STATUSES.includes(status)) return null;
  if (!(score === null || isFiniteNumber(score))) return null;
  return { nodeId, scorer, status: status as CheckStatus, score };
};

const parseCase = (raw: unknown): EvalCaseRecord | null => {
  if (!isRecord(raw) || !Array.isArray(raw['checks'])) return null;
  const caseId = raw['caseId'];
  const verdict = raw['verdict'];
  const durationMs = raw['durationMs'];
  const costInUSD = raw['costInUSD'];
  if (!isString(caseId) || !isString(verdict) || !VERDICTS.includes(verdict)) return null;
  if (!isAmount(durationMs) || !isAmount(costInUSD)) return null;
  const checks = raw['checks'].map(parseCheck);
  if (checks.some((check) => check === null)) return null;
  return {
    caseId,
    verdict: verdict as CaseVerdict,
    durationMs,
    costInUSD,
    checks: checks as EvalCheckRecord[],
  };
};

const parseMetrics = (raw: unknown): EvalRecordMetrics | null => {
  if (!isRecord(raw)) return null;
  const counts = [
    'casesPassed',
    'casesTotal',
    'checksPassed',
    'checksTotal',
    'erroredChecks',
    'skippedChecks',
    'judgeCount',
    'totalTokens',
  ] as const;
  const amounts = ['totalCostInUSD', 'judgeCostInUSD'] as const;
  const nullableAmounts = ['judgeMean', 'p50Ms', 'p95Ms'] as const;
  if (!counts.every((key) => isCount(raw[key]))) return null;
  if (!amounts.every((key) => isAmount(raw[key]))) return null;
  if (!nullableAmounts.every((key) => isNullableAmount(raw[key]))) return null;
  // Validated member by member above.
  const metrics = Object.fromEntries(
    [...counts, ...amounts, ...nullableAmounts].map((key) => [key, raw[key]]),
  ) as unknown as EvalRecordMetrics;
  if (metrics.casesPassed > metrics.casesTotal || metrics.checksPassed > metrics.checksTotal) return null;
  return metrics;
};

const parseRecord = (raw: unknown): EvalRecord | null => {
  if (!isRecord(raw) || !Array.isArray(raw['cases'])) return null;
  const id = raw['id'];
  const finishedAt = raw['finishedAt'];
  const status = raw['status'];
  const datasetName = raw['datasetName'];
  const datasetFingerprint = raw['datasetFingerprint'];
  const pipelineFingerprint = raw['pipelineFingerprint'];
  const mode = raw['mode'];
  const model = raw['model'];
  const caseCount = raw['caseCount'];
  if (!isString(id) || !isAmount(finishedAt)) return null;
  if (status !== 'completed' && status !== 'cancelled') return null;
  if (!isString(datasetName) || !isString(datasetFingerprint) || !isString(pipelineFingerprint)) return null;
  if ((mode !== 'real' && mode !== 'simulated') || !(model === null || isString(model))) return null;
  if (!isCount(caseCount)) return null;
  const cases = raw['cases'].map(parseCase);
  const metrics = parseMetrics(raw['metrics']);
  if (metrics === null || cases.some((entry) => entry === null)) return null;
  return {
    id,
    finishedAt,
    status,
    datasetName,
    datasetFingerprint,
    pipelineFingerprint,
    mode,
    model,
    caseCount,
    cases: cases as EvalCaseRecord[],
    metrics,
  };
};

/**
 * Parses a stored history. Unreadable storage yields an empty history; records
 * that do not validate are dropped individually, so one bad entry does not
 * cost the rest. The cap is re-applied in case storage was edited.
 */
export const parseEvalHistory = (raw: unknown): EvalRecord[] => {
  if (!isRecord(raw) || raw['version'] !== EVAL_HISTORY_SCHEMA_VERSION) return [];
  const records = raw['records'];
  if (!Array.isArray(records)) return [];
  const seen = new Set<string>();
  const parsed: EvalRecord[] = [];
  for (const entry of records) {
    const record = parseRecord(entry);
    if (record === null || seen.has(record.id)) continue;
    seen.add(record.id);
    parsed.push(record);
    if (parsed.length === MAX_EVAL_HISTORY) break;
  }
  return parsed;
};
