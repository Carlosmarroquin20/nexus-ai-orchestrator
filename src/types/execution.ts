/**
 * Wire contract between the client run controller and the server execution
 * stream. Kept minimal and transport-agnostic: only the topology needed to
 * sequence a run crosses the boundary — never telemetry, which flows back the
 * other way as `TelemetryEvent` frames.
 */

import type { NexusNodeKind } from './graph';

/**
 * Per-node parameters the execution engine needs to build a real prompt. Only the
 * fields relevant to a node's kind are populated. Kept minimal to bound the query
 * string size (the descriptor travels as a URL param).
 */
export interface ExecutionNodeParams {
  readonly systemPrompt?: string;
  readonly template?: string;
  readonly labels?: readonly string[];
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface ExecutionNodeRef {
  readonly id: string;
  readonly kind: NexusNodeKind;
  readonly params?: ExecutionNodeParams;
}

export interface ExecutionEdgeRef {
  readonly source: string;
  readonly target: string;
}

/** Serialized graph topology sent to the execution endpoint to drive a run. */
export interface ExecutionDescriptor {
  readonly nodes: ExecutionNodeRef[];
  readonly edges: ExecutionEdgeRef[];
}

/** Terminal outcome of a run, carried by the SSE `done` event. */
export type RunOutcome = 'completed' | 'failed' | 'cancelled';

export interface RunDonePayload {
  readonly status: RunOutcome;
}

/** Whether a run executed against the real backend (Gemini) or the simulator. */
export type ExecutionMode = 'real' | 'simulated';
