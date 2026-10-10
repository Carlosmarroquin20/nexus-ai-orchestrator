import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startRun, stopRun } from '@/services/runExecutor';
import { useGraphStore } from '@/store/useGraphStore';
import { makeEdge, makeNode } from '@/test/factories';
import type { ExecutionRequest } from '@/types/execution';
import { type NodeExecutionState, asRunId } from '@/types/graph';

/**
 * Exercises the client run controller against the real store with `fetch`
 * replaced by a scripted streaming response, so the full path — request shape,
 * incremental SSE decoding, lifecycle transitions, and the staleness guard — is
 * verified without a server.
 */

const store = () => useGraphStore.getState();
const stateOf = (id: string): NodeExecutionState =>
  store().nodes.find((node) => node.id === id)!.data.telemetry.state;

const encoder = new TextEncoder();

const telemetryFrame = (runId: string, nodeId: string, state: NodeExecutionState): string =>
  `data: ${JSON.stringify({ runId, nodeId, state, emittedAt: 1, patch: {} })}\n\n`;
const modeFrame = 'event: mode\ndata: {"mode":"simulated"}\n\n';
const doneFrame = (status: string): string => `event: done\ndata: ${JSON.stringify({ status })}\n\n`;

interface ScriptedStream {
  readonly response: Response;
  readonly push: (frame: string) => void;
  readonly close: () => void;
}

/** A streaming response whose body is driven by the test and honors `signal`. */
const scriptedStream = (signal: AbortSignal | null | undefined): ScriptedStream => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  signal?.addEventListener('abort', () => {
    controller.error(new DOMException('Aborted', 'AbortError'));
  });
  return {
    response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    push: (frame) => controller.enqueue(encoder.encode(frame)),
    close: () => controller.close(),
  };
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly request: ExecutionRequest;
  readonly stream: ScriptedStream;
}

const calls: Call[] = [];

/** Installs a `fetch` that records each call and answers with a scripted stream. */
const stubStreamingFetch = (): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const stream = scriptedStream(init.signal);
      calls.push({ url, init, request: JSON.parse(String(init.body)) as ExecutionRequest, stream });
      return stream.response;
    }),
  );
};

const lastRun = () => store().runsById[store().runOrder.at(-1)!]!;

beforeEach(() => {
  calls.length = 0;
  useGraphStore.setState({
    nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
    edges: [makeEdge('a', 'b')],
    selectedNodeId: null,
    activeRunId: null,
    runsById: {},
    runOrder: [],
    streamStatus: 'disconnected',
    failRate: 0,
    runMode: null,
  });
});

afterEach(() => {
  stopRun();
  vi.unstubAllGlobals();
});

