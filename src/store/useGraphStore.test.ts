import type { Connection } from '@xyflow/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { makeEdge, makeNode } from '@/test/factories';
import { NODE_KIND, asNodeId, asRunId } from '@/types/graph';
import { useGraphStore } from '@/store/useGraphStore';

/**
 * Store/state-machine tests. The Zustand store runs in Node (devtools no-ops
 * without a browser), so the mutation invariants — reference preservation, DAG
 * admissibility, run lifecycle, history — are verified without the UI.
 */

const reset = (): void => {
  useGraphStore.setState({
    nodes: [],
    edges: [],
    selectedNodeId: null,
    activeRunId: null,
    runsById: {},
    runOrder: [],
    streamStatus: 'disconnected',
    failRate: 0,
    runMode: null,
    past: [],
    future: [],
    historyApplying: false,
  });
};

const store = () => useGraphStore.getState();
const connection = (source: string, target: string): Connection => ({
  source,
  target,
  sourceHandle: 'out',
  targetHandle: 'in',
});

beforeEach(reset);

describe('graphUi: structure', () => {
  it('addNode appends a node with type/kind aligned and pristine telemetry', () => {
    const id = store().addNode(NODE_KIND.LLM_CORE, { x: 10, y: 20 });
    const [node] = store().nodes;
    expect(store().nodes).toHaveLength(1);
    expect(node!.id).toBe(id);
    expect(node!.type).toBe(NODE_KIND.LLM_CORE);
    expect(node!.data.kind).toBe(NODE_KIND.LLM_CORE);
    expect(node!.data.telemetry.state).toBe('idle');
  });

  it('onConnect adds an admissible edge', () => {
    store().loadGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], []);
    store().onConnect(connection('a', 'b'));
    expect(store().edges).toHaveLength(1);
  });

  it('onConnect rejects a cycle-forming edge', () => {
    store().loadGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], [makeEdge('a', 'b')]);
    store().onConnect(connection('b', 'a'));
    expect(store().edges).toHaveLength(1);
  });

  it('onConnect rejects a duplicate edge', () => {
    store().loadGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], [makeEdge('a', 'b')]);
    store().onConnect(connection('a', 'b'));
    expect(store().edges).toHaveLength(1);
  });

  it('removeNode drops the node, its edges, and a matching selection', () => {
    store().loadGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], [makeEdge('a', 'b')]);
    store().selectNode(asNodeId('a'));
    store().removeNode(asNodeId('a'));
    expect(store().nodes.map((n) => n.id)).toEqual(['b']);
    expect(store().edges).toHaveLength(0);
    expect(store().selectedNodeId).toBeNull();
  });
});

describe('graphUi: selection', () => {
  it('selectNode selects one node exclusively', () => {
    store().loadGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], []);
    store().selectNode(asNodeId('b'));
    expect(store().nodes.find((n) => n.id === 'b')!.selected).toBe(true);
    expect(store().nodes.find((n) => n.id === 'a')!.selected).toBeFalsy();
    expect(store().selectedNodeId).toBe('b');
  });

  it('clearSelection clears flags and the tracked selection', () => {
    store().loadGraph([makeNode({ id: 'a' })], []);
    store().selectNode(asNodeId('a'));
    store().clearSelection();
    expect(store().nodes.find((n) => n.id === 'a')!.selected).toBe(false);
    expect(store().selectedNodeId).toBeNull();
  });

  it('deleteSelected removes selected nodes', () => {
    store().loadGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], []);
    store().selectNode(asNodeId('a'));
    store().deleteSelected();
    expect(store().nodes.map((n) => n.id)).toEqual(['b']);
  });

  it('duplicateSelected clones with an offset and pristine telemetry', () => {
    store().loadGraph([makeNode({ id: 'a', state: 'completed', latencyMs: 500 })], []);
    store().selectNode(asNodeId('a'));
    store().duplicateSelected();
    expect(store().nodes).toHaveLength(2);
    const clone = store().nodes.find((n) => n.id !== 'a')!;
    expect(clone.data.telemetry.state).toBe('idle');
    expect(clone.selected).toBe(false);
    expect(clone.position.x).toBeGreaterThan(store().nodes[0]!.position.x);
  });
});

