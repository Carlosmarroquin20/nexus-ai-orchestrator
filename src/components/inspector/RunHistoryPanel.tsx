'use client';

import { Trash2 } from 'lucide-react';

import { RunStatusBadge } from '@/components/shared/RunStatusBadge';
import { useGraphActions, useGraphStore, useRunHistory } from '@/store/useGraphStore';
import { cn } from '@/utils/cn';
import { formatCostUSD, formatExactTokens, formatLatency, formatTimestamp } from '@/utils/format';

export const RunHistoryPanel = (): JSX.Element => {
  const runs = useRunHistory();
  const activeRunId = useGraphStore((state) => state.activeRunId);
  const { clearRunHistory } = useGraphActions();

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Run history
        </span>
        {runs.length > 0 ? (
          <button
            type="button"
            onClick={clearRunHistory}
            aria-label="Clear run history"
            className="text-muted-foreground transition-colors hover:text-state-failed"
          >
            <Trash2 className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      {runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet. Execute the pipeline to record one.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {runs.map((run) => {
            const durationMs = run.finishedAt !== null ? run.finishedAt - run.startedAt : null;
            const hasIssues = run.metrics.failedNodeCount > 0 || run.metrics.skippedNodeCount > 0;
            return (
              <li
                key={run.id}
                className={cn(
                  'rounded-md border px-2.5 py-2',
                  run.id === activeRunId ? 'border-state-running/50 bg-state-running/5' : 'border-border',
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {formatTimestamp(run.startedAt)}
                  </span>
                  <RunStatusBadge status={run.status} />
                </div>

                <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                  <span className="flex flex-col">
                    <span className="text-muted-foreground">Duration</span>
                    <span className="font-mono tabular-nums">{formatLatency(durationMs)}</span>
                  </span>
                  <span className="flex flex-col">
                    <span className="text-muted-foreground">Cost</span>
                    <span className="font-mono tabular-nums">
                      {formatCostUSD(run.metrics.aggregateCostInUSD)}
                    </span>
                  </span>
                  <span className="flex flex-col">
                    <span className="text-muted-foreground">Tokens</span>
                    <span className="font-mono tabular-nums">
                      {formatExactTokens(run.metrics.aggregateTotalTokens)}
                    </span>
                  </span>
                </div>

                {hasIssues ? (
                  <div className="mt-1.5 flex gap-3 text-[10px]">
                    {run.metrics.failedNodeCount > 0 ? (
                      <span className="text-state-failed">{run.metrics.failedNodeCount} failed</span>
                    ) : null}
                    {run.metrics.skippedNodeCount > 0 ? (
                      <span className="text-muted-foreground">{run.metrics.skippedNodeCount} skipped</span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
