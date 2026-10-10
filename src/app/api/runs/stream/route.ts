/**
 * Server-sent execution stream: `POST /api/runs/stream` with an
 * `ExecutionRequest` JSON body (ADR 0008).
 *
 * Executes the supplied graph level by level (longest-path rank), running the
 * mutually independent nodes of a level concurrently and streaming a `running`
 * frame then a `completed` (or `failed`) frame per node, and a terminal `done`
 * event. Output text flows downstream: each node's input is the concatenation of
 * its predecessors' outputs (a fixed seed for sources).
 *
 * Execution mode is chosen at request time:
 * - Real: when `GEMINI_API_KEY` is set, LLM-backed nodes (AGENT/LLM_CORE/
 *   CLASSIFIER) call Google AI Studio (Gemini) and report real latency, token
 *   usage, and output. The key is read server-side only and never leaves the server.
 * - Simulated fallback: with no key, deterministic per-kind telemetry is emitted,
 *   so the app remains fully functional without credentials.
 *
 * `failRate` (body, [0,1]) injects faults in either mode to exercise the skip
 * propagation: a failed node's transitive descendants are reported `skipped`.
 *
 * The response is framed as `text/event-stream`: `TelemetryEvent` JSON on the
 * default `message` channel, a named `mode` event up front, and a terminal named
 * `done` event. A stream that closes without `done` means the run was interrupted.
 *
 * Only `application/json` bodies are accepted. Besides being the contract, this
 * keeps the endpoint out of reach of cross-site "simple" requests: a JSON POST
 * from another origin requires a CORS preflight, which this route never grants,
 * so a third-party page cannot start a (billable) run in the user's browser.
 */

import {
  type NexusNodeKind,
  type NodeExecutionState,
  type NodeTelemetryPatch,
  type TelemetryEvent,
  asNodeId,
  asRunId,
} from '@/types/graph';
import type { ExecutionNodeParams, RunOutcome } from '@/types/execution';
import { LlmError } from '@/server/llm/types';
import { resolveLlmProvider } from '@/server/llm/resolveProvider';
import { type ExecutionRequestRejection, parseExecutionRequest } from '@/utils/executionRequest';
import { computeExecutionLevels } from '@/utils/graphValidation';
import { renderTemplate } from '@/utils/promptTemplate';
import { computeTokenCost } from '@/utils/telemetry';
import { safeJsonParse } from '@/utils/telemetryEvent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// Seed input handed to source nodes (no predecessors).
const SEED_INPUT = 'How do I reset my account password?';

/**
 * Cap on the request body. Route handlers have no built-in body limit, so it is
 * enforced here, before any parsing. Sized for the node limit with multi-kilobyte
 * prompts per node.
 */
const MAX_REQUEST_BYTES = 1_000_000;

const REJECTION_STATUS: Readonly<Record<ExecutionRequestRejection, number>> = {
  MALFORMED: 400,
  EMPTY_GRAPH: 400,
  TOO_MANY_NODES: 413,
};

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

/**
 * Reads the request body as UTF-8 text, or returns `null` as soon as it exceeds
 * `maxBytes`. The declared `Content-Length` is only a fast path: it may be absent
 * (chunked upload) or wrong, so the bytes actually received are counted too and
 * the read is abandoned at the limit instead of buffering an unbounded body.
 */
const readBodyCapped = async (request: Request, maxBytes: number): Promise<string | null> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (request.body === null) return '';

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return new Response('Run requests must be sent as application/json.', { status: 415 });
  }

  const body = await readBodyCapped(request, MAX_REQUEST_BYTES);
  if (body === null) {
    return new Response('Run request exceeds the size limit.', { status: 413 });
  }

  const parsed = parseExecutionRequest(safeJsonParse(body));
  if (!parsed.ok) {
    return new Response(parsed.error, { status: REJECTION_STATUS[parsed.code] });
  }
  const { runId, graph: descriptor, failRate } = parsed.request;

  // Resolve the LLM provider from the server env (port/adapter). Absent provider
  // -> simulated fallback. Credentials live in the adapter, never client-exposed.
  const provider = resolveLlmProvider();
  const realMode = provider !== null;

  const levels = computeExecutionLevels(descriptor.nodes, descriptor.edges);
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
      const rendered = renderTemplate(params.template ?? '', inputText);
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
    if (provider !== null) {
      const { systemInstruction, prompt } = buildPrompt(kind, params, inputText);
      const result = await provider.generate({
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
        costInUSD: computeTokenCost(provider.pricing, result.inputTokens, result.outputTokens),
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

      const runNode = async (nodeId: string): Promise<void> => {
        if (aborted) return;

        if (skipped.has(nodeId)) {
          sendEvent(buildEvent(runId, nodeId, 'skipped', {}));
          return;
        }

        const kind = kindById.get(nodeId) ?? 'PROMPT_TEMPLATE';
        const params = paramsById.get(nodeId) ?? {};
        const inputText = gatherInput(nodeId);

        sendEvent(buildEvent(runId, nodeId, 'running', { inputPayload: { input: truncate(inputText, 280) } }));
        if (!realMode) {
          await sleep(RUNNING_PHASE_MS);
          if (aborted) return;
        }

        if (failRate > 0 && Math.random() < failRate) {
          sendEvent(
            buildEvent(runId, nodeId, 'failed', {
              error: { code: 'INJECTED_FAILURE', message: 'Injected fault (failRate).', originNodeId: null },
            }),
          );
          outcome = 'failed';
          for (const descendant of descendantsOf(nodeId)) skipped.add(descendant);
          return;
        }

        try {
          const result = await execute(kind, params, inputText);
          if (aborted) return;
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
          if (aborted) return;
          const code = error instanceof LlmError ? `LLM_${error.status}` : 'EXECUTION_ERROR';
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
      };

      // Execute level by level. Within a level the nodes are mutually independent
      // (edges only cross to higher levels), so they run concurrently — matching
      // the parallelism the critical-path metric assumes.
      for (const level of levels) {
        if (aborted) break;
        await Promise.all(level.map((nodeId) => runNode(nodeId)));
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
