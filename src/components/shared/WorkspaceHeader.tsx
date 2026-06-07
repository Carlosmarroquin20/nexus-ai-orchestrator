import type { ReactNode } from 'react';

import { cn } from '@/utils/cn';

export interface WorkspaceHeaderProps {
  /** Right-aligned action slot (run controls, user menu, etc.). */
  readonly actions?: ReactNode;
  readonly className?: string;
}

/** Top application bar. Presentational layout primitive with no store coupling. */
export const WorkspaceHeader = ({ actions, className }: WorkspaceHeaderProps): JSX.Element => (
  <header
    className={cn(
      'flex h-12 shrink-0 items-center justify-between border-b border-border bg-card px-4',
      className,
    )}
  >
    <div className="flex items-center gap-2">
      <span className="flex size-6 items-center justify-center rounded bg-primary text-xs font-bold text-primary-foreground">
        N
      </span>
      <span className="text-sm font-semibold">Nexus AI Orchestrator</span>
      <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Pipeline Debugger
      </span>
    </div>
    {actions}
  </header>
);
