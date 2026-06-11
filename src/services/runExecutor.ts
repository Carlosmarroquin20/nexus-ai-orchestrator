/**
 * Run execution controller (client side).
 *
 * Bridges the store's run lifecycle to the server SSE execution stream. Holds a
 * single module-level `EventSource` so a run is a true singleton: starting a new
 * run tears down any prior stream. Exposed as plain functions (not a hook) so any
 * client component can trigger a run without prop drilling or context.
 *
 * Flow: `startRun` opens a run in the store (resetting telemetry, minting the
 * runId), encodes the topology into the stream URL, and wires the source to
 * `ingestTelemetryEvent`. The server's `done` event finalizes the run and closes
 * the source; an error finalizes it as failed (EventSource would otherwise
 * auto-reconnect, which is wrong for a one-shot run).
 */

import { useGraphStore } from '@/store/useGraphStore';
import type { ExecutionDescriptor, ExecutionNodeParams, RunOutcome } from '@/types/execution';
import { NODE_KIND, type NexusEdge, type NexusNode } from '@/types/graph';
import { isRecord } from '@/utils/guards';
import { parseTelemetryEvent, safeJsonParse } from '@/utils/telemetryEvent';

const STREAM_ENDPOINT = '/api/runs/stream';

let activeSource: EventSource | null = null;

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

const teardown = (): void => {
  if (activeSource !== null) {
    activeSource.close();
    activeSource = null;
  }
};

/**
 * Starts a run: resets telemetry, opens the SSE stream for the current graph, and
 * streams telemetry into the store. No-op when the graph is empty.
 */
export const startRun = (): void => {
  const store = useGraphStore.getState();
  if (store.nodes.length === 0) return;

  teardown();
  const runId = store.beginRun();
  const descriptor = buildDescriptor(store.nodes, store.edges);
  const params = new URLSearchParams({ runId, graph: JSON.stringify(descriptor) });
  if (store.failRate > 0) params.set('failRate', String(store.failRate));

  store.setStreamStatus('connecting');
  const source = new EventSource(`${STREAM_ENDPOINT}?${params.toString()}`);
  activeSource = source;

  source.onopen = (): void => useGraphStore.getState().setStreamStatus('open');

  source.addEventListener('mode', (event) => {
    const payload = safeJsonParse((event as MessageEvent<string>).data);
    const mode = isRecord(payload) && (payload['mode'] === 'real' || payload['mode'] === 'simulated')
      ? payload['mode']
      : 'simulated';
    useGraphStore.getState().setRunMode(mode);
  });

  source.onmessage = (message: MessageEvent<string>): void => {
    const event = parseTelemetryEvent(safeJsonParse(message.data));
    if (event !== null) useGraphStore.getState().ingestTelemetryEvent(event);
  };

  source.addEventListener('done', (event) => {
    const outcome = readOutcome((event as MessageEvent<string>).data);
    useGraphStore.getState().finalizeRun(outcome);
    teardown();
    useGraphStore.getState().setStreamStatus('disconnected');
  });

  source.onerror = (): void => {
    // A one-shot run treats any transport error as terminal; closing prevents the
    // EventSource from auto-reconnecting to a stream that has already ended.
    if (activeSource === null) return;
    useGraphStore.getState().finalizeRun('failed');
    teardown();
    useGraphStore.getState().setStreamStatus('error');
  };
};

/** Cancels the active run and closes its stream. Safe to call when idle. */
export const stopRun = (): void => {
  teardown();
  const store = useGraphStore.getState();
  if (store.activeRunId !== null) store.cancelRun();
  store.setStreamStatus('disconnected');
};
