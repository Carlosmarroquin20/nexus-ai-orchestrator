/**
 * Evaluation reports written by the command-line runner (ADR 0010): a JSON
 * document for tooling and its Markdown rendering for people. Pure.
 *
 * The JSON keeps every check's full output and detail, unlike the browser
 * history, because a report is the place to audit a verdict. It is versioned so
 * a later reader (an import into the panel's history, for one) can reject a
 * shape it does not know.
 *
 * Outputs, details, and judge reasons are model-produced or dataset-supplied
 * text, so the Markdown never lets them act as markup: inline text is escaped,
 * and outputs are quoted in fenced blocks whose fence is longer than any run of
 * backticks they contain. A report rendered by a Markdown viewer therefore shows
 * an injected link, image, or HTML tag as text instead of loading it.
 */

import type { ExecutionDescriptor, ExecutionMode } from '@/types/execution';
import { formatCostUSD, formatExactTokens, formatLatency } from '@/utils/format';

import type { EvalDataset } from './dataset';
import { formatJudgeMean, formatPassRate } from './display';
import { datasetFingerprint, pipelineFingerprint } from './fingerprint';
import type { EvalCaseFrame, EvalDoneFrame, EvalSummaryFrame } from './protocol';
import type { PassRate } from './summary';

export const EVAL_REPORT_SCHEMA_VERSION = 1 as const;

export interface EvalReport {
  readonly version: typeof EVAL_REPORT_SCHEMA_VERSION;
  readonly evalId: string;
  /** ISO 8601, UTC. */
  readonly finishedAt: string;
  readonly status: EvalDoneFrame['status'];
  readonly mode: ExecutionMode;
  /** `null` in simulated mode. */
  readonly model: string | null;
  readonly dataset: {
    readonly name: string;
    readonly fingerprint: string;
    /** Cases in the dataset; more than `cases.length` when the evaluation was cancelled. */
    readonly caseCount: number;
  };
  readonly pipeline: {
    readonly fingerprint: string;
    readonly nodeCount: number;
  };
  readonly summary: EvalSummaryFrame;
  /** Scored cases in dataset order, with full outputs. */
  readonly cases: readonly EvalCaseFrame[];
}

export interface EvalReportSource {
  readonly evalId: string;
  readonly finishedAt: number;
  readonly status: EvalDoneFrame['status'];
  readonly model: string | null;
  readonly dataset: EvalDataset;
  readonly graph: ExecutionDescriptor;
  readonly summary: EvalSummaryFrame;
  readonly cases: readonly EvalCaseFrame[];
}

export const buildEvalReport = (source: EvalReportSource): EvalReport => ({
  version: EVAL_REPORT_SCHEMA_VERSION,
  evalId: source.evalId,
  finishedAt: new Date(source.finishedAt).toISOString(),
  status: source.status,
  mode: source.model !== null ? 'real' : 'simulated',
  model: source.model,
  dataset: {
    name: source.dataset.name,
    fingerprint: datasetFingerprint(source.dataset),
    caseCount: source.dataset.cases.length,
  },
  pipeline: {
    fingerprint: pipelineFingerprint(source.graph),
    nodeCount: source.graph.nodes.length,
  },
  summary: source.summary,
  cases: source.cases,
});

/* --------------------------------- naming --------------------------------- */

const MAX_SLUG_LENGTH = 60;

/**
 * Lowercase ASCII slug of a dataset name, safe as a file name on any platform:
 * the name comes from the dataset file, so it must not be able to steer the
 * report into another directory (`../`) or produce a reserved character.
 */
export const slugify = (text: string): string => {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'dataset';
};

/** File name without extension, e.g. `2026-11-17T22-45-03Z-support-triage`; sorts by time. */
export const reportFileStem = (report: EvalReport): string =>
  `${report.finishedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}-${slugify(report.dataset.name)}`;

/* -------------------------------- markdown -------------------------------- */

const MARKDOWN_SPECIAL = /[\\`*_[\]|~]/g;

/** Untrusted text as inert inline Markdown: one line, no markup, no HTML. */
export const escapeInline = (text: string): string =>
  text
    .replace(/\r?\n|\r/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(MARKDOWN_SPECIAL, (character) => `\\${character}`);

/** Untrusted text as a fenced block that the text cannot close. */
export const fencedBlock = (text: string): string => {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
};

const table = (header: readonly string[], rows: readonly (readonly string[])[]): string[] => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`),
];

const rateRows = (rates: Readonly<Partial<Record<string, PassRate>>>): string[][] =>
  Object.entries(rates)
    .filter((entry): entry is [string, PassRate] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rate]) => [escapeInline(key), formatPassRate(rate)]);

