/**
 * Data-flow state slice.
 *
 * Owns pipeline-run lifecycle, the streaming transport status, and run-level
 * metric aggregation. It deliberately does NOT own node telemetry storage — that
 * lives on node `data` in the graph-UI slice. This slice drives telemetry through
 * the shared `get().updateNodeTelemetry` action and then snapshots the resulting
 * node state into the active run, keeping a strict separation between the live,
 * mutable graph and the immutable historical run records.
 */

import { type StateCreator } from 'zustand';

import {
  asNodeId,
  asRunId,
  type NexusNode,
  type NodeId,
  type NodeTelemetry,
  type PipelineRun,
  type PipelineRunStatus,
  type RunId,
  type TelemetryError,
  type TelemetryEvent,
} from '@/types/graph';
import type { ExecutionMode } from '@/types/execution';
import { computeRunMetrics } from '@/utils/runAnalysis';

import type { GraphStore } from '../useGraphStore';

/** Lifecycle of the telemetry streaming transport (e.g. SSE / WebSocket). */
export type StreamStatus = 'disconnected' | 'connecting' | 'open' | 'error';

/** Terminal states a run may be finalized into. */
export type TerminalRunStatus = Extract<PipelineRunStatus, 'completed' | 'failed' | 'cancelled'>;

export interface DataFlowSlice {
  readonly activeRunId: RunId | null;
  readonly runsById: Readonly<Record<RunId, PipelineRun>>;
  /** Run ids in chronological start order; the last element is the newest run. */
  readonly runOrder: RunId[];
  readonly streamStatus: StreamStatus;
  /**
   * Human-readable reason for the last stream failure. Non-null only while
   * `streamStatus` is `'error'`; any other status clears it.
   */
  readonly streamError: string | null;
  /** Fault-injection probability [0,1] forwarded to the execution stream. */
  readonly failRate: number;
  /** Execution mode reported by the stream for the current/last run; null until known. */
  readonly runMode: ExecutionMode | null;

  /**
   * Resets all node telemetry, opens a new run in the `running` state, and marks
   * it active. A run that is still active is finalized as `cancelled` first, so a
   * superseded run can never be left `running` in the history. Returns the new
   * run id so callers can correlate the stream.
   */
  readonly beginRun: () => RunId;
  /**
   * Applies a streamed telemetry event to its node and re-snapshots the active
   * run. Events whose `runId` does not match the active run are dropped to guard
   * against late-arriving frames from a superseded run.
   */
  readonly ingestTelemetryEvent: (event: TelemetryEvent) => void;
  /**
   * Closes the active run. Nodes still `running` are settled first, since no
   * further frame will arrive for them: a cancelled run returns them to `idle`,
   * any other outcome marks them `failed` with a `RUN_INTERRUPTED` error.
   */
  readonly finalizeRun: (status: TerminalRunStatus) => void;
  readonly cancelRun: () => void;
  /** Clears recorded runs, retaining only the active run (if any). */
  readonly clearRunHistory: () => void;
  /** Sets the transport status; `reason` is retained only for the `'error'` status. */
  readonly setStreamStatus: (status: StreamStatus, reason?: string) => void;
  /** Sets the fault-injection probability (clamped to [0,1]). */
  readonly setFailRate: (rate: number) => void;
  readonly setRunMode: (mode: ExecutionMode | null) => void;
}

type DataFlowSliceCreator = StateCreator<
  GraphStore,
  [['zustand/devtools', never]],
  [],
  DataFlowSlice
>;

/* ----------------------------- module helpers ---------------------------- */

/** Cap on retained runs; older runs are evicted on the next `beginRun`. */
const MAX_RUN_HISTORY = 25;

/** Attached to a node that was still in flight when its run terminated. */
const RUN_INTERRUPTED: TelemetryError = {
  code: 'RUN_INTERRUPTED',
  message: 'The run ended before this node reported a result.',
  originNodeId: null,
};

const snapshotTelemetry = (
  nodes: readonly NexusNode[],
): Readonly<Record<NodeId, NodeTelemetry>> => {
  const snapshot: Record<NodeId, NodeTelemetry> = {};
  for (const node of nodes) {
    snapshot[asNodeId(node.id)] = node.data.telemetry;
  }
  return snapshot;
};

