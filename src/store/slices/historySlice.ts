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
 */

import { type StateCreator } from 'zustand';

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
        nodes: previous.nodes,
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
        nodes: next.nodes,
        edges: next.edges,
        selectedNodeId: null,
      }),
      false,
      'history/applyRedo',
    );
  },

  clearHistory: () => set({ past: [], future: [] }, false, 'history/clearHistory'),
});
