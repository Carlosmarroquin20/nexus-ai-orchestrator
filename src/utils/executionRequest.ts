/**
 * Defensive parser for the run request body (`POST /api/runs/stream`).
 *
 * The body is untrusted JSON. This module narrows it into a normalized request or
 * a typed rejection without ever trusting the wire shape, and enforces the
 * structural limits of the execution engine. Pure and transport-agnostic: the
 * route handler maps a rejection code to an HTTP status, so the same contract can
 * be exercised in unit tests without a server.
 */

import type {
  ExecutionDescriptor,
  ExecutionNodeParams,
  ExecutionRequest,
} from '@/types/execution';
import { isNodeKind } from '@/types/graph';

import { isFiniteNumber, isRecord, isString } from './guards';

/** Upper bound on nodes per run; bounds fan-out against the model backend. */
export const MAX_EXECUTION_NODES = 200;
/** Run ids are client-minted (`run_<uuid>`); the bound only rejects abuse. */
export const MAX_RUN_ID_LENGTH = 128;

export type ExecutionRequestRejection = 'MALFORMED' | 'EMPTY_GRAPH' | 'TOO_MANY_NODES';

/** A validated request: `failRate` is always present and clamped to [0,1]. */
export type NormalizedExecutionRequest = Required<ExecutionRequest>;

export type ExecutionRequestParseResult =
  | { readonly ok: true; readonly request: NormalizedExecutionRequest }
  | { readonly ok: false; readonly code: ExecutionRequestRejection; readonly error: string };

const reject = (code: ExecutionRequestRejection, error: string): ExecutionRequestParseResult => ({
  ok: false,
  code,
  error,
});

/** Keeps only well-typed parameters; an absent key stays absent. */
const parseParams = (raw: unknown): ExecutionNodeParams => {
  if (!isRecord(raw)) return {};
  return {
    ...(isString(raw['systemPrompt']) ? { systemPrompt: raw['systemPrompt'] } : {}),
    ...(isString(raw['template']) ? { template: raw['template'] } : {}),
    ...(Array.isArray(raw['labels']) ? { labels: raw['labels'].filter(isString) } : {}),
    ...(isFiniteNumber(raw['temperature']) ? { temperature: raw['temperature'] } : {}),
    ...(isFiniteNumber(raw['maxOutputTokens']) ? { maxOutputTokens: raw['maxOutputTokens'] } : {}),
  };
};

/**
 * Narrows a graph payload into a self-consistent descriptor, or `null` when it is
 * malformed. Node ids must be unique (the engine keys every lookup by id), and
 * edges referencing an absent node are dropped, mirroring the snapshot parser.
 */
const parseDescriptor = (raw: unknown): ExecutionDescriptor | null => {
  if (!isRecord(raw) || !Array.isArray(raw['nodes']) || !Array.isArray(raw['edges'])) return null;

  const nodes: ExecutionDescriptor['nodes'] = [];
  const nodeIds = new Set<string>();
  for (const candidate of raw['nodes']) {
    if (!isRecord(candidate)) return null;
    const { id, kind } = candidate;
    if (!isString(id) || id.length === 0 || !isNodeKind(kind)) return null;
    if (nodeIds.has(id)) return null;
    nodeIds.add(id);
    nodes.push({ id, kind, params: parseParams(candidate['params']) });
  }

  const edges: ExecutionDescriptor['edges'] = [];
  for (const candidate of raw['edges']) {
    if (!isRecord(candidate)) return null;
    const { source, target } = candidate;
    if (!isString(source) || !isString(target)) return null;
    if (nodeIds.has(source) && nodeIds.has(target)) edges.push({ source, target });
  }

  return { nodes, edges };
};

/** Narrows arbitrary JSON into a normalized run request, or a typed rejection. */
export const parseExecutionRequest = (raw: unknown): ExecutionRequestParseResult => {
  if (!isRecord(raw)) return reject('MALFORMED', 'Request body must be a JSON object.');

  const runId = raw['runId'];
  if (!isString(runId) || runId.length === 0 || runId.length > MAX_RUN_ID_LENGTH) {
    return reject('MALFORMED', 'Missing or invalid "runId".');
  }

  const graph = parseDescriptor(raw['graph']);
  if (graph === null) return reject('MALFORMED', 'Malformed graph descriptor.');
  if (graph.nodes.length === 0) return reject('EMPTY_GRAPH', 'Graph has no nodes to execute.');
  if (graph.nodes.length > MAX_EXECUTION_NODES) {
    return reject(
      'TOO_MANY_NODES',
      `Graph exceeds the ${MAX_EXECUTION_NODES}-node execution limit.`,
    );
  }

  const rawFailRate = raw['failRate'];
  const failRate = isFiniteNumber(rawFailRate) ? Math.min(Math.max(rawFailRate, 0), 1) : 0;

  return { ok: true, request: { runId, graph, failRate } };
};