const STATUS_LABEL: Readonly<Record<EvalReport['status'], string>> = {
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const modeLine = (report: EvalReport): string =>
  report.model !== null
    ? `Real model (${escapeInline(report.model)})`
    : 'Simulated: outputs are placeholders, so the scores exercise the harness, not the pipeline';

const metricsSection = (report: EvalReport): string[] => {
  const { summary } = report;
  const judge =
    summary.judgeScore === null
      ? formatJudgeMean(null)
      : `${formatJudgeMean(summary.judgeScore.mean)} (${summary.judgeScore.count} grades)`;
  const latency = `${formatLatency(summary.duration?.p50Ms ?? null)} / ${formatLatency(
    summary.duration?.p95Ms ?? null,
  )}`;
  const judgeCost = `${formatCostUSD(summary.judgeUsage.costInUSD)} (${summary.judgeUsage.calls} calls)`;
  return [
    '## Metrics',
    '',
    ...table(
      ['Metric', 'Value'],
      [
        ['Cases passed', formatPassRate(summary.cases)],
        ['Checks passed', formatPassRate(summary.checks)],
        ['Errored checks', String(summary.erroredChecks)],
        ['Skipped checks', String(summary.skippedChecks)],
        ['Judge mean', judge],
        ['Latency p50 / p95', latency],
        ['Pipeline cost', formatCostUSD(summary.totalCostInUSD)],
        ['Pipeline tokens', formatExactTokens(summary.totalTokens)],
        ['Judge cost', judgeCost],
      ],
    ),
  ];
};

const breakdownSection = (
  title: string,
  column: string,
  rates: Readonly<Partial<Record<string, PassRate>>>,
): string[] => {
  const rows = rateRows(rates);
  return rows.length === 0 ? [] : ['', `## ${title}`, '', ...table([column, 'Checks passed'], rows)];
};

const casesSection = (report: EvalReport): string[] => {
  if (report.cases.length === 0) return ['', '## Cases', '', 'No case was scored.'];
  return [
    '',
    '## Cases',
    '',
    ...table(
      ['#', 'Case', 'Verdict', 'Checks passed', 'Duration', 'Cost'],
      report.cases.map((entry) => {
        const evaluated = entry.checks.filter((check) => check.status !== 'skipped');
        const passed = evaluated.filter((check) => check.status === 'passed').length;
        return [
          String(entry.index + 1),
          escapeInline(entry.caseId),
          entry.verdict,
          `${passed}/${evaluated.length}`,
          formatLatency(entry.durationMs),
          formatCostUSD(entry.costInUSD),
        ];
      }),
    ),
  ];
};

/** Every check that did not pass, with its reason and the output it inspected. */
const failuresSection = (report: EvalReport): string[] => {
  const failing = report.cases.filter((entry) => entry.verdict === 'failed');
  if (failing.length === 0) return [];
  return [
    '',
    '## Failures',
    ...failing.flatMap((entry) => [
      '',
      `### ${escapeInline(entry.caseId)}`,
      ...(entry.runOutcome !== 'completed' ? ['', `The pipeline run ${entry.runOutcome}.`] : []),
      ...entry.checks
        .filter((check) => check.status === 'failed' || check.status === 'error')
        .flatMap((check) => [
          '',
          `- ${escapeInline(check.nodeId)} · ${check.scorer}: ${check.status}. ` +
            escapeInline(check.detail),
          ...(check.actual !== null ? ['', fencedBlock(check.actual)] : []),
        ]),
    ]),
  ];
};

export const renderEvalReportMarkdown = (report: EvalReport): string =>
  [
    `# Evaluation: ${escapeInline(report.dataset.name)}`,
    '',
    `- Status: ${STATUS_LABEL[report.status]}, ` +
      `${report.cases.length} of ${report.dataset.caseCount} cases scored`,
    `- Mode: ${modeLine(report)}`,
    `- Finished: ${report.finishedAt}`,
    `- Dataset fingerprint: \`${report.dataset.fingerprint}\``,
    `- Pipeline fingerprint: \`${report.pipeline.fingerprint}\` (${report.pipeline.nodeCount} nodes)`,
    `- Evaluation id: \`${report.evalId}\``,
    '',
    ...metricsSection(report),
    ...breakdownSection('By node', 'Node', report.summary.byNode),
    ...breakdownSection('By scorer', 'Scorer', report.summary.byScorer),
    ...casesSection(report),
    ...failuresSection(report),
    '',
  ].join('\n');
