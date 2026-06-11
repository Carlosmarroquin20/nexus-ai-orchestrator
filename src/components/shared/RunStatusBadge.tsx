import type { PipelineRunStatus } from '@/types/graph';
import { cn } from '@/utils/cn';

const PRESENTATION: Readonly<Record<PipelineRunStatus, { label: string; className: string }>> = {
  queued: { label: 'Queued', className: 'bg-state-idle/15 text-state-idle' },
  running: { label: 'Running', className: 'bg-state-running/15 text-state-running' },
  completed: { label: 'Completed', className: 'bg-state-completed/15 text-state-completed' },
  failed: { label: 'Failed', className: 'bg-state-failed/15 text-state-failed' },
  cancelled: { label: 'Cancelled', className: 'bg-state-idle/15 text-state-idle' },
};

export interface RunStatusBadgeProps {
  readonly status: PipelineRunStatus;
  readonly className?: string;
}

export const RunStatusBadge = ({ status, className }: RunStatusBadgeProps): JSX.Element => {
  const presentation = PRESENTATION[status];
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] font-medium',
        presentation.className,
        className,
      )}
    >
      {presentation.label}
    </span>
  );
};
