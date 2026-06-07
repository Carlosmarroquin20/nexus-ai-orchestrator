import type { EdgeTypes, NodeTypes } from '@xyflow/react';

import { NEXUS_EDGE_TYPE } from '@/config/nodeRegistry';
import { NODE_KIND } from '@/types/graph';

import { NexusNodeView } from './NexusNodeView';
import { TransformationEdge } from './TransformationEdge';

/**
 * React Flow type registries.
 *
 * Every node kind resolves to the single `NexusNodeView` renderer (variant
 * presentation is data-driven via the node registry). The casts bridge React
 * Flow's invariant `NodeTypes`/`EdgeTypes` records, which erase the concrete
 * node/edge generic that our components are precisely typed against — a
 * documented limitation of the library's registration surface.
 */
export const nexusNodeTypes = {
  [NODE_KIND.AGENT]: NexusNodeView,
  [NODE_KIND.VECTOR_DB]: NexusNodeView,
  [NODE_KIND.PROMPT_TEMPLATE]: NexusNodeView,
  [NODE_KIND.CLASSIFIER]: NexusNodeView,
  [NODE_KIND.LLM_CORE]: NexusNodeView,
} as NodeTypes;

export const nexusEdgeTypes = {
  [NEXUS_EDGE_TYPE]: TransformationEdge,
} as EdgeTypes;
