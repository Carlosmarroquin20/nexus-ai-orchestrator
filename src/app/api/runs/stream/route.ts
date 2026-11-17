/**
 * Server-sent execution stream: `POST /api/runs/stream` with an
 * `ExecutionRequest` JSON body (ADR 0008).
 *
 * HTTP adapter over the pipeline engine (`server/engine/runPipeline`, ADR 0010):
 * this module owns request validation, access control, cancellation, and the
 * event-stream framing; execution semantics (level ordering, data flow, failure
 * propagation, simulated versus real mode) live in the engine.
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
 * A `: keep-alive` comment line is interleaved periodically so intermediaries do
 * not drop a stream that is waiting on a slow model call.
 *
 * Only `application/json` bodies are accepted. Besides being the contract, this
 * keeps the endpoint out of reach of cross-site "simple" requests: a JSON POST
 * from another origin requires a CORS preflight, which this route never grants,
 * so a third-party page cannot start a (billable) run in the user's browser.
 */

import { DEFAULT_RUN_INPUT } from '@/config/execution';
import type { RunOutcome } from '@/types/execution';
import type { TelemetryEvent } from '@/types/graph';
import { enforceAccess } from '@/server/accessGate';
import { runPipeline } from '@/server/engine/runPipeline';
import { resolveLlmProvider } from '@/server/llm/resolveProvider';
import { type ExecutionRequestRejection, parseExecutionRequest } from '@/utils/executionRequest';
import { safeJsonParse } from '@/utils/telemetryEvent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

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

/**
 * Interval of the keep-alive comment frame. A model call can leave the stream
 * silent for up to its 30 s timeout per attempt, and proxies and load balancers
 * commonly drop connections idle for 30-60 s. Comment lines are ignored by the
 * client decoder, so the frame carries no meaning beyond keeping bytes flowing.
 */
const HEARTBEAT_INTERVAL_MS = 15_000;

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

export async function POST(request: Request): Promise<Response> {
  // Re-checked here although the proxy also gates this path: a run can incur
  // real model cost, so it must not depend on the proxy matcher alone.
  const refusal = enforceAccess(request);
  if (refusal !== null) return refusal;

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

  // Aborted when the client goes away, however that surfaces: the request signal,
  // or the consumer cancelling the response stream (the only signal some runtimes
  // deliver). The engine binds model calls and their retry delays to it, so an
  // abandoned run stops consuming the provider immediately.
  const runAbort = new AbortController();
  const abortRun = (): void => runAbort.abort();
  if (request.signal.aborted) abortRun();
  else request.signal.addEventListener('abort', abortRun, { once: true });
  const isAborted = (): boolean => runAbort.signal.aborted;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string): void => {
        if (isAborted()) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The stream was closed underneath us: treat it as a disconnect.
          abortRun();
        }
      };
      const sendEvent = (event: TelemetryEvent): void => {
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      };
      const sendDone = (status: RunOutcome): void => {
        enqueue(`event: done\ndata: ${JSON.stringify({ status })}\n\n`);
      };

      // Announce the execution mode up front so the client can label the run live.
      enqueue(`event: mode\ndata: ${JSON.stringify({ mode: provider !== null ? 'real' : 'simulated' })}\n\n`);
      const heartbeat = setInterval(() => enqueue(': keep-alive\n\n'), HEARTBEAT_INTERVAL_MS);

      const { outcome } = await runPipeline({
        runId,
        descriptor,
        input: DEFAULT_RUN_INPUT,
        failRate,
        provider,
        signal: runAbort.signal,
        onEvent: sendEvent,
      });

      if (!isAborted()) sendDone(outcome);

      clearInterval(heartbeat);
      request.signal.removeEventListener('abort', abortRun);
      try {
        controller.close();
      } catch {
        // Already closed by an aborted client; nothing to do.
      }
    },
    cancel() {
      abortRun();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
