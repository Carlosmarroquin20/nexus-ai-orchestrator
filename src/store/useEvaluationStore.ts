/**
 * Evaluation state (ADR 0010): the dataset chosen in the panel, the progress of
 * the current evaluation, and the local history of finished ones.
 *
 * A store of its own rather than a slice of the graph store: evaluations do not
 * change the graph, and the graph's high-frequency telemetry updates should not
 * reach evaluation subscribers, nor the other way round. Keeping it in a store
 * (not component state) lets an evaluation keep running, and its result stay
 * visible, while the panel is closed.
 *
 * The history is read from storage lazily, on first use, because storage is
 * only available in the browser and the panel is the only reader.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import type { EvalDataset } from '@/utils/evaluation/dataset';
import {
  EVAL_HISTORY_STORAGE_KEY,
  type EvalRecord,
  appendEvalRecord,
  parseEvalHistory,
  serializeEvalHistory,
} from '@/utils/evaluation/history';
import { type EvalProgress, IDLE_PROGRESS } from '@/utils/evaluation/progress';
import { readLocalStorage, writeLocalStorage } from '@/utils/localStorage';
import { safeJsonParse } from '@/utils/telemetryEvent';

export interface SelectedDataset {
  readonly source: 'bundled' | 'imported';
  /** Bundled dataset id, or the imported file's name. */
  readonly key: string;
  readonly dataset: EvalDataset;
}

export interface EvaluationStore {
  readonly selection: SelectedDataset | null;
  /**
   * The last imported dataset, kept after switching to a bundled one so it stays
   * selectable without importing the file again.
   */
  readonly imported: SelectedDataset | null;
  readonly progress: EvalProgress;
  readonly history: readonly EvalRecord[];
  readonly historyLoaded: boolean;

  readonly selectDataset: (selection: SelectedDataset | null) => void;
  readonly updateProgress: (update: (progress: EvalProgress) => EvalProgress) => void;
  /** Reads the stored history once; later calls are no-ops. */
  readonly loadHistory: () => void;
  /** Adds a finished evaluation to the history and persists it. */
  readonly recordEvaluation: (record: EvalRecord) => void;
  readonly clearHistory: () => void;
}

const persist = (history: readonly EvalRecord[]): void =>
  writeLocalStorage(EVAL_HISTORY_STORAGE_KEY, serializeEvalHistory(history));

const storedHistory = (): EvalRecord[] => {
  const raw = readLocalStorage(EVAL_HISTORY_STORAGE_KEY);
  return raw === null ? [] : parseEvalHistory(safeJsonParse(raw));
};

export const useEvaluationStore = create<EvaluationStore>()(
  devtools(
    (set, get) => ({
      selection: null,
      imported: null,
      progress: IDLE_PROGRESS,
      history: [],
      historyLoaded: false,

      selectDataset: (selection) =>
        set(
          selection?.source === 'imported' ? { selection, imported: selection } : { selection },
          false,
          'evaluation/selectDataset',
        ),

      updateProgress: (update) =>
        set((state) => ({ progress: update(state.progress) }), false, 'evaluation/updateProgress'),

      loadHistory: () => {
        if (get().historyLoaded) return;
        set({ history: storedHistory(), historyLoaded: true }, false, 'evaluation/loadHistory');
      },

      recordEvaluation: (record) => {
        // Merged into the stored history, which may not have been loaded yet.
        get().loadHistory();
        const history = appendEvalRecord(get().history, record);
        set({ history }, false, 'evaluation/recordEvaluation');
        persist(history);
      },

      clearHistory: () => {
        set({ history: [], historyLoaded: true }, false, 'evaluation/clearHistory');
        persist([]);
      },
    }),
    { name: 'NexusEvaluationStore', enabled: process.env.NODE_ENV !== 'production' },
  ),
);
