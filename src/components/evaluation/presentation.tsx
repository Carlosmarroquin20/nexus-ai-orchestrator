import type { JSX } from 'react';

import { cn } from '@/utils/cn';
import type { CaseChange } from '@/utils/evaluation/comparison';
import type { DeltaTone } from '@/utils/evaluation/display';
import type { CheckStatus } from '@/utils/evaluation/scorers';
import type { CaseVerdict } from '@/utils/evaluation/summary';

/**
 * Static presentation maps for evaluation states. Exhaustive records (rather
 * than computed class names) keep the Tailwind classes statically analyzable.
 */

interface Presentation {
  readonly label: string;
  readonly className: string;
}

export const CHECK_STATUS: Readonly<Record<CheckStatus, Presentation>> = {
  passed: { label: 'Passed', className: 'bg-state-completed/15 text-state-completed' },
  failed: { label: 'Failed', className: 'bg-state-failed/15 text-state-failed' },
  error: { label: 'Error', className: 'bg-state-running/15 text-state-running' },
  skipped: { label: 'Skipped', className: 'bg-state-idle/15 text-state-idle' },
};

export const CHECK_DOT: Readonly<Record<CheckStatus, string>> = {
  passed: 'bg-state-completed',
  failed: 'bg-state-failed',
  error: 'bg-state-running',
  skipped: 'bg-state-idle/50',
};

export const VERDICT: Readonly<Record<CaseVerdict, Presentation>> = {
  passed: CHECK_STATUS.passed,
  failed: CHECK_STATUS.failed,
  skipped: { label: 'Not evaluated', className: CHECK_STATUS.skipped.className },
};

export const CASE_CHANGE: Readonly<Record<CaseChange, Presentation>> = {
  regressed: { label: 'Regressed', className: 'bg-state-failed/15 text-state-failed' },
  fixed: { label: 'Fixed', className: 'bg-state-completed/15 text-state-completed' },
  unchanged: { label: 'Unchanged', className: 'bg-muted text-muted-foreground' },
  not_comparable: { label: 'Not comparable', className: 'bg-state-idle/15 text-state-idle' },
  only_in_baseline: { label: 'Baseline only', className: 'bg-state-idle/15 text-state-idle' },
  only_in_candidate: { label: 'Candidate only', className: 'bg-state-idle/15 text-state-idle' },
};

export const DELTA_TONE: Readonly<Record<DeltaTone, string>> = {
  better: 'text-state-completed',
  worse: 'text-state-failed',
  neutral: 'text-muted-foreground',
};

export const Tag = ({
  presentation,
  className,
}: {
  readonly presentation: Presentation;
  readonly className?: string;
}): JSX.Element => (
  <span
    className={cn(
      'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
      presentation.className,
      className,
    )}
  >
    {presentation.label}
  </span>
);

export const SectionTitle = ({ children }: { readonly children: string }): JSX.Element => (
  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
);
