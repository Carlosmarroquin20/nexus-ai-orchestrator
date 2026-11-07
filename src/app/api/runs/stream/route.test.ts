import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_EXECUTION_NODES } from '@/utils/executionRequest';
import { INITIAL_SSE_STATE, type SseEvent, feedSse } from '@/utils/sseParser';

import * as route from './route';

/**
 * Route-handler tests. The handler is invoked directly with a `Request`, in
 * simulated mode (no API key), with fake timers standing in for the simulator's
 * wall-clock pacing so a run completes instantly.
 */

const ENDPOINT = 'http://localhost/api/runs/stream';

const post = (body: string, headers: Record<string, string> = {}): Promise<Response> =>
  route.POST(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    }),
  );

const graphBody = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    runId: 'run_test',
    graph: {
      nodes: [
        { id: 'a', kind: 'LLM_CORE', params: {} },
        { id: 'b', kind: 'PROMPT_TEMPLATE', params: { template: 'Answer: {{input}}' } },
      ],
      edges: [{ source: 'a', target: 'b' }],
    },
    ...overrides,
  });

/** Drains a streamed response to completion and decodes its SSE frames. */
const readEvents = async (response: Response): Promise<SseEvent[]> => {
  const pending = response.text();
  await vi.runAllTimersAsync();
  return feedSse(INITIAL_SSE_STATE, await pending).events;
};

interface Frame {
  readonly nodeId: string;
  readonly state: string;
  readonly patch: Record<string, unknown>;
}

const telemetryOf = (events: readonly SseEvent[]): Frame[] =>
  events.filter((event) => event.event === 'message').map((event) => JSON.parse(event.data) as Frame);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('GEMINI_API_KEY', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('POST /api/runs/stream: request validation', () => {
  it('exposes no GET handler, so the graph can never travel in a URL', () => {
    expect('GET' in route).toBe(false);
  });

  it('rejects a non-JSON content type', async () => {
    const response = await post(graphBody(), { 'Content-Type': 'text/plain' });
    expect(response.status).toBe(415);
  });

  it('rejects malformed JSON and an empty graph', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post(graphBody({ graph: { nodes: [], edges: [] } }))).status).toBe(400);
  });

  it('rejects a graph over the node limit', async () => {
    const nodes = Array.from({ length: MAX_EXECUTION_NODES + 1 }, (_, i) => ({
      id: `n${i}`,
      kind: 'VECTOR_DB',
    }));
    const response = await post(graphBody({ graph: { nodes, edges: [] } }));
    expect(response.status).toBe(413);
  });

  it('rejects an oversized body by its declared and by its actual length', async () => {
    const declared = await post(graphBody(), { 'Content-Length': '5000000' });
    expect(declared.status).toBe(413);

    const oversized = graphBody({ padding: 'x'.repeat(1_100_000) });
    expect((await post(oversized)).status).toBe(413);
  });
});

describe('POST /api/runs/stream: simulated execution', () => {
  it('streams mode, per-node frames in dependency order, and a terminal done', async () => {
    const response = await post(graphBody());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const events = await readEvents(response);
    expect(events[0]).toEqual({ event: 'mode', data: '{"mode":"simulated"}' });
    expect(events.at(-1)).toEqual({ event: 'done', data: '{"status":"completed"}' });

    const frames = telemetryOf(events);
    expect(frames.map((frame) => `${frame.nodeId}:${frame.state}`)).toEqual([
      'a:running',
      'a:completed',
      'b:running',
      'b:completed',
    ]);
    // Output flows downstream and the template renders it.
    expect(frames[2]!.patch['inputPayload']).toEqual({ input: 'Simulated LLM_CORE output.' });
    expect(frames[3]!.patch['outputPayload']).toEqual({ output: 'Answer: Simulated LLM_CORE output.' });
  });

  it('fails the injected node, skips its descendants, and reports a failed run', async () => {
    const events = await readEvents(await post(graphBody({ failRate: 1 })));

    const frames = telemetryOf(events);
    expect(frames.map((frame) => `${frame.nodeId}:${frame.state}`)).toEqual([
      'a:running',
      'a:failed',
      'b:skipped',
    ]);
    expect(frames[1]!.patch['error']).toMatchObject({ code: 'INJECTED_FAILURE' });
    expect(events.at(-1)).toEqual({ event: 'done', data: '{"status":"failed"}' });
  });
});

/* -------------------------------------------------------------------------- */
/* Real mode: the Gemini adapter runs against a scripted `fetch`.             */
/* -------------------------------------------------------------------------- */

interface ModelCall {
  readonly signal: AbortSignal | null | undefined;
  readonly release: () => void;
}

const GEMINI_REPLY = {
  candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 },
};

/**
 * Replaces `fetch` with a model endpoint whose calls stay pending until the test
 * releases them, and which rejects like the platform `fetch` when aborted.
 */
const stubModelEndpoint = (): ModelCall[] => {
  const calls: ModelCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal;
          signal?.addEventListener('abort', () => reject(signal.reason));
          calls.push({ signal, release: () => resolve(Response.json(GEMINI_REPLY)) });
        }),
    ),
  );
  return calls;
};

const independentLlmNodes = (count: number): string =>
  graphBody({
    graph: {
      nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, kind: 'LLM_CORE' })),
      edges: [],
    },
  });

describe('POST /api/runs/stream: real execution', () => {
  beforeEach(() => {
    // The adapter paces itself on the network, so real timers are required.
    vi.useRealTimers();
    vi.stubEnv('GEMINI_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps at most four model calls of a level in flight', async () => {
    const calls = stubModelEndpoint();
    const response = await post(independentLlmNodes(10));
    const body = response.text();

    await vi.waitFor(() => expect(calls).toHaveLength(4));
    // No fifth call may start while the first four are pending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(4);

    calls[0]!.release();
    await vi.waitFor(() => expect(calls).toHaveLength(5));

    // Drain the rest: release every pending call until all ten have run.
    await vi.waitFor(() => {
      for (const call of calls) call.release();
      expect(calls).toHaveLength(10);
    });
    for (const call of calls) call.release();

    const events = feedSse(INITIAL_SSE_STATE, await body).events;
    expect(telemetryOf(events).filter((frame) => frame.state === 'completed')).toHaveLength(10);
    expect(events.at(-1)).toEqual({ event: 'done', data: '{"status":"completed"}' });
  });

  it('aborts the in-flight model call when the client cancels the stream', async () => {
    const calls = stubModelEndpoint();
    const response = await post(independentLlmNodes(1));
    const reader = response.body!.getReader();

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.signal?.aborted).toBe(false);

    await reader.cancel();
    await vi.waitFor(() => expect(calls[0]!.signal?.aborted).toBe(true));
  });

  it('aborts the in-flight model call when the request signal aborts', async () => {
    const calls = stubModelEndpoint();
    const client = new AbortController();
    const response = await route.POST(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: independentLlmNodes(1),
        signal: client.signal,
      }),
    );
    void response.text().catch(() => undefined);

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    client.abort();
    await vi.waitFor(() => expect(calls[0]!.signal?.aborted).toBe(true));
  });
});
