import { describe, expect, it } from 'vitest';

import { makeEdge, makeNode } from '@/test/factories';
import { NODE_KIND } from '@/types/graph';
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
