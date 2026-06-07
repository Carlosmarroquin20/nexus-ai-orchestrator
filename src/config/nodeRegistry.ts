/**
 * Node-variant registry: the immutable, single source of truth for per-kind
 * presentation metadata, handle topology, and default configuration factories.
 *
 * Constraint: this module is intentionally free of React and icon-library
 * imports. Icons are referenced by name (`NodeKindIcon`) and resolved to
 * components at the view layer, keeping configuration decoupled from rendering.
 */

import {
  NODE_KIND,
  type AgentNodeConfig,
  type ClassifierNodeConfig,
  type LlmCoreNodeConfig,
  type NexusNodeKind,
  type PromptTemplateNodeConfig,
  type VectorDbNodeConfig,
} from '@/types/graph';

/** Icon identifiers resolved against the lucide-react set in the canvas layer. */
export type NodeKindIcon = 'bot' | 'database' | 'file-text' | 'git-branch' | 'cpu';

export interface NodeHandleSpec {
  readonly id: string;
  readonly kind: 'source' | 'target';
  readonly label: string;
}

/** Maps a node kind to its corresponding configuration payload type. */
type ConfigForKind<K extends NexusNodeKind> = K extends typeof NODE_KIND.AGENT
  ? AgentNodeConfig
  : K extends typeof NODE_KIND.VECTOR_DB
    ? VectorDbNodeConfig
    : K extends typeof NODE_KIND.PROMPT_TEMPLATE
      ? PromptTemplateNodeConfig
      : K extends typeof NODE_KIND.CLASSIFIER
        ? ClassifierNodeConfig
        : K extends typeof NODE_KIND.LLM_CORE
          ? LlmCoreNodeConfig
          : never;

export interface NodeKindDescriptor<K extends NexusNodeKind = NexusNodeKind> {
  readonly kind: K;
  readonly displayName: string;
  readonly description: string;
  readonly icon: NodeKindIcon;
  /** HSL CSS custom property (declared in globals.css) used as the node accent. */
  readonly accentVar: `--${string}`;
  readonly handles: readonly NodeHandleSpec[];
  /** Produces a fresh, fully-populated default config. Never returns a shared reference. */
  readonly createDefaultConfig: () => ConfigForKind<K>;
}

const TARGET_HANDLE: NodeHandleSpec = { id: 'in', kind: 'target', label: 'Input' };
const SOURCE_HANDLE: NodeHandleSpec = { id: 'out', kind: 'source', label: 'Output' };

/**
 * Per-kind descriptors. The mapped-type annotation forces each entry's
 * `createDefaultConfig` to return exactly the config type bound to its key,
 * catching config/kind drift at compile time.
 */
export const NODE_REGISTRY: Readonly<{ [K in NexusNodeKind]: NodeKindDescriptor<K> }> = {
  [NODE_KIND.AGENT]: {
    kind: NODE_KIND.AGENT,
    displayName: 'Agent',
    description: 'Autonomous orchestrator that plans and dispatches tool calls over a bound LLM core.',
    icon: 'bot',
    accentVar: '--node-agent',
    handles: [TARGET_HANDLE, SOURCE_HANDLE],
    createDefaultConfig: (): AgentNodeConfig => ({
      systemPrompt: '',
      toolNames: [],
      maxIterations: 8,
      llmCoreRef: null,
    }),
  },
  [NODE_KIND.LLM_CORE]: {
    kind: NODE_KIND.LLM_CORE,
    displayName: 'LLM Core',
    description: 'Stateless inference primitive wrapping a single foundation-model endpoint.',
    icon: 'cpu',
    accentVar: '--node-llm-core',
    handles: [TARGET_HANDLE, SOURCE_HANDLE],
    createDefaultConfig: (): LlmCoreNodeConfig => ({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      temperature: 0.7,
      maxOutputTokens: 4_096,
      topP: 1,
    }),
  },
  [NODE_KIND.PROMPT_TEMPLATE]: {
    kind: NODE_KIND.PROMPT_TEMPLATE,
    displayName: 'Prompt Template',
    description: 'Parameterized prompt with declared interpolation variables and a pinned version.',
    icon: 'file-text',
    accentVar: '--node-prompt-template',
    handles: [TARGET_HANDLE, SOURCE_HANDLE],
    createDefaultConfig: (): PromptTemplateNodeConfig => ({
      template: '',
      inputVariables: [],
      version: '1.0.0',
    }),
  },
  [NODE_KIND.CLASSIFIER]: {
    kind: NODE_KIND.CLASSIFIER,
    displayName: 'Classifier',
    description: 'Routing primitive that maps an input payload onto a discrete label set.',
    icon: 'git-branch',
    accentVar: '--node-classifier',
    handles: [TARGET_HANDLE, SOURCE_HANDLE],
    createDefaultConfig: (): ClassifierNodeConfig => ({
      labels: [],
      confidenceThreshold: 0.5,
      llmCoreRef: null,
    }),
  },
  [NODE_KIND.VECTOR_DB]: {
    kind: NODE_KIND.VECTOR_DB,
    displayName: 'Vector Store',
    description: 'Similarity-search index over an embedding space for retrieval-augmented flows.',
    icon: 'database',
    accentVar: '--node-vector-db',
    handles: [TARGET_HANDLE, SOURCE_HANDLE],
    createDefaultConfig: (): VectorDbNodeConfig => ({
      provider: 'pgvector',
      indexName: 'default-index',
      embeddingModel: 'text-embedding-3-large',
      topK: 5,
      similarityMetric: 'cosine',
    }),
  },
};

/** Stable presentation order for the node palette / toolbox. */
export const NODE_KIND_ORDER: readonly NexusNodeKind[] = [
  NODE_KIND.AGENT,
  NODE_KIND.LLM_CORE,
  NODE_KIND.PROMPT_TEMPLATE,
  NODE_KIND.CLASSIFIER,
  NODE_KIND.VECTOR_DB,
];

/** Type-preserving accessor that narrows the descriptor to the requested kind. */
export const getNodeDescriptor = <K extends NexusNodeKind>(kind: K): NodeKindDescriptor<K> =>
  NODE_REGISTRY[kind];

/**
 * React Flow registration keys.
 *
 * Node type keys are the `NexusNodeKind` values themselves — the store sets
 * `node.type === node.data.kind`, so a single `nodeTypes` map keyed by kind
 * resolves every variant. The edge type key is registered separately.
 */
export const NEXUS_EDGE_TYPE = 'transformation' as const;
export type NexusEdgeType = typeof NEXUS_EDGE_TYPE;
