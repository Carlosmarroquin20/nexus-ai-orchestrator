/**
 * Evaluation controller (client side, ADR 0010).
 *
 * Mirrors the run controller: plain functions any component can call, one
 * module-level `AbortController` so at most one evaluation stream is open, and a
 * staleness check before every store write so a stopped or superseded stream
 * cannot write into the evaluation that replaced it.
 *
 * Flow: `startEvaluation` checks locally what the server would reject anyway
 * (empty pipeline, checks on nodes the pipeline lacks) to answer without a round
 * trip, posts the current pipeline and the selected dataset, and folds the
 * streamed frames into the store's progress. When the server finishes the
 * evaluation (completed, or cancelled with a summary) it is added to the local
 * history with the fingerprints of what ran. A rejected request, a transport
 * error, or a stream that closes early fails the evaluation with the reason.
 * Stopping from the client cancels it without recording it: the server never
 * sends the summary of an evaluation whose request was aborted.
 */

import { useEvaluationStore } from '@/store/useEvaluationStore';
import { useGraphStore } from '@/store/useGraphStore';
import { buildExecutionDescriptor } from '@/utils/executionDescriptor';
import { type EvalDataset, findUnknownNodeIds, parseEvalDataset } from '@/utils/evaluation/dataset';
import { datasetFingerprint, pipelineFingerprint } from '@/utils/evaluation/fingerprint';
import { toEvalRecord } from '@/utils/evaluation/history';
import {
  CONNECTING_PROGRESS,
  type EvalProgress,
  applyEvalEvent,
  cancelProgress,
  failProgress,
} from '@/utils/evaluation/progress';
import type { EvaluationRequest } from '@/utils/evaluation/protocol';
import type { SseEvent } from '@/utils/sseParser';
import { safeJsonParse } from '@/utils/telemetryEvent';

import { readEventStream, readRejection } from './eventStreamClient';

const STREAM_ENDPOINT = '/api/evals/stream';

/**
 * Largest dataset file accepted for import. The server caps the whole request
 * (pipeline included) at 2.5 MB; refusing larger files here saves an upload that
 * could only be rejected.
 */
export const MAX_DATASET_FILE_BYTES = 2_000_000;

/** Unknown node ids quoted in a mismatch message before it is shortened. */
const MAX_QUOTED_NODE_IDS = 5;

const FAILURE_REASON = {
  emptyPipeline: 'Add nodes to the pipeline before evaluating it.',
  unreachable: 'Could not reach the evaluation endpoint.',
  interrupted: 'The evaluation stream closed before the evaluation finished.',
} as const;

interface Fingerprints {
  readonly dataset: string;
  readonly pipeline: string;
}

let activeController: AbortController | null = null;

const updateProgress = (update: (progress: EvalProgress) => EvalProgress): void =>
  useEvaluationStore.getState().updateProgress(update);

/** Detaches and aborts the active stream, if any. */
const teardown = (): void => {
  const controller = activeController;
  // Cleared before aborting, so the aborted stream's continuations see themselves as stale.
  activeController = null;
  controller?.abort();
};

const fail = (reason: string): void => {
  activeController = null;
  updateProgress((progress) => failProgress(progress, reason));
};

/** Records the evaluation if the server finished it with a summary. */
const recordIfFinished = (progress: EvalProgress, fingerprints: Fingerprints): void => {
  const { started, summary, phase } = progress;
  if (started === null || summary === null) return;
  if (phase !== 'completed' && phase !== 'cancelled') return;
  useEvaluationStore.getState().recordEvaluation(
    toEvalRecord({
      started,
      cases: progress.cases,
      summary,
      status: phase,
      finishedAt: Date.now(),
      datasetFingerprint: fingerprints.dataset,
      pipelineFingerprint: fingerprints.pipeline,
    }),
  );
};

