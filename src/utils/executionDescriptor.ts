/**
 * Projects the live graph onto the execution wire contract (`ExecutionDescriptor`).
 * Pure and framework-agnostic: the run controller calls it with a store snapshot.
 *
 * Only the fields the engine consumes cross the boundary. Presentation state,
 * telemetry, and config that has no execution effect (tool names, iteration
 * budgets, vector-store settings) stay on the client.
 *
 * Sampling resolution: AGENT and CLASSIFIER nodes carry no sampling settings of
 * their own. They are backed by the LLM_CORE node named in `llmCoreRef`, and
 * inherit its sampling settings. A reference that is unset, dangling, or points at
 * a node of another kind (all reported by the diagnostics panel) contributes
 * nothing, which leaves the provider's defaults in effect rather than failing
 * the run. The core's `provider`/`model` are not forwarded: the server executes
 * against its own configured model.
 */

import type { ExecutionDescriptor, ExecutionNodeParams } from '@/types/execution';
import {
  type LlmCoreNodeConfig,
  NODE_KIND,
  type NexusEdge,
  type NexusNode,
  type NodeId,
} from '@/types/graph';

type SamplingParams = Pick<ExecutionNodeParams, 'temperature' | 'maxOutputTokens'>;

const NO_SAMPLING: SamplingParams = {};

const samplingOf = (config: LlmCoreNodeConfig): SamplingParams => ({
  temperature: config.temperature,
  maxOutputTokens: config.maxOutputTokens,
});

/** Sampling settings of the LLM_CORE bound by `ref`, or none if it does not resolve. */
const boundSampling = (
  ref: NodeId | null,
  coreById: ReadonlyMap<string, LlmCoreNodeConfig>,
): SamplingParams => {
  if (ref === null) return NO_SAMPLING;
  const core = coreById.get(ref);
  return core !== undefined ? samplingOf(core) : NO_SAMPLING;
};

const extractParams = (
  node: NexusNode,
  coreById: ReadonlyMap<string, LlmCoreNodeConfig>,
): ExecutionNodeParams => {
  switch (node.data.kind) {
    case NODE_KIND.AGENT:
      return {
        systemPrompt: node.data.config.systemPrompt,
        ...boundSampling(node.data.config.llmCoreRef, coreById),
      };
    case NODE_KIND.CLASSIFIER:
      return {
        labels: node.data.config.labels,
        ...boundSampling(node.data.config.llmCoreRef, coreById),
      };
    case NODE_KIND.LLM_CORE:
      return samplingOf(node.data.config);
    case NODE_KIND.PROMPT_TEMPLATE:
      return { template: node.data.config.template };
    case NODE_KIND.VECTOR_DB:
      return {};
    default: {
      const _exhaustive: never = node.data;
      return _exhaustive;
    }
  }
};

export const buildExecutionDescriptor = (
  nodes: readonly NexusNode[],
  edges: readonly NexusEdge[],
): ExecutionDescriptor => {
  const coreById = new Map<string, LlmCoreNodeConfig>();
  for (const node of nodes) {
    if (node.data.kind === NODE_KIND.LLM_CORE) coreById.set(node.id, node.data.config);
  }
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      params: extractParams(node, coreById),
    })),
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target })),
  };
};
