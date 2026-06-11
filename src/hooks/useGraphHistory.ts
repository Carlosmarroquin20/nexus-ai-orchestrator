'use client';

import { useEffect } from 'react';

import type { GraphSnapshot } from '@/store/slices/historySlice';
import { useGraphStore } from '@/store/useGraphStore';
import type { NexusEdge, NexusNode } from '@/types/graph';

/**
 * Window of inactivity after which a burst of edits is committed as a single
 * undo step. Coalesces continuous gestures (dragging, typing) into one entry.
 */
const HISTORY_DEBOUNCE_MS = 300;

/**
 * Structural equality that deliberately ignores telemetry and selection. A node
 * object's identity changes on telemetry ticks and on selection, but its
 * `position`, `data.label`, and `data.config` references change only on genuine
 * structural/config edits. Comparing those references (plus node/edge identity)
 * yields an undo-relevant change signal without diffing deep payloads.
 */
const sameNodes = (a: readonly NexusNode[], b: readonly NexusNode[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    if (x.id !== y.id) return false;
    if (x.position !== y.position) return false;
    if (x.data.label !== y.data.label) return false;
    if (x.data.config !== y.data.config) return false;
  }
  return true;
};

const sameEdges = (a: readonly NexusEdge[], b: readonly NexusEdge[]): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    if (x.id !== y.id || x.source !== y.source || x.target !== y.target) return false;
  }
  return true;
};

const isSameStructure = (
  snapshot: GraphSnapshot,
  nodes: readonly NexusNode[],
  edges: readonly NexusEdge[],
): boolean => sameNodes(snapshot.nodes, nodes) && sameEdges(snapshot.edges, edges);

/**
 * Records topology/config edits into the undo history. Call EXACTLY ONCE at the
 * workspace root, after `useGraphAutoPersist` so the hydrated graph — not the
 * empty initial state — becomes the history baseline.
 *
 * `present` tracks the last committed structural snapshot. The first edit of a
 * burst pushes `present` onto the undo stack; the debounce timer marks the burst
 * end and advances `present`. Changes flagged `historyApplying` (undo/redo) only
 * resync `present` and are never recorded.
 */
export const useGraphHistory = (): void => {
  useEffect(() => {
    let present: GraphSnapshot = {
      nodes: useGraphStore.getState().nodes,
      edges: useGraphStore.getState().edges,
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    let burst = false;

    const commitPresent = (): void => {
      present = { nodes: useGraphStore.getState().nodes, edges: useGraphStore.getState().edges };
      burst = false;
      timer = null;
    };

    const unsubscribe = useGraphStore.subscribe((state) => {
      if (state.historyApplying) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        burst = false;
        present = { nodes: state.nodes, edges: state.edges };
        useGraphStore.setState({ historyApplying: false });
        return;
      }

      if (isSameStructure(present, state.nodes, state.edges)) return;

      if (!burst) {
        useGraphStore.getState().recordSnapshot(present);
        burst = true;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(commitPresent, HISTORY_DEBOUNCE_MS);
    });

    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, []);
};
