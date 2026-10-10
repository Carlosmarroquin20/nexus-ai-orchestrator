/**
 * Incremental Server-Sent Events decoder.
 *
 * `EventSource` can only issue GET requests, so a stream opened with `fetch`
 * (required to send a request body) has to decode the `text/event-stream` framing
 * itself. Network chunks split frames at arbitrary byte offsets; the decoder is
 * therefore a pure reducer over an explicit carry-over state, which makes
 * "any chunking of the same bytes yields the same events" a testable property.
 *
 * Implemented subset of the WHATWG framing, sufficient for this application:
 * - `event:` and `data:` fields; multiple `data:` lines join with `\n`.
 * - Lines starting with `:` are comments (usable as keep-alives) and are ignored,
 *   as are the `id:` and `retry:` fields.
 * - A blank line dispatches the pending event; one with no `data:` is dropped.
 * - Lines end with LF or CRLF. A lone CR terminator, legal in the specification,
 *   is not emitted by this application's server and is not recognized.
 */

export interface SseEvent {
  /** Event name; `'message'` when the frame carries no `event:` field. */
  readonly event: string;
  readonly data: string;
}

export interface SseDecoderState {
  /** Trailing characters of the last chunk that do not yet form a complete line. */
  readonly buffer: string;
  /** `event:` value of the frame being assembled; empty when unset. */
  readonly eventName: string;
  readonly dataLines: readonly string[];
}

export const INITIAL_SSE_STATE: SseDecoderState = { buffer: '', eventName: '', dataLines: [] };

export interface SseDecodeStep {
  readonly state: SseDecoderState;
  readonly events: SseEvent[];
}

const DEFAULT_EVENT_NAME = 'message';

/** Field value per the specification: everything after the colon, minus one leading space. */
const fieldValue = (line: string, colon: number): string => {
  const raw = line.slice(colon + 1);
  return raw.startsWith(' ') ? raw.slice(1) : raw;
};

/**
 * Feeds one decoded text chunk into the decoder and returns the events it
 * completes together with the state to pass to the next call.
 */
export const feedSse = (state: SseDecoderState, chunk: string): SseDecodeStep => {
  const lines = (state.buffer + chunk).split('\n');
  // The final segment has no terminator yet; it is carried into the next call.
  const buffer = lines.pop() ?? '';

  const events: SseEvent[] = [];
  let eventName = state.eventName;
  let dataLines = state.dataLines;

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line === '') {
      if (dataLines.length > 0) {
        events.push({
          event: eventName === '' ? DEFAULT_EVENT_NAME : eventName,
          data: dataLines.join('\n'),
        });
      }
      eventName = '';
      dataLines = [];
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === 0) continue;

    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : fieldValue(line, colon);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines = [...dataLines, value];
  }

  return { state: { buffer, eventName, dataLines }, events };
};
