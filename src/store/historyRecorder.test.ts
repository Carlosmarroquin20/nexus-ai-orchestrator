import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeNode } from '@/test/factories';
import { NODE_KIND, asNodeId } from '@/types/graph';
import { HISTORY_DEBOUNCE_MS, attachHistoryRecorder } from '@/store/historyRecorder';
import { useGraphStore } from '@/store/useGraphStore';

/**
 * The recorder writes to the store it observes, so these tests exercise it
 * against the real store: a stub would not reproduce the synchronous nested
 * notification that the re-entrancy guard exists for.
 */

const store = () => useGraphStore.getState();
const origin = { x: 0, y: 0 };

let detach: () => void = () => undefined;

const attach = (): void => {
  detach = attachHistoryRecorder(useGraphStore);
};

beforeEach(() => {
  vi.useFakeTimers();
  useGraphStore.setState({
    nodes: [],
    edges: [],
    selectedNodeId: null,
    past: [],
    future: [],
    historyApplying: false,
  });
});

afterEach(() => {
  detach();
  detach = () => undefined;
  vi.useRealTimers();
});

describe('attachHistoryRecorder', () => {
  it('records exactly one snapshot for a structural edit', () => {
    attach();
    expect(() => store().addNode(NODE_KIND.AGENT, origin)).not.toThrow();
    expect(store().past).toHaveLength(1);
    expect(store().past[0]!.nodes).toHaveLength(0);
  });

  it('coalesces a burst of edits into a single undo step', () => {
    attach();
    store().addNode(NODE_KIND.AGENT, origin);
    store().addNode(NODE_KIND.LLM_CORE, origin);
    expect(store().past).toHaveLength(1);

    vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
    store().addNode(NODE_KIND.CLASSIFIER, origin);
    expect(store().past).toHaveLength(2);
    expect(store().past[1]!.nodes).toHaveLength(2);
  });

  it('ignores telemetry and selection changes', () => {
    store().loadGraph([makeNode({ id: 'a' })], []);
    attach();
    store().updateNodeTelemetry(asNodeId('a'), 'running', {});
    store().selectNode(asNodeId('a'));
    store().resetTelemetry();
    expect(store().past).toHaveLength(0);
  });

  it('does not record undo or redo and resyncs its baseline', () => {
    attach();
    store().addNode(NODE_KIND.AGENT, origin);
    vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

    store().applyUndo();
    expect(store().nodes).toHaveLength(0);
    expect(store().past).toHaveLength(0);
    expect(store().future).toHaveLength(1);
    expect(store().historyApplying).toBe(false);

    store().applyRedo();
    expect(store().nodes).toHaveLength(1);
    expect(store().past).toHaveLength(1);
    expect(store().future).toHaveLength(0);

    // The next edit is measured against the redone graph, not a stale baseline.
    store().addNode(NODE_KIND.LLM_CORE, origin);
    expect(store().past).toHaveLength(2);
    expect(store().past[1]!.nodes).toHaveLength(1);
  });

  it('undoes a whole burst in one step', () => {
    attach();
    store().addNode(NODE_KIND.AGENT, origin);
    store().addNode(NODE_KIND.LLM_CORE, origin);
    vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

    store().applyUndo();
    expect(store().nodes).toHaveLength(0);
  });

  it('stops recording once detached', () => {
    attach();
    detach();
    store().addNode(NODE_KIND.AGENT, origin);
    expect(store().past).toHaveLength(0);
  });
});
