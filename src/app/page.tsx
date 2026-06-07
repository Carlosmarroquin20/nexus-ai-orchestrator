'use client';

import { ReactFlowProvider } from '@xyflow/react';

import { GraphCanvas } from '@/components/canvas/GraphCanvas';
import { InspectorPanel } from '@/components/inspector/InspectorPanel';
import { WorkspaceHeader } from '@/components/shared/WorkspaceHeader';
import { useTelemetryStream } from '@/hooks/useTelemetryStream';

/**
 * Primary IDE workspace.
 *
 * `ReactFlowProvider` wraps the entire workspace (not just the canvas) so that
 * viewport-aware hooks used by overlays — `useGraphManipulation` in the toolbar —
 * share the same flow instance as `GraphCanvas`.
 *
 * The telemetry stream endpoint is environment-provided. When unset, the stream
 * stays idle and the canvas remains fully operable for manual graph authoring.
 */
export default function WorkspacePage(): JSX.Element {
  useTelemetryStream({
    url: process.env['NEXT_PUBLIC_TELEMETRY_STREAM_URL'] ?? null,
  });

  return (
    <ReactFlowProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <WorkspaceHeader />
        <main className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <GraphCanvas />
          </div>
          <InspectorPanel />
        </main>
      </div>
    </ReactFlowProvider>
  );
}