/* --------------------------------- slice ---------------------------------- */

export const createDataFlowSlice: DataFlowSliceCreator = (set, get) => ({
  activeRunId: null,
  runsById: {},
  runOrder: [],
  streamStatus: 'disconnected',
  streamError: null,
  failRate: 0,
  runMode: null,

  beginRun: () => {
    if (get().activeRunId !== null) get().finalizeRun('cancelled');
    get().resetTelemetry();
    const runId = asRunId(`run_${crypto.randomUUID()}`);
    const nodes = get().nodes;
    const run: PipelineRun = {
      id: runId,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      telemetryByNode: snapshotTelemetry(nodes),
      metrics: computeRunMetrics(nodes, get().edges),
    };
    set(
      (store) => {
        const runOrder = [...store.runOrder, runId].slice(-MAX_RUN_HISTORY);
        const merged: Record<RunId, PipelineRun> = { ...store.runsById, [runId]: run };
        // Rebuild from the capped order so evicted runs are pruned from the map.
        const runsById = Object.fromEntries(
          runOrder.map((id) => [id, merged[id]!]),
        ) as Record<RunId, PipelineRun>;
        // `runMode` resets to null; the stream reports it via the `mode` event.
        return { activeRunId: runId, runsById, runOrder, runMode: null };
      },
      false,
      'dataFlow/beginRun',
    );
    return runId;
  },

  ingestTelemetryEvent: (event) => {
    const activeRunId = get().activeRunId;
    if (activeRunId === null || event.runId !== activeRunId) return;

    // Delegate the node-level write to the graph-UI slice so the reference-
    // preserving re-render guarantee holds for the canvas.
    get().updateNodeTelemetry(event.nodeId, event.state, event.patch);

    const nodes = get().nodes;
    const metrics = computeRunMetrics(nodes, get().edges);
    const telemetryByNode = snapshotTelemetry(nodes);
    set(
      (store) => {
        const current = store.runsById[activeRunId];
        if (current === undefined) return {};
        return {
          runsById: { ...store.runsById, [activeRunId]: { ...current, metrics, telemetryByNode } },
        };
      },
      false,
      'dataFlow/ingestTelemetryEvent',
    );
  },

  finalizeRun: (status) => {
    const activeRunId = get().activeRunId;
    if (activeRunId === null) return;

    // The stream is gone, so an in-flight node would otherwise stay `running`
    // indefinitely on the canvas and in the recorded run.
    for (const node of get().nodes) {
      if (node.data.telemetry.state !== 'running') continue;
      if (status === 'cancelled') get().updateNodeTelemetry(asNodeId(node.id), 'idle', {});
      else get().updateNodeTelemetry(asNodeId(node.id), 'failed', { error: RUN_INTERRUPTED });
    }

    const nodes = get().nodes;
    const metrics = computeRunMetrics(nodes, get().edges);
    const telemetryByNode = snapshotTelemetry(nodes);
    set(
      (store) => {
        const current = store.runsById[activeRunId];
        if (current === undefined) return { activeRunId: null };
        return {
          activeRunId: null,
          runsById: {
            ...store.runsById,
            [activeRunId]: {
              ...current,
              status,
              finishedAt: Date.now(),
              metrics,
              telemetryByNode,
            },
          },
        };
      },
      false,
      `dataFlow/finalizeRun:${status}`,
    );
  },

  cancelRun: () => get().finalizeRun('cancelled'),

  clearRunHistory: () =>
    set(
      (store) => {
        if (store.activeRunId === null) return { runsById: {}, runOrder: [] };
        const active = store.runsById[store.activeRunId];
        if (active === undefined) return { runsById: {}, runOrder: [] };
        return { runsById: { [store.activeRunId]: active }, runOrder: [store.activeRunId] };
      },
      false,
      'dataFlow/clearRunHistory',
    ),

  setStreamStatus: (status, reason) =>
    set(
      { streamStatus: status, streamError: status === 'error' ? (reason ?? null) : null },
      false,
      'dataFlow/setStreamStatus',
    ),

  setFailRate: (rate) =>
    set({ failRate: Math.min(Math.max(rate, 0), 1) }, false, 'dataFlow/setFailRate'),

  setRunMode: (mode) => set({ runMode: mode }, false, 'dataFlow/setRunMode'),
});
