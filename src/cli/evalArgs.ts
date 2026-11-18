/**
 * Command-line arguments of the evaluation runner (`npm run eval`, ADR 0010).
 * Pure: the entry point passes `process.argv` and acts on the result.
 */

import { parseArgs } from 'node:util';

export const DEFAULT_DATASET = 'support-triage';
export const DEFAULT_OUT_DIR = 'eval-reports';

export interface EvalCliOptions {
  /** A bundled dataset id, or the path of a dataset file. */
  readonly dataset: string;
  /** Path of a graph file exported from the editor; `null` selects the demo pipeline. */
  readonly graph: string | null;
  readonly outDir: string;
  /** Use the simulator even when a model is configured. */
  readonly simulate: boolean;
  /** Case pass rate (0-1) below which the command fails; `null` disables the gate. */
  readonly failUnder: number | null;
}

export type EvalCliArgs =
  | { readonly kind: 'run'; readonly options: EvalCliOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly error: string };

export const EVAL_CLI_USAGE = `Usage: npm run eval -- [options]

Runs a dataset through a pipeline, scores every case, and writes a Markdown
and a JSON report.

Options:
  --dataset <id|path>   Bundled dataset id or dataset file (default: ${DEFAULT_DATASET})
  --graph <path>        Graph file exported from the editor (default: the demo pipeline)
  --out <dir>           Report directory (default: ${DEFAULT_OUT_DIR})
  --simulate            Use the simulator even if GEMINI_API_KEY is set
  --fail-under <pct>    Exit with 1 when the case pass rate is below pct (0-100)
  -h, --help            Show this help

Exit codes: 0 done, 1 below --fail-under or failed, 2 invalid input, 130 interrupted.`;

const parsePercent = (value: string): number | null => {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const percent = Number(value);
  return percent <= 100 ? percent / 100 : null;
};

/** Parses the arguments after the script name (`process.argv.slice(2)`). */
export const parseEvalCliArgs = (argv: readonly string[]): EvalCliArgs => {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        dataset: { type: 'string' },
        graph: { type: 'string' },
        out: { type: 'string' },
        simulate: { type: 'boolean' },
        'fail-under': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    // parseArgs reports unknown options, missing values, and stray positionals.
    return { kind: 'error', error: error instanceof Error ? error.message : String(error) };
  }

  if (values.help === true) return { kind: 'help' };

  const blank = (['dataset', 'graph', 'out'] as const).find((name) => values[name]?.trim() === '');
  if (blank !== undefined) return { kind: 'error', error: `--${blank} needs a value.` };

  let failUnder: number | null = null;
  if (values['fail-under'] !== undefined) {
    failUnder = parsePercent(values['fail-under']);
    if (failUnder === null) {
      return { kind: 'error', error: '--fail-under must be a percentage between 0 and 100.' };
    }
  }

  return {
    kind: 'run',
    options: {
      dataset: values.dataset ?? DEFAULT_DATASET,
      graph: values.graph ?? null,
      outDir: values.out ?? DEFAULT_OUT_DIR,
      simulate: values.simulate === true,
      failUnder,
    },
  };
};
