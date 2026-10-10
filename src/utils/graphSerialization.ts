/**
 * Pure (de)serialization for graph snapshots — the persistence/transfer format.
 *
 * Invariants:
 * - A snapshot is a canonical projection of the authored document: only the
 *   fields listed in `PersistedNode` / `PersistedEdge` are written. React Flow
 *   runtime fields (`selected`, `dragging`, `measured`, ...) never reach the file,
 *   so serializing the same document twice yields identical bytes.
 * - Telemetry is NEVER persisted. It is execution state, not topology; snapshots
 *   omit it on write and rehydrate it to pristine on read. A reload must never
 *   resurrect a stale `running` state or fabricated latency.
 * - Every snapshot carries a `version`. Parsing rejects unknown versions rather
 *   than guessing, leaving room for an explicit migration step later.
 * - Parsing is defensive: untrusted/persisted input is validated structurally
 *   and self-consistency-checked (edges referencing absent nodes are dropped).
 *   Config field shapes are trusted within a schema version.
 */

import { NEXUS_EDGE_TYPE } from '@/config/nodeRegistry';
import { createPristineTelemetry } from '@/config/telemetry';
import {
  NODE_KIND,
  type DataTransformKind,
  type GraphEdgeData,
  type NexusEdge,
  type NexusNode,
  type NexusNodeConfig,
  type NexusNodeKind,
} from '@/types/graph';

import { isFiniteNumber, isRecord, isString } from './guards';

export const GRAPH_SCHEMA_VERSION = 1 as const;
export const GRAPH_STORAGE_KEY = 'nexus:graph:v1';

export interface GraphSnapshot {
  readonly nodes: NexusNode[];
  readonly edges: NexusEdge[];
}

interface PersistedNode {
  readonly id: string;
  readonly type: NexusNodeKind;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: {
    readonly kind: NexusNodeKind;
    readonly label: string;
    readonly description?: string;
    readonly config: NexusNodeConfig;
  };
}

interface PersistedEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly sourceHandle: string | null;
  readonly targetHandle: string | null;
  readonly data?: GraphEdgeData;
}

interface GraphEnvelope {
  readonly version: typeof GRAPH_SCHEMA_VERSION;
  readonly nodes: PersistedNode[];
  readonly edges: PersistedEdge[];
}

export type GraphParseResult =
  | { readonly ok: true; readonly snapshot: GraphSnapshot }
  | { readonly ok: false; readonly error: string };

const NODE_KINDS = new Set<string>(Object.values(NODE_KIND));
const TRANSFORM_KINDS = new Set<string>([
  'passthrough',
  'map',
  'filter',
  'reduce',
  'embed',
  'rerank',
]);

const isNodeKind = (value: unknown): value is NexusNodeKind =>
  typeof value === 'string' && NODE_KINDS.has(value);

/* ------------------------------- serialize ------------------------------- */

// `type` is written from `data.kind`: the two are equal by store invariant, and
// the discriminant is the statically-typed one.
const toPersistedNode = (node: NexusNode): PersistedNode => ({
  id: node.id,
  type: node.data.kind,
  position: { x: node.position.x, y: node.position.y },
  data: {
    kind: node.data.kind,
    label: node.data.label,
    ...(node.data.description !== undefined ? { description: node.data.description } : {}),
    config: node.data.config,
  },
});

const toPersistedEdge = (edge: NexusEdge): PersistedEdge => ({
  id: edge.id,
  source: edge.source,
  target: edge.target,
  sourceHandle: edge.sourceHandle ?? null,
  targetHandle: edge.targetHandle ?? null,
  ...(edge.data !== undefined ? { data: edge.data } : {}),
});

export const serializeGraph = (
  nodes: readonly NexusNode[],
  edges: readonly NexusEdge[],
): string => {
  const envelope: GraphEnvelope = {
    version: GRAPH_SCHEMA_VERSION,
    nodes: nodes.map(toPersistedNode),
    edges: edges.map(toPersistedEdge),
  };
  return JSON.stringify(envelope, null, 2);
};

