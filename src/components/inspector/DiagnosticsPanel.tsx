'use client';

import { useReactFlow } from '@xyflow/react';
import { useMemo } from 'react';

import { useGraphActions, useNexusEdges, useNexusNodes } from '@/store/useGraphStore';
import type { NexusEdge, NexusNode, NodeId } from '@/types/graph';
import { cn } from '@/utils/cn';
import { analyzeGraph, type DiagnosticSeverity } from '@/utils/graphDiagnostics';

const SEVERITY_DOT: Readonly<Record<DiagnosticSeverity, string>> = {
  error: 'bg-state-failed',
  warning: 'bg-state-running',
  info: 'bg-state-idle',
};

export const DiagnosticsPanel = (): JSX.Element => {
  const nodes = useNexusNodes();
  const edges = useNexusEdges();
  const { selectNode } = useGraphActions();
  const reactFlow = useReactFlow<NexusNode, NexusEdge>();

  // Recomputed only when topology/config references change. Telemetry ticks
  // replace the node array reference, so this also recomputes during a run; the
  // analysis is O(V + E) and cheap relative to the canvas render it accompanies.
  const diagnostics = useMemo(() => analyzeGraph(nodes, edges), [nodes, edges]);
  const labelById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node.data.label])),
    [nodes],
  );

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length;

  const focus = (nodeId: NodeId | null): void => {
    if (nodeId === null) return;
    selectNode(nodeId);
    const node = reactFlow.getNode(nodeId);
    if (node !== undefined) {
      reactFlow.setCenter(node.position.x, node.position.y, { zoom: 1.2, duration: 300 });
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Diagnostics
        </span>
        {diagnostics.length > 0 ? (
          <span className="flex items-center gap-2 text-[11px]">
            {errorCount > 0 ? <span className="text-state-failed">{errorCount} errors</span> : null}
            {warningCount > 0 ? (
              <span className="text-state-running">{warningCount} warnings</span>
            ) : null}
          </span>
        ) : null}
      </div>

      {diagnostics.length === 0 ? (
        <p className="text-xs text-state-completed">No issues detected.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {diagnostics.map((diagnostic) => {
            const label = diagnostic.nodeId !== null ? labelById.get(diagnostic.nodeId) : null;
            return (
              <li key={diagnostic.id}>
                <button
                  type="button"
                  onClick={() => focus(diagnostic.nodeId)}
                  disabled={diagnostic.nodeId === null}
                  className={cn(
                    'flex w-full items-start gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors',
                    diagnostic.nodeId !== null ? 'hover:bg-accent' : 'cursor-default',
                  )}
                >
                  <span
                    className={cn('mt-1 size-1.5 shrink-0 rounded-full', SEVERITY_DOT[diagnostic.severity])}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    {label !== null && label !== undefined ? (
                      <span className="font-medium text-foreground">{label}: </span>
                    ) : null}
                    <span className="text-muted-foreground">{diagnostic.message}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
