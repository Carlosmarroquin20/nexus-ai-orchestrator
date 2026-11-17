/**
 * Defensive decoding of the evaluation stream's frames on the client (ADR 0010).
 *
 * The frames are typed in `protocol.ts`, but what arrives is untyped JSON. Each
 * parser narrows `unknown` into one frame type or returns `null`, never coercing:
 * a malformed frame is dropped instead of reaching state that the panel renders
 * (a missing number would otherwise surface as a crash in a formatter). Only the
 * fields the client reads are validated; unknown extra fields are ignored, so
 * the server can add fields without breaking older clients. Pure throughout.
 *
 * Property access uses bracket notation: fields of a narrowed
 * `Record<string, unknown>` come from an index signature.
 */

import type { ExecutionMode, RunOutcome } from '@/types/execution';

import { isFiniteNumber, isRecord, isString } from '../guards';
import type { ScorerKind } from './dataset';
import type {
  EvalCaseFrame,
  EvalCaseStartedFrame,
  EvalCheckFrame,
  EvalDoneFrame,
  EvalStartedFrame,
  EvalSummaryFrame,
  JudgeUsageTotals,
} from './protocol';
import type { CheckStatus } from './scorers';
import type { CaseVerdict, DurationStats, JudgeScoreStats, PassRate } from './summary';

const oneOf =
  <T extends string>(values: readonly T[]) =>
  (value: unknown): value is T =>
    typeof value === 'string' && (values as readonly string[]).includes(value);

const isMode = oneOf<ExecutionMode>(['real', 'simulated']);
const isRunOutcome = oneOf<RunOutcome>(['completed', 'failed', 'cancelled']);
const isVerdict = oneOf<CaseVerdict>(['passed', 'failed', 'skipped']);
const isCheckStatus = oneOf<CheckStatus>(['passed', 'failed', 'error', 'skipped']);
const isDoneStatus = oneOf<EvalDoneFrame['status']>(['completed', 'cancelled']);
const isScorerKind = oneOf<ScorerKind>(['equals', 'contains', 'regex', 'oneOf', 'llm_judge']);

const isCount = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && Number.isInteger(value);
const isAmount = (value: unknown): value is number => isFiniteNumber(value) && value >= 0;
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isNullableNumber = (value: unknown): value is number | null => value === null || isFiniteNumber(value);

export const parseStartedFrame = (raw: unknown): EvalStartedFrame | null => {
  if (!isRecord(raw)) return null;
  const evalId = raw['evalId'];
  const datasetName = raw['datasetName'];
  const caseCount = raw['caseCount'];
  const mode = raw['mode'];
  const model = raw['model'];
  if (!isString(evalId) || !isString(datasetName) || !isCount(caseCount) || !isMode(mode)) return null;
  // `model` is absent from servers that predate it; that reads as unknown, not as an error.
  return { evalId, datasetName, caseCount, mode, model: isString(model) ? model : null };
};

export const parseCaseStartedFrame = (raw: unknown): EvalCaseStartedFrame | null => {
  if (!isRecord(raw) || !isString(raw['caseId']) || !isCount(raw['index'])) return null;
  return { caseId: raw['caseId'], index: raw['index'] };
};

const parseCheckFrame = (raw: unknown): EvalCheckFrame | null => {
  if (!isRecord(raw)) return null;
  const nodeId = raw['nodeId'];
  const scorer = raw['scorer'];
  const status = raw['status'];
  const detail = raw['detail'];
  const actual = raw['actual'];
  const score = raw['score'];
  if (!isString(nodeId) || !isString(scorer) || !isCheckStatus(status) || !isString(detail)) return null;
  if (!isNullableString(actual) || !isNullableNumber(score)) return null;
  return { nodeId, scorer, status, detail, actual, score };
};

export const parseCaseFrame = (raw: unknown): EvalCaseFrame | null => {
  if (!isRecord(raw) || !Array.isArray(raw['checks'])) return null;
  const caseId = raw['caseId'];
  const index = raw['index'];
  const runOutcome = raw['runOutcome'];
  const verdict = raw['verdict'];
  const durationMs = raw['durationMs'];
  const costInUSD = raw['costInUSD'];
  const totalTokens = raw['totalTokens'];
  if (!isString(caseId) || !isCount(index) || !isRunOutcome(runOutcome) || !isVerdict(verdict)) return null;
  if (!isAmount(durationMs) || !isAmount(costInUSD) || !isCount(totalTokens)) return null;
  const checks: EvalCheckFrame[] = [];
  for (const rawCheck of raw['checks']) {
    const check = parseCheckFrame(rawCheck);
    // One bad check invalidates the case: a partial list would misstate its verdict.
    if (check === null) return null;
    checks.push(check);
  }
  return { caseId, index, runOutcome, verdict, durationMs, costInUSD, totalTokens, checks };
};

