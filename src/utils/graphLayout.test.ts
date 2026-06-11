import { describe, expect, it } from 'vitest';

import { computeLayeredLayout } from '@/utils/graphLayout';

const n = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }));
const e = (
  pairs: ReadonlyArray<readonly [string, string]>,
): { source: string; target: string }[] => pairs.map(([source, target]) => ({ source, target }));

describe('computeLayeredLayout', () => {
  it('places ranks left-to-right along a chain', () => {
    const positions = computeLayeredLayout(n('a', 'b', 'c'), e([['a', 'b'], ['b', 'c']]));
    expect(positions.get('a')!.x).toBeLessThan(positions.get('b')!.x);
    expect(positions.get('b')!.x).toBeLessThan(positions.get('c')!.x);
  });

  it('assigns independent sources the same rank, ahead of their shared target', () => {
    const positions = computeLayeredLayout(n('a', 'b', 'c'), e([['a', 'c'], ['b', 'c']]));
    expect(positions.get('a')!.x).toBe(positions.get('b')!.x);
    expect(positions.get('c')!.x).toBeGreaterThan(positions.get('a')!.x);
  });

  it('returns a position for every node even when cyclic', () => {
    const positions = computeLayeredLayout(n('a', 'b'), e([['a', 'b'], ['b', 'a']]));
    expect(positions.size).toBe(2);
  });

  it('returns an empty map for no nodes', () => {
    expect(computeLayeredLayout([], []).size).toBe(0);
  });
});
