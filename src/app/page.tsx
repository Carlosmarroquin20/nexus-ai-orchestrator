'use client';

import { ReactFlowProvider } from '@xyflow/react';
import type { JSX } from 'react';

import { CommandPalette } from '@/components/canvas/CommandPalette';
import { GraphCanvas } from '@/components/canvas/GraphCanvas';
import { InspectorPanel } from '@/components/inspector/InspectorPanel';
import { WorkspaceActions } from '@/components/shared/WorkspaceActions';
import { WorkspaceHeader } from '@/components/shared/WorkspaceHeader';
import { useCanvasShortcuts } from '@/hooks/useCanvasShortcuts';
import { useGraphAutoPersist } from '@/hooks/useGraphPersistence';
import { useGraphHistory } from '@/hooks/useGraphHistory';
import { useSettingsPersistence } from '@/hooks/useSettingsPersistence';

/**
 * Primary IDE workspace.
 *
 * `ReactFlowProvider` wraps the entire workspace (not just the canvas) so that
 * viewport-aware hooks used by overlays — `useGraphManipulation` in the toolbar —
 * share the same flow instance as `GraphCanvas`.
 *
 * No stream is opened on mount: a run's execution stream is owned by
 * `services/runExecutor` and exists only between `startRun` and its completion.
 */
export default function WorkspacePage(): JSX.Element {
  // Persist the graph to localStorage and rehydrate it on load. Ordering matters:
  // history is initialized after hydration so the loaded graph is the baseline.
  useGraphAutoPersist();
  useSettingsPersistence();
  useGraphHistory();
  useCanvasShortcuts();

  return (
    <ReactFlowProvider>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <WorkspaceHeader actions={<WorkspaceActions />} />
        <main className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <GraphCanvas />
          </div>
          <InspectorPanel />
        </main>
      </div>
      <CommandPalette />
    </ReactFlowProvider>
  );
}