const parsePassRate = (raw: unknown): PassRate | null => {
  if (!isRecord(raw)) return null;
  const passed = raw['passed'];
  const total = raw['total'];
  const rate = raw['rate'];
  if (!isCount(passed) || !isCount(total) || passed > total || !isNullableNumber(rate)) return null;
  return { passed, total, rate };
};

/** Entries of a record of pass rates; `null` if any value is not a pass rate. */
const parseRateEntries = (raw: unknown): [string, PassRate][] | null => {
  if (!isRecord(raw)) return null;
  const entries: [string, PassRate][] = [];
  for (const [key, value] of Object.entries(raw)) {
    const rate = parsePassRate(value);
    if (rate === null) return null;
    entries.push([key, rate]);
  }
  return entries;
};

const parseJudgeScore = (raw: unknown): JudgeScoreStats | null | undefined => {
  if (raw === null) return null;
  if (!isRecord(raw) || !isFiniteNumber(raw['mean']) || !isCount(raw['count'])) return undefined;
  return { mean: raw['mean'], count: raw['count'] };
};

const parseDuration = (raw: unknown): DurationStats | null | undefined => {
  if (raw === null) return null;
  if (!isRecord(raw)) return undefined;
  const meanMs = raw['meanMs'];
  const p50Ms = raw['p50Ms'];
  const p95Ms = raw['p95Ms'];
  const maxMs = raw['maxMs'];
  if (!isAmount(meanMs) || !isAmount(p50Ms) || !isAmount(p95Ms) || !isAmount(maxMs)) return undefined;
  return { meanMs, p50Ms, p95Ms, maxMs };
};

const parseJudgeUsage = (raw: unknown): JudgeUsageTotals | null => {
  if (!isRecord(raw)) return null;
  const calls = raw['calls'];
  const inputTokens = raw['inputTokens'];
  const outputTokens = raw['outputTokens'];
  const costInUSD = raw['costInUSD'];
  if (!isCount(calls) || !isCount(inputTokens) || !isCount(outputTokens) || !isAmount(costInUSD)) return null;
  return { calls, inputTokens, outputTokens, costInUSD };
};

export const parseSummaryFrame = (raw: unknown): EvalSummaryFrame | null => {
  if (!isRecord(raw)) return null;
  const cases = parsePassRate(raw['cases']);
  const checks = parsePassRate(raw['checks']);
  const nodeRates = parseRateEntries(raw['byNode']);
  const scorerRates = parseRateEntries(raw['byScorer']);
  const judgeScore = parseJudgeScore(raw['judgeScore']);
  const duration = parseDuration(raw['duration']);
  const judgeUsage = parseJudgeUsage(raw['judgeUsage']);
  const erroredChecks = raw['erroredChecks'];
  const skippedChecks = raw['skippedChecks'];
  const totalCostInUSD = raw['totalCostInUSD'];
  const meanCostInUSD = raw['meanCostInUSD'];
  const totalTokens = raw['totalTokens'];
  if (cases === null || checks === null || nodeRates === null || scorerRates === null) return null;
  if (judgeScore === undefined || duration === undefined || judgeUsage === null) return null;
  if (!isCount(erroredChecks) || !isCount(skippedChecks) || !isCount(totalTokens)) return null;
  if (!isAmount(totalCostInUSD) || !(meanCostInUSD === null || isAmount(meanCostInUSD))) return null;
  return {
    cases,
    checks,
    erroredChecks,
    skippedChecks,
    byNode: Object.fromEntries(nodeRates),
    // Scorer kinds this client does not know are dropped rather than shown unlabeled.
    byScorer: Object.fromEntries(scorerRates.filter(([kind]) => isScorerKind(kind))),
    judgeScore,
    duration,
    totalCostInUSD,
    meanCostInUSD,
    totalTokens,
    judgeUsage,
  };
};

export const parseDoneFrame = (raw: unknown): EvalDoneFrame | null =>
  isRecord(raw) && isDoneStatus(raw['status']) ? { status: raw['status'] } : null;
