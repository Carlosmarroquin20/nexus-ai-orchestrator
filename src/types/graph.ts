/**
 * Core domain model for the Nexus AI Orchestrator graph engine.
 *
 * This module is the single source of truth for graph topology, node taxonomy,
 * and execution telemetry. It is framework-agnostic at the domain layer and
 * interops with React Flow (`@xyflow/react`) only through the typed `Node` /
 * `Edge` aliases declared at the bottom of the file.
 *
 * Architectural constraints:
 * - Node/Edge `data` payloads are declared as `type` aliases (never `interface`).
 *   React Flow's generics constrain data to `Record<string, unknown>`; object
 *   `type` aliases satisfy that constraint via an implicit index signature,
 *   whereas `interface` declarations do not (they are open to augmentation and
 *   therefore lack the implicit signature). Converting these to interfaces will
 *   break `Node<TData>` instantiation.
 * - All domain records are `readonly`. Mutation happens exclusively through store
 *   actions that produce new references; this is what allows React Flow's
 *   per-node memoization to skip untouched nodes.
 */

import type { Edge, Node, NodeProps } from '@xyflow/react';

/* -------------------------------------------------------------------------- */
/* Branded identifiers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Nominal string brands. They prevent accidental substitution of one id kind
 * for another (e.g. passing an `EdgeId` where a `NodeId` is required) while
 * remaining runtime-identical to `string`.
 *
 * Boundary rule: React Flow exposes `id` as a plain `string`. Cross the brand
 * boundary explicitly with the `as*` constructors below — never with a raw
 * `as NodeId` cast scattered through call sites.
 */
declare const ID_BRAND: unique symbol;

export type NodeId = string & { readonly [ID_BRAND]: 'NodeId' };
export type EdgeId = string & { readonly [ID_BRAND]: 'EdgeId' };
export type RunId = string & { readonly [ID_BRAND]: 'RunId' };

export const asNodeId = (value: string): NodeId => value as NodeId;
export const asEdgeId = (value: string): EdgeId => value as EdgeId;
export const asRunId = (value: string): RunId => value as RunId;

/* -------------------------------------------------------------------------- */
/* Node taxonomy                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Enumeration of node variants supported by the orchestrator. Modeled as a
 * frozen const map rather than a TS `enum` to avoid the dual type/value runtime
 * artifact and to derive both the value namespace and the literal union below.
 */
export const NODE_KIND = {
  AGENT: 'AGENT',
  VECTOR_DB: 'VECTOR_DB',
  PROMPT_TEMPLATE: 'PROMPT_TEMPLATE',
  CLASSIFIER: 'CLASSIFIER',
  LLM_CORE: 'LLM_CORE',
} as const;

export type NexusNodeKind = (typeof NODE_KIND)[keyof typeof NODE_KIND];

/* -------------------------------------------------------------------------- */
/* Execution telemetry                                                        */
/* -------------------------------------------------------------------------- */

export type NodeExecutionState = 'idle' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Structured failure descriptor attached to telemetry when `state === 'failed'`.
 * `originNodeId` is non-null only when a failure propagated from an upstream node
 * across a data dependency edge, enabling root-cause tracing in the inspector.
 */
export interface TelemetryError {
  readonly code: string;
  readonly message: string;
  readonly originNodeId: NodeId | null;
}

/**
 * Per-node execution telemetry.
 *
 * Invariants (enforced by store actions, not by the type system):
 * - `totalTokens === inputTokens + outputTokens` at all times.
 * - `latencyMs` is `null` until the node first transitions out of `'idle'`; it
 *   is never negative.
 * - `error` is non-null iff `state === 'failed'`.
 * - `lastUpdatedAt` is `null` only in the pristine (never-executed) state.
 */
export interface NodeTelemetry {
  readonly state: NodeExecutionState;
  readonly latencyMs: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costInUSD: number;
  readonly inputPayload: Record<string, unknown>;
  readonly outputPayload: Record<string, unknown>;
  readonly lastUpdatedAt: number | null;
  readonly error: TelemetryError | null;
}

/**
 * Mutable subset of telemetry accepted by streaming ingest. `totalTokens` is
 * intentionally excluded — it is derived to preserve the additive invariant —
 * as are `state` and `lastUpdatedAt`, which are controlled by the store action.
 */
