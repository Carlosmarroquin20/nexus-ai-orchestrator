import { describe, expect, it } from 'vitest';

import { type EvaluationOptions, runEvaluation } from '@/server/evaluation/runEvaluation';
import { LlmError, type LlmGenerateRequest, type LlmProvider } from '@/server/llm/types';
import type { ExecutionDescriptor } from '@/types/execution';
import type { EvalDataset } from '@/utils/evaluation/dataset';

/**
 * Evaluator tests with a scripted classifier standing in for the model, so each
 * case's verdict is known in advance.
 */

const graph: ExecutionDescriptor = {
  nodes: [
    { id: 'cls', kind: 'CLASSIFIER', params: { labels: ['billing', 'technical', 'general'] } },
    { id: 'answer', kind: 'PROMPT_TEMPLATE', params: { template: 'Routed to {{label}}' } },
  ],
  edges: [{ source: 'cls', target: 'answer' }],
};

const dataset: EvalDataset = {
  version: 1,
  name: 'Routing',
  cases: [
    {
      id: 'charge',
      input: 'Why was I charged twice?',
      checks: [
        { scorer: 'equals', nodeId: 'cls', expected: 'billing' },
        { scorer: 'contains', nodeId: 'answer', expected: 'billing' },
      ],
    },
    {
      id: 'crash',
      input: 'The app crashes on upload.',
      checks: [{ scorer: 'equals', nodeId: 'cls', expected: 'billing' }],
    },
    {
      id: 'outage',
      input: 'boom',
      checks: [{ scorer: 'equals', nodeId: 'cls', expected: 'general' }],
    },
  ],
};

interface ScriptedProvider extends LlmProvider {
  readonly prompts: string[];
}

/** Labels by keyword; fails on "boom"; optionally holds a call until released. */
const scriptedClassifier = (hold?: Promise<void>): ScriptedProvider => {
  const prompts: string[] = [];
  return {
    id: 'scripted',
    model: 'scripted',
    pricing: { inputPerMillionUSD: 1_000_000, outputPerMillionUSD: 0 },
    prompts,
    generate: async (request: LlmGenerateRequest) => {
      prompts.push(request.prompt);
      if (hold !== undefined) await hold;
      if (request.prompt.includes('boom')) throw new LlmError('upstream unavailable', 503);
      const text = request.prompt.includes('charged') ? 'Billing.' : 'technical';
      return { text, inputTokens: 3, outputTokens: 2, latencyMs: 1 };
    },
  };
};

const evaluate = (overrides: Partial<EvaluationOptions> = {}) => {
  const log: string[] = [];
  const result = runEvaluation({
    evalId: 'eval_1',
    graph,
    dataset,
    provider: scriptedClassifier(),
    signal: new AbortController().signal,
    onCaseStarted: (caseId, index) => log.push(`start:${caseId}:${index}`),
    onCaseScored: ({ score }) => log.push(`scored:${score.caseId}`),
    ...overrides,
  });
  return { log, result };
};

describe('runEvaluation', () => {
  it('runs every case in order and scores it against the full outputs', async () => {
    const { log, result } = evaluate();
    const { outcome, cases, summary } = await result;

    expect(outcome).toBe('completed');
    expect(log).toEqual([
      'start:charge:0',
      'scored:charge',
      'start:crash:1',
      'scored:crash',
      'start:outage:2',
      'scored:outage',
    ]);
    expect(cases.map((evaluated) => evaluated.score.checks.map((check) => check.status))).toEqual([
      ['passed', 'passed'],
      ['failed'],
      ['error'],
    ]);
    expect(cases[0]!.score.checks[1]!.actual).toBe('Routed to Billing.');
    expect(cases.map((evaluated) => evaluated.runOutcome)).toEqual(['completed', 'completed', 'failed']);

    expect(summary.cases).toEqual({ passed: 1, total: 3, rate: 1 / 3 });
    expect(summary.checks).toEqual({ passed: 2, total: 4, rate: 0.5 });
    expect(summary.erroredChecks).toBe(1);
  });

  it('feeds each case its own input', async () => {
    const provider = scriptedClassifier();
    await evaluate({ provider }).result;
    expect(provider.prompts.map((prompt) => prompt.split('Request: ')[1])).toEqual([
      'Why was I charged twice?',
      'The app crashes on upload.',
      'boom',
    ]);
  });

  it('accounts tokens and provider-priced cost per case', async () => {
    const { cases } = await evaluate().result;
    // One classifier call per case: 3 input tokens at $1 per token, 2 output tokens free.
    expect(cases[0]!.score.totalTokens).toBe(5);
    expect(cases[0]!.score.costInUSD).toBeCloseTo(3, 10);
    // The failed call reports no usage.
    expect(cases[2]!.score.totalTokens).toBe(0);
  });

  it('stops between cases when cancelled and summarizes only the scored ones', async () => {
    const controller = new AbortController();
    const { log, result } = evaluate({
      signal: controller.signal,
      onCaseScored: ({ score }) => {
        log.push(`scored:${score.caseId}`);
        controller.abort();
      },
    });
    const { outcome, cases, summary } = await result;

    expect(outcome).toBe('cancelled');
    expect(log).toEqual(['start:charge:0', 'scored:charge']);
    expect(cases).toHaveLength(1);
    expect(summary.cases.total).toBe(1);
  });

  it('abandons the case in progress without scoring it', async () => {
    const controller = new AbortController();
    let release!: () => void;
    const provider = scriptedClassifier(new Promise<void>((resolve) => (release = resolve)));
    const { log, result } = evaluate({ provider, signal: controller.signal });

    while (provider.prompts.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    release();
    const { outcome, cases } = await result;

    expect(outcome).toBe('cancelled');
    expect(cases).toEqual([]);
    expect(log).toEqual(['start:charge:0']);
  });
});
