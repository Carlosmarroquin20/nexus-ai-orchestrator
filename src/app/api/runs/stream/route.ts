/**
 * Server-sent execution stream: `GET /api/runs/stream?runId=<id>&graph=<json>`.
 *
 * Executes the supplied graph in topological order, streaming a `running` frame
 * then a `completed` (or `failed`) frame per node, and a terminal `done` event.
 * Output text flows downstream: each node's input is the concatenation of its
 * predecessors' outputs (a fixed seed for sources).
 *
 * Execution mode is chosen at request time:
 * - Real: when `GEMINI_API_KEY` is set, LLM-backed nodes (AGENT/LLM_CORE/
 *   CLASSIFIER) call Google AI Studio (Gemini) and report real latency, token
 *   usage, and output. The key is read server-side only and never leaves the server.
 * - Simulated fallback: with no key, deterministic per-kind telemetry is emitted,
 *   so the app remains fully functional without credentials.
 *
 * `failRate` (query, [0,1]) injects faults in either mode to exercise the skip
 * propagation: a failed node's transitive descendants are reported `skipped`.
 *
 * Frames are `TelemetryEvent` JSON on the default `message` channel; the terminal
 * signal uses a named `done` event so the client can close without auto-reconnect.
 */

import {
  type NexusNodeKind,
  type NodeExecutionState,
  type NodeTelemetryPatch,
  type TelemetryEvent,
  asNodeId,
  asRunId,
} from '@/types/graph';
import type { ExecutionDescriptor, ExecutionNodeParams, RunOutcome } from '@/types/execution';
import { GeminiError, generateWithGemini } from '@/server/geminiClient';
import { isFiniteNumber, isRecord, isString } from '@/utils/guards';
import { topologicalOrder } from '@/utils/graphValidation';
import { safeJsonParse } from '@/utils/telemetryEvent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';
// USD per 1M tokens. Estimate; reconcile with the model's published rate card.
const GEMINI_PRICING = { inputPerMillionUSD: 0.1, outputPerMillionUSD: 0.4 };
// Seed input handed to source nodes (no predecessors).
const SEED_INPUT = 'How do I reset my account password?';

/** Wall-clock pacing for the simulated fallback (real mode is paced by the API). */
const RUNNING_PHASE_MS = 420;
const INTER_NODE_GAP_MS = 110;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const randomInt = (min: number, max: number): number =>
  Math.floor(min + Math.random() * (max - min + 1));

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

interface NodeExecutionResult {
  readonly outputText: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly costInUSD: number;
}

