/**
 * Run execution controller (client side).
 *
 * Bridges the store's run lifecycle to the server execution stream. Holds a single
 * module-level `AbortController` so a run is a true singleton: starting a new run
 * tears down any prior stream. Exposed as plain functions (not a hook) so any
 * client component can trigger a run without prop drilling or context.
 *
 * Transport (ADR 0008): the run request is the JSON body of a POST, and the
 * response body is read incrementally and decoded as `text/event-stream`.
 * `EventSource` is not used because it can only issue GET requests, which would
 * force the graph (prompts included) into the URL.
 *
 * Flow: `startRun` opens a run in the store (resetting telemetry, minting the
 * runId), posts the topology, and feeds decoded frames to `ingestTelemetryEvent`.
 * The server's `done` event finalizes the run. A rejected request, a transport
 * error, or a stream that closes without `done` finalizes it as failed and records
 * the reason alongside the stream status.
 *
 * Staleness: every asynchronous continuation re-checks that its controller is
 * still the active one before touching the store, so a stream that was stopped or
 * superseded can never write into the run that replaced it.
 */

import { useGraphStore } from '@/store/useGraphStore';
import type {
  ExecutionDescriptor,
  ExecutionNodeParams,
  ExecutionRequest,
  RunOutcome,
} from '@/types/execution';
import { NODE_KIND, type NexusEdge, type NexusNode } from '@/types/graph';
import { isRecord } from '@/utils/guards';
import { INITIAL_SSE_STATE, type SseEvent, feedSse } from '@/utils/sseParser';
import { parseTelemetryEvent, safeJsonParse } from '@/utils/telemetryEvent';

const STREAM_ENDPOINT = '/api/runs/stream';

/** Display bound for a server-supplied rejection reason. */
const MAX_REASON_LENGTH = 200;

/** Reasons for failures that carry no server-supplied message. */
const FAILURE_REASON = {
  unreachable: 'Could not reach the execution endpoint.',
  interrupted: 'The stream closed before the run finished.',
} as const;

let activeController: AbortController | null = null;

/** Extracts the execution-relevant parameters from a node's variant config. */
const extractParams = (node: NexusNode): ExecutionNodeParams => {
  switch (node.data.kind) {
    case NODE_KIND.AGENT:
      return { systemPrompt: node.data.config.systemPrompt };
    case NODE_KIND.CLASSIFIER:
      return { labels: node.data.config.labels };
    case NODE_KIND.LLM_CORE:
      return {
        temperature: node.data.config.temperature,
        maxOutputTokens: node.data.config.maxOutputTokens,
      };
    case NODE_KIND.PROMPT_TEMPLATE:
      return { template: node.data.config.template };
    default:
      return {};
  }
};

const buildDescriptor = (
  nodes: readonly NexusNode[],
  edges: readonly NexusEdge[],
): ExecutionDescriptor => ({
  nodes: nodes.map((node) => ({ id: node.id, kind: node.data.kind, params: extractParams(node) })),
  edges: edges.map((edge) => ({ source: edge.source, target: edge.target })),
});

const readOutcome = (data: string): RunOutcome => {
  const payload = safeJsonParse(data);
  const status = isRecord(payload) ? payload['status'] : undefined;
  return status === 'failed' || status === 'cancelled' ? status : 'completed';
};

/** Detaches and aborts the active stream, if any. */
const teardown = (): void => {
  const controller = activeController;
  // Cleared before aborting so the aborted stream's continuations see themselves
  // as stale and do not report the abort as a transport failure.
  activeController = null;
  controller?.abort();
};

/**
 * Applies one decoded frame to the store. Returns `true` once the terminal `done`
 * event has finalized the run and the stream should no longer be read.
 */
const applyEvent = (event: SseEvent): boolean => {
  const store = useGraphStore.getState();
  switch (event.event) {
    case 'mode': {
      const payload = safeJsonParse(event.data);
      store.setRunMode(isRecord(payload) && payload['mode'] === 'real' ? 'real' : 'simulated');
      return false;
    }
    case 'done': {
      store.finalizeRun(readOutcome(event.data));
      activeController = null;
      store.setStreamStatus('disconnected');
      return true;
    }
    case 'message': {
      const telemetry = parseTelemetryEvent(safeJsonParse(event.data));
      if (telemetry !== null) store.ingestTelemetryEvent(telemetry);
      return false;
    }
    default:
      return false;
  }
};

/** Finalizes the active run as failed after a rejected request or a broken stream. */
const failRun = (reason: string): void => {
  const store = useGraphStore.getState();
  store.finalizeRun('failed');
  activeController = null;
  store.setStreamStatus('error', reason);
};

/**
 * Reason for a non-2xx response. The route answers rejections in plain text; any
 * other body (a framework or proxy error page) is not fit for display, so only the
 * status is reported for it.
 */
const readRejection = async (response: Response): Promise<string> => {
  const fallback = `Run request rejected (HTTP ${response.status}).`;
  if (!(response.headers.get('content-type') ?? '').startsWith('text/plain')) return fallback;
  const text = (await response.text().catch(() => '')).trim();
  return text.length > 0 ? text.slice(0, MAX_REASON_LENGTH) : fallback;
};

const consumeStream = async (
  controller: AbortController,
  request: ExecutionRequest,
): Promise<void> => {
  const isCurrent = (): boolean => activeController === controller;

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
      const reason = await readRejection(response);
      if (isCurrent()) failRun(reason);
      return;
    }
    useGraphStore.getState().setStreamStatus('open');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let state = INITIAL_SSE_STATE;
    for (;;) {
      const { done, value } = await reader.read();
      if (!isCurrent()) return;
      if (done) break;
      const step = feedSse(state, decoder.decode(value, { stream: true }));
      state = step.state;
      for (const event of step.events) {
        if (applyEvent(event)) {
          void reader.cancel();
          return;
        }
      }
    }
    // The body ended without a `done` event: the server went away mid-run.
    failRun(FAILURE_REASON.interrupted);
  } catch {
    // An abort issued by `teardown` has already cleared the controller, so it is
    // filtered out here; anything else is a genuine transport failure.
    if (isCurrent()) failRun(FAILURE_REASON.unreachable);
  }
};

/**
 * Starts a run: resets telemetry, posts the current graph to the execution
 * endpoint, and streams telemetry into the store. No-op when the graph is empty.
 */
export const startRun = (): void => {
  const store = useGraphStore.getState();
  if (store.nodes.length === 0) return;

  teardown();
  const runId = store.beginRun();
  const request: ExecutionRequest = {
    runId,
    graph: buildDescriptor(store.nodes, store.edges),
    ...(store.failRate > 0 ? { failRate: store.failRate } : {}),
  };

  store.setStreamStatus('connecting');
  const controller = new AbortController();
  activeController = controller;
  void consumeStream(controller, request);
};

/** Cancels the active run and closes its stream. Safe to call when idle. */
export const stopRun = (): void => {
  teardown();
  const store = useGraphStore.getState();
  if (store.activeRunId !== null) store.cancelRun();
  store.setStreamStatus('disconnected');
};
