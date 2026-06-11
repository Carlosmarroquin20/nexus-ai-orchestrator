'use client';

import { Handle, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';

import { MetricStat, type MetricTone } from '@/components/shared/MetricStat';
import { StatePill } from '@/components/shared/StatePill';
import { getNodeDescriptor } from '@/config/nodeRegistry';
import type { NexusNode } from '@/types/graph';
import { cn } from '@/utils/cn';
import { formatCostUSD, formatLatency, formatTokens } from '@/utils/format';
import { type LatencyBand, classifyLatency } from '@/utils/telemetry';

import { NODE_ICONS } from './icons';

const LATENCY_TONE: Readonly<Record<LatencyBand, MetricTone>> = {
  unknown: 'default',
  nominal: 'success',
  degraded: 'warning',
  critical: 'critical',
};

/**
 * Single data-driven renderer registered for every node kind. Variant-specific
 * presentation is resolved from the node registry rather than branched per kind,
 * so adding a node variant requires no change here.
 *
 * Memoized: React Flow passes a stable `data` reference for untouched nodes, so
 * this component re-renders only when its own telemetry changes — the contract
 * that `updateNodeTelemetry` upholds by preserving sibling references.
 */
export const NexusNodeView = memo(({ data, selected }: NodeProps<NexusNode>): JSX.Element => {
  const descriptor = getNodeDescriptor(data.kind);
  const Icon = NODE_ICONS[descriptor.icon];
  const { telemetry } = data;
  const accent = `hsl(var(${descriptor.accentVar}))`;
  const accentSurface = `hsl(var(${descriptor.accentVar}) / 0.15)`;

  return (
    <div
      className={cn(
        'w-60 rounded-lg border border-l-4 bg-card text-card-foreground shadow-sm transition-shadow',
        selected ? 'ring-2 ring-ring' : 'ring-0',
        telemetry.state === 'running' && 'shadow-[0_0_0_1px_hsl(var(--state-running)/0.4)]',
        telemetry.state === 'skipped' && 'opacity-60',
      )}
      style={{ borderLeftColor: accent }}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: accentSurface, color: accent }}
        >
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold leading-tight">{data.label}</p>
          <p className="truncate text-[11px] text-muted-foreground">{descriptor.displayName}</p>
        </div>
        <StatePill state={telemetry.state} />
      </header>

      <div className="grid grid-cols-3 gap-2 border-t border-border px-3 py-2">
        <MetricStat
          label="Latency"
          value={formatLatency(telemetry.latencyMs)}
          tone={LATENCY_TONE[classifyLatency(telemetry.latencyMs)]}
        />
        <MetricStat label="Tokens" value={formatTokens(telemetry.totalTokens)} />
        <MetricStat label="Cost" value={formatCostUSD(telemetry.costInUSD)} />
      </div>

      {descriptor.handles.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.kind}
          position={handle.kind === 'target' ? Position.Left : Position.Right}
        />
      ))}
    </div>
  );
});
NexusNodeView.displayName = 'NexusNodeView';
