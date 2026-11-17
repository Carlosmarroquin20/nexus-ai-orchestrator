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
import { createJudge } from '@/server/evaluation/judge';
import type { LlmProvider } from '@/server/llm/types';
import type { ExecutionDescriptor, RunOutcome } from '@/types/execution';
import type { EvalDataset } from '@/utils/evaluation/dataset';
import type { JudgeUsageTotals } from '@/utils/evaluation/protocol';
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
  /** Cost of grading with the LLM judge, kept apart from the pipeline's own cost. */
  readonly judgeUsage: JudgeUsageTotals;
}

/** Runs and scores every case. Never rejects. */
export const runEvaluation = async (options: EvaluationOptions): Promise<EvaluationResult> => {
  const { evalId, graph, dataset, provider, signal, onCaseStarted, onCaseScored } = options;
  const cases: EvaluatedCase[] = [];

  // Judge calls are evaluation overhead: case duration, cost, and tokens describe
  // the pipeline under test, and grading is accounted separately.
  const judgeUsage = { calls: 0, inputTokens: 0, outputTokens: 0, costInUSD: 0 };
  const judge = createJudge({
    provider,
    signal,
    onUsage: (usage) => {
      judgeUsage.calls += 1;
      judgeUsage.inputTokens += usage.inputTokens;
      judgeUsage.outputTokens += usage.outputTokens;
      judgeUsage.costInUSD += usage.costInUSD;
    },
  });

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
    const durationMs = Date.now() - startedAt;

    const checks = await scoreCase(
      evalCase,
      new Map([...run.nodes].map(([nodeId, record]) => [nodeId, record.outputText])),
      judge,
    );
    // Cancelled while judging: the case is incomplete and is not reported.
    if (signal.aborted) break;

    const records = [...run.nodes.values()];
    const evaluated: EvaluatedCase = {
      index,
      runOutcome: run.outcome,
      score: {
        caseId: evalCase.id,
        checks,
        durationMs,
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
    judgeUsage,
  };
};
