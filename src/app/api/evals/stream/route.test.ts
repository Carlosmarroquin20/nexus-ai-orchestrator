import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EVAL_DATASET_SCHEMA_VERSION } from '@/utils/evaluation/dataset';
import type { EvalCaseFrame, EvalStartedFrame } from '@/utils/evaluation/protocol';
import type { EvalSummary } from '@/utils/evaluation/summary';
import { INITIAL_SSE_STATE, type SseEvent, feedSse } from '@/utils/sseParser';

import * as route from './route';

/**
 * Endpoint tests in simulated mode (no API key), with fake timers standing in for
 * the simulator's pacing. Scoring logic is covered by the evaluator tests; these
 * cover validation, status mapping, and the event contract.
 */

const ENDPOINT = 'http://localhost/api/evals/stream';

const graph = {
  nodes: [
    { id: 'tpl', kind: 'PROMPT_TEMPLATE', params: { template: 'Q: {{x}}' } },
    { id: 'llm', kind: 'LLM_CORE', params: {} },
  ],
  edges: [{ source: 'tpl', target: 'llm' }],
};

const dataset = {
  version: EVAL_DATASET_SCHEMA_VERSION,
  name: 'Smoke',
  cases: [
    { id: 'a', input: 'refund please', checks: [{ nodeId: 'tpl', scorer: 'equals', expected: 'Q: refund please' }] },
    { id: 'b', input: 'hello', checks: [{ nodeId: 'llm', scorer: 'contains', expected: 'billing' }] },
  ],
};

const body = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ evalId: 'eval_test', graph, dataset, ...overrides });

const post = (payload: string, headers: Record<string, string> = {}): Promise<Response> =>
  route.POST(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload,
    }),
  );

const readEvents = async (response: Response): Promise<SseEvent[]> => {
  const pending = response.text();
  await vi.runAllTimersAsync();
  return feedSse(INITIAL_SSE_STATE, await pending).events;
};

const dataOf = <T>(events: readonly SseEvent[], name: string): T[] =>
  events.filter((event) => event.event === name).map((event) => JSON.parse(event.data) as T);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('GEMINI_API_KEY', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('POST /api/evals/stream', () => {
  it('streams started, a start and a result per case, the summary, and done', async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await readEvents(response);
    expect(events.map((event) => event.event)).toEqual([
      'started',
      'case_started',
      'case',
      'case_started',
      'case',
      'summary',
      'done',
    ]);

    const [started] = dataOf<EvalStartedFrame>(events, 'started');
    expect(started).toEqual({ evalId: 'eval_test', datasetName: 'Smoke', caseCount: 2, mode: 'simulated' });

    const results = dataOf<EvalCaseFrame>(events, 'case');
    expect(results.map((frame) => [frame.caseId, frame.verdict])).toEqual([
      ['a', 'passed'],
      ['b', 'failed'],
    ]);
    expect(results[1]!.checks[0]).toMatchObject({
      nodeId: 'llm',
      scorer: 'contains',
      status: 'failed',
      actual: 'Simulated LLM_CORE output.',
      score: null,
    });

    const [summary] = dataOf<EvalSummary>(events, 'summary');
    expect(summary!.cases).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(dataOf(events, 'done')).toEqual([{ status: 'completed' }]);
  });

  it('maps each rejection to its status', async () => {
    expect((await post(body(), { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post('{nope')).status).toBe(400);
    expect((await post(body({ dataset: { version: 1, name: 'x', cases: [] } }))).status).toBe(400);

    const mismatch = await post(
      body({ dataset: { ...dataset, cases: [{ ...dataset.cases[0], checks: [{ nodeId: 'ghost', scorer: 'equals', expected: 'x' }] }] } }),
    );
    expect(mismatch.status).toBe(422);
    expect(await mismatch.text()).toContain('ghost');

    const wide = { nodes: Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, kind: 'AGENT' })), edges: [] };
    const manyCases = Array.from({ length: 100 }, (_, i) => ({
      id: `c${i}`,
      input: 'q',
      checks: [{ nodeId: 'n0', scorer: 'equals', expected: 'x' }],
    }));
    expect((await post(body({ graph: wide, dataset: { ...dataset, cases: manyCases } }))).status).toBe(413);
  });

  it('runs one evaluation at a time and frees the slot when it ends', async () => {
    const first = await post(body());
    const busy = await post(body());
    expect(busy.status).toBe(429);
    expect(busy.headers.get('retry-after')).toBe('30');

    await readEvents(first);
    const next = await post(body());
    expect(next.status).toBe(200);
    await readEvents(next);
  });

  it('frees the slot when the client cancels the evaluation', async () => {
    const first = await post(body());
    await first.body!.cancel();
    await vi.runAllTimersAsync();

    const next = await post(body());
    expect(next.status).toBe(200);
    await readEvents(next);
  });

  it('does not let a rejected request hold the slot', async () => {
    expect((await post('{nope')).status).toBe(400);
    const next = await post(body());
    expect(next.status).toBe(200);
    await readEvents(next);
  });

  it('refuses an unauthenticated request when the access gate is enabled', async () => {
    vi.stubEnv('NEXUS_AUTH_USER', 'ada');
    vi.stubEnv('NEXUS_AUTH_PASSWORD', 'secret');
    expect((await post(body())).status).toBe(401);
  });

  it('exposes no GET handler', () => {
    expect('GET' in route).toBe(false);
  });
});
