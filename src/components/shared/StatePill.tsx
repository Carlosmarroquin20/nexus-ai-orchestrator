import type { NodeExecutionState } from '@/types/graph';
import { cn } from '@/utils/cn';

interface StatePresentation {
  readonly label: string;
  readonly dot: string;
  readonly text: string;
  readonly surface: string;
}

/**
 * Static presentation map keyed by every member of `NodeExecutionState`. Keeping
 * this exhaustive (rather than computing class names) keeps the Tailwind classes
 * statically analyzable by the JIT compiler.
 */
const STATE_PRESENTATION: Readonly<Record<NodeExecutionState, StatePresentation>> = {
  idle: { label: 'Idle', dot: 'bg-state-idle', text: 'text-state-idle', surface: 'bg-state-idle/10' },
  running: {
    label: 'Running',
    dot: 'bg-state-running animate-pulse-running',
    text: 'text-state-running',
    surface: 'bg-state-running/10',
  },
  completed: {
    label: 'Completed',
    dot: 'bg-state-completed',
    text: 'text-state-completed',
    surface: 'bg-state-completed/10',
  },
  failed: {
    label: 'Failed',
    dot: 'bg-state-failed',
    text: 'text-state-failed',
    surface: 'bg-state-failed/10',
  },
  skipped: {
    label: 'Skipped',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    surface: 'bg-muted',
  },
};

export interface StatePillProps {
  readonly state: NodeExecutionState;
  readonly className?: string;
}

export const StatePill = ({ state, className }: StatePillProps): JSX.Element => {
  const presentation = STATE_PRESENTATION[state];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        presentation.surface,
        presentation.text,
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', presentation.dot)} aria-hidden />
      {presentation.label}
    </span>
  );
};
