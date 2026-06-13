/**
 * Converts a pipeline run into an OpenTelemetry trace in OTLP/JSON form.
 *
 * The run becomes a root span and each node a child span, so a captured run can
 * be ingested by any OTLP-compatible backend (Jaeger, Tempo, Grafana, etc.).
 * Pure and framework-agnostic.
 *
 * OTLP encoding notes honored here:
 * - `traceId` is 16 bytes (32 hex chars); `spanId` is 8 bytes (16 hex chars).
 *   Both are derived deterministically from the run/node ids, so re-exporting a
 *   run yields a stable trace.
 * - Timestamps are nanoseconds since the Unix epoch encoded as decimal *strings*
 *   (the values exceed `Number.MAX_SAFE_INTEGER`, so `ms` is suffixed with six
 *   zeros rather than multiplied).
 * - `status.code`: 0 = UNSET, 1 = OK, 2 = ERROR. `kind`: 1 = INTERNAL.
 * - Attribute values are tagged unions (`stringValue` / `intValue` as string / `doubleValue`).
 */

import type { NexusNodeKind, PipelineRun } from '@/types/graph';

export const SERVICE_NAME = 'nexus-ai-orchestrator';
const SCOPE = { name: 'nexus.orchestrator', version: '0.1.0' } as const;
const SPAN_KIND_INTERNAL = 1;

type OtlpAnyValue =
  | { readonly stringValue: string }
  | { readonly intValue: string }
  | { readonly doubleValue: number };

interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpAnyValue;
}

interface OtlpStatus {
  readonly code: 0 | 1 | 2;
  readonly message?: string;
}

interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: OtlpAttribute[];
  readonly status: OtlpStatus;
}

export interface OtlpTracePayload {
  readonly resourceSpans: ReadonlyArray<{
    readonly resource: { readonly attributes: OtlpAttribute[] };
    readonly scopeSpans: ReadonlyArray<{
      readonly scope: { readonly name: string; readonly version: string };
      readonly spans: OtlpSpan[];
    }>;
  }>;
}

export interface NodeTraceInfo {
  readonly label: string;
  readonly kind: NexusNodeKind;
}

/* ------------------------------- encoders -------------------------------- */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Deterministic lowercase-hex string of `hexLength` chars derived from `input`. */
const hexFromString = (input: string, hexLength: number): string => {
  let out = '';
  let counter = 0;
  while (out.length < hexLength) {
    let hash = FNV_OFFSET;
    const chunk = `${input}:${counter}`;
    for (let i = 0; i < chunk.length; i += 1) {
      hash ^= chunk.charCodeAt(i);
      hash = Math.imul(hash, FNV_PRIME);
    }
    out += (hash >>> 0).toString(16).padStart(8, '0');
    counter += 1;
  }
  return out.slice(0, hexLength);
};

/** Epoch milliseconds to nanoseconds, as a decimal string (avoids float precision loss). */
const toUnixNano = (epochMs: number): string => `${Math.round(epochMs)}000000`;

const stringAttr = (key: string, value: string): OtlpAttribute => ({ key, value: { stringValue: value } });
const intAttr = (key: string, value: number): OtlpAttribute => ({
  key,
  value: { intValue: `${Math.round(value)}` },
});
const doubleAttr = (key: string, value: number): OtlpAttribute => ({ key, value: { doubleValue: value } });

const runStatus = (run: PipelineRun): OtlpStatus => {
  if (run.status === 'failed' || run.metrics.failedNodeCount > 0) {
    return { code: 2, message: `${run.metrics.failedNodeCount} node(s) failed` };
  }
  return run.status === 'completed' ? { code: 1 } : { code: 0 };
};

/* -------------------------------- mapping -------------------------------- */

export const runToOtlpTrace = (
  run: PipelineRun,
  nodeInfoById: ReadonlyMap<string, NodeTraceInfo>,
): OtlpTracePayload => {
  const traceId = hexFromString(run.id, 32);
  const rootSpanId = hexFromString(`${run.id}:root`, 16);

  const rootSpan: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: 'pipeline.run',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: toUnixNano(run.startedAt),
    endTimeUnixNano: toUnixNano(run.finishedAt ?? run.startedAt),
    attributes: [
      stringAttr('nexus.run.id', run.id),
      stringAttr('nexus.run.status', run.status),
      intAttr('nexus.run.node_count', run.metrics.nodeCount),
      intAttr('nexus.run.failed_nodes', run.metrics.failedNodeCount),
      intAttr('nexus.run.skipped_nodes', run.metrics.skippedNodeCount),
      intAttr('nexus.tokens.total', run.metrics.aggregateTotalTokens),
      doubleAttr('nexus.cost.usd', run.metrics.aggregateCostInUSD),
      intAttr('nexus.latency.critical_path_ms', run.metrics.criticalPathLatencyMs),
      intAttr('nexus.latency.compute_ms', run.metrics.totalLatencyMs),
    ],
    status: runStatus(run),
  };

  const nodeSpans: OtlpSpan[] = Object.entries(run.telemetryByNode).map(([nodeId, telemetry]) => {
    const info = nodeInfoById.get(nodeId);
    const end = telemetry.lastUpdatedAt ?? run.startedAt;
    const start = telemetry.latencyMs !== null ? end - telemetry.latencyMs : end;
    const failure = telemetry.state === 'failed';
    return {
      traceId,
      spanId: hexFromString(`${run.id}:${nodeId}`, 16),
      parentSpanId: rootSpanId,
      name: info?.label ?? nodeId,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: toUnixNano(start),
      endTimeUnixNano: toUnixNano(end),
      attributes: [
        stringAttr('nexus.node.id', nodeId),
        ...(info !== undefined ? [stringAttr('nexus.node.kind', info.kind)] : []),
        stringAttr('nexus.node.state', telemetry.state),
        intAttr('nexus.tokens.input', telemetry.inputTokens),
        intAttr('nexus.tokens.output', telemetry.outputTokens),
        intAttr('nexus.tokens.total', telemetry.totalTokens),
        doubleAttr('nexus.cost.usd', telemetry.costInUSD),
        ...(telemetry.latencyMs !== null ? [intAttr('nexus.latency.ms', telemetry.latencyMs)] : []),
      ],
      status: failure
        ? { code: 2, message: telemetry.error?.message ?? 'Node failed.' }
        : { code: telemetry.state === 'completed' ? 1 : 0 },
    };
  });

  return {
    resourceSpans: [
      {
        resource: { attributes: [stringAttr('service.name', SERVICE_NAME)] },
        scopeSpans: [{ scope: SCOPE, spans: [rootSpan, ...nodeSpans] }],
      },
    ],
  };
};
