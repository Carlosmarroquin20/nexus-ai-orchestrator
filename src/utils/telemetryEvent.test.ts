import { describe, expect, it } from 'vitest';

import { parseTelemetryEvent, safeJsonParse } from '@/utils/telemetryEvent';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns null on malformed JSON instead of throwing', () => {
    expect(safeJsonParse('{not json')).toBeNull();
  });
});

describe('parseTelemetryEvent', () => {
  const base = { runId: 'r1', nodeId: 'n1', state: 'completed', emittedAt: 123 };

  it('parses a valid event and its patch', () => {
    const event = parseTelemetryEvent({ ...base, patch: { inputTokens: 10, outputTokens: 5, latencyMs: 200 } });
    expect(event).not.toBeNull();
    expect(event!.runId).toBe('r1');
    expect(event!.patch.inputTokens).toBe(10);
    expect(event!.patch.latencyMs).toBe(200);
  });

  it('accepts an explicit null latency', () => {
    const event = parseTelemetryEvent({ ...base, patch: { latencyMs: null } });
    expect(event!.patch.latencyMs).toBeNull();
  });

  it('omits invalid patch fields but keeps valid ones', () => {
    const event = parseTelemetryEvent({ ...base, patch: { inputTokens: 'nope', costInUSD: 2 } });
    expect(event!.patch.inputTokens).toBeUndefined();
    expect(event!.patch.costInUSD).toBe(2);
  });

  it('rejects an invalid state', () => {
    expect(parseTelemetryEvent({ ...base, state: 'bogus' })).toBeNull();
  });

  it('rejects missing identifiers', () => {
    expect(parseTelemetryEvent({ state: 'completed', emittedAt: 1 })).toBeNull();
  });

  it('parses a structured error payload', () => {
    const event = parseTelemetryEvent({ ...base, state: 'failed', patch: { error: { code: 'E', message: 'm' } } });
    expect(event!.patch.error).toEqual({ code: 'E', message: 'm', originNodeId: null });
  });
});
