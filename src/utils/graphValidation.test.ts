import { describe, expect, it } from 'vitest';

import {
  detectCycle,
  isAdmissibleConnection,
  topologicalOrder,
  wouldCreateCycle,
} from '@/utils/graphValidation';

const n = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }));
const e = (
  pairs: ReadonlyArray<readonly [string, string]>,
): { source: string; target: string }[] => pairs.map(([source, target]) => ({ source, target }));

describe('detectCycle', () => {
  it('returns false for a DAG', () => {
    expect(detectCycle(n('a', 'b', 'c'), e([['a', 'b'], ['b', 'c']]))).toBe(false);
  });

  it('detects a back-edge cycle', () => {
    expect(detectCycle(n('a', 'b'), e([['a', 'b'], ['b', 'a']]))).toBe(true);
  });

  it('detects a self-loop', () => {
    expect(detectCycle(n('a'), e([['a', 'a']]))).toBe(true);
  });
});

describe('topologicalOrder', () => {
  it('orders dependencies before dependents', () => {
    const order = topologicalOrder(n('a', 'b', 'c'), e([['a', 'b'], ['b', 'c']]));
    expect(order).not.toBeNull();
    expect(order!.indexOf('a')).toBeLessThan(order!.indexOf('b'));
    expect(order!.indexOf('b')).toBeLessThan(order!.indexOf('c'));
  });

  it('returns null for a cyclic graph', () => {
    expect(topologicalOrder(n('a', 'b'), e([['a', 'b'], ['b', 'a']]))).toBeNull();
  });
});

describe('connection admissibility', () => {
  it('flags an edge that would close a cycle', () => {
    expect(wouldCreateCycle(n('a', 'b'), e([['a', 'b']]), 'b', 'a')).toBe(true);
  });

  it('allows an edge that keeps the graph acyclic', () => {
    expect(wouldCreateCycle(n('a', 'b', 'c'), e([['a', 'b']]), 'b', 'c')).toBe(false);
  });

  it('rejects self-connections and duplicates', () => {
    expect(isAdmissibleConnection(n('a'), [], 'a', 'a')).toBe(false);
    expect(isAdmissibleConnection(n('a', 'b'), e([['a', 'b']]), 'a', 'b')).toBe(false);
  });

  it('admits a valid new edge', () => {
    expect(isAdmissibleConnection(n('a', 'b', 'c'), e([['a', 'b']]), 'b', 'c')).toBe(true);
  });
});
