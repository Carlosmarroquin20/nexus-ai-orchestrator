'use client';

import { MetricStat } from '@/components/shared/MetricStat';
import { StatePill } from '@/components/shared/StatePill';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { getNodeDescriptor } from '@/config/nodeRegistry';
import type { NexusNode } from '@/types/graph';
import { useSelectedNode } from '@/store/useGraphStore';
import { formatCostUSD, formatExactTokens, formatLatency, formatTimestamp } from '@/utils/format';

import { PayloadViewer } from './PayloadViewer';
import { RunMetricsBar } from './RunMetricsBar';

/** Flattens a config value to a single-line display string without per-kind branching. */
const renderConfigValue = (value: unknown): string => {
  if (Array.isArray(value)) return value.length === 0 ? '∅' : value.join(', ');
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const NodeDetail = ({ node }: { readonly node: NexusNode }): JSX.Element => {
  const descriptor = getNodeDescriptor(node.data.kind);
  const { telemetry, config } = node.data;
  const configEntries = Object.entries(config);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold">{node.data.label}</h3>
          <StatePill state={telemetry.state} />
        </div>
        <p className="text-xs text-muted-foreground">{descriptor.displayName}</p>
      </header>

      <section className="grid grid-cols-2 gap-3">
        <MetricStat label="Latency" value={formatLatency(telemetry.latencyMs)} />
        <MetricStat label="Cost" value={formatCostUSD(telemetry.costInUSD)} />
        <MetricStat label="Input tokens" value={formatExactTokens(telemetry.inputTokens)} />
        <MetricStat label="Output tokens" value={formatExactTokens(telemetry.outputTokens)} />
        <MetricStat label="Total tokens" value={formatExactTokens(telemetry.totalTokens)} />
        <MetricStat label="Updated" value={formatTimestamp(telemetry.lastUpdatedAt)} />
      </section>

      {telemetry.error !== null ? (
        <div className="rounded-md border border-state-failed/40 bg-state-failed/10 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-state-failed">
            {telemetry.error.code}
          </p>
          <p className="mt-1 text-xs text-foreground">{telemetry.error.message}</p>
        </div>
      ) : null}

      <Separator />

      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Configuration
        </h4>
        <dl className="flex flex-col gap-1.5">
          {configEntries.map(([key, value]) => (
            <div key={key} className="flex items-start justify-between gap-3 text-xs">
              <dt className="shrink-0 font-medium text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-words text-right font-mono text-foreground">
                {renderConfigValue(value)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Separator />

      <PayloadViewer title="Input payload" payload={telemetry.inputPayload} />
      <PayloadViewer title="Output payload" payload={telemetry.outputPayload} />
    </div>
  );
};

/**
 * Right-hand inspection sidebar. Renders run-level aggregates always, and the
 * selected node's full execution trace when a node is selected. Subscribes only
 * to the selected node and active run, so it re-renders on selection changes and
 * on telemetry deltas for the selected node — never for unrelated graph mutations.
 */
export const InspectorPanel = (): JSX.Element => {
  const selectedNode = useSelectedNode();

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-background">
      <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <h2 className="text-sm font-semibold">Inspector</h2>
      </header>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 p-4">
          <RunMetricsBar />
          {selectedNode !== null ? (
            <NodeDetail node={selectedNode} />
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
              Select a node to inspect its execution trace and payload buffers.
            </p>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
};
