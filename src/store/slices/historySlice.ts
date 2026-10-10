/**
 * Undo/redo history slice.
 *
 * A snapshot captures the current `nodes`/`edges` array references. Because the
 * graph-UI slice updates immutably (new arrays, and new node objects only for
 * changed nodes), capturing references is a correct O(1) snapshot — no deep copy.
 *
 * Recording cadence and the distinction between structural edits (undoable) and
 * telemetry/selection churn (not undoable) is owned by the `useGraphHistory`
 * recorder hook; this slice only manages the stacks and applies time-travel.
 * `historyApplying` is the handshake: undo/redo set it so the recorder ignores
 * the resulting change instead of recording it as a fresh edit.
 *
 * Telemetry is execution state, not document state (ADR 0004), so it is never
 * time-travelled. A captured node reference also captures whatever telemetry the
 * node held at capture time, which may predate a run or have been taken mid-run;
 * restoring it verbatim would erase a finished run's results or resurrect a
 * `running` state that no stream will ever settle. Undo/redo therefore restore
 * structure only and re-base the live telemetry onto it (`withLiveTelemetry`).
 */

import { type StateCreator } from 'zustand';

import { createPristineTelemetry } from '@/config/telemetry';
import type { NexusEdge, NexusNode } from '@/types/graph';

import type { GraphStore } from '../useGraphStore';

export interface GraphSnapshot {
  readonly nodes: NexusNode[];
  readonly edges: NexusEdge[];
}

const MAX_HISTORY_DEPTH = 100;

export interface HistorySlice {
  readonly past: GraphSnapshot[];
  readonly future: GraphSnapshot[];
  /** Set transiently by undo/redo so the recorder ignores the induced change. */
  readonly historyApplying: boolean;

  /** Pushes a pre-change snapshot onto the undo stack and clears the redo stack. */
  readonly recordSnapshot: (snapshot: GraphSnapshot) => void;
  readonly applyUndo: () => void;
  readonly applyRedo: () => void;
  readonly clearHistory: () => void;
}

type HistorySliceCreator = StateCreator<
  GraphStore,
  [['zustand/devtools', never]],
  [],
  HistorySlice
>;

/**
 * Projects the live telemetry onto a restored node array. A node present in the
 * live graph keeps its current telemetry; a node the restore brings back (it was
 * deleted since the snapshot) has no live execution state and starts pristine.
 * Node identity is preserved whenever the telemetry reference is already current,
 * so restoring across a telemetry-free interval re-renders nothing extra.
 */
const withLiveTelemetry = (
  restored: readonly NexusNode[],
  live: readonly NexusNode[],
): NexusNode[] => {
  const liveTelemetry = new Map(live.map((node) => [node.id, node.data.telemetry]));
  return restored.map((node) => {
    const telemetry = liveTelemetry.get(node.id) ?? createPristineTelemetry();
    return telemetry === node.data.telemetry
      ? node
      : ({ ...node, data: { ...node.data, telemetry } } as NexusNode);
  });
};

export const createHistorySlice: HistorySliceCreator = (set, get) => ({
  past: [],
  future: [],
  historyApplying: false,

  recordSnapshot: (snapshot) =>
    set(
      (store) => ({ past: [...store.past, snapshot].slice(-MAX_HISTORY_DEPTH), future: [] }),
      false,
      'history/recordSnapshot',
    ),

  applyUndo: () => {
    const { past, nodes, edges } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1]!;
    set(
      (store) => ({
        past: store.past.slice(0, -1),
        future: [...store.future, { nodes, edges }],
        historyApplying: true,
        nodes: withLiveTelemetry(previous.nodes, nodes),
        edges: previous.edges,
        selectedNodeId: null,
      }),
      false,
      'history/applyUndo',
    );
  },

  applyRedo: () => {
    const { future, nodes, edges } = get();
    if (future.length === 0) return;
    const next = future[future.length - 1]!;
    set(
      (store) => ({
        future: store.future.slice(0, -1),
        past: [...store.past, { nodes, edges }],
        historyApplying: true,
        nodes: withLiveTelemetry(next.nodes, nodes),
        edges: next.edges,
        selectedNodeId: null,
      }),
      false,
      'history/applyRedo',
    );
  },

  clearHistory: () => set({ past: [], future: [] }, false, 'history/clearHistory'),
});
