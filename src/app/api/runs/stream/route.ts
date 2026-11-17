/**
 * Server-sent execution stream: `POST /api/runs/stream` with an
 * `ExecutionRequest` JSON body (ADR 0008).
 *
 * HTTP adapter over the pipeline engine (`server/engine/runPipeline`, ADR 0010):
 * this module owns request validation and the run's event contract. Execution
 * semantics (level ordering, data flow, failure propagation, simulated versus
 * real mode) live in the engine; body limits, cancellation, and keep-alive live in
 * `server/http/eventStream`.
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
 * Event contract: `TelemetryEvent` JSON on the default `message` channel, a named
 * `mode` event up front, and a terminal named `done` event. A stream that closes
 * without `done` means the run was interrupted.
 */

import { enforceAccess } from '@/server/accessGate';
import { runPipeline } from '@/server/engine/runPipeline';
import { createEventStream, readJsonBody } from '@/server/http/eventStream';
import { resolveLlmProvider } from '@/server/llm/resolveProvider';
import { type ExecutionRequestRejection, parseExecutionRequest } from '@/utils/executionRequest';
import { safeJsonParse } from '@/utils/telemetryEvent';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Cap on the request body. Route handlers have no built-in body limit, so it is
 * enforced while reading, before any parsing. Sized for the node limit with
 * multi-kilobyte prompts per node.
 */
const MAX_REQUEST_BYTES = 1_000_000;

const REJECTION_STATUS: Readonly<Record<ExecutionRequestRejection, number>> = {
  MALFORMED: 400,
  EMPTY_GRAPH: 400,
  TOO_MANY_NODES: 413,
};

export async function POST(request: Request): Promise<Response> {
  // Re-checked here although the proxy also gates this path: a run can incur
  // real model cost, so it must not depend on the proxy matcher alone.
  const refusal = enforceAccess(request);
  if (refusal !== null) return refusal;

  const body = await readJsonBody(request, MAX_REQUEST_BYTES, 'Run request');
  if (!body.ok) return body.response;

  const parsed = parseExecutionRequest(safeJsonParse(body.text));
  if (!parsed.ok) {
    return new Response(parsed.error, { status: REJECTION_STATUS[parsed.code] });
  }
  const { runId, graph: descriptor, failRate, input } = parsed.request;

  // Resolve the LLM provider from the server env (port/adapter). Absent provider
  // -> simulated fallback. Credentials live in the adapter, never client-exposed.
  const provider = resolveLlmProvider();

  return createEventStream(request, async ({ signal, send }) => {
    // Announce the execution mode up front so the client can label the run live.
    send('mode', { mode: provider !== null ? 'real' : 'simulated' });

    const { outcome } = await runPipeline({
      runId,
      descriptor,
      input,
      failRate,
      provider,
      signal,
      onEvent: (event) => send(null, event),
    });

    send('done', { status: outcome });
  });
}
