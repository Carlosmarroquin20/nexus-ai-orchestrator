'use client';

import * as Tabs from '@radix-ui/react-tabs';
import { FlaskConical, X } from 'lucide-react';
import { type JSX, useEffect, useState } from 'react';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useEvaluationStore } from '@/store/useEvaluationStore';

import { EvaluationCompare } from './EvaluationCompare';
import { EvaluationControls } from './EvaluationControls';
import { EvaluationResults } from './EvaluationResults';

const TAB_CLASS =
  'border-b-2 border-transparent px-1 pb-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-foreground data-[state=active]:text-foreground';

/**
 * Header entry point to dataset evaluations (ADR 0010): a button that opens the
 * evaluations dialog. The evaluation lives in its own store, so closing the
 * dialog does not stop it; the button shows a pulse while one is in flight.
 */
export const EvaluationPanel = (): JSX.Element => {
  const [open, setOpen] = useState(false);
  const phase = useEvaluationStore((state) => state.progress.phase);
  const historyCount = useEvaluationStore((state) => state.history.length);
  const loadHistory = useEvaluationStore((state) => state.loadHistory);
  const isRunning = phase === 'connecting' || phase === 'running';

  // Storage is read on first open only: the workspace does not need the history.
  useEffect(() => {
    if (open) loadHistory();
  }, [open, loadHistory]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* A Radix trigger, so closing the dialog returns focus to this button. */}
      <DialogTrigger
        className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
      >
        <FlaskConical className="size-3.5" aria-hidden />
        Evaluate
        {isRunning ? (
          <span
            className="size-1.5 rounded-full bg-state-running animate-pulse-running"
            aria-label="Evaluation running"
          />
        ) : null}
      </DialogTrigger>

      <DialogContent
        // No description element: the title and the controls describe the dialog.
        aria-describedby={undefined}
        className="top-[4vh] flex h-[92vh] w-[calc(100%-2rem)] max-w-6xl flex-col"
      >
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <DialogTitle className="text-sm font-semibold">Evaluations</DialogTitle>
          <DialogClose
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </DialogClose>
        </header>

        <EvaluationControls />

        <Tabs.Root defaultValue="results" className="flex min-h-0 flex-1 flex-col">
          <Tabs.List
            className="flex shrink-0 gap-4 border-b border-border px-4 pt-3"
            aria-label="Evaluation views"
          >
            <Tabs.Trigger value="results" className={TAB_CLASS}>
              Results
            </Tabs.Trigger>
            <Tabs.Trigger value="compare" className={TAB_CLASS}>
              History & compare{historyCount > 0 ? ` (${historyCount})` : ''}
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="results" className="min-h-0 flex-1 overflow-y-auto p-4 outline-none">
            <EvaluationResults />
          </Tabs.Content>
          <Tabs.Content value="compare" className="min-h-0 flex-1 overflow-y-auto p-4 outline-none">
            <EvaluationCompare />
          </Tabs.Content>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  );
};
