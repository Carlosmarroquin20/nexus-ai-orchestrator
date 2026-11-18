'use client';

import { ChevronDown, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import { type JSX, useState } from 'react';

import { MetricStat } from '@/components/shared/MetricStat';
import { useEvaluationStore } from '@/store/useEvaluationStore';
import { cn } from '@/utils/cn';
import { formatJudgeMean, formatPassRate } from '@/utils/evaluation/display';
import type { EvalCaseFrame, EvalStartedFrame, EvalSummaryFrame } from '@/utils/evaluation/protocol';
import type { PassRate } from '@/utils/evaluation/summary';
import { formatCostUSD, formatExactTokens, formatLatency } from '@/utils/format';

import { CHECK_DOT, CHECK_STATUS, SectionTitle, Tag, VERDICT } from './presentation';

const ModeNotice = ({ started }: { readonly started: EvalStartedFrame }): JSX.Element =>
  started.mode === 'simulated' ? (
    <div className="flex gap-2 rounded-md border border-state-running/40 bg-state-running/10 p-3 text-xs">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-state-running" aria-hidden />
      <p>
        <span className="font-semibold">Simulated run.</span> No model is configured, so node outputs
        are placeholders: these scores check the evaluation harness, not your prompts, and LLM-judge
        checks are skipped. Set <code className="font-mono">GEMINI_API_KEY</code> on the server to
        evaluate a real model.
      </p>
    </div>
  ) : (
    <p className="text-xs text-muted-foreground">
      Evaluated against{' '}
      <span className="font-mono text-foreground">{started.model ?? 'the configured model'}</span>.
    </p>
  );

const Progress = ({
  started,
  done,
  current,
}: {
  readonly started: EvalStartedFrame | null;
  readonly done: number;
  readonly current: string | null;
}): JSX.Element => {
  const total = started?.caseCount ?? 0;
  const ratio = total === 0 ? 0 : done / total;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {started === null
          ? 'Connecting…'
          : `Case ${Math.min(done + 1, total)} of ${total}${current !== null ? ` · ${current}` : ''}`}
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
      >
        <div className="h-full bg-state-running transition-all" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
};

const RateList = ({
  title,
  rates,
}: {
  readonly title: string;
  readonly rates: ReadonlyArray<readonly [string, PassRate]>;
}): JSX.Element | null =>
  rates.length === 0 ? null : (
    <div className="flex flex-col gap-1.5">
      <SectionTitle>{title}</SectionTitle>
      <ul className="flex flex-col gap-1 text-xs">
        {rates.map(([key, rate]) => (
          <li key={key} className="flex items-center justify-between gap-3">
            <span className="truncate font-mono text-muted-foreground">{key}</span>
            <span className="shrink-0 font-mono tabular-nums">{formatPassRate(rate)}</span>
          </li>
        ))}
      </ul>
    </div>
  );

const Summary = ({ summary }: { readonly summary: EvalSummaryFrame }): JSX.Element => (
  <section className="flex flex-col gap-4 rounded-md border border-border bg-card p-4">
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <MetricStat
        label="Cases passed"
        value={formatPassRate(summary.cases)}
        tone={summary.cases.rate === null ? 'default' : summary.cases.rate === 1 ? 'success' : 'warning'}
      />
      <MetricStat label="Checks passed" value={formatPassRate(summary.checks)} />
      <MetricStat
        label="Judge mean"
        value={formatJudgeMean(summary.judgeScore?.mean ?? null)}
        {...(summary.judgeScore !== null ? { unit: `${summary.judgeScore.count} graded` } : {})}
      />
      <MetricStat
        label="Errors · skipped"
        value={`${summary.erroredChecks} · ${summary.skippedChecks}`}
        tone={summary.erroredChecks > 0 ? 'critical' : 'default'}
      />
      <MetricStat
        label="Case p50 · p95"
        value={
          summary.duration === null
            ? '—'
            : `${formatLatency(summary.duration.p50Ms)} · ${formatLatency(summary.duration.p95Ms)}`
        }
      />
      <MetricStat label="Pipeline cost" value={formatCostUSD(summary.totalCostInUSD)} />
      <MetricStat
        label="Judge cost"
        value={formatCostUSD(summary.judgeUsage.costInUSD)}
        unit={`${summary.judgeUsage.calls} call${summary.judgeUsage.calls === 1 ? '' : 's'}`}
      />
      <MetricStat label="Pipeline tokens" value={formatExactTokens(summary.totalTokens)} />
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      <RateList title="Checks by node" rates={Object.entries(summary.byNode)} />
      <RateList
        title="Checks by scorer"
        rates={Object.entries(summary.byScorer).flatMap(([kind, rate]) =>
          rate !== undefined ? [[kind, rate] as const] : [],
        )}
      />
    </div>
  </section>
);

const CaseRow = ({ result }: { readonly result: EvalCaseFrame }): JSX.Element => {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left text-xs hover:bg-accent"
      >
        <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="w-6 shrink-0 font-mono tabular-nums text-muted-foreground">{result.index + 1}</span>
        <span className="min-w-0 flex-1 truncate font-mono">{result.caseId}</span>
        <span className="flex shrink-0 items-center gap-1">
          {result.checks.map((check, position) => {
            const label = `${check.nodeId} · ${check.scorer}: ${CHECK_STATUS[check.status].label}`;
            return (
              <span
                key={position}
                role="img"
                aria-label={label}
                title={label}
                className={cn('size-2 rounded-full', CHECK_DOT[check.status])}
              />
            );
          })}
        </span>
        <span className="hidden w-16 shrink-0 text-right font-mono tabular-nums text-muted-foreground sm:block">
          {formatLatency(result.durationMs)}
        </span>
        <Tag presentation={VERDICT[result.verdict]} className="w-24 justify-center" />
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {result.runOutcome !== 'completed' ? (
            <p className="text-xs text-state-failed">The pipeline run for this case {result.runOutcome}.</p>
          ) : null}
          {result.checks.map((check, position) => (
            <div key={position} className="flex flex-col gap-1 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <Tag presentation={CHECK_STATUS[check.status]} />
                <span className="font-mono">{check.nodeId}</span>
                <span className="text-muted-foreground">{check.scorer}</span>
              </div>
              <p className="text-muted-foreground">{check.detail}</p>
              {check.actual !== null ? (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 font-mono text-[11px]">
                  {check.actual}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </li>
  );
};

/** Live progress, the summary, and the per-case results of the current evaluation. */
export const EvaluationResults = (): JSX.Element => {
  const progress = useEvaluationStore((state) => state.progress);
  const { phase, started, cases, summary, error, currentCase } = progress;

  if (phase === 'idle') {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
        Choose a dataset and run it against the current pipeline. Each case runs the whole pipeline
        and checks the outputs of the nodes the dataset names.
      </p>
    );
  }

  const isRunning = phase === 'connecting' || phase === 'running';
  return (
    <div className="flex flex-col gap-4">
      {error !== null ? (
        <p role="alert" className="rounded-md border border-state-failed/40 bg-state-failed/10 p-3 text-xs">
          {error}
        </p>
      ) : null}
      {started !== null ? <ModeNotice started={started} /> : null}
      {isRunning ? (
        <Progress started={started} done={cases.length} current={currentCase?.caseId ?? null} />
      ) : null}
      {phase === 'cancelled' ? (
        <p className="text-xs text-muted-foreground">
          {started === null
            ? 'Stopped before the evaluation started.'
            : `Stopped after ${cases.length} of ${started.caseCount} cases.`}
          {summary === null ? ' Evaluations stopped from here are not saved for comparison.' : ''}
        </p>
      ) : null}
      {phase === 'completed' && summary === null ? (
        // The reducer drops a summary frame that fails validation; without it there
        // are no metrics to show or to save, and that must not pass silently.
        <p role="alert" className="text-xs text-state-running">
          The evaluation finished, but its summary could not be read, so it was not saved for
          comparison. The case results below are the ones received.
        </p>
      ) : null}
      {summary !== null ? <Summary summary={summary} /> : null}

      {cases.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Cases</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {cases.map((result) => (
              <CaseRow key={result.index} result={result} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
};
