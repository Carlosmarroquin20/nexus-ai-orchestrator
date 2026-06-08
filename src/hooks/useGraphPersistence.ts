'use client';

import { useEffect, useMemo } from 'react';

import { useGraphStore } from '@/store/useGraphStore';
import {
  GRAPH_STORAGE_KEY,
  type GraphParseResult,
  parseGraph,
  serializeGraph,
} from '@/utils/graphSerialization';
import { safeJsonParse } from '@/utils/telemetryEvent';

const SAVE_DEBOUNCE_MS = 500;

const readStorage = (): string | null => {
  try {
    return window.localStorage.getItem(GRAPH_STORAGE_KEY);
  } catch {
    // Private mode / disabled storage: degrade to non-persistent session.
    return null;
  }
};

const writeStorage = (value: string): void => {
  try {
    window.localStorage.setItem(GRAPH_STORAGE_KEY, value);
  } catch {
    // Quota exceeded or storage denied: drop the write silently.
  }
};

/**
 * Owns the localStorage persistence lifecycle. Call EXACTLY ONCE at the workspace
 * root: it hydrates the graph on mount and then debounce-writes topology changes.
 *
 * SSR-safe by construction — the effect runs client-only, so `window` is never
 * touched during server render, avoiding hydration mismatches (the server always
 * renders the empty initial graph; the client rehydrates after mount).
 */
export const useGraphAutoPersist = (): void => {
  useEffect(() => {
    const raw = readStorage();
    if (raw !== null) {
      const result = parseGraph(safeJsonParse(raw));
      if (result.ok) {
        useGraphStore.getState().loadGraph(result.snapshot.nodes, result.snapshot.edges);
      }
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = useGraphStore.subscribe((state, previous) => {
      // Persist only on topology changes; telemetry deltas during a run must not
      // thrash storage (and are never serialized anyway).
      if (state.nodes === previous.nodes && state.edges === previous.edges) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        writeStorage(serializeGraph(state.nodes, state.edges));
      }, SAVE_DEBOUNCE_MS);
    });

    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, []);
};

const downloadJson = (json: string, filename: string): void => {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export interface GraphTransferApi {
  /** Serializes the current graph and triggers a timestamped file download. */
  readonly exportToFile: () => void;
  /** Parses a file and, on success, replaces the current graph. Returns the result. */
  readonly importFromFile: (file: File) => Promise<GraphParseResult>;
  readonly clearGraph: () => void;
}

/**
 * User-triggered graph transfer (export / import / clear). Stateless and
 * effect-free, so it may be called from any component without lifecycle concerns;
 * the returned API has a stable identity.
 */
export const useGraphTransfer = (): GraphTransferApi =>
  useMemo(
    () => ({
      exportToFile: () => {
        const { nodes, edges } = useGraphStore.getState();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        downloadJson(serializeGraph(nodes, edges), `nexus-pipeline-${stamp}.json`);
      },
      importFromFile: async (file) => {
        const text = await file.text();
        const result = parseGraph(safeJsonParse(text));
        if (result.ok) {
          useGraphStore.getState().loadGraph(result.snapshot.nodes, result.snapshot.edges);
        }
        return result;
      },
      clearGraph: () => useGraphStore.getState().clearGraph(),
    }),
    [],
  );
