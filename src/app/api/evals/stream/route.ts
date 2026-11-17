/**
 * Dataset evaluation stream: `POST /api/evals/stream` with an `EvaluationRequest`
 * JSON body (`evalId`, `graph`, `dataset`), ADR 0010.
 *
 * Runs every case of the dataset through the pipeline engine, one case at a time,
 * scores each against the full node outputs on the server, and streams progress.
 * Shares the run endpoint's guarantees through `server/http/eventStream`: JSON-only
 * bodies, a size cap, client-disconnect cancellation, and the keep-alive heartbeat.
 *
 * Event contract (frame types in `utils/evaluation/protocol`): `started`, then per
 * case `case_started` and `case`, then `summary` and a terminal `done`.
 */

import { enforceAccess } from '@/server/accessGate';
import { runEvaluation } from '@/server/evaluation/runEvaluation';
import { createEventStream, readJsonBody } from '@/server/http/eventStream';
import { resolveLlmProvider } from '@/server/llm/resolveProvider';
import {
  type EvalCaseFrame,
  type EvalCaseStartedFrame,
  type EvalDoneFrame,
  type EvalStartedFrame,
  type EvalSummaryFrame,
  type EvaluationRejection,
  MAX_FRAME_OUTPUT_LENGTH,
  parseEvaluationRequest,
} from '@/utils/evaluation/protocol';
import { isCasePassed } from '@/utils/evaluation/summary';
import { safeJsonParse } from '@/utils/telemetryEvent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Cap on the request body: the pipeline (bounded like a run request) plus a
 * dataset of up to 100 cases.
 */
const MAX_REQUEST_BYTES = 2_500_000;

const REJECTION_STATUS: Readonly<Record<EvaluationRejection, number>> = {
  MALFORMED: 400,
  EMPTY_GRAPH: 400,
  INVALID_DATASET: 400,
  DATASET_MISMATCH: 422,
  TOO_MANY_NODES: 413,
  OVER_BUDGET: 413,
};

/**
 * Evaluations allowed in flight per server process. One evaluation already makes
 * up to `MAX_EVAL_MODEL_CALLS` calls; letting callers start them in parallel
 * would multiply that against the provider quota (OWASP LLM10). The count is
 * in-memory and per instance: it bounds load, while the access gate remains the
 * control on who may evaluate at all.
 */
const MAX_CONCURRENT_EVALUATIONS = 1;
let activeEvaluations = 0;

const shorten = (text: string | null): string | null =>
  text === null || text.length <= MAX_FRAME_OUTPUT_LENGTH
    ? text
    : `${text.slice(0, MAX_FRAME_OUTPUT_LENGTH)}…`;

export async function POST(request: Request): Promise<Response> {
  // Re-checked here although the proxy also gates this path: an evaluation makes
  // many model calls, so it must not depend on the proxy matcher alone.
  const refusal = enforceAccess(request);
  if (refusal !== null) return refusal;

  const body = await readJsonBody(request, MAX_REQUEST_BYTES, 'Evaluation request');
  if (!body.ok) return body.response;

  const parsed = parseEvaluationRequest(safeJsonParse(body.text));
  if (!parsed.ok) {
    return new Response(parsed.error, { status: REJECTION_STATUS[parsed.code] });
  }
  const { evalId, graph, dataset } = parsed.request;
  const provider = resolveLlmProvider();

  // Taken only after validation, so rejected requests never hold the slot; the
  // producer releases it however the evaluation ends.
  if (activeEvaluations >= MAX_CONCURRENT_EVALUATIONS) {
    return new Response(
      'An evaluation is already running on this server; try again when it finishes.',
      { status: 429, headers: { 'Retry-After': '30' } },
    );
  }
  activeEvaluations += 1;

  return createEventStream(request, async ({ signal, send }) => {
    try {
      const started: EvalStartedFrame = {
        evalId,
        datasetName: dataset.name,
        caseCount: dataset.cases.length,
        mode: provider !== null ? 'real' : 'simulated',
      };
      send('started', started);

      const { outcome, summary } = await runEvaluation({
        evalId,
        graph,
        dataset,
        provider,
        signal,
        onCaseStarted: (caseId, index) => {
          const frame: EvalCaseStartedFrame = { caseId, index };
          send('case_started', frame);
        },
        onCaseScored: ({ index, runOutcome, score }) => {
          const frame: EvalCaseFrame = {
            caseId: score.caseId,
            index,
            runOutcome,
            passed: isCasePassed(score),
            durationMs: score.durationMs,
            costInUSD: score.costInUSD,
            totalTokens: score.totalTokens,
            checks: score.checks.map((result) => ({
              nodeId: result.check.nodeId,
              scorer: result.check.scorer,
              status: result.status,
              detail: result.detail,
              actual: shorten(result.actual),
            })),
          };
          send('case', frame);
        },
      });

      const summaryFrame: EvalSummaryFrame = summary;
      send('summary', summaryFrame);
      const done: EvalDoneFrame = { status: outcome };
      send('done', done);
    } finally {
      activeEvaluations -= 1;
    }
  });
}
