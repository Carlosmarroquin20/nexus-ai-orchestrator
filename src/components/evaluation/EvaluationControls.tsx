'use client';

import { Play, Square, Upload } from 'lucide-react';
import { type ChangeEvent, type JSX, useEffect, useRef, useState } from 'react';

import { Select } from '@/components/ui/select';
import { BUNDLED_DATASETS } from '@/config/evalDatasets';
import { readDatasetFile, startEvaluation, stopEvaluation } from '@/services/evalExecutor';
import { type SelectedDataset, useEvaluationStore } from '@/store/useEvaluationStore';
import { cn } from '@/utils/cn';
import { type EvalDataset, parseEvalDataset } from '@/utils/evaluation/dataset';

/**
 * Bundled datasets, parsed once. They pass the same parser as imported files; a
 * test keeps them valid, so one that fails here is left out rather than offered.
 */
const BUNDLED_SELECTIONS: readonly SelectedDataset[] = BUNDLED_DATASETS.flatMap((entry) => {
  const result = parseEvalDataset(entry.raw);
  return result.ok ? [{ source: 'bundled' as const, key: entry.id, dataset: result.dataset }] : [];
});

const optionValue = (selection: SelectedDataset): string => `${selection.source}:${selection.key}`;

const describeDataset = (dataset: EvalDataset): string => {
  const checks = dataset.cases.flatMap((evalCase) => evalCase.checks);
  const judged = checks.filter((check) => check.scorer === 'llm_judge').length;
  const parts = [
    `${dataset.cases.length} case${dataset.cases.length === 1 ? '' : 's'}`,
    `${checks.length} check${checks.length === 1 ? '' : 's'}`,
    ...(judged > 0 ? [`${judged} graded by the LLM judge`] : []),
  ];
  return parts.join(' · ');
};

const BUTTON_CLASS =
  'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40';

/** Dataset choice (bundled or imported) and the run/stop control. */
export const EvaluationControls = (): JSX.Element => {
  const selection = useEvaluationStore((state) => state.selection);
  const imported = useEvaluationStore((state) => state.imported);
  const selectDataset = useEvaluationStore((state) => state.selectDataset);
  const phase = useEvaluationStore((state) => state.progress.phase);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const isRunning = phase === 'connecting' || phase === 'running';

  // Preselect the first bundled dataset, so the panel is usable in one click.
  useEffect(() => {
    if (selection === null && BUNDLED_SELECTIONS[0] !== undefined) selectDataset(BUNDLED_SELECTIONS[0]);
  }, [selection, selectDataset]);

  const options = imported !== null ? [...BUNDLED_SELECTIONS, imported] : BUNDLED_SELECTIONS;

  const onSelect = (value: string): void => {
    const next = options.find((option) => optionValue(option) === value);
    if (next !== undefined) selectDataset(next);
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    // Reset the input so choosing the same file again re-triggers onChange.
    event.currentTarget.value = '';
    if (file === undefined) return;
    const result = await readDatasetFile(file);
    if (!result.ok) {
      setImportError(`${file.name}: ${result.error}`);
      return;
    }
    setImportError(null);
    selectDataset({ source: 'imported', key: file.name, dataset: result.dataset });
  };

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="eval-dataset" className="text-xs font-medium text-muted-foreground">
          Dataset
        </label>
        <Select
          id="eval-dataset"
          className="w-64"
          value={selection !== null ? optionValue(selection) : ''}
          onChange={(event) => onSelect(event.currentTarget.value)}
          disabled={isRunning}
        >
          {options.map((option) => (
            <option key={optionValue(option)} value={optionValue(option)}>
              {option.source === 'imported'
                ? `${option.dataset.name} (${option.key})`
                : option.dataset.name}
            </option>
          ))}
        </Select>
        <button
          type="button"
          onClick={() => {
            setImportError(null);
            fileInputRef.current?.click();
          }}
          disabled={isRunning}
          className={cn(BUTTON_CLASS, 'border border-border font-medium text-foreground hover:bg-accent')}
        >
          <Upload className="size-3.5" aria-hidden />
          Import JSON
        </button>

        <button
          type="button"
          onClick={isRunning ? stopEvaluation : startEvaluation}
          disabled={!isRunning && selection === null}
          className={cn(
            BUTTON_CLASS,
            'ml-auto',
            isRunning
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          {isRunning ? (
            <>
              <Square className="size-3.5" aria-hidden />
              Stop
            </>
          ) : (
            <>
              <Play className="size-3.5" aria-hidden />
              Run evaluation
            </>
          )}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            void onFileChange(event);
          }}
        />
      </div>

      {selection !== null ? (
        <p className="text-xs text-muted-foreground">
          <span className="text-foreground">{describeDataset(selection.dataset)}.</span>{' '}
          {selection.dataset.description ?? ''}
        </p>
      ) : null}
      {importError !== null ? (
        <p role="alert" className="break-words text-xs text-state-failed">
          {importError}
        </p>
      ) : null}
    </div>
  );
};
