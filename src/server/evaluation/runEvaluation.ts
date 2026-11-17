/**
 * Dataset evaluation (ADR 0010): runs every case of a dataset through the pipeline
 * engine and scores it against the full node outputs.
 *
 * Cases run one after another, never concurrently: each case already runs the
 * independent nodes of a level in parallel, and running cases in parallel on top
 * would multiply the request rate against a rate-limited free tier. Fault
 * injection is always off, since injected failures would distort the metrics.
 *
 * Transport-agnostic, like the engine: progress is reported through callbacks.
 */

import { runPipeline } from '@/server/engine/runPipeline';
import type { LlmProvider } from '@/server/llm/types';
import type { ExecutionDescriptor, RunOutcome } from '@/types/execution';
import type { EvalDataset } from '@/utils/evaluation/dataset';
import { scoreCase } from '@/utils/evaluation/scorers';
import { type CaseScore, type EvalSummary, summarizeEvaluation } from '@/utils/evaluation/summary';

export interface EvaluatedCase {
  readonly index: number;
  readonly runOutcome: RunOutcome;
  readonly score: CaseScore;
}

export interface EvaluationOptions {
  readonly evalId: string;
  readonly graph: ExecutionDescriptor;
  readonly dataset: EvalDataset;
  /** Model backend; `null` selects the simulator. */
  readonly provider: LlmProvider | null;
  /** Stops the evaluation; the case in progress is abandoned and not scored. */
  readonly signal: AbortSignal;
  /** Called before each case runs. Must not throw. */
  readonly onCaseStarted: (caseId: string, index: number) => void;
  /** Called once each case is scored. Must not throw. */
  readonly onCaseScored: (evaluated: EvaluatedCase) => void;
}

export interface EvaluationResult {
  readonly outcome: 'completed' | 'cancelled';
  /** Every case scored before completion or cancellation, in dataset order. */
  readonly cases: readonly EvaluatedCase[];
  /** Metrics over the scored cases only. */
  readonly summary: EvalSummary;
}

/** Runs and scores every case. Never rejects. */
export const runEvaluation = async (options: EvaluationOptions): Promise<EvaluationResult> => {
  const { evalId, graph, dataset, provider, signal, onCaseStarted, onCaseScored } = options;
  const cases: EvaluatedCase[] = [];

  for (const [index, evalCase] of dataset.cases.entries()) {
    if (signal.aborted) break;
    onCaseStarted(evalCase.id, index);

    const startedAt = Date.now();
    const run = await runPipeline({
      runId: `${evalId}:${evalCase.id}`,
      descriptor: graph,
      input: evalCase.input,
      failRate: 0,
      provider,
      signal,
      // Per-node telemetry is not part of an evaluation report.
      onEvent: () => undefined,
    });
    if (run.outcome === 'cancelled') break;

    const records = [...run.nodes.values()];
    const evaluated: EvaluatedCase = {
      index,
      runOutcome: run.outcome,
      score: {
        caseId: evalCase.id,
        checks: scoreCase(
          evalCase,
          new Map([...run.nodes].map(([nodeId, record]) => [nodeId, record.outputText])),
        ),
        durationMs: Date.now() - startedAt,
        costInUSD: records.reduce((sum, record) => sum + record.costInUSD, 0),
        totalTokens: records.reduce(
          (sum, record) => sum + record.inputTokens + record.outputTokens,
          0,
        ),
      },
    };
    cases.push(evaluated);
    onCaseScored(evaluated);
  }

  return {
    outcome: signal.aborted ? 'cancelled' : 'completed',
    cases,
    summary: summarizeEvaluation(cases.map((evaluated) => evaluated.score)),
  };
};
