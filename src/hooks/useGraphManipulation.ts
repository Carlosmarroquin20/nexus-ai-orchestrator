'use client';

import { useMemo } from 'react';

import { useReactFlow } from '@xyflow/react';

import { useGraphActions, useGraphStore } from '@/store/useGraphStore';
import type { NexusEdge, NexusNode, NexusNodeKind, NodeId } from '@/types/graph';

export interface GraphManipulationApi {
  /** Instantiates a node centered in the current viewport. Returns its id. */
  readonly addNodeAtViewportCenter: (kind: NexusNodeKind) => NodeId;
  /** Instantiates a node at a screen-space point (e.g. a drag-drop coordinate). */
  readonly addNodeAtClientPoint: (
    kind: NexusNodeKind,
    client: { readonly x: number; readonly y: number },
  ) => NodeId;
  readonly deleteNode: (nodeId: NodeId) => void;
  /** Removes the currently selected node, if any. */
  readonly deleteSelectedNode: () => void;
}

/**
 * Viewport-aware graph manipulation primitives.
 *
 * Must be called within a `ReactFlowProvider` — it depends on `useReactFlow` to
 * project screen coordinates into flow space, accounting for the live pan/zoom
 * transform. The returned API has a stable identity across renders, so it is safe
 * to pass to memoized children and effect dependency arrays.
 */
export const useGraphManipulation = (): GraphManipulationApi => {
  const { screenToFlowPosition } = useReactFlow<NexusNode, NexusEdge>();
  const { addNode, removeNode } = useGraphActions();

  return useMemo<GraphManipulationApi>(() => {
    const addNodeAtClientPoint: GraphManipulationApi['addNodeAtClientPoint'] = (kind, client) =>
      addNode(kind, screenToFlowPosition(client));

    return {
      addNodeAtClientPoint,
      addNodeAtViewportCenter: (kind) =>
        addNodeAtClientPoint(kind, {
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        }),
      deleteNode: (nodeId) => removeNode(nodeId),
      deleteSelectedNode: () => {
        const { selectedNodeId } = useGraphStore.getState();
        if (selectedNodeId !== null) removeNode(selectedNodeId);
      },
    };
  }, [addNode, removeNode, screenToFlowPosition]);
};
