import { describe, expect, it } from 'vitest';

import { makeEdge, makeNode } from '@/test/factories';
import { NODE_KIND, type NexusNode } from '@/types/graph';
import { GRAPH_SCHEMA_VERSION, parseGraph, serializeGraph } from '@/utils/graphSerialization';
import { safeJsonParse } from '@/utils/telemetryEvent';

describe('serializeGraph / parseGraph', () => {
  it('round-trips nodes and edges', () => {
    const nodes = [
      makeNode({ id: 'a', kind: NODE_KIND.LLM_CORE }),
      makeNode({ id: 'b', kind: NODE_KIND.AGENT }),
    ];
    const result = parseGraph(safeJsonParse(serializeGraph(nodes, [makeEdge('a', 'b')])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.nodes.map((node) => node.id)).toEqual(['a', 'b']);
      expect(result.snapshot.edges).toHaveLength(1);
    }
  });

  it('strips telemetry to pristine on serialize', () => {
    const node = makeNode({ id: 'a', state: 'completed', latencyMs: 999, inputTokens: 50 });
    const result = parseGraph(safeJsonParse(serializeGraph([node], [])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const telemetry = result.snapshot.nodes[0]!.data.telemetry;
      expect(telemetry.state).toBe('idle');
      expect(telemetry.latencyMs).toBeNull();
      expect(telemetry.totalTokens).toBe(0);
    }
  });

  it('writes only authored fields, omitting telemetry and runtime state', () => {
    const node = {
      ...makeNode({ id: 'a', state: 'running', latencyMs: 12 }),
      selected: true,
      dragging: true,
      measured: { width: 240, height: 96 },
    } as NexusNode;
    const envelope = JSON.parse(serializeGraph([node], [])) as {
      nodes: Array<Record<string, unknown> & { data: Record<string, unknown> }>;
    };
    expect(Object.keys(envelope.nodes[0]!)).toEqual(['id', 'type', 'position', 'data']);
    expect(Object.keys(envelope.nodes[0]!.data)).toEqual(['kind', 'label', 'config']);
  });

  it('serializes identically regardless of telemetry and selection', () => {
    const edges = [makeEdge('a', 'b')];
    const plain = [makeNode({ id: 'a' }), makeNode({ id: 'b' })];
    const churned = [
      {
        ...makeNode({ id: 'a', state: 'completed', latencyMs: 300, inputTokens: 40 }),
        selected: true,
      } as NexusNode,
      makeNode({ id: 'b', state: 'failed' }),
    ];
    const selectedEdges = edges.map((edge) => ({ ...edge, selected: true }));
    expect(serializeGraph(churned, selectedEdges)).toBe(serializeGraph(plain, edges));
  });

  it('round-trips the optional node description', () => {
    const base = makeNode({ id: 'a' });
    const described = { ...base, data: { ...base.data, description: 'entry point' } } as NexusNode;
    const result = parseGraph(safeJsonParse(serializeGraph([described, makeNode({ id: 'b' })], [])));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.nodes[0]!.data.description).toBe('entry point');
      expect('description' in result.snapshot.nodes[1]!.data).toBe(false);
    }
  });

  it('rejects an unknown schema version', () => {
    expect(parseGraph({ version: 999, nodes: [], edges: [] }).ok).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(parseGraph(null).ok).toBe(false);
    expect(parseGraph({ version: GRAPH_SCHEMA_VERSION }).ok).toBe(false);
  });

  it('drops edges referencing absent nodes', () => {
    const json = JSON.stringify({
      version: GRAPH_SCHEMA_VERSION,
      nodes: [
        {
          id: 'a',
          type: NODE_KIND.LLM_CORE,
          position: { x: 0, y: 0 },
          data: { kind: NODE_KIND.LLM_CORE, label: 'a', config: {} },
        },
      ],
      edges: [{ id: 'e', source: 'a', target: 'ghost' }],
    });
    const result = parseGraph(safeJsonParse(json));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.edges).toHaveLength(0);
  });
});
