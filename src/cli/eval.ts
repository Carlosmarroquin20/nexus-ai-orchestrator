/**
 * Command-line evaluation runner: `npm run eval -- [options]` (ADR 0010).
 *
 * Runs a dataset through a pipeline with the same engine, scorers, and judge as
 * the evaluation endpoint, prints one line per case, and writes the report as
 * Markdown and JSON. This module is the I/O shell; argument parsing, input
 * validation, and report rendering are pure modules with their own tests.
 *
 * The model is configured as for the server: `GEMINI_API_KEY` (and optionally
 * `GEMINI_MODEL`) from the environment or `.env.local`; without a key, or with
 * `--simulate`, the simulator runs. Ctrl+C stops after abandoning the case in
 * progress and still writes the report of the cases scored so far; a second
 * Ctrl+C quits at once.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EVAL_CLI_USAGE, type EvalCliOptions, parseEvalCliArgs } from '@/cli/evalArgs';
import { findBundledDataset, resolveEvalInputs } from '@/cli/evalInputs';
import { toCaseFrame } from '@/server/evaluation/caseFrame';
import { runEvaluation } from '@/server/evaluation/runEvaluation';
import { resolveLlmProvider } from '@/server/llm/resolveProvider';
import { formatPassRate, formatRate } from '@/utils/evaluation/display';
import { countModelCalls } from '@/utils/evaluation/protocol';
import {
  type EvalReport,
  buildEvalReport,
  renderEvalReportMarkdown,
  reportFileStem,
} from '@/utils/evaluation/report';
import { caseVerdict } from '@/utils/evaluation/summary';
import { formatCostUSD, formatLatency } from '@/utils/format';
import { safeJsonParse } from '@/utils/telemetryEvent';

const EXIT_CODE = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** 128 + SIGINT, the shell convention for a run stopped with Ctrl+C. */
  interrupted: 130,
} as const;

const ENV_FILE = '.env.local';

/** Tolerance when comparing a pass rate with the --fail-under gate. */
const RATE_EPSILON = 1e-9;

const print = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const printError = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * Dataset text (names, case ids) printed to the terminal with control
 * characters replaced, so a crafted dataset cannot emit escape sequences.
 */
const terminalSafe = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

/** Reports invalid input and yields the matching exit code. */
const invalidInput = (message: string): number => {
  printError(message);
  return EXIT_CODE.usage;
};

type JsonFileResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const readJsonFile = async (filePath: string, label: string): Promise<JsonFileResult> => {
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error && 'code' in error ? String(error.code) : 'unreadable';
    return { ok: false, error: `Cannot read the ${label} file ${filePath} (${reason}).` };
  }
  const value = safeJsonParse(text);
  return value === null
    ? { ok: false, error: `The ${label} file ${filePath} is not valid JSON.` }
    : { ok: true, value };
};

const readDataset = (key: string): Promise<JsonFileResult> => {
  const bundled = findBundledDataset(key);
  return bundled !== undefined
    ? Promise.resolve({ ok: true, value: bundled })
    : readJsonFile(key, 'dataset');
};

/**
 * Why the case pass rate misses the --fail-under gate, or `null` when it clears
 * it. An evaluation in which no case got a verdict measured nothing, so it never
 * clears a gate.
 */
const gateFailure = (rate: number | null, failUnder: number): string | null => {
  if (rate === null) return 'No case got a verdict, so the --fail-under gate cannot be met.';
  if (rate + RATE_EPSILON >= failUnder) return null;
  return `Case pass rate ${formatRate(rate)} is below the required ${formatRate(failUnder)}.`;
};

type WriteResult =
  | { readonly ok: true; readonly stem: string }
  | { readonly ok: false; readonly error: string };

