import { describe, expect, it } from 'vitest';

import { createPristineTelemetry } from '@/config/telemetry';
import { makeEdge, makeNode } from '@/test/factories';
import type { NexusNode } from '@/types/graph';
import { isSameGraphStructure } from '@/utils/graphStructure';

const withData = (node: NexusNode, data: Partial<NexusNode['data']>): NexusNode =>
  ({ ...node, data: { ...node.data, ...data } }) as NexusNode;

describe('isSameGraphStructure', () => {
  const a = makeNode({ id: 'a' });
  const b = makeNode({ id: 'b' });
  const edges = [makeEdge('a', 'b')];
  const base = { nodes: [a, b], edges };

  it('treats identical references as the same structure', () => {
    expect(isSameGraphStructure(base, base)).toBe(true);
    expect(isSameGraphStructure(base, { nodes: [a, b], edges: [...edges] })).toBe(true);
  });

  it('ignores telemetry, selection, and measurement churn', () => {
    const ticked = withData(a, { telemetry: { ...createPristineTelemetry(), state: 'running' } });
    const selected = { ...b, selected: true, measured: { width: 240, height: 96 } } as NexusNode;
    expect(isSameGraphStructure(base, { nodes: [ticked, selected], edges })).toBe(true);
  });

  it('detects position, label, and config edits', () => {
    const moved = { ...a, position: { x: 10, y: 0 } } as NexusNode;
    expect(isSameGraphStructure(base, { nodes: [moved, b], edges })).toBe(false);
    expect(isSameGraphStructure(base, { nodes: [withData(a, { label: 'renamed' }), b], edges })).toBe(
      false,
    );
    const reconfigured = withData(a, { config: { ...a.data.config } } as Partial<NexusNode['data']>);
    expect(isSameGraphStructure(base, { nodes: [reconfigured, b], edges })).toBe(false);
  });

  it('detects added, removed, and reordered nodes', () => {
    expect(isSameGraphStructure(base, { nodes: [a], edges })).toBe(false);
    expect(isSameGraphStructure(base, { nodes: [a, b, makeNode({ id: 'c' })], edges })).toBe(false);
    expect(isSameGraphStructure(base, { nodes: [b, a], edges })).toBe(false);
  });

  it('detects edge changes', () => {
    expect(isSameGraphStructure(base, { nodes: [a, b], edges: [] })).toBe(false);
    expect(isSameGraphStructure(base, { nodes: [a, b], edges: [makeEdge('b', 'a')] })).toBe(false);
  });
});
