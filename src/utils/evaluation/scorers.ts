/**
 * Deterministic scorers for evaluation checks (ADR 0010). Pure functions: given a
 * check and the output of the node it inspects, they decide pass or fail and say
 * why, so every verdict in an evaluation report can be audited.
 *
 * Text comparisons (`equals`, `contains`, `oneOf`) run on normalized text, because
 * models decorate short answers ("Billing.", "**billing**", " billing\n") without
 * changing their meaning. `regex` runs on the raw output, since a pattern author
 * may care about exactly that decoration.
 */

import { type DeterministicCheck, type EvalCase, type EvalCheck, type LlmJudgeCheck } from './dataset';
import { normalizeOutput } from './normalize';
import { compileSafeRegex } from './safeRegex';

/**
 * Upper bound on the output a regex check is applied to. Matching is linear in
 * the subject (`safeRegex.ts`), and the bound keeps that cost small. A longer
 * output is reported as an error rather than silently truncated.
 */
export const MAX_REGEX_SUBJECT_LENGTH = 20_000;

/** Length at which an output is shortened when quoted in a verdict's detail. */
const DETAIL_PREVIEW_LENGTH = 120;

/**
 * `error`: the check could not be evaluated (e.g. the node produced no output) and
 * counts against the pass rate. `skipped`: the check was deliberately not
 * evaluated (an LLM judge without a model) and counts neither way.
 */
export type CheckStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface CheckResult {
  readonly check: EvalCheck;
  readonly status: CheckStatus;
  /** The output the check inspected; `null` when the node produced none. */
  readonly actual: string | null;
  /** Human-readable reason for the verdict. */
  readonly detail: string;
  /** Grade on the judge's 1-5 scale; `null` for deterministic checks or when no grade was produced. */
  readonly score: number | null;
}

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DETAIL_PREVIEW_LENGTH ? flat : `${flat.slice(0, DETAIL_PREVIEW_LENGTH)}…`;
};

const verdict = (
  check: DeterministicCheck,
  actual: string,
  passed: boolean,
  failure: string,
): CheckResult => ({
  check,
  status: passed ? 'passed' : 'failed',
  actual,
  detail: passed ? 'Passed.' : failure,
  score: null,
});

/** The verdict for any check whose node produced no output: not evaluable, counted against. */
export const noOutputResult = (check: EvalCheck): CheckResult => ({
  check,
  status: 'error',
  actual: null,
  detail: `Node "${check.nodeId}" produced no output (failed, skipped, or not reached).`,
  score: null,
});

/** Scores one deterministic check against the output of its node (`null` when there is none). */
export const scoreCheck = (check: DeterministicCheck, output: string | null): CheckResult => {
  if (output === null) return noOutputResult(check);

  switch (check.scorer) {
    case 'equals':
      return verdict(
        check,
        output,
        normalizeOutput(output) === normalizeOutput(check.expected),
        `Expected "${check.expected}", got "${preview(output)}".`,
      );
    case 'contains':
      return verdict(
        check,
        output,
        normalizeOutput(output).includes(normalizeOutput(check.expected)),
        `Expected the output to contain "${check.expected}", got "${preview(output)}".`,
      );
    case 'oneOf': {
      const normalized = normalizeOutput(output);
      return verdict(
        check,
        output,
        check.expected.some((option) => normalizeOutput(option) === normalized),
        `Expected one of [${check.expected.join(', ')}], got "${preview(output)}".`,
      );
    }
    case 'regex': {
      if (output.length > MAX_REGEX_SUBJECT_LENGTH) {
        return {
          check,
          status: 'error',
          actual: output,
          detail: `Output exceeds ${MAX_REGEX_SUBJECT_LENGTH} characters; regex checks are not applied to it.`,
          score: null,
        };
      }
      const compiled = compileSafeRegex(check.pattern, check.flags);
      if (!compiled.ok) {
        // Unreachable for parsed datasets, which compile every pattern up front.
        return {
          check,
          status: 'error',
          actual: output,
          detail: `Regex ${compiled.field} ${compiled.error}`,
          score: null,
        };
      }
      return verdict(
        check,
        output,
        compiled.regex.test(output),
        `Expected the output to match /${check.pattern}/${check.flags}, got "${preview(output)}".`,
      );
    }
    default: {
      const _exhaustive: never = check;
      return _exhaustive;
    }
  }
};

/**
 * Grades one `llm_judge` check. Supplied by the caller, which owns the model
 * connection; `input` is the case input, which the judge sees as the question.
 */
export type JudgeCheckFn = (
  check: LlmJudgeCheck,
  output: string | null,
  input: string,
) => Promise<CheckResult>;

/**
 * Scores every check of a case. `outputs` maps node ids to their full output, or
 * to `null` when the node did not complete; a node absent from the map was not
 * reached. Checks are scored one at a time, in dataset order: judge calls share
 * the provider's rate limit with the pipeline itself.
 */
export const scoreCase = async (
  evalCase: EvalCase,
  outputs: ReadonlyMap<string, string | null>,
  judge: JudgeCheckFn,
): Promise<CheckResult[]> => {
  const results: CheckResult[] = [];
  for (const check of evalCase.checks) {
    const output = outputs.get(check.nodeId) ?? null;
    results.push(
      check.scorer === 'llm_judge'
        ? await judge(check, output, evalCase.input)
        : scoreCheck(check, output),
    );
  }
  return results;
};