/** Per-kind simulated telemetry profile (used only without an API key). */
const simulateMetrics = (kind: NexusNodeKind): Omit<NodeExecutionResult, 'outputText'> => {
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

const parseParams = (raw: unknown): ExecutionNodeParams => {
  if (!isRecord(raw)) return {};
  return {
    ...(isString(raw['systemPrompt']) ? { systemPrompt: raw['systemPrompt'] } : {}),
    ...(isString(raw['template']) ? { template: raw['template'] } : {}),
    ...(Array.isArray(raw['labels']) ? { labels: raw['labels'].filter(isString) } : {}),
    ...(isFiniteNumber(raw['temperature']) ? { temperature: raw['temperature'] } : {}),
    ...(isFiniteNumber(raw['maxOutputTokens']) ? { maxOutputTokens: raw['maxOutputTokens'] } : {}),
  };
};

/** Defensively narrows the query payload into an execution descriptor. */
const parseDescriptor = (raw: unknown): ExecutionDescriptor | null => {
  if (!isRecord(raw) || !Array.isArray(raw['nodes']) || !Array.isArray(raw['edges'])) return null;

  const nodes: ExecutionDescriptor['nodes'] = [];
  for (const candidate of raw['nodes']) {
    if (!isRecord(candidate) || !isString(candidate['id']) || !isString(candidate['kind'])) {
      return null;
    }
    if (!NODE_KINDS.has(candidate['kind'])) return null;
    nodes.push({
      id: candidate['id'],
      kind: candidate['kind'] as NexusNodeKind,
      params: parseParams(candidate['params']),
    });
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

const geminiCost = (inputTokens: number, outputTokens: number): number =>
  (inputTokens / 1_000_000) * GEMINI_PRICING.inputPerMillionUSD +
  (outputTokens / 1_000_000) * GEMINI_PRICING.outputPerMillionUSD;

/** Builds the prompt (and optional system instruction) for an LLM-backed node. */
const buildPrompt = (
  kind: NexusNodeKind,
  params: ExecutionNodeParams,
  inputText: string,
): { systemInstruction?: string; prompt: string } => {
  if (kind === 'AGENT') {
    return {
      ...(params.systemPrompt !== undefined && params.systemPrompt.length > 0
        ? { systemInstruction: params.systemPrompt }
        : {}),
      prompt: inputText,
    };
  }
  if (kind === 'CLASSIFIER') {
    const labels = params.labels !== undefined && params.labels.length > 0
      ? params.labels.join(', ')
      : 'general';
    return {
      prompt: `Classify the request into exactly one of: [${labels}]. Reply with only the label.\n\nRequest: ${inputText}`,
    };
  }
  return { prompt: inputText };
};

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

  // Server-only credentials. Absent key -> simulated fallback. Never client-exposed.
  const apiKey = process.env['GEMINI_API_KEY'];
  const model = process.env['GEMINI_MODEL'] ?? DEFAULT_GEMINI_MODEL;
  const realMode = typeof apiKey === 'string' && apiKey.length > 0;

  const order =
    topologicalOrder(descriptor.nodes, descriptor.edges) ?? descriptor.nodes.map((node) => node.id);
  const kindById = new Map(descriptor.nodes.map((node) => [node.id, node.kind]));
  const paramsById = new Map(descriptor.nodes.map((node) => [node.id, node.params ?? {}]));

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of descriptor.edges) {
    (outgoing.get(edge.source) ?? outgoing.set(edge.source, []).get(edge.source)!).push(edge.target);
    (incoming.get(edge.target) ?? incoming.set(edge.target, []).get(edge.target)!).push(edge.source);
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

  const outputById = new Map<string, string>();
  const gatherInput = (nodeId: string): string => {
    const predecessors = incoming.get(nodeId) ?? [];
    const parts = predecessors
      .map((predecessor) => outputById.get(predecessor) ?? '')
      .filter((text) => text.length > 0);
    return parts.length > 0 ? parts.join('\n\n') : SEED_INPUT;
  };

  const execute = async (
    kind: NexusNodeKind,
    params: ExecutionNodeParams,
    inputText: string,
  ): Promise<NodeExecutionResult> => {
    if (kind === 'PROMPT_TEMPLATE') {
      const rendered =
        params.template !== undefined && params.template.length > 0
          ? params.template.replace(/\{\{\s*[\w$.]+\s*\}\}/g, inputText)
          : inputText;
      return { outputText: rendered, inputTokens: 0, outputTokens: 0, latencyMs: 0, costInUSD: 0 };
    }
    if (kind === 'VECTOR_DB') {
      return {
        outputText: `Retrieved context for: ${truncate(inputText, 160)}`,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        costInUSD: 0,
      };
    }

    // LLM-backed kinds: AGENT, LLM_CORE, CLASSIFIER.
    if (apiKey) {
      const { systemInstruction, prompt } = buildPrompt(kind, params, inputText);
      const result = await generateWithGemini({
        apiKey,
        model,
        prompt,
        ...(systemInstruction !== undefined ? { systemInstruction } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        ...(params.maxOutputTokens !== undefined ? { maxOutputTokens: params.maxOutputTokens } : {}),
        signal: request.signal,
      });
      return {
        outputText: result.text,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        costInUSD: geminiCost(result.inputTokens, result.outputTokens),
      };
    }

    const metrics = simulateMetrics(kind);
    return { outputText: `Simulated ${kind} output.`, ...metrics };
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

      // Announce the execution mode up front so the client can label the run live.
      enqueue(`event: mode\ndata: ${JSON.stringify({ mode: realMode ? 'real' : 'simulated' })}\n\n`);

      let outcome: RunOutcome = 'completed';
      const skipped = new Set<string>();

      for (const nodeId of order) {
        if (aborted) break;

        if (skipped.has(nodeId)) {
          sendEvent(buildEvent(runId, nodeId, 'skipped', {}));
          continue;
        }

        const kind = kindById.get(nodeId) ?? 'PROMPT_TEMPLATE';
        const params = paramsById.get(nodeId) ?? {};
        const inputText = gatherInput(nodeId);

        sendEvent(buildEvent(runId, nodeId, 'running', { inputPayload: { input: truncate(inputText, 280) } }));
        if (!realMode) {
          await sleep(RUNNING_PHASE_MS);
          if (aborted) break;
        }

        if (failRate > 0 && Math.random() < failRate) {
          sendEvent(
            buildEvent(runId, nodeId, 'failed', {
              error: { code: 'INJECTED_FAILURE', message: 'Injected fault (failRate).', originNodeId: null },
            }),
          );
          outcome = 'failed';
          for (const descendant of descendantsOf(nodeId)) skipped.add(descendant);
          continue;
        }

        try {
          const result = await execute(kind, params, inputText);
          if (aborted) break;
          outputById.set(nodeId, result.outputText);
          sendEvent(
            buildEvent(runId, nodeId, 'completed', {
              latencyMs: result.latencyMs,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              costInUSD: result.costInUSD,
              outputPayload: { output: truncate(result.outputText, 600) },
            }),
          );
        } catch (error) {
          if (aborted) break;
          const code = error instanceof GeminiError ? `GEMINI_${error.status}` : 'EXECUTION_ERROR';
          sendEvent(
            buildEvent(runId, nodeId, 'failed', {
              error: {
                code,
                message: error instanceof Error ? error.message : 'Node execution failed.',
                originNodeId: null,
              },
            }),
          );
          outcome = 'failed';
          for (const descendant of descendantsOf(nodeId)) skipped.add(descendant);
        }

        if (!realMode && !aborted) await sleep(INTER_NODE_GAP_MS);
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
