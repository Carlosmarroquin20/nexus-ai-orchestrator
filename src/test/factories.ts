/**
 * Test factories for graph entities. Builds plain objects shaped like the domain
 * types (the React Flow generic is erased at runtime, so a localized structural
 * cast is sufficient). Used by the pure-core unit tests.
 */

import { NEXUS_EDGE_TYPE, getNodeDescriptor } from '@/config/nodeRegistry';
import { createPristineTelemetry } from '@/config/telemetry';
import {
  NODE_KIND,
  type NexusEdge,
  type NexusNode,
  type NexusNodeKind,
  type NodeExecutionState,
} from '@/types/graph';

export interface MakeNodeOptions {
  readonly id: string;
  readonly kind?: NexusNodeKind;
  readonly state?: NodeExecutionState;
  readonly latencyMs?: number | null;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costInUSD?: number;
  readonly config?: Record<string, unknown>;
  readonly position?: { x: number; y: number };
  readonly label?: string;
}

export const makeNode = (options: MakeNodeOptions): NexusNode => {
  const kind = options.kind ?? NODE_KIND.LLM_CORE;
  const inputTokens = options.inputTokens ?? 0;
  const outputTokens = options.outputTokens ?? 0;
  return {
    id: options.id,
    type: kind,
    position: options.position ?? { x: 0, y: 0 },
    data: {
      kind,
      label: options.label ?? options.id,
      config: { ...getNodeDescriptor(kind).createDefaultConfig(), ...options.config },
      telemetry: {
        ...createPristineTelemetry(),
        state: options.state ?? 'idle',
        latencyMs: options.latencyMs ?? null,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        costInUSD: options.costInUSD ?? 0,
      },
    },
  } as unknown as NexusNode;
};

export const makeEdge = (source: string, target: string): NexusEdge =>
  ({
    id: `${source}->${target}`,
    source,
    target,
    sourceHandle: 'out',
    targetHandle: 'in',
    type: NEXUS_EDGE_TYPE,
    data: {
      dependencyKind: 'data',
      transformation: { kind: 'passthrough', expression: null, bytesTransferred: 0 },
    },
  }) as NexusEdge;
