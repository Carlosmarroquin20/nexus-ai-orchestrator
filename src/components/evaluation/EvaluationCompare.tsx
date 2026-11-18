'use client';

import { ArrowRight, Trash2 } from 'lucide-react';
import { type JSX, useMemo, useState } from 'react';

import { Select } from '@/components/ui/select';
import { useEvaluationStore } from '@/store/useEvaluationStore';
import { cn } from '@/utils/cn';
import {
  type CaseComparison,
  type MetricDelta,
  compareEvaluations,
} from '@/utils/evaluation/comparison';
import {
  deltaTone,
  formatJudgeMean,
  formatRate,
  formatRateDelta,
  formatSigned,
} from '@/utils/evaluation/display';
import { type EvalRecord, MAX_EVAL_HISTORY } from '@/utils/evaluation/history';
import { formatCostUSD, formatDateTime, formatLatency } from '@/utils/format';

import { CASE_CHANGE, CHECK_STATUS, DELTA_TONE, SectionTitle, Tag, VERDICT } from './presentation';

/** Short fingerprint prefix: enough to tell configurations apart at a glance. */
const shortFingerprint = (fingerprint: string): string => fingerprint.slice(0, 7);

const recordLabel = (record: EvalRecord): string =>
  `${formatDateTime(record.finishedAt)} · ${record.datasetName} · ${formatRate(
    record.metrics.casesTotal === 0 ? null : record.metrics.casesPassed / record.metrics.casesTotal,
  )}`;

const engineLabel = (record: EvalRecord): string =>
  record.mode === 'simulated' ? 'Simulated' : (record.model ?? 'Real model');

