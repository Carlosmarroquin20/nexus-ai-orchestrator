import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { INITIAL_SSE_STATE, type SseEvent, feedSse } from '@/utils/sseParser';

/** Decodes a sequence of chunks from a fresh state and returns every event produced. */
const decodeAll = (chunks: readonly string[]): SseEvent[] => {
  let state = INITIAL_SSE_STATE;
  const events: SseEvent[] = [];
  for (const chunk of chunks) {
    const step = feedSse(state, chunk);
    state = step.state;
    events.push(...step.events);
  }
  return events;
};

describe('feedSse', () => {
  it('decodes a default-channel frame as a message event', () => {
    expect(decodeAll(['data: {"a":1}\n\n'])).toEqual([{ event: 'message', data: '{"a":1}' }]);
  });

  it('decodes named events', () => {
    expect(decodeAll(['event: done\ndata: {"status":"completed"}\n\n'])).toEqual([
      { event: 'done', data: '{"status":"completed"}' },
    ]);
  });

  it('joins multiple data lines with a newline', () => {
    expect(decodeAll(['data: first\ndata: second\n\n'])).toEqual([
      { event: 'message', data: 'first\nsecond' },
    ]);
  });

  it('strips exactly one leading space from a field value', () => {
    expect(decodeAll(['data:  padded\n\n', 'data:tight\n\n'])).toEqual([
      { event: 'message', data: ' padded' },
      { event: 'message', data: 'tight' },
    ]);
  });

  it('accepts CRLF line endings', () => {
    expect(decodeAll(['event: mode\r\ndata: x\r\n\r\n'])).toEqual([{ event: 'mode', data: 'x' }]);
  });

  it('ignores comments and unsupported fields', () => {
    expect(decodeAll([': keep-alive\n\n', 'id: 7\nretry: 1000\ndata: kept\n\n'])).toEqual([
      { event: 'message', data: 'kept' },
    ]);
  });

  it('drops a frame that carries no data and resets its event name', () => {
    expect(decodeAll(['event: orphan\n\n', 'data: next\n\n'])).toEqual([
      { event: 'message', data: 'next' },
    ]);
  });

  it('withholds an unterminated frame until its blank line arrives', () => {
    const first = feedSse(INITIAL_SSE_STATE, 'data: par');
    expect(first.events).toEqual([]);
    const second = feedSse(first.state, 'tial\n');
    expect(second.events).toEqual([]);
    expect(feedSse(second.state, '\n').events).toEqual([{ event: 'message', data: 'partial' }]);
  });

  it('yields the same events for any chunking of the same stream', () => {
    const frameArb = fc.record({
      event: fc.constantFrom('', 'mode', 'done'),
      // Printable payloads without line terminators, as produced by JSON.stringify.
      data: fc.stringMatching(/^[ -~]{1,40}$/),
    });
    const encode = (frame: { event: string; data: string }): string =>
      `${frame.event === '' ? '' : `event: ${frame.event}\n`}data: ${frame.data}\n\n`;

    fc.assert(
      fc.property(
        fc.array(frameArb, { maxLength: 8 }),
        fc.array(fc.nat(400), { maxLength: 12 }),
        (frames, cuts) => {
          const stream = frames.map(encode).join('');
          const offsets = [...new Set(cuts.map((cut) => cut % (stream.length + 1)))].sort(
            (a, b) => a - b,
          );
          const chunks: string[] = [];
          let previous = 0;
          for (const offset of offsets) {
            chunks.push(stream.slice(previous, offset));
            previous = offset;
          }
          chunks.push(stream.slice(previous));

          expect(decodeAll(chunks)).toEqual(decodeAll([stream]));
          expect(decodeAll([stream])).toHaveLength(frames.length);
        },
      ),
    );
  });
});
