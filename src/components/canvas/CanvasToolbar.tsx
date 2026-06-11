'use client';

import { Panel } from '@xyflow/react';
import { Play, Square } from 'lucide-react';

import type { StreamStatus } from '@/store/slices/dataFlowSlice';
import { NODE_KIND_ORDER, getNodeDescriptor } from '@/config/nodeRegistry';
import { useActiveRun, useGraphStore } from '@/store/useGraphStore';
import { useGraphManipulation } from '@/hooks/useGraphManipulation';
import { startRun, stopRun } from '@/services/runExecutor';
import { cn } from '@/utils/cn';

import { getNodeIcon } from './icons';

const STREAM_STATUS_LABEL: Readonly<Record<StreamStatus, string>> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  open: 'Streaming',
  error: 'Stream error',
};

const STREAM_STATUS_DOT: Readonly<Record<StreamStatus, string>> = {
  disconnected: 'bg-state-idle',
  connecting: 'bg-state-running animate-pulse-running',
  open: 'bg-state-completed',
  error: 'bg-state-failed',
};

/**
 * Canvas overlay: the node palette (instantiates variants at viewport center)
 * and the run/stream controls. Subscribes only to action references and the two
 * scalar status fields it renders, so node-level telemetry updates never re-render it.
 */
export const CanvasToolbar = (): JSX.Element => {
  const { addNodeAtViewportCenter } = useGraphManipulation();
  const activeRun = useActiveRun();
  const streamStatus = useGraphStore((state) => state.streamStatus);

  const isRunning = activeRun?.status === 'running';

  return (
    <Panel
      position="top-left"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card/95 p-2 shadow-lg backdrop-blur"
    >
      <div className="flex flex-col gap-1">
        <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Add node
        </span>
        <div className="flex flex-col gap-0.5">
          {NODE_KIND_ORDER.map((kind) => {
            const Icon = getNodeIcon(kind);
            const descriptor = getNodeDescriptor(kind);
            return (
              <button
                key={kind}
                type="button"
                title={descriptor.description}
                onClick={() => addNodeAtViewportCenter(kind)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent"
              >
                <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                {descriptor.displayName}
              </button>
            );
          })}
        </div>
      </div>

      <div className="border-t border-border pt-2">
        <button
          type="button"
          onClick={isRunning ? stopRun : startRun}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors',
            isRunning
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          {isRunning ? (
            <>
              <Square className="size-3.5" aria-hidden />
              Stop run
            </>
          ) : (
            <>
              <Play className="size-3.5" aria-hidden />
              Execute pipeline
            </>
          )}
        </button>

        <div className="mt-2 flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <span className={cn('size-1.5 rounded-full', STREAM_STATUS_DOT[streamStatus])} aria-hidden />
          {STREAM_STATUS_LABEL[streamStatus]}
        </div>
      </div>
    </Panel>
  );
};