/* --------------------------------- parse --------------------------------- */

const parsePosition = (raw: unknown): { x: number; y: number } | null => {
  if (!isRecord(raw) || !isFiniteNumber(raw['x']) || !isFiniteNumber(raw['y'])) return null;
  return { x: raw['x'], y: raw['y'] };
};

const parseNode = (raw: unknown): NexusNode | null => {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const type = raw['type'];
  const data = raw['data'];
  const position = parsePosition(raw['position']);
  if (!isString(id) || !isNodeKind(type) || position === null || !isRecord(data)) return null;

  const label = data['label'];
  const description = data['description'];
  const config = data['config'];
  // The data discriminant must agree with the React Flow node type, and config
  // must be an object. Field-level config validation is intentionally trusted
  // within a schema version (the cast below relies on this).
  if (data['kind'] !== type || !isString(label) || !isRecord(config)) return null;

  return {
    id,
    type,
    position,
    data: {
      kind: type,
      label,
      ...(isString(description) ? { description } : {}),
      config,
      telemetry: createPristineTelemetry(),
    },
  } as unknown as NexusNode;
};

const parseEdgeData = (raw: unknown): GraphEdgeData => {
  const fallback: GraphEdgeData = {
    dependencyKind: 'data',
    transformation: { kind: 'passthrough', expression: null, bytesTransferred: 0 },
  };
  if (!isRecord(raw) || !isRecord(raw['transformation'])) return fallback;
  const transformation = raw['transformation'];
  const kind = isString(transformation['kind']) && TRANSFORM_KINDS.has(transformation['kind'])
    ? (transformation['kind'] as DataTransformKind)
    : 'passthrough';
  return {
    dependencyKind: raw['dependencyKind'] === 'control' ? 'control' : 'data',
    transformation: {
      kind,
      expression: isString(transformation['expression']) ? transformation['expression'] : null,
      bytesTransferred: isFiniteNumber(transformation['bytesTransferred'])
        ? transformation['bytesTransferred']
        : 0,
    },
  };
};

const parseEdge = (raw: unknown): NexusEdge | null => {
  if (!isRecord(raw)) return null;
  const id = raw['id'];
  const source = raw['source'];
  const target = raw['target'];
  if (!isString(id) || !isString(source) || !isString(target)) return null;
  return {
    id,
    source,
    target,
    sourceHandle: isString(raw['sourceHandle']) ? raw['sourceHandle'] : null,
    targetHandle: isString(raw['targetHandle']) ? raw['targetHandle'] : null,
    type: NEXUS_EDGE_TYPE,
    data: parseEdgeData(raw['data']),
  };
};

/** Narrows arbitrary JSON into a validated, self-consistent {@link GraphSnapshot}. */
export const parseGraph = (raw: unknown): GraphParseResult => {
  if (!isRecord(raw)) return { ok: false, error: 'Invalid or empty graph file.' };
  if (raw['version'] !== GRAPH_SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported schema version (expected ${GRAPH_SCHEMA_VERSION}).` };
  }
  if (!Array.isArray(raw['nodes']) || !Array.isArray(raw['edges'])) {
    return { ok: false, error: 'Missing "nodes" or "edges" array.' };
  }

  const nodes: NexusNode[] = [];
  for (const candidate of raw['nodes']) {
    const node = parseNode(candidate);
    if (node === null) return { ok: false, error: 'Malformed node entry.' };
    nodes.push(node);
  }

  const edges: NexusEdge[] = [];
  for (const candidate of raw['edges']) {
    const edge = parseEdge(candidate);
    if (edge === null) return { ok: false, error: 'Malformed edge entry.' };
    edges.push(edge);
  }

  // Drop edges referencing absent nodes so the loaded graph is self-consistent.
  const nodeIds = new Set(nodes.map((node) => node.id));
  const validEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  return { ok: true, snapshot: { nodes, edges: validEdges } };
};
