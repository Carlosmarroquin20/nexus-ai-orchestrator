/**
 * Graph UI state slice.
 *
 * Owns the visual graph topology — the React Flow node and edge arrays plus
 * selection — and the React Flow change handlers. Telemetry physically lives on
 * node `data`, so the canonical per-node telemetry write (`updateNodeTelemetry`)
 * is implemented here, where the node array is owned; the data-flow slice invokes
 * it through the shared store `get()` during streaming ingest.
 */

import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
import { type StateCreator } from 'zustand';

import { NEXUS_EDGE_TYPE, getNodeDescriptor } from '@/config/nodeRegistry';
import { type TokenPricing, createPristineTelemetry } from '@/config/telemetry';
import {
  NODE_KIND,
  asEdgeId,
  asNodeId,
  type GraphEdgeData,
  type NexusEdge,
  type NexusNode,
  type NexusNodeConfig,
  type NexusNodeData,
  type NexusNodeKind,
  type NodeExecutionState,
  type NodeId,
  type NodeTelemetryPatch,
} from '@/types/graph';
import { isAdmissibleConnection } from '@/utils/graphValidation';
import { reconcileTelemetry, resolvePricing } from '@/utils/telemetry';

import type { GraphStore } from '../useGraphStore';

export interface GraphUiSlice {
  readonly nodes: NexusNode[];
  readonly edges: NexusEdge[];
  readonly selectedNodeId: NodeId | null;

  readonly onNodesChange: (changes: NodeChange<NexusNode>[]) => void;
  readonly onEdgesChange: (changes: EdgeChange<NexusEdge>[]) => void;
  /** Commits a connection only if it preserves the DAG invariant; otherwise a no-op. */
  readonly onConnect: (connection: Connection) => void;

  readonly addNode: (kind: NexusNodeKind, position: XYPosition) => NodeId;
  readonly removeNode: (nodeId: NodeId) => void;
  readonly setSelectedNode: (nodeId: NodeId | null) => void;

  /**
   * Reconciles a single node's telemetry in place. Crucially, every untouched
   * node object retains its identity across the update, so React Flow's per-node
   * memoization re-renders only the affected node — never the whole canvas.
   * Unknown node ids resolve to a no-op that preserves all references.
   */
  readonly updateNodeTelemetry: (
    nodeId: NodeId,
    state: NodeExecutionState,
    patch: NodeTelemetryPatch,
  ) => void;

  /**
   * Replaces a node's configuration. The caller is responsible for passing a
   * config whose variant matches the node's kind (the editing forms guarantee
   * this by deriving the new config from the node's existing config).
   */
  readonly setNodeConfig: (nodeId: NodeId, config: NexusNodeConfig) => void;
  readonly setNodeLabel: (nodeId: NodeId, label: string) => void;

  /** Resets every node to pristine telemetry; invoked at run start. */
  readonly resetTelemetry: () => void;
}

type GraphUiSliceCreator = StateCreator<
  GraphStore,
  [['zustand/devtools', never]],
  [],
  GraphUiSlice
>;

/* ----------------------------- module helpers ---------------------------- */

const createNodeId = (): NodeId => asNodeId(`node_${crypto.randomUUID()}`);

const createEdgeId = (connection: Connection): string =>
  asEdgeId(
    `xy-edge__${connection.source}${connection.sourceHandle ?? ''}-${connection.target}${
      connection.targetHandle ?? ''
    }`,
  );

const createDefaultEdgeData = (): GraphEdgeData => ({
  dependencyKind: 'data',
  transformation: { kind: 'passthrough', expression: null, bytesTransferred: 0 },
});

/**
 * Builds a fully-populated `data` payload for a node kind. The cast bridges a
 * known TypeScript limitation: the compiler cannot correlate the generic key `K`
 * with the matching discriminated-union member, even though `createDefaultConfig`
 * is statically bound to the correct config type. The shape is exhaustively
 * correct by construction.
 */
const buildNodeData = <K extends NexusNodeKind>(kind: K): Extract<NexusNodeData, { kind: K }> => {
  const descriptor = getNodeDescriptor(kind);
  return {
    kind,
    label: descriptor.displayName,
    telemetry: createPristineTelemetry(),
    config: descriptor.createDefaultConfig(),
    // `as unknown as` is required because TypeScript cannot prove the generic
    // key `K` correlates with the matching union member; the shape is correct by
    // construction (see the function-level comment).
  } as unknown as Extract<NexusNodeData, { kind: K }>;
};

