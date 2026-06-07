import { cn } from '@/utils/cn';

export type MetricTone = 'default' | 'success' | 'warning' | 'critical';

const TONE_TEXT: Readonly<Record<MetricTone, string>> = {
  default: 'text-foreground',
  success: 'text-state-completed',
  warning: 'text-state-running',
  critical: 'text-state-failed',
};

export interface MetricStatProps {
  readonly label: string;
  /** Pre-formatted value. Formatting (locale, precision) is the caller's concern. */
  readonly value: string;
  readonly unit?: string;
  readonly tone?: MetricTone;
  readonly className?: string;
}

/** Compact labeled metric. Values use tabular, monospaced figures for alignment. */
export const MetricStat = ({
  label,
  value,
  unit,
  tone = 'default',
  className,
}: MetricStatProps): JSX.Element => (
  <div className={cn('flex flex-col gap-0.5', className)}>
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
    <span className={cn('font-mono text-sm tabular-nums', TONE_TEXT[tone])}>
      {value}
      {unit !== undefined ? <span className="ml-1 text-xs text-muted-foreground">{unit}</span> : null}
    </span>
  </div>
);
