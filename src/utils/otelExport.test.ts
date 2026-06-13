import { describe, expect, it } from 'vitest';

import { createPristineTelemetry } from '@/config/telemetry';
import {
  NODE_KIND,
  type NodeTelemetry,
  type PipelineRun,
  asNodeId,
  asRunId,
} from '@/types/graph';
import { SERVICE_NAME, runToOtlpTrace } from '@/utils/otelExport';

const telemetry = (over: Partial<NodeTelemetry>): NodeTelemetry => ({
  ...createPristineTelemetry(),
  ...over,
});

const buildRun = (): PipelineRun => ({
  id: asRunId('run-1'),
  status: 'completed',
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_002_000,
  telemetryByNode: {
    [asNodeId('a')]: telemetry({
      state: 'completed',
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      costInUSD: 0.1,
      lastUpdatedAt: 1_700_000_001_000,
    }),
    [asNodeId('b')]: telemetry({
      state: 'failed',
      latencyMs: 50,
      lastUpdatedAt: 1_700_000_001_500,
      error: { code: 'X', message: 'boom', originNodeId: null },
    }),
  },
  metrics: {
    totalLatencyMs: 150,
    aggregateInputTokens: 10,
    aggregateOutputTokens: 5,
    aggregateTotalTokens: 15,
    aggregateCostInUSD: 0.1,
    nodeCount: 2,
    failedNodeCount: 1,
    skippedNodeCount: 0,
    criticalPathLatencyMs: 150,
  },
});

const info = new Map([
  ['a', { label: 'Alpha', kind: NODE_KIND.LLM_CORE }],
  ['b', { label: 'Beta', kind: NODE_KIND.AGENT }],
]);

describe('runToOtlpTrace', () => {
  it('produces a single resource span scoped to the service', () => {
    const trace = runToOtlpTrace(buildRun(), info);
    expect(trace.resourceSpans).toHaveLength(1);
    expect(trace.resourceSpans[0]!.resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: SERVICE_NAME },
    });
  });

  it('emits a root span plus one span per node', () => {
    const spans = runToOtlpTrace(buildRun(), info).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(3);
    const root = spans.find((span) => span.name === 'pipeline.run')!;
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    // A failed node forces the run status to ERROR even though run.status is completed.
    expect(root.status.code).toBe(2);
  });

  it('parents node spans to the root and encodes valid OTLP ids/timestamps', () => {
    const spans = runToOtlpTrace(buildRun(), info).resourceSpans[0]!.scopeSpans[0]!.spans;
    const root = spans.find((span) => span.name === 'pipeline.run')!;
    const alpha = spans.find((span) => span.name === 'Alpha')!;

    expect(alpha.parentSpanId).toBe(root.spanId);
    expect(alpha.traceId).toBe(root.traceId);
    expect(alpha.spanId).toMatch(/^[0-9a-f]{16}$/);
    // start = lastUpdatedAt - latencyMs; nanos are decimal strings.
    expect(alpha.startTimeUnixNano).toBe('1700000000900000000');
    expect(alpha.endTimeUnixNano).toBe('1700000001000000000');
    expect(alpha.status.code).toBe(1);
  });

  it('marks a failed node span with ERROR and the error message', () => {
    const spans = runToOtlpTrace(buildRun(), info).resourceSpans[0]!.scopeSpans[0]!.spans;
    const beta = spans.find((span) => span.name === 'Beta')!;
    expect(beta.status).toEqual({ code: 2, message: 'boom' });
    expect(beta.attributes).toContainEqual({ key: 'nexus.node.kind', value: { stringValue: 'AGENT' } });
    expect(beta.attributes).toContainEqual({ key: 'nexus.tokens.total', value: { intValue: '0' } });
  });

  it('is deterministic: the same run yields the same trace id', () => {
    const run = buildRun();
    expect(runToOtlpTrace(run, info).resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId).toBe(
      runToOtlpTrace(run, info).resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId,
    );
  });
});