/** Resolves token pricing for nodes whose cost is model-derived; null otherwise. */
const resolvePricingForNode = (node: NexusNode): TokenPricing | null =>
  node.data.kind === NODE_KIND.LLM_CORE ? resolvePricing(node.data.config.model) : null;

/**
 * Reference-preserving single-node update. Returns a new array with only the
 * matched node replaced (siblings retain identity), or `null` if the id is
 * absent. This identity preservation is the precondition for React Flow's
 * selective re-render and is shared by every node-mutation action.
 */
const mapNodeById = (
  nodes: readonly NexusNode[],
  nodeId: NodeId,
  transform: (node: NexusNode) => NexusNode,
): NexusNode[] | null => {
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index === -1) return null;
  const next = nodes.slice();
  next[index] = transform(nodes[index]!);
  return next;
};

/* --------------------------------- slice ---------------------------------- */

export const createGraphUiSlice: GraphUiSliceCreator = (set) => ({
  nodes: [],
  edges: [],
  selectedNodeId: null,

  onNodesChange: (changes) =>
    set(
      (store) => ({ nodes: applyNodeChanges(changes, store.nodes) }),
      false,
      'graphUi/onNodesChange',
    ),

  onEdgesChange: (changes) =>
    set(
      (store) => ({ edges: applyEdgeChanges(changes, store.edges) }),
      false,
      'graphUi/onEdgesChange',
    ),

  onConnect: (connection) =>
    set(
      (store) => {
        if (!connection.source || !connection.target) return {};
        if (
          !isAdmissibleConnection(store.nodes, store.edges, connection.source, connection.target)
        ) {
          return {};
        }
        const edge: NexusEdge = {
          id: createEdgeId(connection),
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle,
          targetHandle: connection.targetHandle,
          type: NEXUS_EDGE_TYPE,
          data: createDefaultEdgeData(),
        };
        return { edges: addEdge(edge, store.edges) };
      },
      false,
      'graphUi/onConnect',
    ),

  addNode: (kind, position) => {
    const id = createNodeId();
    // Per-variant construction; the outer cast mirrors `buildNodeData` — the node
    // is a single concrete union member, which the compiler cannot infer from the
    // generic kind alone.
    const node = { id, type: kind, position, data: buildNodeData(kind) } as NexusNode;
    set((store) => ({ nodes: [...store.nodes, node] }), false, 'graphUi/addNode');
    return id;
  },

  removeNode: (nodeId) =>
    set(
      (store) => ({
        nodes: store.nodes.filter((node) => node.id !== nodeId),
        edges: store.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
        selectedNodeId: store.selectedNodeId === nodeId ? null : store.selectedNodeId,
      }),
      false,
      'graphUi/removeNode',
    ),

  setSelectedNode: (nodeId) =>
    set({ selectedNodeId: nodeId }, false, 'graphUi/setSelectedNode'),

  updateNodeTelemetry: (nodeId, state, patch) =>
    set(
      (store) => {
        const nodes = mapNodeById(store.nodes, nodeId, (target) => {
          const telemetry = reconcileTelemetry(
            target.data.telemetry,
            state,
            patch,
            Date.now(),
            resolvePricingForNode(target),
          );
          return { ...target, data: { ...target.data, telemetry } } as NexusNode;
        });
        return nodes !== null ? { nodes } : {};
      },
      false,
      'graphUi/updateNodeTelemetry',
    ),

  setNodeConfig: (nodeId, config) =>
    set(
      (store) => {
        const nodes = mapNodeById(
          store.nodes,
          nodeId,
          (target) => ({ ...target, data: { ...target.data, config } }) as NexusNode,
        );
        return nodes !== null ? { nodes } : {};
      },
      false,
      'graphUi/setNodeConfig',
    ),

  setNodeLabel: (nodeId, label) =>
    set(
      (store) => {
        const nodes = mapNodeById(
          store.nodes,
          nodeId,
          (target) => ({ ...target, data: { ...target.data, label } }) as NexusNode,
        );
        return nodes !== null ? { nodes } : {};
      },
      false,
      'graphUi/setNodeLabel',
    ),

  resetTelemetry: () =>
    set(
      (store) => ({
        nodes: store.nodes.map(
          (node) =>
            ({ ...node, data: { ...node.data, telemetry: createPristineTelemetry() } }) as NexusNode,
        ),
      }),
      false,
      'graphUi/resetTelemetry',
    ),
});