const consumeStream = async (
  controller: AbortController,
  request: EvaluationRequest,
  fingerprints: Fingerprints,
): Promise<void> => {
  const isCurrent = (): boolean => activeController === controller;

  const onEvent = (event: SseEvent): boolean => {
    updateProgress((progress) => applyEvalEvent(progress, event));
    if (event.event !== 'done') return false;
    const { progress } = useEvaluationStore.getState();
    // A malformed `done` frame leaves the evaluation open; keep reading until the body ends.
    if (progress.phase === 'running') return false;
    activeController = null;
    recordIfFinished(progress, fingerprints);
    return true;
  };

  try {
    const response = await fetch(STREAM_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(request),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!isCurrent()) return;
    if (!response.ok || response.body === null) {
      const reason = await readRejection(response, 'Evaluation request');
      if (isCurrent()) fail(reason);
      return;
    }
    const end = await readEventStream(response.body, { isCurrent, onEvent });
    if (end === 'ended') fail(FAILURE_REASON.interrupted);
  } catch {
    // An abort issued by `teardown` has already cleared the controller.
    if (isCurrent()) fail(FAILURE_REASON.unreachable);
  }
};

/** Message for dataset checks that name nodes the pipeline does not have, or `null`. */
const mismatchReason = (dataset: EvalDataset, nodeIds: ReadonlySet<string>): string | null => {
  const unknown = findUnknownNodeIds(dataset, nodeIds);
  if (unknown.length === 0) return null;
  const quoted = unknown.slice(0, MAX_QUOTED_NODE_IDS).map((id) => `"${id}"`);
  const more = unknown.length > MAX_QUOTED_NODE_IDS ? ` and ${unknown.length - MAX_QUOTED_NODE_IDS} more` : '';
  return (
    `The dataset checks nodes this pipeline does not have: ${quoted.join(', ')}${more}. ` +
    "Load the pipeline it was written for, or edit the dataset's node ids."
  );
};

/**
 * Evaluates the current pipeline against the selected dataset. No-op without a
 * selected dataset; an evaluation already in flight is replaced.
 */
export const startEvaluation = (): void => {
  const { selection } = useEvaluationStore.getState();
  if (selection === null) return;

  teardown();
  const { nodes, edges } = useGraphStore.getState();
  if (nodes.length === 0) {
    updateProgress(() => failProgress(CONNECTING_PROGRESS, FAILURE_REASON.emptyPipeline));
    return;
  }
  const graph = buildExecutionDescriptor(nodes, edges);
  const mismatch = mismatchReason(selection.dataset, new Set(graph.nodes.map((node) => node.id)));
  if (mismatch !== null) {
    updateProgress(() => failProgress(CONNECTING_PROGRESS, mismatch));
    return;
  }

  const request: EvaluationRequest = {
    evalId: `eval_${crypto.randomUUID()}`,
    graph,
    dataset: selection.dataset,
  };
  const fingerprints: Fingerprints = {
    dataset: datasetFingerprint(selection.dataset),
    pipeline: pipelineFingerprint(graph),
  };

  updateProgress(() => CONNECTING_PROGRESS);
  const controller = new AbortController();
  activeController = controller;
  void consumeStream(controller, request, fingerprints);
};

/** Stops the evaluation in flight. Cases already scored stay visible. Safe when idle. */
export const stopEvaluation = (): void => {
  teardown();
  updateProgress(cancelProgress);
};

export type DatasetFileResult =
  | { readonly ok: true; readonly dataset: EvalDataset }
  | { readonly ok: false; readonly error: string };

/** Reads and validates a dataset file chosen by the user. Never throws. */
export const readDatasetFile = async (file: File): Promise<DatasetFileResult> => {
  if (file.size > MAX_DATASET_FILE_BYTES) {
    return { ok: false, error: `The file is larger than ${MAX_DATASET_FILE_BYTES / 1_000_000} MB.` };
  }
  const text = await file.text().catch(() => null);
  if (text === null) return { ok: false, error: 'The file could not be read.' };
  const raw = safeJsonParse(text);
  if (raw === null) return { ok: false, error: 'The file is not valid JSON.' };
  return parseEvalDataset(raw);
};
