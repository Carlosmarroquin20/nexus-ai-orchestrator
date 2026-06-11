/**
 * Workspace settings (de)serialization. Settings are deliberately kept separate
 * from the graph snapshot: they are environment/debugging preferences, not part
 * of the shareable pipeline document, so they never travel with an exported graph
 * and live under their own storage key. Versioned and defensively parsed.
 */

import { isFiniteNumber, isRecord } from './guards';

export const SETTINGS_SCHEMA_VERSION = 1 as const;
export const SETTINGS_STORAGE_KEY = 'nexus:settings:v1';

export interface WorkspaceSettings {
  /** Fault-injection probability in [0,1]. */
  readonly failRate: number;
}

interface SettingsEnvelope extends WorkspaceSettings {
  readonly version: typeof SETTINGS_SCHEMA_VERSION;
}

export const serializeSettings = (settings: WorkspaceSettings): string =>
  JSON.stringify({
    version: SETTINGS_SCHEMA_VERSION,
    failRate: settings.failRate,
  } satisfies SettingsEnvelope);

export const parseSettings = (raw: unknown): WorkspaceSettings | null => {
  if (!isRecord(raw) || raw['version'] !== SETTINGS_SCHEMA_VERSION) return null;
  const failRate = raw['failRate'];
  if (!isFiniteNumber(failRate)) return null;
  // Clamp defensively; persisted values must satisfy the [0,1] invariant.
  return { failRate: Math.min(Math.max(failRate, 0), 1) };
};
