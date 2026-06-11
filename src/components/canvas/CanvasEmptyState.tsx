'use client';

import { Sparkles } from 'lucide-react';

import { useGraphTransfer } from '@/hooks/useGraphPersistence';

/**
 * Centered overlay shown when the graph is empty. The container is
 * pointer-events-none so canvas panning still works through it; only the card
 * captures clicks.
 */
export const CanvasEmptyState = (): JSX.Element => {
  const { loadDemo } = useGraphTransfer();

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-card/90 p-6 text-center shadow-lg backdrop-blur">
        <h2 className="text-sm font-semibold">Empty workspace</h2>
        <p className="text-xs text-muted-foreground">
          Add nodes from the toolbar or press Ctrl/⌘ K. To explore right away, load a sample pipeline.
        </p>
        <button
          type="button"
          onClick={loadDemo}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Sparkles className="size-3.5" aria-hidden />
          Load demo pipeline
        </button>
      </div>
    </div>
  );
};
