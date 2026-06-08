/**
 * Pure static analysis of a pipeline graph. Produces a flat, severity-ordered
 * list of diagnostics covering structural integrity (cycles, isolation, dangling
 * references) and per-variant configuration completeness.
 *
 * Framework-agnostic and side-effect-free: operates on plain node/edge arrays so
 * it is trivially unit-testable and recomputable from a memoized selector. It
 * reads topology and config only — never telemetry.
 */

import {
  NODE_KIND,
  type NexusEdge,
  type NexusNode,
  type NodeId,
  asNodeId,
} from '@/types/graph';
import { detectCycle } from './graphValidation';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** Stable key for rendering and de-duplication: `${code}:${nodeId ?? 'graph'}`. */
  readonly id: string;
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  /** Related node for focus, or `null` for graph-level diagnostics. */
  readonly nodeId: NodeId | null;
}

const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*([\w$.]+)\s*\}\}/g;

/** Extracts the unique `{{ variable }}` references declared inside a template body. */
export const extractTemplateVariables = (template: string): string[] => {
  const found = new Set<string>();
  for (const match of template.matchAll(TEMPLATE_VARIABLE_PATTERN)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found];
};

/** Shared LLM_CORE binding validation for agents and classifiers. */
const validateLlmCoreRef = (
  ref: NodeId | null,
  ownerId: string,
  llmCoreIds: ReadonlySet<string>,
  nodeCount: number,
  add: (s: DiagnosticSeverity, code: string, message: string, nodeId: NodeId | null) => void,
  nodeId: NodeId,
): void => {
  if (ref === null) {
    add('warning', 'UNBOUND_LLM_CORE', 'No LLM core is bound.', nodeId);
    return;
  }
  if (ref === ownerId) {
    add('error', 'SELF_LLM_REF', 'Node is bound to itself.', nodeId);
    return;
  }
  // Distinguish "missing node" from "wrong kind" only when the graph is fully
  // loaded; an empty/partial graph would produce noise.
  if (!llmCoreIds.has(ref) && nodeCount > 0) {
    add('error', 'INVALID_LLM_REF', 'Bound LLM core is missing or not an LLM Core node.', nodeId);
  }
};

/**
 * Analyzes the graph and returns diagnostics ordered by severity (errors first),
 * preserving node order within a severity band.
 */
export const analyzeGraph = (
  nodes: readonly NexusNode[],
  edges: readonly NexusEdge[],
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const add = (
    severity: DiagnosticSeverity,
    code: string,
    message: string,
    nodeId: NodeId | null,
  ): void => {
    diagnostics.push({ id: `${code}:${nodeId ?? 'graph'}`, severity, code, message, nodeId });
  };

  // Graph-level: cycles. onConnect prevents them interactively, but imported
  // graphs are not guaranteed acyclic, so the DAG invariant is re-checked here.
  if (detectCycle(nodes, edges)) {
    add('error', 'CYCLE', 'The graph contains a cycle; execution order is undefined.', null);
  }

  const llmCoreIds = new Set(
    nodes.filter((node) => node.data.kind === NODE_KIND.LLM_CORE).map((node) => node.id),
  );
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }

  for (const node of nodes) {
    const nodeId = asNodeId(node.id);

    if (nodes.length > 1 && !connectedIds.has(node.id)) {
      add('info', 'ISOLATED', 'Node has no connections.', nodeId);
    }

    switch (node.data.kind) {
      case NODE_KIND.AGENT: {
        const { config } = node.data;
        if (config.systemPrompt.trim() === '') {
          add('warning', 'EMPTY_SYSTEM_PROMPT', 'System prompt is empty.', nodeId);
        }
        validateLlmCoreRef(config.llmCoreRef, node.id, llmCoreIds, nodes.length, add, nodeId);
        break;
      }
      case NODE_KIND.CLASSIFIER: {
        const { config } = node.data;
        if (config.labels.length === 0) {
          add('warning', 'EMPTY_LABELS', 'Classifier has no labels defined.', nodeId);
        }
        validateLlmCoreRef(config.llmCoreRef, node.id, llmCoreIds, nodes.length, add, nodeId);
        break;
      }
      case NODE_KIND.LLM_CORE: {
        if (node.data.config.model.trim() === '') {
          add('warning', 'EMPTY_MODEL', 'No model selected.', nodeId);
        }
        break;
      }
      case NODE_KIND.PROMPT_TEMPLATE: {
        const { config } = node.data;
        if (config.template.trim() === '') {
          add('warning', 'EMPTY_TEMPLATE', 'Template body is empty.', nodeId);
          break;
        }
        const used = new Set(extractTemplateVariables(config.template));
        const declared = new Set(config.inputVariables);
        const undeclared = [...used].filter((name) => !declared.has(name));
        const unused = [...declared].filter((name) => !used.has(name));
        if (undeclared.length > 0) {
          add(
            'warning',
            'UNDECLARED_VARS',
            `Template uses undeclared variables: ${undeclared.join(', ')}.`,
            nodeId,
          );
        }
        if (unused.length > 0) {
          add('info', 'UNUSED_VARS', `Declared but unused variables: ${unused.join(', ')}.`, nodeId);
        }
        break;
      }
      case NODE_KIND.VECTOR_DB: {
        if (node.data.config.indexName.trim() === '') {
          add('warning', 'EMPTY_INDEX', 'No index name configured.', nodeId);
        }
        break;
      }
      default: {
        const _exhaustive: never = node.data;
        return _exhaustive;
      }
    }
  }

  return diagnostics.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
};
