/**
 * Inputs of the evaluation runner (ADR 0010): which dataset and which pipeline
 * to evaluate, validated exactly like a request to the evaluation endpoint.
 * Pure: the entry point reads the files and passes their parsed JSON.
 *
 * The pipeline comes from a graph file exported from the editor (the same
 * snapshot format the editor imports), or is the demo pipeline. Going through
 * `parseEvaluationRequest` gives the command line the endpoint's limits: node
 * count, dataset shape, node ids that exist, and the model-call budget, which
 * keeps an evaluation inside the free tier however it is started.
 */

import { createDemoPipeline } from '@/config/demoPipeline';
import { BUNDLED_DATASETS } from '@/config/evalDatasets';
import type { ExecutionDescriptor } from '@/types/execution';
import { type EvaluationRequest, parseEvaluationRequest } from '@/utils/evaluation/protocol';
import { buildExecutionDescriptor } from '@/utils/executionDescriptor';
import { parseGraph } from '@/utils/graphSerialization';

export type EvalInputsResult =
  | { readonly ok: true; readonly request: EvaluationRequest }
  | { readonly ok: false; readonly error: string };

/** Raw JSON of the bundled dataset with this id, or `undefined`. */
export const findBundledDataset = (id: string): unknown =>
  BUNDLED_DATASETS.find((entry) => entry.id === id)?.raw;

export const demoGraph = (): ExecutionDescriptor => {
  const { nodes, edges } = createDemoPipeline();
  return buildExecutionDescriptor(nodes, edges);
};

export interface EvalInputsSource {
  readonly evalId: string;
  /** Parsed graph file; `null` selects the demo pipeline. */
  readonly graphRaw: unknown;
  readonly datasetRaw: unknown;
}

export const resolveEvalInputs = ({
  evalId,
  graphRaw,
  datasetRaw,
}: EvalInputsSource): EvalInputsResult => {
  let graph: ExecutionDescriptor;
  if (graphRaw === null) {
    graph = demoGraph();
  } else {
    const parsed = parseGraph(graphRaw);
    if (!parsed.ok) return { ok: false, error: `Invalid graph file: ${parsed.error}` };
    graph = buildExecutionDescriptor(parsed.snapshot.nodes, parsed.snapshot.edges);
  }

  const parsed = parseEvaluationRequest({ evalId, graph, dataset: datasetRaw });
  return parsed.ok ? { ok: true, request: parsed.request } : { ok: false, error: parsed.error };
};
