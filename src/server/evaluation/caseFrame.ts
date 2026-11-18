/**
 * Projection of a scored case onto its reported form (ADR 0010), shared by the
 * evaluation endpoint, which streams it as a `case` frame, and the command-line
 * runner, which writes it into a report. Pure.
 */

import type { EvaluatedCase } from '@/server/evaluation/runEvaluation';
import type { EvalCaseFrame } from '@/utils/evaluation/protocol';
import { caseVerdict } from '@/utils/evaluation/summary';

export interface CaseFrameOptions {
  /**
   * Length at which each check's inspected output is cut, with an ellipsis
   * appended. Omitted, outputs are reported in full.
   */
  readonly maxOutputLength?: number;
}

const shorten = (text: string | null, maxLength: number | undefined): string | null =>
  text === null || maxLength === undefined || text.length <= maxLength
    ? text
    : `${text.slice(0, maxLength)}…`;

export const toCaseFrame = (
  { index, runOutcome, score }: EvaluatedCase,
  { maxOutputLength }: CaseFrameOptions = {},
): EvalCaseFrame => ({
  caseId: score.caseId,
  index,
  runOutcome,
  verdict: caseVerdict(score),
  durationMs: score.durationMs,
  costInUSD: score.costInUSD,
  totalTokens: score.totalTokens,
  checks: score.checks.map((result) => ({
    nodeId: result.check.nodeId,
    scorer: result.check.scorer,
    status: result.status,
    detail: result.detail,
    actual: shorten(result.actual, maxOutputLength),
    score: result.score,
  })),
});