const HistoryTable = ({ history }: { readonly history: readonly EvalRecord[] }): JSX.Element => (
  <div className="overflow-x-auto rounded-md border border-border">
    <table className="w-full text-left text-xs">
      <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-3 py-2 font-medium">Finished</th>
          <th className="px-3 py-2 font-medium">Dataset</th>
          <th className="px-3 py-2 font-medium">Model</th>
          <th className="px-3 py-2 font-medium">Pipeline</th>
          <th className="px-3 py-2 text-right font-medium">Cases</th>
          <th className="px-3 py-2 text-right font-medium">Judge</th>
          <th className="px-3 py-2 text-right font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {history.map((record) => (
          <tr key={record.id} className="border-t border-border">
            <td className="whitespace-nowrap px-3 py-2 font-mono">{formatDateTime(record.finishedAt)}</td>
            <td className="px-3 py-2">
              {record.datasetName}
              {record.status === 'cancelled' ? (
                <span className="ml-1.5 text-muted-foreground">
                  ({record.cases.length}/{record.caseCount}, cancelled)
                </span>
              ) : null}
            </td>
            <td className="px-3 py-2">{engineLabel(record)}</td>
            <td className="px-3 py-2 font-mono text-muted-foreground" title={record.pipelineFingerprint}>
              {shortFingerprint(record.pipelineFingerprint)}
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {record.metrics.casesPassed}/{record.metrics.casesTotal}
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {record.metrics.judgeMean === null ? '—' : record.metrics.judgeMean.toFixed(2)}
            </td>
            <td className="px-3 py-2 text-right font-mono tabular-nums">
              {formatCostUSD(record.metrics.totalCostInUSD)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const DeltaStat = ({
  label,
  metric,
  format,
  formatDelta,
  higherIsBetter,
}: {
  readonly label: string;
  readonly metric: MetricDelta;
  readonly format: (value: number | null) => string;
  readonly formatDelta: (delta: number | null) => string;
  readonly higherIsBetter: boolean;
}): JSX.Element => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
    <span className="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
      {format(metric.baseline)}
      <ArrowRight className="size-3" aria-label="to" />
      <span className="text-foreground">{format(metric.candidate)}</span>
    </span>
    <span
      className={cn('font-mono text-sm tabular-nums', DELTA_TONE[deltaTone(metric.delta, higherIsBetter)])}
    >
      {formatDelta(metric.delta)}
    </span>
  </div>
);

const ChangedCase = ({ entry }: { readonly entry: CaseComparison }): JSX.Element => (
  <li className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <Tag presentation={CASE_CHANGE[entry.change]} className="w-28 justify-center" />
      <span className="min-w-0 flex-1 truncate font-mono">{entry.caseId}</span>
      <span className="flex items-center gap-1.5">
        {entry.baseline !== null ? <Tag presentation={VERDICT[entry.baseline]} /> : <span>—</span>}
        <ArrowRight className="size-3 text-muted-foreground" aria-label="to" />
        {entry.candidate !== null ? <Tag presentation={VERDICT[entry.candidate]} /> : <span>—</span>}
      </span>
    </div>
    {entry.checkChanges.length > 0 ? (
      <ul className="flex flex-col gap-0.5 pl-1 text-muted-foreground">
        {entry.checkChanges.map((change) => (
          <li key={change.position} className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-foreground">{change.nodeId}</span>
            <span>{change.scorer}:</span>
            <span>
              {CHECK_STATUS[change.baseline].label}
              {change.baselineScore !== null ? ` (${change.baselineScore}/5)` : ''}
            </span>
            <ArrowRight className="size-3" aria-label="to" />
            <span className="text-foreground">
              {CHECK_STATUS[change.candidate].label}
              {change.candidateScore !== null ? ` (${change.candidateScore}/5)` : ''}
            </span>
          </li>
        ))}
      </ul>
    ) : null}
  </li>
);

const Comparison = ({
  baseline,
  candidate,
}: {
  readonly baseline: EvalRecord;
  readonly candidate: EvalRecord;
}): JSX.Element => {
  const comparison = useMemo(() => compareEvaluations(baseline, candidate), [baseline, candidate]);
  const { metrics, counts, changed, checksMovedCount } = comparison;
  const differences = [
    comparison.sameDataset ? null : 'The datasets differ: cases are matched by id.',
    comparison.samePipeline ? null : 'The pipeline changed (prompts, labels, sampling, or wiring).',
    comparison.sameModel
      ? null
      : `The model changed: ${engineLabel(baseline)} to ${engineLabel(candidate)}.`,
  ].filter((line): line is string => line !== null);

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1 text-xs">
        {differences.length === 0 ? (
          <li className="text-muted-foreground">
            Same dataset, pipeline, and model: differences come from model nondeterminism alone.
          </li>
        ) : (
          differences.map((line) => (
            <li key={line} className="text-foreground">
              {line}
            </li>
          ))
        )}
      </ul>

      <section className="grid grid-cols-2 gap-4 rounded-md border border-border bg-card p-4 sm:grid-cols-3 lg:grid-cols-6">
        <DeltaStat
          label="Case pass rate"
          metric={metrics.caseRate}
          format={formatRate}
          formatDelta={formatRateDelta}
          higherIsBetter
        />
        <DeltaStat
          label="Check pass rate"
          metric={metrics.checkRate}
          format={formatRate}
          formatDelta={formatRateDelta}
          higherIsBetter
        />
        <DeltaStat
          label="Judge mean"
          metric={metrics.judgeMean}
          format={formatJudgeMean}
          formatDelta={(delta) => formatSigned(delta, (magnitude) => magnitude.toFixed(2))}
          higherIsBetter
        />
        <DeltaStat
          label="Case p50"
          metric={metrics.p50Ms}
          format={formatLatency}
          formatDelta={(delta) => formatSigned(delta, formatLatency)}
          higherIsBetter={false}
        />
        <DeltaStat
          label="Case p95"
          metric={metrics.p95Ms}
          format={formatLatency}
          formatDelta={(delta) => formatSigned(delta, formatLatency)}
          higherIsBetter={false}
        />
        <DeltaStat
          label="Pipeline cost"
          metric={metrics.totalCostInUSD}
          format={(value) => (value === null ? '—' : formatCostUSD(value))}
          formatDelta={(delta) => formatSigned(delta, formatCostUSD)}
          higherIsBetter={false}
        />
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Cases</SectionTitle>
        <p className="text-xs text-muted-foreground">
          {counts.regressed} regressed · {counts.fixed} fixed · {counts.unchanged} unchanged
          {checksMovedCount > 0 ? ` (${checksMovedCount} with check changes)` : ''}
          {counts.not_comparable > 0 ? ` · ${counts.not_comparable} not comparable` : ''}
          {counts.only_in_baseline + counts.only_in_candidate > 0
            ? ` · ${counts.only_in_baseline + counts.only_in_candidate} on one side only`
            : ''}
        </p>
        {changed.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {changed.map((entry) => (
              <ChangedCase key={entry.caseId} entry={entry} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
};

/** The saved evaluations and a case-by-case comparison of any two of them. */
export const EvaluationCompare = (): JSX.Element => {
  const history = useEvaluationStore((state) => state.history);
  const clearHistory = useEvaluationStore((state) => state.clearHistory);
  // Ids rather than indices, so a new evaluation landing on top keeps the choice.
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);

  if (history.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-10 text-center text-xs text-muted-foreground">
        No saved evaluations yet. Each finished evaluation is saved in this browser (the last{' '}
        {MAX_EVAL_HISTORY}), so you can change a prompt, run again, and compare.
      </p>
    );
  }

  // Defaults: the newest evaluation against the one before it.
  const candidate = history.find((record) => record.id === candidateId) ?? history[0]!;
  const baseline =
    history.find((record) => record.id === baselineId) ??
    history.find((record) => record.id !== candidate.id) ??
    null;

  const onClear = (): void => {
    if (window.confirm('Delete all saved evaluations from this browser? This cannot be undone.')) {
      clearHistory();
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <SectionTitle>{`Saved evaluations (${history.length}/${MAX_EVAL_HISTORY})`}</SectionTitle>
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-state-failed"
          >
            <Trash2 className="size-3.5" aria-hidden />
            Clear
          </button>
        </div>
        <HistoryTable history={history} />
      </section>

      {baseline === null ? (
        <p className="text-xs text-muted-foreground">Run one more evaluation to compare two of them.</p>
      ) : (
        <section className="flex flex-col gap-3">
          <SectionTitle>Compare</SectionTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label htmlFor="eval-baseline" className="text-muted-foreground">
              Baseline
            </label>
            <Select
              id="eval-baseline"
              className="w-72"
              value={baseline.id}
              onChange={(event) => setBaselineId(event.currentTarget.value)}
            >
              {history.map((record) => (
                <option key={record.id} value={record.id}>
                  {recordLabel(record)}
                </option>
              ))}
            </Select>
            <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
            <label htmlFor="eval-candidate" className="text-muted-foreground">
              Candidate
            </label>
            <Select
              id="eval-candidate"
              className="w-72"
              value={candidate.id}
              onChange={(event) => setCandidateId(event.currentTarget.value)}
            >
              {history.map((record) => (
                <option key={record.id} value={record.id}>
                  {recordLabel(record)}
                </option>
              ))}
            </Select>
          </div>
          {baseline.id === candidate.id ? (
            <p className="text-xs text-muted-foreground">Choose two different evaluations.</p>
          ) : (
            <Comparison baseline={baseline} candidate={candidate} />
          )}
        </section>
      )}
    </div>
  );
};