/** Writes both report files under a shared stem, or says why they could not be written. */
const writeReport = async (outDir: string, report: EvalReport): Promise<WriteResult> => {
  const stem = path.join(outDir, reportFileStem(report));
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(`${stem}.md`, renderEvalReportMarkdown(report), 'utf8');
    return { ok: true, stem };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not write the report to ${outDir}: ${reason}` };
  }
};

const run = async (options: EvalCliOptions): Promise<number> => {
  // Loaded before the provider is resolved; variables already set take precedence.
  if (!options.simulate && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

  const datasetFile = await readDataset(options.dataset);
  if (!datasetFile.ok) return invalidInput(datasetFile.error);
  const graphFile = options.graph !== null ? await readJsonFile(options.graph, 'graph') : null;
  if (graphFile !== null && !graphFile.ok) return invalidInput(graphFile.error);

  const evalId = `eval_${randomUUID()}`;
  const inputs = resolveEvalInputs({
    evalId,
    graphRaw: graphFile?.value ?? null,
    datasetRaw: datasetFile.value,
  });
  if (!inputs.ok) return invalidInput(inputs.error);
  const { graph, dataset } = inputs.request;

  const provider = options.simulate ? null : resolveLlmProvider();
  const caseCount = dataset.cases.length;

  print(`Evaluating "${terminalSafe(dataset.name)}": ${caseCount} case${caseCount === 1 ? '' : 's'}`);
  print(`Pipeline: ${options.graph ?? 'demo pipeline'} (${graph.nodes.length} nodes)`);
  if (provider !== null) {
    print(`Model: ${provider.model}, up to ${countModelCalls(graph, dataset)} model calls`);
  } else {
    print('Mode: simulated. Outputs are placeholders: the scores exercise the harness, not the');
    print('pipeline, and LLM judge checks are skipped.');
  }
  print();

  const controller = new AbortController();
  const onInterrupt = (): void => {
    if (controller.signal.aborted) process.exit(EXIT_CODE.interrupted);
    printError('Stopping: the case in progress is abandoned. Press Ctrl+C again to quit now.');
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);

  const width = String(caseCount).length;
  const result = await runEvaluation({
    evalId,
    graph,
    dataset,
    provider,
    signal: controller.signal,
    onCaseStarted: () => undefined,
    onCaseScored: ({ index, score }) => {
      const position = `[${String(index + 1).padStart(width)}/${caseCount}]`;
      print(
        `${position} ${caseVerdict(score).padEnd(7)} ${formatLatency(score.durationMs).padStart(9)}  ` +
          terminalSafe(score.caseId),
      );
    },
  });
  process.off('SIGINT', onInterrupt);

  const report = buildEvalReport({
    evalId,
    finishedAt: Date.now(),
    status: result.outcome,
    model: provider?.model ?? null,
    dataset,
    graph,
    summary: { ...result.summary, judgeUsage: result.judgeUsage },
    cases: result.cases.map((evaluated) => toCaseFrame(evaluated)),
  });

  // The headline is printed before the files are written, so a failed write
  // never loses the result of a long evaluation.
  const { summary } = result;
  print();
  print(`Cases passed:  ${formatPassRate(summary.cases)}`);
  print(`Checks passed: ${formatPassRate(summary.checks)}`);
  print(`Pipeline cost: ${formatCostUSD(summary.totalCostInUSD)}`);

  const written = await writeReport(options.outDir, report);
  if (!written.ok) {
    printError(written.error);
    return EXIT_CODE.failed;
  }
  print(`Report:        ${written.stem}.md`);
  print(`               ${written.stem}.json`);

  if (result.outcome === 'cancelled') {
    printError(`Interrupted after ${result.cases.length} of ${caseCount} cases.`);
    return EXIT_CODE.interrupted;
  }
  const failure =
    options.failUnder !== null ? gateFailure(summary.cases.rate, options.failUnder) : null;
  if (failure !== null) {
    printError(failure);
    return EXIT_CODE.failed;
  }
  return EXIT_CODE.ok;
};

const main = async (): Promise<number> => {
  const args = parseEvalCliArgs(process.argv.slice(2));
  switch (args.kind) {
    case 'help':
      print(EVAL_CLI_USAGE);
      return EXIT_CODE.ok;
    case 'error':
      printError(`${args.error}\n\n${EVAL_CLI_USAGE}`);
      return EXIT_CODE.usage;
    case 'run':
      return run(args.options);
  }
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    printError(`Evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = EXIT_CODE.failed;
  },
);
