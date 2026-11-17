/**
 * Client side of the POST + SSE transport (ADR 0008), shared by the run and the
 * evaluation controllers.
 *
 * Both controllers post a JSON body, read the response incrementally, decode it
 * with `utils/sseParser`, and must stop touching state the moment they are
 * superseded. This module owns the reading; the controllers own their state and
 * decide what each event means.
 */

import { INITIAL_SSE_STATE, type SseEvent, feedSse } from '@/utils/sseParser';

/** Display bound for a server-supplied rejection reason. */
const MAX_REASON_LENGTH = 200;

/**
 * Reason for a non-2xx response. The routes answer rejections in plain text; any
 * other body (a framework or proxy error page) is not fit for display, so only
 * the status is reported for it.
 */
export const readRejection = async (response: Response, subject: string): Promise<string> => {
  const fallback = `${subject} rejected (HTTP ${response.status}).`;
  if (!(response.headers.get('content-type') ?? '').startsWith('text/plain')) return fallback;
  const text = (await response.text().catch(() => '')).trim();
  return text.length > 0 ? text.slice(0, MAX_REASON_LENGTH) : fallback;
};

/**
 * How reading ended: `stopped` when `onEvent` asked to stop (the terminal event
 * arrived), `ended` when the body closed first, `stale` when the caller was
 * superseded while reading.
 */
export type StreamEnd = 'stopped' | 'ended' | 'stale';

export interface ReadEventStreamOptions {
  /** Re-checked after every read; once false, nothing more is delivered. */
  readonly isCurrent: () => boolean;
  /** Handles one event; returns `true` to stop reading. */
  readonly onEvent: (event: SseEvent) => boolean;
}

/**
 * Decodes `body` as `text/event-stream` and delivers its events in order. Read
 * errors (including the abort of a superseded request) propagate to the caller,
 * which tells a genuine transport failure from its own abort.
 */
export const readEventStream = async (
  body: ReadableStream<Uint8Array>,
  { isCurrent, onEvent }: ReadEventStreamOptions,
): Promise<StreamEnd> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let state = INITIAL_SSE_STATE;
  for (;;) {
    const { done, value } = await reader.read();
    if (!isCurrent()) return 'stale';
    if (done) return 'ended';
    const step = feedSse(state, decoder.decode(value, { stream: true }));
    state = step.state;
    for (const event of step.events) {
      if (onEvent(event)) {
        void reader.cancel();
        return 'stopped';
      }
    }
  }
};
