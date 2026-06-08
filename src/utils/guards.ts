/**
 * Primitive runtime type guards shared by the defensive parsers (telemetry
 * frames, graph snapshots). Narrow `unknown` at trust boundaries; never assume
 * the shape of external/persisted data.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
