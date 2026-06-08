/**
 * Root Zustand store for the orchestrator.
 *
 * Composition strategy: the store is assembled from decoupled slices
 * (`graphUi`, `dataFlow`) sharing a single `set`/`get`. This keeps concerns
 * isolated at authoring time while allowing cross-slice coordination at runtime
 * (e.g. the data-flow slice driving the graph-UI slice's `updateNodeTelemetry`).
 *
 * Subscription strategy: components must select the narrowest slice of state
 * they need via the exported selector hooks. Selecting the whole store, or
 * deriving fresh object/array references inside an inline selector without
 * `useShallow`, defeats Zustand's reference-equality bail-out and re-renders the
 * subscriber on every unrelated state change.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

import {
  type NexusEdge,
  type NexusNode,
  type PipelineRun,
  type PipelineRunMetrics,
} from '@/types/graph';

import { createDataFlowSlice, type DataFlowSlice } from './slices/dataFlowSlice';
import { createGraphUiSlice, type GraphUiSlice } from './slices/graphUiSlice';

export type GraphStore = GraphUiSlice & DataFlowSlice;

export const useGraphStore = create<GraphStore>()(
  devtools(
    (...args) => ({
      ...createGraphUiSlice(...args),
      ...createDataFlowSlice(...args),
    }),
    {
      name: 'NexusGraphStore',
      enabled: process.env.NODE_ENV !== 'production',
    },
  ),
);

/* -------------------------------------------------------------------------- */
/* Pure selectors                                                             */
/* -------------------------------------------------------------------------- */

/** Resolves the currently selected node, or `null`. Returns a stable reference. */
export const selectSelectedNode = (state: GraphStore): NexusNode | null => {
  if (state.selectedNodeId === null) return null;
  return state.nodes.find((node) => node.id === state.selectedNodeId) ?? null;
};

/** Resolves the active run record, or `null` when no run is in flight. */
export const selectActiveRun = (state: GraphStore): PipelineRun | null =>
  state.activeRunId === null ? null : (state.runsById[state.activeRunId] ?? null);

const selectGraphActions = (state: GraphStore) => ({
  addNode: state.addNode,
  removeNode: state.removeNode,
  setSelectedNode: state.setSelectedNode,
  selectNode: state.selectNode,
  deleteSelected: state.deleteSelected,
  clearSelection: state.clearSelection,
  duplicateSelected: state.duplicateSelected,
  setNodeConfig: state.setNodeConfig,
  setNodeLabel: state.setNodeLabel,
  loadGraph: state.loadGraph,
  clearGraph: state.clearGraph,
  onNodesChange: state.onNodesChange,
  onEdgesChange: state.onEdgesChange,
  onConnect: state.onConnect,
  updateNodeTelemetry: state.updateNodeTelemetry,
  resetTelemetry: state.resetTelemetry,
  beginRun: state.beginRun,
  ingestTelemetryEvent: state.ingestTelemetryEvent,
  finalizeRun: state.finalizeRun,
  cancelRun: state.cancelRun,
  setStreamStatus: state.setStreamStatus,
});

/* -------------------------------------------------------------------------- */
/* Selector hooks                                                             */
/* -------------------------------------------------------------------------- */

export const useNexusNodes = (): NexusNode[] => useGraphStore((state) => state.nodes);

export const useNexusEdges = (): NexusEdge[] => useGraphStore((state) => state.edges);

export const useSelectedNode = (): NexusNode | null => useGraphStore(selectSelectedNode);

export const useActiveRun = (): PipelineRun | null => useGraphStore(selectActiveRun);

export const useActiveRunMetrics = (): PipelineRunMetrics | null =>
  useGraphStore((state) => selectActiveRun(state)?.metrics ?? null);

/**
 * Action bundle with a stable object identity (via `useShallow`). Action
 * references never change, so consuming components subscribe to behavior without
 * subscribing to any mutable data — they never re-render on telemetry updates.
 */
export const useGraphActions = (): ReturnType<typeof selectGraphActions> =>
  useGraphStore(useShallow(selectGraphActions));