export type NodeTelemetryPatch = Partial<
  Pick<
    NodeTelemetry,
    'latencyMs' | 'inputTokens' | 'outputTokens' | 'costInUSD' | 'inputPayload' | 'outputPayload' | 'error'
  >
>;

/* -------------------------------------------------------------------------- */
/* Node-variant configuration                                                 */
/* -------------------------------------------------------------------------- */

export type LlmProvider = 'anthropic' | 'openai' | 'google' | 'mistral' | 'self_hosted';
export type VectorStoreProvider = 'pinecone' | 'weaviate' | 'qdrant' | 'pgvector';
export type SimilarityMetric = 'cosine' | 'dot_product' | 'euclidean';

export interface AgentNodeConfig {
  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
  readonly maxIterations: number;
  /** NodeId of the bound LLM_CORE that backs this agent; null when unbound. */
  readonly llmCoreRef: NodeId | null;
}

export interface VectorDbNodeConfig {
  readonly provider: VectorStoreProvider;
  readonly indexName: string;
  readonly embeddingModel: string;
  readonly topK: number;
  readonly similarityMetric: SimilarityMetric;
}

export interface PromptTemplateNodeConfig {
  readonly template: string;
  /** Declared interpolation variables; validated against `template` at parse time. */
  readonly inputVariables: readonly string[];
  readonly version: string;
}

export interface ClassifierNodeConfig {
  readonly labels: readonly string[];
  /** Decision threshold in the inclusive range [0, 1]. */
  readonly confidenceThreshold: number;
  readonly llmCoreRef: NodeId | null;
}

export interface LlmCoreNodeConfig {
  readonly provider: LlmProvider;
  readonly model: string;
  /** Sampling temperature in the inclusive range [0, 2]. */
  readonly temperature: number;
  readonly maxOutputTokens: number;
  /** Nucleus-sampling cutoff in the inclusive range [0, 1]. */
  readonly topP: number;
}

/** Union of every node-variant configuration payload. */
export type NexusNodeConfig =
  | AgentNodeConfig
  | VectorDbNodeConfig
  | PromptTemplateNodeConfig
  | ClassifierNodeConfig
  | LlmCoreNodeConfig;

/* -------------------------------------------------------------------------- */
/* Node data payloads                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Shared shape for every node's `data`. `kind` is duplicated from the React Flow
 * `node.type` field to make `data` independently discriminable in contexts that
 * receive payloads detached from their wrapper (e.g. the inspector).
 *
 * Invariant: `node.type === node.data.kind` for every node in the store.
 */
type NodeDataBase = {
  readonly kind: NexusNodeKind;
  readonly label: string;
  readonly description?: string;
  readonly telemetry: NodeTelemetry;
};

export type AgentNodeData = NodeDataBase & {
  readonly kind: typeof NODE_KIND.AGENT;
  readonly config: AgentNodeConfig;
};

export type VectorDbNodeData = NodeDataBase & {
  readonly kind: typeof NODE_KIND.VECTOR_DB;
  readonly config: VectorDbNodeConfig;
};

export type PromptTemplateNodeData = NodeDataBase & {
  readonly kind: typeof NODE_KIND.PROMPT_TEMPLATE;
  readonly config: PromptTemplateNodeConfig;
};

export type ClassifierNodeData = NodeDataBase & {
  readonly kind: typeof NODE_KIND.CLASSIFIER;
  readonly config: ClassifierNodeConfig;
};

export type LlmCoreNodeData = NodeDataBase & {
  readonly kind: typeof NODE_KIND.LLM_CORE;
  readonly config: LlmCoreNodeConfig;
};

/** Discriminated union over `kind` covering every node-variant payload. */
export type NexusNodeData =
  | AgentNodeData
  | VectorDbNodeData
  | PromptTemplateNodeData
  | ClassifierNodeData
  | LlmCoreNodeData;

/**
 * Compile-time guarantee that the data union and the kind union stay in sync.
 * If a variant is added to `NODE_KIND` without a matching data type (or vice
 * versa), one of these aliases resolves to `never` and downstream usage fails.
 */
export type _AssertKindCoverage = NexusNodeData['kind'] extends NexusNodeKind
  ? NexusNodeKind extends NexusNodeData['kind']
    ? true
    : never
  : never;

/* -------------------------------------------------------------------------- */
/* Edge data and structural tracking                                          */
/* -------------------------------------------------------------------------- */

/**
 * Classifies the semantics of an edge transformation applied to the upstream
 * `outputPayload` before it materializes as the downstream `inputPayload`.
 */