describe('startRun', () => {
  it('posts the graph as a JSON body and never in the URL', async () => {
    stubStreamingFetch();
    store().setFailRate(0.25);
    startRun();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const { url, init, request } = calls[0]!;
    expect(url).toBe('/api/runs/stream');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(request.runId).toBe(store().activeRunId);
    expect(request.failRate).toBe(0.25);
    expect(request.graph.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(request.graph.edges).toEqual([{ source: 'a', target: 'b' }]);
  });

  it('applies streamed frames and finalizes on the done event', async () => {
    stubStreamingFetch();
    startRun();
    await vi.waitFor(() => expect(store().streamStatus).toBe('open'));
    const { request, stream } = calls[0]!;

    stream.push(modeFrame);
    stream.push(telemetryFrame(request.runId, 'a', 'running'));
    await vi.waitFor(() => expect(stateOf('a')).toBe('running'));
    expect(store().runMode).toBe('simulated');

    // A frame split across two network chunks must still be decoded.
    const frame = telemetryFrame(request.runId, 'a', 'completed');
    stream.push(frame.slice(0, 20));
    stream.push(frame.slice(20));
    stream.push(telemetryFrame(request.runId, 'b', 'completed'));
    stream.push(doneFrame('completed'));

    await vi.waitFor(() => expect(store().activeRunId).toBeNull());
    expect(stateOf('a')).toBe('completed');
    expect(stateOf('b')).toBe('completed');
    expect(lastRun().status).toBe('completed');
    expect(store().streamStatus).toBe('disconnected');
  });

  it('finalizes the run as failed when the server rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Graph exceeds the 200-node execution limit.', { status: 413 })),
    );
    startRun();
    await vi.waitFor(() => expect(store().activeRunId).toBeNull());
    expect(lastRun().status).toBe('failed');
    expect(store().streamStatus).toBe('error');
    expect(store().streamError).toBe('Graph exceeds the 200-node execution limit.');
  });

  it('reports only the status when a rejection body is not plain text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body>Bad Gateway</body></html>', {
            status: 502,
            headers: { 'Content-Type': 'text/html' },
          }),
      ),
    );
    startRun();
    await vi.waitFor(() => expect(store().activeRunId).toBeNull());
    expect(store().streamError).toBe('Run request rejected (HTTP 502).');
  });

  it('clears the previous failure reason when a new run starts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Malformed graph descriptor.', { status: 400 })));
    startRun();
    await vi.waitFor(() => expect(store().streamError).toBe('Malformed graph descriptor.'));

    stubStreamingFetch();
    startRun();
    expect(store().streamStatus).toBe('connecting');
    expect(store().streamError).toBeNull();
  });

  it('finalizes the run as failed on a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    startRun();
    await vi.waitFor(() => expect(store().activeRunId).toBeNull());
    expect(lastRun().status).toBe('failed');
    expect(store().streamStatus).toBe('error');
    expect(store().streamError).toBe('Could not reach the execution endpoint.');
  });

  it('treats a stream that closes without done as an interrupted run', async () => {
    stubStreamingFetch();
    startRun();
    await vi.waitFor(() => expect(store().streamStatus).toBe('open'));
    const { request, stream } = calls[0]!;

    stream.push(telemetryFrame(request.runId, 'a', 'running'));
    await vi.waitFor(() => expect(stateOf('a')).toBe('running'));
    stream.close();

    await vi.waitFor(() => expect(store().activeRunId).toBeNull());
    expect(lastRun().status).toBe('failed');
    expect(stateOf('a')).toBe('failed');
    expect(store().nodes[0]!.data.telemetry.error?.code).toBe('RUN_INTERRUPTED');
    expect(store().streamStatus).toBe('error');
    expect(store().streamError).toBe('The stream closed before the run finished.');
  });

  it('does not let a superseded stream write into the run that replaced it', async () => {
    stubStreamingFetch();
    startRun();
    await vi.waitFor(() => expect(store().streamStatus).toBe('open'));
    const first = calls[0]!;

    startRun();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    await vi.waitFor(() => expect(store().streamStatus).toBe('open'));
    const second = calls[1]!;

    expect(first.init.signal?.aborted).toBe(true);
    expect(store().runsById[asRunId(first.request.runId)]!.status).toBe('cancelled');
    expect(store().activeRunId).toBe(second.request.runId);
    expect(stateOf('a')).toBe('idle');
    expect(store().streamStatus).toBe('open');
  });
});

describe('stopRun', () => {
  it('aborts the request and records a cancelled run without a transport error', async () => {
    stubStreamingFetch();
    startRun();
    await vi.waitFor(() => expect(store().streamStatus).toBe('open'));
    const { request, stream, init } = calls[0]!;
    stream.push(telemetryFrame(request.runId, 'a', 'running'));
    await vi.waitFor(() => expect(stateOf('a')).toBe('running'));

    stopRun();

    expect(init.signal?.aborted).toBe(true);
    expect(store().activeRunId).toBeNull();
    expect(lastRun().status).toBe('cancelled');
    expect(stateOf('a')).toBe('idle');

    // The aborted read rejects asynchronously; it must not be reported as a failure.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store().streamStatus).toBe('disconnected');
    expect(lastRun().status).toBe('cancelled');
  });
});
