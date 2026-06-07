'use client';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type OnSelectionChangeParams,
  ReactFlow,
} from '@xyflow/react';
import { useCallback } from 'react';

import { getNodeDescriptor } from '@/config/nodeRegistry';
import { useGraphActions, useNexusEdges, useNexusNodes } from '@/store/useGraphStore';
import { type NexusEdge, type NexusNode, asNodeId } from '@/types/graph';

import { CanvasToolbar } from './CanvasToolbar';
import { nexusEdgeTypes, nexusNodeTypes } from './nodeTypes';

/**
 * React Flow surface. The node/edge arrays and change handlers are sourced from
 * the store; selection is mirrored back into the store so the inspector can react
 * to it. Must be rendered inside a `ReactFlowProvider` (supplied by the page) so
 * that viewport-dependent hooks (e.g. `useGraphManipulation`) resolve.
 */
export const GraphCanvas = (): JSX.Element => {
  const nodes = useNexusNodes();
  const edges = useNexusEdges();
  const { onNodesChange, onEdgesChange, onConnect, setSelectedNode } = useGraphActions();

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes }: OnSelectionChangeParams): void => {
      const [first] = selectedNodes;
      setSelectedNode(first !== undefined ? asNodeId(first.id) : null);
    },
    [setSelectedNode],
  );

  return (
    <ReactFlow<NexusNode, NexusEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nexusNodeTypes}
      edgeTypes={nexusEdgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onSelectionChange={onSelectionChange}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.5 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: false }}
    >
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <MiniMap<NexusNode>
        pannable
        zoomable
        className="!bg-card"
        maskColor="hsl(var(--background) / 0.7)"
        nodeColor={(node) => `hsl(var(${getNodeDescriptor(node.data.kind).accentVar}))`}
      />
      <Controls className="!shadow-lg [&>button]:!border-border [&>button]:!bg-card [&>button]:!fill-foreground" />
      <CanvasToolbar />
    </ReactFlow>
  );
};
