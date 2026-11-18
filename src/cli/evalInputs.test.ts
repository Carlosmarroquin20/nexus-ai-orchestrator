import { describe, expect, it } from 'vitest';

import { demoGraph, findBundledDataset, resolveEvalInputs } from '@/cli/evalInputs';
import { createDemoPipeline } from '@/config/demoPipeline';
import { serializeGraph } from '@/utils/graphSerialization';

const bundled = findBundledDataset('support-triage');

/** A graph file as the editor exports it, optionally without some nodes. */
const exportedDemo = (withoutNodeIds: readonly string[] = []): unknown => {
  const { nodes, edges } = createDemoPipeline();
  return JSON.parse(
    serializeGraph(
      nodes.filter((node) => !withoutNodeIds.includes(node.id)),
      edges,
    ),
  ) as unknown;
};

describe('findBundledDataset', () => {
  it('finds bundled datasets by id only', () => {
    expect(bundled).toBeDefined();
    expect(findBundledDataset('missing')).toBeUndefined();
  });
});

describe('resolveEvalInputs', () => {
  it('evaluates the demo pipeline when no graph file is given', () => {
    const result = resolveEvalInputs({ evalId: 'eval_1', graphRaw: null, datasetRaw: bundled });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.evalId).toBe('eval_1');
    expect(result.request.graph).toEqual(demoGraph());
    expect(result.request.dataset.name).toBe('Support triage');
  });

  it('reads a graph file exported from the editor into the same descriptor', () => {
    const result = resolveEvalInputs({
      evalId: 'eval_1',
      graphRaw: exportedDemo(),
      datasetRaw: bundled,
    });
    expect(result.ok && result.request.graph).toEqual(demoGraph());
  });

  it('rejects a file that is not a graph snapshot', () => {
    expect(
      resolveEvalInputs({ evalId: 'eval_1', graphRaw: { nodes: [] }, datasetRaw: bundled }),
    ).toEqual({ ok: false, error: 'Invalid graph file: Unsupported schema version (expected 1).' });
  });

  it('applies the endpoint rules to the dataset', () => {
    const invalid = resolveEvalInputs({
      evalId: 'eval_1',
      graphRaw: null,
      datasetRaw: { cases: [] },
    });
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error).toMatch(/^Invalid dataset: /);

    const mismatch = resolveEvalInputs({
      evalId: 'eval_1',
      graphRaw: exportedDemo(['demo-formatter']),
      datasetRaw: bundled,
    });
    expect(mismatch).toEqual({
      ok: false,
      error: 'The dataset checks nodes this pipeline does not contain: demo-formatter.',
    });
  });

  it('rejects a graph file without nodes', () => {
    const empty = resolveEvalInputs({
      evalId: 'eval_1',
      graphRaw: { version: 1, nodes: [], edges: [] },
      datasetRaw: bundled,
    });
    expect(empty).toEqual({ ok: false, error: 'Graph has no nodes to execute.' });
  });
});
