/**
 * Wire contract of the evaluation endpoint (`POST /api/evals/stream`, ADR 0010):
 * the request parser and the frames the server streams back. Pure and shared by
 * the server and the client.
 *
 * Event contract, in order: one `started`, then per case a `case_started` and a
 * `case` frame, then one `summary` and a terminal `done`. A stream that closes
 * without `done` means the evaluation was interrupted.
 */

import type { ExecutionDescriptor, ExecutionMode, RunOutcome } from '@/types/execution';
import { NODE_KIND } from '@/types/graph';

import { parseGraphDescriptor } from '../executionRequest';
import { isRecord, isString } from '../guards';
import { type EvalDataset, findUnknownNodeIds, parseEvalDataset } from './dataset';
import type { CheckStatus } from './scorers';
import type { CaseVerdict, EvalSummary } from './summary';

/** Evaluation ids are client-minted; the bound only rejects abuse. */
export const MAX_EVAL_ID_LENGTH = 128;

/**
 * Upper bound on model calls one evaluation may trigger: cases times LLM-backed
 * nodes. Without it a single request could fan out into thousands of billable
 * calls (OWASP LLM10, unbounded consumption). Sized for the bundled dataset with
 * ample room, while keeping a full evaluation inside free-tier quotas.
 */
export const MAX_EVAL_MODEL_CALLS = 300;

/** Display bound for the output quoted next to each verdict in a `case` frame. */
export const MAX_FRAME_OUTPUT_LENGTH = 2_000;

const LLM_BACKED_KINDS: ReadonlySet<string> = new Set([
  NODE_KIND.AGENT,
  NODE_KIND.LLM_CORE,
  NODE_KIND.CLASSIFIER,
]);

export interface EvaluationRequest {
  readonly evalId: string;
  readonly graph: ExecutionDescriptor;
  readonly dataset: EvalDataset;
}

export type EvaluationRejection =
  | 'MALFORMED'
  | 'EMPTY_GRAPH'
  | 'TOO_MANY_NODES'
  | 'INVALID_DATASET'
  | 'DATASET_MISMATCH'
  | 'OVER_BUDGET';

export type EvaluationRequestParseResult =
  | { readonly ok: true; readonly request: EvaluationRequest }
  | { readonly ok: false; readonly code: EvaluationRejection; readonly error: string };

const reject = (code: EvaluationRejection, error: string): EvaluationRequestParseResult => ({
  ok: false,
  code,
  error,
});

/** Model calls an evaluation of `dataset` against `graph` would trigger at most. */
export const countModelCalls = (graph: ExecutionDescriptor, dataset: EvalDataset): number =>
  graph.nodes.filter((node) => LLM_BACKED_KINDS.has(node.kind)).length * dataset.cases.length;

/** Narrows arbitrary JSON into an evaluation request, or a typed rejection. */
export const parseEvaluationRequest = (raw: unknown): EvaluationRequestParseResult => {
  if (!isRecord(raw)) return reject('MALFORMED', 'Request body must be a JSON object.');

  const evalId = raw['evalId'];
  if (!isString(evalId) || evalId.length === 0 || evalId.length > MAX_EVAL_ID_LENGTH) {
    return reject('MALFORMED', 'Missing or invalid "evalId".');
  }

  const parsedGraph = parseGraphDescriptor(raw['graph']);
  if (!parsedGraph.ok) return reject(parsedGraph.code, parsedGraph.error);
  const { graph } = parsedGraph;

  const parsedDataset = parseEvalDataset(raw['dataset']);
  if (!parsedDataset.ok) return reject('INVALID_DATASET', `Invalid dataset: ${parsedDataset.error}`);
  const { dataset } = parsedDataset;

  const unknown = findUnknownNodeIds(dataset, new Set(graph.nodes.map((node) => node.id)));
  if (unknown.length > 0) {
    return reject(
      'DATASET_MISMATCH',
      `The dataset checks nodes this pipeline does not contain: ${unknown.join(', ')}.`,
    );
  }

  const modelCalls = countModelCalls(graph, dataset);
  if (modelCalls > MAX_EVAL_MODEL_CALLS) {
    return reject(
      'OVER_BUDGET',
      `This evaluation would make up to ${modelCalls} model calls; the limit is ${MAX_EVAL_MODEL_CALLS}. Use fewer cases or a smaller pipeline.`,
    );
  }

  return { ok: true, request: { evalId, graph, dataset } };
};

/* --------------------------------- frames --------------------------------- */

export interface EvalStartedFrame {
  readonly evalId: string;
  readonly datasetName: string;
  readonly caseCount: number;
  /**
   * Simulated runs produce placeholder outputs, so their scores measure the
   * harness, not the pipeline; clients must say so.
   */
  readonly mode: ExecutionMode;
}

export interface EvalCaseStartedFrame {
  readonly caseId: string;
  /** Zero-based position of the case in the dataset. */
  readonly index: number;
}

export interface EvalCheckFrame {
  readonly nodeId: string;
  readonly scorer: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Inspected output, shortened to `MAX_FRAME_OUTPUT_LENGTH`; `null` when the node produced none. */
  readonly actual: string | null;
  /** Judge grade (1-5); `null` for deterministic checks. */
  readonly score: number | null;
}

export interface EvalCaseFrame {
  readonly caseId: string;
  readonly index: number;
  /** Outcome of the case's pipeline run; checks are scored whatever it is. */
  readonly runOutcome: RunOutcome;
  /** `skipped` when none of the case's checks was evaluated. */
  readonly verdict: CaseVerdict;
  readonly durationMs: number;
  readonly costInUSD: number;
  readonly totalTokens: number;
  readonly checks: readonly EvalCheckFrame[];
}

export type EvalSummaryFrame = EvalSummary;

export interface EvalDoneFrame {
  readonly status: 'completed' | 'cancelled';
}
