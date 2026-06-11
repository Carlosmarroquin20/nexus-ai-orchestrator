'use client';

import { MetricStat } from '@/components/shared/MetricStat';
import type { PipelineRunStatus } from '@/types/graph';
import { useActiveRun, useActiveRunMetrics } from '@/store/useGraphStore';
import { cn } from '@/utils/cn';
import { formatCostUSD, formatExactTokens, formatLatency } from '@/utils/format';

const STATUS_PRESENTATION: Readonly<Record<PipelineRunStatus, { label: string; className: string }>> = {
  queued: { label: 'Queued', className: 'bg-state-idle/15 text-state-idle' },
  running: { label: 'Running', className: 'bg-state-running/15 text-state-running' },
  completed: { label: 'Completed', className: 'bg-state-completed/15 text-state-completed' },
  failed: { label: 'Failed', className: 'bg-state-failed/15 text-state-failed' },
  cancelled: { label: 'Cancelled', className: 'bg-state-idle/15 text-state-idle' },
};

/**
 * Aggregate run telemetry header. Subscribes narrowly to the active run and its
 * metrics; renders an idle affordance when no run has been initiated.
 */
export const RunMetricsBar = (): JSX.Element => {
  const activeRun = useActiveRun();
  const metrics = useActiveRunMetrics();

  if (activeRun === null || metrics === null) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
        No active pipeline run. Execute the pipeline to capture telemetry.
      </div>
    );
  }

  const status = STATUS_PRESENTATION[activeRun.status];

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Pipeline Run
        </span>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', status.className)}>
          {status.label}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <MetricStat label="Total latency" value={formatLatency(metrics.totalLatencyMs)} />
        <MetricStat label="Total cost" value={formatCostUSD(metrics.aggregateCostInUSD)} />
        <MetricStat label="Total tokens" value={formatExactTokens(metrics.aggregateTotalTokens)} />
        <MetricStat
          label="Failed nodes"
          value={`${metrics.failedNodeCount} / ${metrics.nodeCount}`}
          tone={metrics.failedNodeCount > 0 ? 'critical' : 'success'}
        />
        <MetricStat
          label="Skipped nodes"
          value={`${metrics.skippedNodeCount} / ${metrics.nodeCount}`}
          tone={metrics.skippedNodeCount > 0 ? 'warning' : 'default'}
        />
      </div>
    </div>
  );
};
