import { afterEach, describe, expect, it, vi } from 'vitest';

import { type PipelineRunOptions, runPipeline } from '@/server/engine/runPipeline';
import { LlmError, type LlmGenerateRequest, type LlmProvider } from '@/server/llm/types';
import type { ExecutionDescriptor } from '@/types/execution';
import type { TelemetryEvent } from '@/types/graph';

/**
 * Engine tests: no HTTP, no network. A fake provider stands in for the model, so
 * data flow, parameter forwarding, failure propagation, and cancellation are
 * observable directly on the engine's callback and result.
 */

const chain = (...kinds: Array<[string, string, Record<string, unknown>?]>): ExecutionDescriptor => ({
  nodes: kinds.map(([id, kind, params]) => ({
    id,
    kind: kind as ExecutionDescriptor['nodes'][number]['kind'],
    params: params ?? {},
  })),
  edges: kinds.slice(1).map(([id], index) => ({ source: kinds[index]![0], target: id })),
});

interface FakeProvider extends LlmProvider {
  readonly requests: LlmGenerateRequest[];
}

/** A provider whose reply is computed from the request; records every request. */
const fakeProvider = (reply: (request: LlmGenerateRequest) => string | Promise<string>): FakeProvider => {
  const requests: LlmGenerateRequest[] = [];
  return {
    id: 'fake',
    model: 'fake-model',
    pricing: { inputPerMillionUSD: 1, outputPerMillionUSD: 2 },
    requests,
    generate: async (request) => {
      requests.push(request);
      const text = await reply(request);
      return { text, inputTokens: 10, outputTokens: 5, latencyMs: 7 };
    },
  };
};

const run = (overrides: Partial<PipelineRunOptions> & Pick<PipelineRunOptions, 'descriptor'>) => {
  const events: TelemetryEvent[] = [];
  const result = runPipeline({
    runId: 'run_test',
    input: 'What is my balance?',
    failRate: 0,
    provider: null,
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { events, result };
};

const trace = (events: readonly TelemetryEvent[]): string[] =>
  events.map((event) => `${event.nodeId}:${event.state}`);

afterEach(() => {
  vi.useRealTimers();
});

describe('runPipeline: simulated mode', () => {
  it('feeds the run input to sources and returns every node in dependency order', async () => {
    vi.useFakeTimers();
    const { events, result } = run({
      descriptor: chain(['a', 'LLM_CORE'], ['b', 'PROMPT_TEMPLATE', { template: 'Answer: {{x}}' }]),
    });
    await vi.runAllTimersAsync();
    const { outcome, nodes } = await result;

    expect(outcome).toBe('completed');
    expect(trace(events)).toEqual(['a:running', 'a:completed', 'b:running', 'b:completed']);
    expect(events[0]!.patch.inputPayload).toEqual({ input: 'What is my balance?' });
    expect(nodes.get('a')!.outputText).toBe('Simulated LLM_CORE output.');
    expect(nodes.get('b')!.outputText).toBe('Answer: Simulated LLM_CORE output.');
  });
});

describe('runPipeline: with a provider', () => {
  it('passes each output downstream and forwards prompts and sampling settings', async () => {
    const provider = fakeProvider((request) => `reply to <${request.prompt}>`);
    const { result } = run({
      provider,
      descriptor: chain(
        ['core', 'LLM_CORE', { temperature: 0.1, maxOutputTokens: 64, topP: 0.5 }],
        ['agent', 'AGENT', { systemPrompt: 'be brief', temperature: 0.3 }],
      ),
    });
    const { outcome, nodes } = await result;

    expect(outcome).toBe('completed');
    expect(provider.requests[0]).toMatchObject({
      prompt: 'What is my balance?',
      temperature: 0.1,
      maxOutputTokens: 64,
      topP: 0.5,
    });
    expect(provider.requests[1]).toMatchObject({
      prompt: 'reply to <What is my balance?>',
      systemInstruction: 'be brief',
      temperature: 0.3,
    });
    expect(nodes.get('agent')).toMatchObject({
      state: 'completed',
      outputText: 'reply to <reply to <What is my balance?>>',
      inputTokens: 10,
      outputTokens: 5,
      latencyMs: 7,
      error: null,
    });
    // Cost is derived from the provider's own pricing: 10 in at $1/M + 5 out at $2/M.
    expect(nodes.get('agent')!.costInUSD).toBeCloseTo(0.00002, 10);
  });

  it('returns the full output while events carry a truncated preview', async () => {
    const long = 'x'.repeat(5_000);
    const { events, result } = run({ provider: fakeProvider(() => long), descriptor: chain(['a', 'LLM_CORE']) });
    const { nodes } = await result;

    expect(nodes.get('a')!.outputText).toBe(long);
    const preview = events.find((event) => event.state === 'completed')!.patch.outputPayload!['output'];
    expect(typeof preview === 'string' && preview.length < long.length).toBe(true);
  });

  it('records a provider failure, skips its descendants, and fails the run', async () => {
    const provider = fakeProvider(() => {
      throw new LlmError('rate limited', 429);
    });
    const { events, result } = run({
      provider,
      descriptor: chain(['a', 'LLM_CORE'], ['b', 'AGENT'], ['c', 'PROMPT_TEMPLATE']),
    });
    const { outcome, nodes } = await result;

    expect(outcome).toBe('failed');
    expect(trace(events)).toEqual(['a:running', 'a:failed', 'b:skipped', 'c:skipped']);
    expect(nodes.get('a')!.error).toEqual({ code: 'LLM_429', message: 'rate limited' });
    expect(nodes.get('c')).toMatchObject({ state: 'skipped', outputText: null });
    expect(provider.requests).toHaveLength(1);
  });

  it('injects faults at the requested rate without calling the provider', async () => {
    const provider = fakeProvider(() => 'never');
    const { result } = run({ provider, failRate: 1, descriptor: chain(['a', 'AGENT'], ['b', 'AGENT']) });
    const { outcome, nodes } = await result;

    expect(outcome).toBe('failed');
    expect(nodes.get('a')!.error?.code).toBe('INJECTED_FAILURE');
    expect(nodes.get('b')!.state).toBe('skipped');
    expect(provider.requests).toHaveLength(0);
  });
});

describe('runPipeline: cancellation', () => {
  it('stops at the abort, emits nothing after it, and resolves as cancelled', async () => {
    const controller = new AbortController();
    let releaseFirstCall: (() => void) | null = null;
    const provider = fakeProvider(
      () =>
        new Promise<string>((resolve) => {
          releaseFirstCall = () => resolve('late reply');
        }),
    );
    const { events, result } = run({
      provider,
      signal: controller.signal,
      descriptor: chain(['a', 'LLM_CORE'], ['b', 'AGENT']),
    });

    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    expect(provider.requests[0]!.signal).toBe(controller.signal);
    controller.abort();
    releaseFirstCall!();
    const { outcome, nodes } = await result;

    expect(outcome).toBe('cancelled');
    expect(trace(events)).toEqual(['a:running']);
    expect(nodes.size).toBe(0);
  });

  it('does nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { events, result } = run({
      provider: fakeProvider(() => 'never'),
      signal: controller.signal,
      descriptor: chain(['a', 'LLM_CORE']),
    });
    const { outcome } = await result;

    expect(outcome).toBe('cancelled');
    expect(events).toEqual([]);
  });
});
