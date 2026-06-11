/**
 * Server-sent execution stream: `GET /api/runs/stream?runId=<id>&graph=<json>`.
 *
 * This is a deterministic execution SIMULATOR, not a real model-calling engine —
 * it provides the transport and event structure a production engine would slot
 * into. It sequences the supplied graph in topological order and emits, per node,
 * a `running` frame followed by a `completed` frame carrying simulated telemetry,
 * then a terminal `done` event.
 *
 * Frames are `TelemetryEvent` JSON on the default `message` channel (consumed by
 * the client's `onmessage`); the terminal signal uses a named `done` event so the
 * client can close the source without triggering EventSource auto-reconnect.
 *
 * Stateless by design: the topology is passed in the query string. For very large
 * graphs that exceed URL limits, the production evolution is a POST-to-start +
 * GET-by-id handshake; the event contract here is unaffected by that change.
 */

import {
  type NexusNodeKind,
  type NodeExecutionState,
  type NodeTelemetryPatch,
  type TelemetryEvent,
  asNodeId,
  asRunId,
} from '@/types/graph';
import type { ExecutionDescriptor, RunOutcome } from '@/types/execution';
import { isFiniteNumber, isRecord, isString } from '@/utils/guards';
import { topologicalOrder } from '@/utils/graphValidation';
import { safeJsonParse } from '@/utils/telemetryEvent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable proxy buffering so frames flush immediately.
  'X-Accel-Buffering': 'no',
};

/** Wall-clock pacing per phase (kept short; independent of the reported latency). */
const RUNNING_PHASE_MS = 420;
const INTER_NODE_GAP_MS = 110;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min: number, max: number): number =>
  Math.floor(min + Math.random() * (max - min + 1));

interface SimulatedMetrics {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly costInUSD: number;
}

