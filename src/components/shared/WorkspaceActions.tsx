'use client';

import { Download, Trash2, Upload } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';

import { useGraphTransfer } from '@/hooks/useGraphPersistence';
import { cn } from '@/utils/cn';

const BUTTON_CLASS =
  'flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent';

/**
 * Workspace-level persistence controls (import / export / clear) for the header
 * actions slot. Reads/writes the graph exclusively through the transfer API.
 */
export const WorkspaceActions = (): JSX.Element => {
  const { exportToFile, importFromFile, clearGraph } = useGraphTransfer();
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
        className={cn(BUTTON_CLASS, 'text-muted-foreground hover:text-state-failed')}
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
