'use client';

import { useReactFlow } from '@xyflow/react';
import { useCallback } from 'react';

import { useGraphStore } from '@/store/useGraphStore';
import type { NexusEdge, NexusNode } from '@/types/graph';
import { computeLayeredLayout } from '@/utils/graphLayout';

/**
 * Returns a callback that re-ranks the graph into topological layers and frames
 * the result. `fitView` is deferred one frame so React Flow has rendered the new
 * positions before it measures and frames them. Must be used within a
 * `ReactFlowProvider`.
 */
export const useAutoLayout = (): (() => void) => {
  const reactFlow = useReactFlow<NexusNode, NexusEdge>();

  return useCallback(() => {
    const { nodes, edges, applyLayout } = useGraphStore.getState();
    if (nodes.length === 0) return;
    applyLayout(computeLayeredLayout(nodes, edges));
    window.requestAnimationFrame(() => {
      void reactFlow.fitView({ padding: 0.2, duration: 400 });
    });
  }, [reactFlow]);
};