describe('graphUi: reference-preserving updates', () => {
  it('updateNodeTelemetry rebuilds only the target node, preserving siblings', () => {
    store().loadGraph([makeNode({ id: 'a' }), makeNode({ id: 'b' })], []);
    const before = store().nodes;
    const beforeB = before.find((n) => n.id === 'b')!;

    store().updateNodeTelemetry(asNodeId('a'), 'completed', { inputTokens: 100, outputTokens: 50 });

    const after = store().nodes;
    expect(after).not.toBe(before); // new array
    expect(after.find((n) => n.id === 'b')!).toBe(beforeB); // sibling identity preserved
    const a = after.find((n) => n.id === 'a')!;
    expect(a).not.toBe(before.find((n) => n.id === 'a'));
    expect(a.data.telemetry.totalTokens).toBe(150); // input + output invariant
  });

  it('updateNodeTelemetry on an unknown id preserves the array reference', () => {
    store().loadGraph([makeNode({ id: 'a' })], []);
    const before = store().nodes;
    store().updateNodeTelemetry(asNodeId('ghost'), 'completed', {});
    expect(store().nodes).toBe(before);
  });

  it('setNodeConfig and setNodeLabel update the target only', () => {
    store().loadGraph(
      [makeNode({ id: 'a', kind: NODE_KIND.LLM_CORE }), makeNode({ id: 'b' })],
      [],
    );
    const beforeB = store().nodes.find((n) => n.id === 'b')!;
    store().setNodeLabel(asNodeId('a'), 'Renamed');
    store().setNodeConfig(asNodeId('a'), {
      provider: 'google',
      model: 'gemini-2.0-flash',
      temperature: 0.2,
      maxOutputTokens: 1024,
      topP: 1,
    });
    expect(store().nodes.find((n) => n.id === 'a')!.data.label).toBe('Renamed');
    expect(store().nodes.find((n) => n.id === 'b')!).toBe(beforeB);
  });

  it('applyLayout repositions mapped nodes and keeps the rest', () => {
    store().loadGraph(
      [makeNode({ id: 'a', position: { x: 0, y: 0 } }), makeNode({ id: 'b', position: { x: 0, y: 0 } })],
      [],
    );
    store().applyLayout(new Map([['a', { x: 320, y: 40 }]]));
    expect(store().nodes.find((n) => n.id === 'a')!.position).toEqual({ x: 320, y: 40 });
    expect(store().nodes.find((n) => n.id === 'b')!.position).toEqual({ x: 0, y: 0 });
  });
});

describe('dataFlow: run lifecycle', () => {
  it('beginRun opens a running run and resets prior telemetry', () => {
    store().loadGraph([makeNode({ id: 'a', state: 'completed', latencyMs: 999 })], []);
    const runId = store().beginRun();
    expect(store().activeRunId).toBe(runId);
    expect(store().runsById[runId]!.status).toBe('running');
    expect(store().nodes.find((n) => n.id === 'a')!.data.telemetry.state).toBe('idle');
  });

  it('ingestTelemetryEvent applies matching events and updates run metrics', () => {
    store().loadGraph([makeNode({ id: 'a' })], []);
    const runId = store().beginRun();
    store().ingestTelemetryEvent({
      runId,
      nodeId: asNodeId('a'),
      state: 'completed',
      emittedAt: Date.now(),
      patch: { inputTokens: 100, outputTokens: 50, latencyMs: 200 },
    });
    expect(store().nodes.find((n) => n.id === 'a')!.data.telemetry.totalTokens).toBe(150);
    expect(store().runsById[runId]!.metrics.aggregateTotalTokens).toBe(150);
  });

  it('ingestTelemetryEvent ignores events from a superseded run', () => {
    store().loadGraph([makeNode({ id: 'a' })], []);
    store().beginRun();
    store().ingestTelemetryEvent({
      runId: asRunId('stale-run'),
      nodeId: asNodeId('a'),
      state: 'completed',
      emittedAt: Date.now(),
      patch: { inputTokens: 100 },
    });
    expect(store().nodes.find((n) => n.id === 'a')!.data.telemetry.state).toBe('idle');
  });

  it('finalizeRun terminates the active run', () => {
    store().beginRun();
    store().finalizeRun('completed');
    expect(store().activeRunId).toBeNull();
    const run = store().runOrder.map((id) => store().runsById[id]!).at(-1)!;
    expect(run.status).toBe('completed');
    expect(run.finishedAt).not.toBeNull();
  });

  it('caps the run history and retains the active run when cleared', () => {
    for (let i = 0; i < 30; i += 1) {
      store().beginRun();
      store().finalizeRun('completed');
    }
    expect(store().runOrder.length).toBeLessThanOrEqual(25);

    const active = store().beginRun();
    store().clearRunHistory();
    expect(store().runOrder).toEqual([active]);
  });

  it('setFailRate clamps to [0, 1]', () => {
    store().setFailRate(5);
    expect(store().failRate).toBe(1);
    store().setFailRate(-1);
    expect(store().failRate).toBe(0);
  });
});

describe('history: undo / redo', () => {
  it('restores a recorded snapshot and replays it', () => {
    store().addNode(NODE_KIND.LLM_CORE, { x: 0, y: 0 });
    store().recordSnapshot({ nodes: store().nodes, edges: store().edges }); // snapshot A (1 node)
    store().addNode(NODE_KIND.AGENT, { x: 0, y: 0 }); // state B (2 nodes)
    expect(store().nodes).toHaveLength(2);

    store().applyUndo();
    expect(store().nodes).toHaveLength(1);

    store().applyRedo();
    expect(store().nodes).toHaveLength(2);
  });

  it('applyUndo is a no-op with an empty past', () => {
    store().addNode(NODE_KIND.LLM_CORE, { x: 0, y: 0 });
    store().applyUndo();
    expect(store().nodes).toHaveLength(1);
  });
});
