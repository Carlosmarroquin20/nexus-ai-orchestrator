/**
 * Defensive parser for inbound telemetry frames.
 *
 * The streaming transport delivers untyped JSON. These guards narrow `unknown`
 * into a `TelemetryEvent` without ever trusting the wire shape; malformed frames
 * are rejected (return `null`) rather than coerced, so a single bad frame can
 * never corrupt store state. All functions are pure.
 *
 * Property access uses bracket notation throughout: once narrowed to
 * `Record<string, unknown>`, fields originate from an index signature, which
 * `noPropertyAccessFromIndexSignature` requires to be read via brackets.
 */

import {
  asNodeId,
  asRunId,
  type NodeExecutionState,
  type NodeTelemetryPatch,
  type TelemetryError,
  type TelemetryEvent,
} from '@/types/graph';

const EXECUTION_STATES = new Set<string>(['idle', 'running', 'completed', 'failed']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const isExecutionState = (value: unknown): value is NodeExecutionState =>
  typeof value === 'string' && EXECUTION_STATES.has(value);

/** Parses an error sub-payload; returns `null` unless `code` and `message` are present. */
const parseError = (raw: unknown): TelemetryError | null => {
  if (!isRecord(raw) || !isString(raw['code']) || !isString(raw['message'])) return null;
  const originNodeId = raw['originNodeId'];
  return {
    code: raw['code'],
    message: raw['message'],
    originNodeId: isString(originNodeId) ? asNodeId(originNodeId) : null,
  };
};

/**
 * Builds a telemetry patch from a raw payload. Keys are included only when their
 * value passes validation, satisfying `exactOptionalPropertyTypes` (an absent
 * key is distinct from an explicit `undefined`).
 */
const parsePatch = (raw: unknown): NodeTelemetryPatch => {
  if (!isRecord(raw)) return {};
  const latency = raw['latencyMs'];
  const parsedError = parseError(raw['error']);
  return {
    ...(isFiniteNumber(raw['inputTokens']) ? { inputTokens: raw['inputTokens'] } : {}),
    ...(isFiniteNumber(raw['outputTokens']) ? { outputTokens: raw['outputTokens'] } : {}),
    ...(isFiniteNumber(raw['costInUSD']) ? { costInUSD: raw['costInUSD'] } : {}),
    ...(isFiniteNumber(latency) || latency === null ? { latencyMs: latency as number | null } : {}),
    ...(isRecord(raw['inputPayload']) ? { inputPayload: raw['inputPayload'] } : {}),
    ...(isRecord(raw['outputPayload']) ? { outputPayload: raw['outputPayload'] } : {}),
    ...(parsedError !== null ? { error: parsedError } : {}),
  };
};

/** Narrows arbitrary JSON into a `TelemetryEvent`, or `null` if the frame is invalid. */
export const parseTelemetryEvent = (raw: unknown): TelemetryEvent | null => {
  if (!isRecord(raw)) return null;
  const runId = raw['runId'];
  const nodeId = raw['nodeId'];
  const state = raw['state'];
  const emittedAt = raw['emittedAt'];
  if (!isString(runId) || !isString(nodeId)) return null;
  if (!isExecutionState(state) || !isFiniteNumber(emittedAt)) return null;
  return {
    runId: asRunId(runId),
    nodeId: asNodeId(nodeId),
    state,
    emittedAt,
    patch: parsePatch(raw['patch']),
  };
};

/** `JSON.parse` that yields `null` instead of throwing on malformed input. */
export const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};