/** Per-kind telemetry profile. Rough, illustrative figures for the simulation. */
const simulateMetrics = (kind: NexusNodeKind): SimulatedMetrics => {
  switch (kind) {
    case 'LLM_CORE':
    case 'AGENT': {
      const inputTokens = randomInt(400, 2400);
      const outputTokens = randomInt(150, 1600);
      return {
        inputTokens,
        outputTokens,
        latencyMs: randomInt(700, 4200),
        costInUSD: (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15,
      };
    }
    case 'CLASSIFIER': {
      const inputTokens = randomInt(80, 400);
      const outputTokens = randomInt(5, 40);
      return {
        inputTokens,
        outputTokens,
        latencyMs: randomInt(150, 900),
        costInUSD: (inputTokens / 1_000_000) * 1 + (outputTokens / 1_000_000) * 5,
      };
    }
    case 'VECTOR_DB':
      return { inputTokens: 0, outputTokens: 0, latencyMs: randomInt(40, 320), costInUSD: 0 };
    case 'PROMPT_TEMPLATE':
      return { inputTokens: 0, outputTokens: 0, latencyMs: randomInt(2, 25), costInUSD: 0 };
    default:
      return { inputTokens: 0, outputTokens: 0, latencyMs: randomInt(50, 200), costInUSD: 0 };
  }
};

const NODE_KINDS = new Set<string>([
  'AGENT',
  'VECTOR_DB',
  'PROMPT_TEMPLATE',
  'CLASSIFIER',
  'LLM_CORE',
]);

/** Defensively narrows the query payload into an execution descriptor. */
const parseDescriptor = (raw: unknown): ExecutionDescriptor | null => {
  if (!isRecord(raw) || !Array.isArray(raw['nodes']) || !Array.isArray(raw['edges'])) return null;

  const nodes: ExecutionDescriptor['nodes'] = [];
  for (const candidate of raw['nodes']) {
    if (!isRecord(candidate) || !isString(candidate['id']) || !isString(candidate['kind'])) {
      return null;
    }
    if (!NODE_KINDS.has(candidate['kind'])) return null;
    nodes.push({ id: candidate['id'], kind: candidate['kind'] as NexusNodeKind });
  }

  const edges: ExecutionDescriptor['edges'] = [];
  for (const candidate of raw['edges']) {
    if (!isRecord(candidate) || !isString(candidate['source']) || !isString(candidate['target'])) {
      return null;
    }
    edges.push({ source: candidate['source'], target: candidate['target'] });
  }

  return { nodes, edges };
};

const buildEvent = (
  runId: string,
  nodeId: string,
  state: NodeExecutionState,
  patch: NodeTelemetryPatch,
): TelemetryEvent => ({
  runId: asRunId(runId),
  nodeId: asNodeId(nodeId),
  state,
  emittedAt: Date.now(),
  patch,
});

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const runId = url.searchParams.get('runId');
  const graphParam = url.searchParams.get('graph');

  if (runId === null || graphParam === null) {
    return new Response('Missing "runId" or "graph" query parameter.', { status: 400 });
  }

  const descriptor = parseDescriptor(safeJsonParse(graphParam));
  if (descriptor === null) {
    return new Response('Malformed graph descriptor.', { status: 400 });
  }
  if (descriptor.nodes.length === 0) {
    return new Response('Graph has no nodes to execute.', { status: 400 });
  }

  const failRateParam = Number(url.searchParams.get('failRate'));
  const failRate = isFiniteNumber(failRateParam) ? Math.min(Math.max(failRateParam, 0), 1) : 0;

  // Topological order drives execution; cyclic graphs fall back to input order
  // (diagnostics already surface the cycle to the user).
  const order =
    topologicalOrder(descriptor.nodes, descriptor.edges) ?? descriptor.nodes.map((node) => node.id);
  const kindById = new Map(descriptor.nodes.map((node) => [node.id, node.kind]));

  const outgoing = new Map<string, string[]>();
  for (const edge of descriptor.edges) {
    const bucket = outgoing.get(edge.source);
    if (bucket === undefined) outgoing.set(edge.source, [edge.target]);
    else bucket.push(edge.target);
  }

  /** Transitive descendants of a node (the subgraph that cannot run if it fails). */
  const descendantsOf = (start: string): Set<string> => {
    const result = new Set<string>();
    const stack = [...(outgoing.get(start) ?? [])];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      for (const next of outgoing.get(current) ?? []) {
        if (!result.has(next)) stack.push(next);
      }
    }
    return result;
  };

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
      };
      request.signal.addEventListener('abort', onAbort);

      const enqueue = (chunk: string): void => {
        if (aborted) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          aborted = true;
        }
      };
      const sendEvent = (event: TelemetryEvent): void => {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      };
      const sendDone = (status: RunOutcome): void => {
        enqueue(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
      };

      let outcome: RunOutcome = 'completed';
      const skipped = new Set<string>();

      for (const nodeId of order) {
        if (aborted) break;

        // Downstream of an upstream failure: report as skipped without executing.
        if (skipped.has(nodeId)) {
          sendEvent(buildEvent(runId, nodeId, 'skipped', {}));
          continue;
        }

        const kind = kindById.get(nodeId) ?? 'PROMPT_TEMPLATE';

        sendEvent(buildEvent(runId, nodeId, 'running', { inputPayload: { phase: 'invoke' } }));
        await sleep(RUNNING_PHASE_MS);
        if (aborted) break;

        if (Math.random() < failRate) {
          sendEvent(
            buildEvent(runId, nodeId, 'failed', {
              error: { code: 'SIMULATED_FAILURE', message: 'Simulated node failure.', originNodeId: null },
            }),
          );
          outcome = 'failed';
          // Mark the transitive descendants as skipped; independent branches run on.
          for (const descendant of descendantsOf(nodeId)) skipped.add(descendant);
          continue;
        }

        const metrics = simulateMetrics(kind);
        sendEvent(
          buildEvent(runId, nodeId, 'completed', {
            latencyMs: metrics.latencyMs,
            inputTokens: metrics.inputTokens,
            outputTokens: metrics.outputTokens,
            costInUSD: metrics.costInUSD,
            outputPayload: { kind, summary: `Simulated output for ${kind}.` },
          }),
        );
        await sleep(INTER_NODE_GAP_MS);
      }

      if (!aborted) sendDone(outcome);

      request.signal.removeEventListener('abort', onAbort);
      try {
        controller.close();
      } catch {
        // Already closed by an aborted client; nothing to do.
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
