'use client';

import type { JSX } from 'react';

import { MetricStat } from '@/components/shared/MetricStat';
import { RunStatusBadge } from '@/components/shared/RunStatusBadge';
import { useLatestRun } from '@/store/useGraphStore';
import { formatCostUSD, formatExactTokens, formatLatency } from '@/utils/format';

/**
 * Aggregate run telemetry header. Summarizes the active run while it is in
 * flight and the most recent run once it ends, so the aggregate metrics outlive
 * the run; renders an idle affordance when no run has been recorded.
 */
export const RunMetricsBar = (): JSX.Element => {
  const run = useLatestRun();

  if (run === null) {
    return (
      <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
        No pipeline run yet. Execute the pipeline to capture telemetry.
      </div>
    );
  }

  const { metrics } = run;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {run.finishedAt === null ? 'Pipeline run' : 'Last run'}
        </span>
        <RunStatusBadge status={run.status} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <MetricStat label="Critical path" value={formatLatency(metrics.criticalPathLatencyMs)} />
        <MetricStat label="Compute time" value={formatLatency(metrics.totalLatencyMs)} />
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
