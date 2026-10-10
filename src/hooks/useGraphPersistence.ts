'use client';

import { useEffect, useMemo } from 'react';

import { createDemoPipeline } from '@/config/demoPipeline';
import { stopRun } from '@/services/runExecutor';
import { useGraphStore } from '@/store/useGraphStore';
import type { PipelineRun } from '@/types/graph';
import { runToOtlpTrace } from '@/utils/otelExport';
import { isSameGraphStructure } from '@/utils/graphStructure';
import {
  GRAPH_STORAGE_KEY,
  type GraphParseResult,
  parseGraph,
  serializeGraph,
} from '@/utils/graphSerialization';
import { readLocalStorage, writeLocalStorage } from '@/utils/localStorage';
import { safeJsonParse } from '@/utils/telemetryEvent';

const SAVE_DEBOUNCE_MS = 500;

const readStorage = (): string | null => readLocalStorage(GRAPH_STORAGE_KEY);
const writeStorage = (value: string): void => writeLocalStorage(GRAPH_STORAGE_KEY, value);

/**
 * Owns the localStorage persistence lifecycle. Call EXACTLY ONCE at the workspace
 * root: it hydrates the graph on mount and then debounce-writes document changes.
 *
 * Writes are gated on a structural comparison, not on array identity: the node
 * array is replaced on every telemetry tick and selection toggle, none of which
 * changes the serialized document. A pending write is flushed on `pagehide` and
 * on unmount, so an edit made within the debounce window survives closing the tab.
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
    const flush = (): void => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      const { nodes, edges } = useGraphStore.getState();
      writeStorage(serializeGraph(nodes, edges));
    };

    const unsubscribe = useGraphStore.subscribe((state, previous) => {
      if (isSameGraphStructure(previous, state)) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    });
    window.addEventListener('pagehide', flush);

    return () => {
      window.removeEventListener('pagehide', flush);
      unsubscribe();
      flush();
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
  /** Replaces the current graph with the bundled example pipeline. */
  readonly loadDemo: () => void;
  /** Exports a recorded run as an OpenTelemetry (OTLP/JSON) trace file. */
  readonly exportRunTrace: (run: PipelineRun) => void;
  readonly clearGraph: () => void;
}

/**
 * User-triggered graph transfer (export / import / clear). Stateless and
 * effect-free, so it may be called from any component without lifecycle concerns;
 * the returned API has a stable identity.
 *
 * Every operation that replaces the graph stops the active run first: a stream
 * left open would keep billing the backend for a pipeline that no longer exists
 * and would finalize its run record against the replacement graph's nodes.
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
          stopRun();
          useGraphStore.getState().loadGraph(result.snapshot.nodes, result.snapshot.edges);
        }
        return result;
      },
      loadDemo: () => {
        const { nodes, edges } = createDemoPipeline();
        stopRun();
        useGraphStore.getState().loadGraph(nodes, edges);
      },
      exportRunTrace: (run) => {
        const info = new Map(
          useGraphStore
            .getState()
            .nodes.map((node) => [node.id, { label: node.data.label, kind: node.data.kind }]),
        );
        const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-');
        downloadJson(JSON.stringify(runToOtlpTrace(run, info), null, 2), `nexus-trace-${stamp}.json`);
      },
      clearGraph: () => {
        stopRun();
        useGraphStore.getState().clearGraph();
      },
    }),
    [],
  );
