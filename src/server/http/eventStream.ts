/**
 * HTTP plumbing shared by the streaming endpoints (pipeline runs, evaluations):
 * bounded JSON body reading and a `text/event-stream` response with cancellation
 * and keep-alive handled once, so every endpoint gets the same guarantees.
 *
 * Request side: only `application/json` bodies are accepted. Besides being the
 * contract, this keeps the endpoints out of reach of cross-site "simple"
 * requests: a JSON POST from another origin requires a CORS preflight, which no
 * route grants, so a third-party page cannot start billable work in the user's
 * browser (ADR 0008). The body is size-capped while it is read.
 *
 * Response side: the producer receives an abort signal that fires when the client
 * goes away, however that surfaces — the request signal, the consumer cancelling
 * the stream (the only signal some runtimes deliver), or a failed write. Writes
 * after that point are dropped. A `: keep-alive` comment is interleaved so
 * intermediaries do not drop a stream that is waiting on a slow model call.
 *
 * Server-only.
 */

const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
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

export type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly response: Response };

/**
 * Reads a JSON request body within `maxBytes`, or produces the refusal: `415` for
 * a non-JSON content type, `413` past the limit. `subject` names the request in
 * the refusal message (for example, "Run request").
 */
export const readJsonBody = async (
  request: Request,
  maxBytes: number,
  subject: string,
): Promise<BodyReadResult> => {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      response: new Response(`${subject}s must be sent as application/json.`, { status: 415 }),
    };
  }
  const text = await readBodyCapped(request, maxBytes);
  if (text === null) {
    return {
      ok: false,
      response: new Response(`${subject} exceeds the size limit.`, { status: 413 }),
    };
  }
  return { ok: true, text };
};

export interface EventStreamWriter {
  /** Fires when the client goes away; writes after it are dropped. */
  readonly signal: AbortSignal;
  /**
   * Writes one frame: `event` `null` uses the default `message` channel, a name
   * produces a named event. `data` is serialized as JSON.
   */
  readonly send: (event: string | null, data: unknown) => void;
}

/**
 * Builds a `text/event-stream` response whose frames are written by `produce`.
 * The stream closes when `produce` settles; a producer that rejects simply ends
 * the stream, which the client reads as an interrupted run.
 */
export const createEventStream = (
  request: Request,
  produce: (writer: EventStreamWriter) => Promise<void>,
): Response => {
  const abort = new AbortController();
  const abortStream = (): void => abort.abort();
  if (request.signal.aborted) abortStream();
  else request.signal.addEventListener('abort', abortStream, { once: true });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string): void => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The stream was closed underneath us: treat it as a disconnect.
          abortStream();
        }
      };
      const send = (event: string | null, data: unknown): void => {
        const name = event === null ? '' : `event: ${event}\n`;
        write(`${name}data: ${JSON.stringify(data)}\n\n`);
      };

      const heartbeat = setInterval(() => write(': keep-alive\n\n'), HEARTBEAT_INTERVAL_MS);
      try {
        await produce({ signal: abort.signal, send });
      } catch {
        // No terminal frame is written; the client treats the stream as interrupted.
      } finally {
        clearInterval(heartbeat);
        request.signal.removeEventListener('abort', abortStream);
        try {
          controller.close();
        } catch {
          // Already closed by an aborted client; nothing to do.
        }
      }
    },
    cancel() {
      abortStream();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
};
