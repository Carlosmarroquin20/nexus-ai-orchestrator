'use client';

import { Download, Redo2, Trash2, Undo2, Upload } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';

import { useGraphActions, useGraphStore } from '@/store/useGraphStore';
import { useGraphTransfer } from '@/hooks/useGraphPersistence';
import { cn } from '@/utils/cn';

const BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

/**
 * Workspace-level controls: undo/redo history and graph persistence
 * (import / export / clear). Operates exclusively through store actions and the
 * transfer API.
 */
export const WorkspaceActions = (): JSX.Element => {
  const { exportToFile, importFromFile, clearGraph } = useGraphTransfer();
  const { applyUndo, applyRedo } = useGraphActions();
  const canUndo = useGraphStore((state) => state.past.length > 0);
  const canRedo = useGraphStore((state) => state.future.length > 0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const onImportClick = (): void => {
    setError(null);
    fileInputRef.current?.click();
  };

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.currentTarget.files?.[0];
    // Reset the input so selecting the same file again re-triggers onChange.
    event.currentTarget.value = '';
    if (file === undefined) return;
    const result = await importFromFile(file);
    if (!result.ok) setError(result.error);
  };

  const onClear = (): void => {
    if (window.confirm('Discard the current pipeline? This action cannot be undone.')) {
      clearGraph();
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      {error !== null ? <span className="text-[11px] text-state-failed">{error}</span> : null}

      <button
        type="button"
        onClick={applyUndo}
        disabled={!canUndo}
        aria-label="Undo"
        title="Undo (Ctrl/⌘ Z)"
        className={cn(BUTTON_CLASS, 'px-1.5')}
      >
        <Undo2 className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={applyRedo}
        disabled={!canRedo}
        aria-label="Redo"
        title="Redo (Ctrl/⌘ Shift Z)"
        className={cn(BUTTON_CLASS, 'px-1.5')}
      >
        <Redo2 className="size-3.5" aria-hidden />
      </button>

      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

      <button type="button" onClick={onImportClick} className={BUTTON_CLASS}>
        <Upload className="size-3.5" aria-hidden />
        Import
      </button>
      <button type="button" onClick={exportToFile} className={BUTTON_CLASS}>
        <Download className="size-3.5" aria-hidden />
        Export
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear pipeline"
        className={cn(BUTTON_CLASS, 'px-1.5 text-muted-foreground hover:text-state-failed')}
      >
        <Trash2 className="size-3.5" aria-hidden />
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
  );
};
