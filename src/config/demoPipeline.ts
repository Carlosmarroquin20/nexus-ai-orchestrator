/**
 * Loadable example pipeline: a retrieval-augmented support assistant.
 *
 * A factory (not a constant) so every load yields fresh node objects with
 * pristine telemetry and no shared references. The graph is a valid DAG with
 * complete per-variant configuration and resolved `llmCoreRef` bindings, so the
 * diagnostics panel reports no issues on load.
 *
 * Layout is hand-placed in topological layers (sources left, sink right) so it
 * frames cleanly under `fitView`.
 */

import {
  type AgentNodeConfig,
  type ClassifierNodeConfig,
  type LlmCoreNodeConfig,
  NODE_KIND,
  type NexusEdge,
  type NexusNode,
  type NexusNodeConfig,
  type NexusNodeKind,
  type PromptTemplateNodeConfig,
  type VectorDbNodeConfig,
  asNodeId,
} from '@/types/graph';
import { NEXUS_EDGE_TYPE } from '@/config/nodeRegistry';
import { createPristineTelemetry } from '@/config/telemetry';

const IDS = {
  prompt: 'demo-prompt',
  vectordb: 'demo-vectordb',
  llm: 'demo-llm',
  classifier: 'demo-classifier',
  agent: 'demo-agent',
  formatter: 'demo-formatter',
} as const;

// The cast bridges the same correlated-union limitation as the store's node
// factory: `config` is the union type here, but each call site supplies a config
// matching `kind` (enforced by `satisfies` at the call site).
const makeNode = (
  id: string,
  kind: NexusNodeKind,
  label: string,
  position: { x: number; y: number },
  config: NexusNodeConfig,
): NexusNode =>
  ({
    id,
    type: kind,
    position,
    data: { kind, label, config, telemetry: createPristineTelemetry() },
  }) as unknown as NexusNode;

const makeEdge = (source: string, target: string): NexusEdge => ({
  id: `demo-edge-${source}-${target}`,
  source,
  target,
  sourceHandle: 'out',
  targetHandle: 'in',
  type: NEXUS_EDGE_TYPE,
  data: {
    dependencyKind: 'data',
    transformation: { kind: 'passthrough', expression: null, bytesTransferred: 0 },
  },
});

export const createDemoPipeline = (): { nodes: NexusNode[]; edges: NexusEdge[] } => ({
  nodes: [
    makeNode(IDS.prompt, NODE_KIND.PROMPT_TEMPLATE, 'Query Template', { x: 40, y: 40 }, {
      template:
        'Answer the question using only the provided context.\n\nQuestion: {{question}}\nContext: {{context}}',
      inputVariables: ['question', 'context'],
      version: '1.0.0',
    } satisfies PromptTemplateNodeConfig),

    makeNode(IDS.vectordb, NODE_KIND.VECTOR_DB, 'Knowledge Base', { x: 40, y: 220 }, {
      provider: 'pgvector',
      indexName: 'support-kb',
      embeddingModel: 'text-embedding-3-large',
      topK: 5,
      similarityMetric: 'cosine',
    } satisfies VectorDbNodeConfig),

    makeNode(IDS.llm, NODE_KIND.LLM_CORE, 'Claude Sonnet 4.6', { x: 40, y: 400 }, {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      temperature: 0.4,
      maxOutputTokens: 2048,
      topP: 1,
    } satisfies LlmCoreNodeConfig),

    makeNode(IDS.classifier, NODE_KIND.CLASSIFIER, 'Intent Classifier', { x: 380, y: 140 }, {
      labels: ['billing', 'technical', 'general'],
      confidenceThreshold: 0.6,
      llmCoreRef: asNodeId(IDS.llm),
    } satisfies ClassifierNodeConfig),

    makeNode(IDS.agent, NODE_KIND.AGENT, 'Retrieval Agent', { x: 720, y: 240 }, {
      systemPrompt:
        'You are a customer-support agent. Answer using the retrieved context; escalate when unsure.',
      toolNames: ['search_docs', 'escalate'],
      maxIterations: 6,
      llmCoreRef: asNodeId(IDS.llm),
    } satisfies AgentNodeConfig),

    makeNode(IDS.formatter, NODE_KIND.PROMPT_TEMPLATE, 'Response Formatter', { x: 1060, y: 240 }, {
      template: 'Format the assistant answer as concise Markdown.\n\n{{answer}}',
      inputVariables: ['answer'],
      version: '1.0.0',
    } satisfies PromptTemplateNodeConfig),
  ],
  edges: [
    makeEdge(IDS.prompt, IDS.classifier),
    makeEdge(IDS.llm, IDS.classifier),
    makeEdge(IDS.classifier, IDS.agent),
    makeEdge(IDS.vectordb, IDS.agent),
    makeEdge(IDS.llm, IDS.agent),
    makeEdge(IDS.agent, IDS.formatter),
  ],
});