export type DataTransformKind = 'passthrough' | 'map' | 'filter' | 'reduce' | 'embed' | 'rerank';

export interface DataTransformation {
  readonly kind: DataTransformKind;
  /**
   * Declarative transform expression (JSONata-style). `null` for `'passthrough'`,
   * where the downstream input is referentially the upstream output.
   */
  readonly expression: string | null;
  readonly bytesTransferred: number;
}

export type GraphEdgeData = {
  /** `'data'` edges carry payloads; `'control'` edges encode ordering only. */
  readonly dependencyKind: 'data' | 'control';
  readonly transformation: DataTransformation;
};

/**
 * Topology-only projection of an edge, decoupled from React Flow's rendering
 * model. Cycle validators and topological sorting operate on this structure so
 * that graph algorithms never depend on the view layer.
 */
export interface EdgeDependency {
  readonly id: EdgeId;
  readonly source: NodeId;
  readonly target: NodeId;
  readonly kind: 'data' | 'control';
}

/* -------------------------------------------------------------------------- */
/* Pipeline execution                                                         */
/* -------------------------------------------------------------------------- */

export type PipelineRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Sum-based roll-up of per-node telemetry (no graph structure required). */
export interface RunTelemetryTotals {
  /** Sum of node latencies (cumulative compute time), NOT wall-clock. */
  readonly totalLatencyMs: number;
  readonly aggregateInputTokens: number;
  readonly aggregateOutputTokens: number;
  readonly aggregateTotalTokens: number;
  readonly aggregateCostInUSD: number;
  readonly nodeCount: number;
  readonly failedNodeCount: number;
  readonly skippedNodeCount: number;
}

/** Full run metrics: telemetry totals plus structural (critical-path) analysis. */
export interface PipelineRunMetrics extends RunTelemetryTotals {
  /**
   * Wall-clock latency of the longest dependency path — the minimum achievable
   * latency when independent branches run in parallel. Distinct from
   * `totalLatencyMs`, which sums every node's latency.
   */
  readonly criticalPathLatencyMs: number;
}

/**
 * An atomic, immutable execution of the pipeline. A run snapshots per-node
 * telemetry at capture time so historical runs remain stable even as the live
 * graph continues to mutate.
 */
export interface PipelineRun {
  readonly id: RunId;
  readonly status: PipelineRunStatus;
  readonly startedAt: number;
  /** Epoch ms; `null` while `status` is `'queued'` or `'running'`. */
  readonly finishedAt: number | null;
  readonly telemetryByNode: Readonly<Record<NodeId, NodeTelemetry>>;
  readonly metrics: PipelineRunMetrics;
}

/**
 * Discrete telemetry update emitted by the execution backend over the streaming
 * transport and consumed by the data-flow store slice.
 */
export interface TelemetryEvent {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly state: NodeExecutionState;
  readonly emittedAt: number;
  readonly patch: NodeTelemetryPatch;
}

/* -------------------------------------------------------------------------- */
/* React Flow interop aliases                                                 */
/* -------------------------------------------------------------------------- */

export type AgentNode = Node<AgentNodeData, typeof NODE_KIND.AGENT>;
export type VectorDbNode = Node<VectorDbNodeData, typeof NODE_KIND.VECTOR_DB>;
export type PromptTemplateNode = Node<PromptTemplateNodeData, typeof NODE_KIND.PROMPT_TEMPLATE>;
export type ClassifierNode = Node<ClassifierNodeData, typeof NODE_KIND.CLASSIFIER>;
export type LlmCoreNode = Node<LlmCoreNodeData, typeof NODE_KIND.LLM_CORE>;

/** Union of every concrete node type; the element type of the store's node array. */
export type NexusNode =
  | AgentNode
  | VectorDbNode
  | PromptTemplateNode
  | ClassifierNode
  | LlmCoreNode;

export type NexusEdge = Edge<GraphEdgeData>;

/** Per-variant `NodeProps` aliases consumed by custom canvas node components. */
export type AgentNodeProps = NodeProps<AgentNode>;
export type VectorDbNodeProps = NodeProps<VectorDbNode>;
export type PromptTemplateNodeProps = NodeProps<PromptTemplateNode>;
export type ClassifierNodeProps = NodeProps<ClassifierNode>;
export type LlmCoreNodeProps = NodeProps<LlmCoreNode>;
