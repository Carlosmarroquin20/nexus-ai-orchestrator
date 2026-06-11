'use client';

import { MetricStat } from '@/components/shared/MetricStat';
import { RunStatusBadge } from '@/components/shared/RunStatusBadge';
import { useActiveRun, useActiveRunMetrics } from '@/store/useGraphStore';
import { formatCostUSD, formatExactTokens, formatLatency } from '@/utils/format';

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

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Pipeline Run
        </span>
        <RunStatusBadge status={activeRun.status} />
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
