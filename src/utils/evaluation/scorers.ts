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

import { type EvalCase, type EvalCheck } from './dataset';
import { normalizeOutput } from './normalize';

/**
 * Upper bound on the output a regex check is applied to. Patterns come from a
 * dataset file and run on the server; bounding the subject (as well as the
 * pattern, see `dataset.ts`) caps the cost of a pathological pattern. A longer
 * output is reported as an error rather than silently truncated.
 */
export const MAX_REGEX_SUBJECT_LENGTH = 20_000;

/** Length at which an output is shortened when quoted in a verdict's detail. */
const DETAIL_PREVIEW_LENGTH = 120;

export type CheckStatus = 'passed' | 'failed' | 'error';

export interface CheckResult {
  readonly check: EvalCheck;
  /** `error` means the check could not be evaluated, e.g. the node produced no output. */
  readonly status: CheckStatus;
  /** The output the check inspected; `null` when the node produced none. */
  readonly actual: string | null;
  /** Human-readable reason for the verdict. */
  readonly detail: string;
}

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= DETAIL_PREVIEW_LENGTH ? flat : `${flat.slice(0, DETAIL_PREVIEW_LENGTH)}…`;
};

const verdict = (
  check: EvalCheck,
  actual: string,
  passed: boolean,
  failure: string,
): CheckResult => ({
  check,
  status: passed ? 'passed' : 'failed',
  actual,
  detail: passed ? 'Passed.' : failure,
});

/** Scores one check against the output of its node (`null` when there is none). */
export const scoreCheck = (check: EvalCheck, output: string | null): CheckResult => {
  if (output === null) {
    return {
      check,
      status: 'error',
      actual: null,
      detail: `Node "${check.nodeId}" produced no output (failed, skipped, or not reached).`,
    };
  }

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
        };
      }
      return verdict(
        check,
        output,
        new RegExp(check.pattern, check.flags).test(output),
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
 * Scores every check of a case. `outputs` maps node ids to their full output, or
 * to `null` when the node did not complete; a node absent from the map was not
 * reached.
 */
export const scoreCase = (
  evalCase: EvalCase,
  outputs: ReadonlyMap<string, string | null>,
): CheckResult[] => evalCase.checks.map((check) => scoreCheck(check, outputs.get(check.nodeId) ?? null));
