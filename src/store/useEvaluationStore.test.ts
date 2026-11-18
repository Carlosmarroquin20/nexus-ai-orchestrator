import { beforeEach, describe, expect, it } from 'vitest';

import { type SelectedDataset, useEvaluationStore } from '@/store/useEvaluationStore';
import type { EvalDataset } from '@/utils/evaluation/dataset';
import { IDLE_PROGRESS } from '@/utils/evaluation/progress';

const store = () => useEvaluationStore.getState();

const dataset = (name: string): EvalDataset => ({
  version: 1,
  name,
  cases: [{ id: 'c', input: 'q', checks: [{ scorer: 'equals', nodeId: 'n', expected: 'x' }] }],
});

const bundled: SelectedDataset = { source: 'bundled', key: 'smoke', dataset: dataset('Smoke') };
const imported: SelectedDataset = { source: 'imported', key: 'mine.json', dataset: dataset('Mine') };

beforeEach(() => {
  useEvaluationStore.setState({
    selection: null,
    imported: null,
    progress: IDLE_PROGRESS,
    history: [],
    historyLoaded: false,
  });
});

describe('useEvaluationStore', () => {
  it('keeps the imported dataset after switching to a bundled one', () => {
    store().selectDataset(imported);
    store().selectDataset(bundled);
    expect(store().selection).toBe(bundled);
    expect(store().imported).toBe(imported);
  });

  it('replaces the imported dataset with the next import', () => {
    const next: SelectedDataset = { ...imported, key: 'other.json' };
    store().selectDataset(imported);
    store().selectDataset(next);
    expect(store().imported).toBe(next);
  });

  it('loads the history once, starting empty without browser storage', () => {
    store().loadHistory();
    expect(store()).toMatchObject({ history: [], historyLoaded: true });
  });
});
