import { describe, expect, it } from 'vitest';

import type { DeterministicCheck, EvalCase } from '@/utils/evaluation/dataset';
import { normalizeOutput } from '@/utils/evaluation/normalize';
import {
  type JudgeCheckFn,
  MAX_REGEX_SUBJECT_LENGTH,
  scoreCase,
  scoreCheck,
} from '@/utils/evaluation/scorers';

const equals = (expected: string): DeterministicCheck => ({ scorer: 'equals', nodeId: 'n', expected });
const contains = (expected: string): DeterministicCheck => ({ scorer: 'contains', nodeId: 'n', expected });
const oneOf = (...expected: string[]): DeterministicCheck => ({ scorer: 'oneOf', nodeId: 'n', expected });
const regex = (pattern: string, flags = ''): DeterministicCheck => ({ scorer: 'regex', nodeId: 'n', pattern, flags });

const statusOf = (check: DeterministicCheck, output: string | null): string => scoreCheck(check, output).status;

describe('normalizeOutput', () => {
  it('ignores case, surrounding decoration, and repeated whitespace', () => {
    expect(normalizeOutput('  **Billing.**\n')).toBe('billing');
    expect(normalizeOutput('"Technical"')).toBe('technical');
    expect(normalizeOutput('Reset   your\n\npassword')).toBe('reset your password');
  });

  it('keeps punctuation inside the text', () => {
    expect(normalizeOutput('e-mail, not phone.')).toBe('e-mail, not phone');
  });

  it('folds compatibility characters', () => {
    expect(normalizeOutput('ＢＩＬＬＩＮＧ')).toBe('billing');
  });
});

describe('scoreCheck', () => {
  it('equals compares normalized text', () => {
    expect(statusOf(equals('billing'), 'Billing.')).toBe('passed');
    expect(statusOf(equals('billing'), 'billing support')).toBe('failed');
  });

  it('contains looks for normalized text inside the output', () => {
    expect(statusOf(contains('refund'), 'You can request a REFUND within 30 days.')).toBe('passed');
    expect(statusOf(contains('refund'), 'Contact sales.')).toBe('failed');
  });

  it('oneOf accepts any listed option', () => {
    expect(statusOf(oneOf('billing', 'technical'), 'Technical')).toBe('passed');
    expect(statusOf(oneOf('billing', 'technical'), 'general')).toBe('failed');
  });

  it('regex matches the raw output with the given flags', () => {
    expect(statusOf(regex('^\\d{3}$'), '500')).toBe('passed');
    expect(statusOf(regex('^\\d{3}$'), ' 500')).toBe('failed');
    expect(statusOf(regex('^yes$', 'i'), 'YES')).toBe('passed');
  });

  it('reports an error, not a failure, when the node produced no output', () => {
    const result = scoreCheck(equals('billing'), null);
    expect(result.status).toBe('error');
    expect(result.actual).toBeNull();
    expect(result.detail).toContain('"n"');
  });

  it('matches a backtracking-prone pattern in linear time', () => {
    // `^(a+)+$` takes exponential time in a backtracking engine on this subject.
    const started = performance.now();
    expect(statusOf(regex('^(a+)+$'), `${'a'.repeat(5_000)}b`)).toBe('failed');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('applies the m and s flags', () => {
    expect(statusOf(regex('^b$', 'm'), 'a\nb')).toBe('passed');
    expect(statusOf(regex('a.b', 's'), 'a\nb')).toBe('passed');
    expect(statusOf(regex('a.b'), 'a\nb')).toBe('failed');
  });

  it('refuses to run a regex over an oversized output', () => {
    const result = scoreCheck(regex('a'), 'a'.repeat(MAX_REGEX_SUBJECT_LENGTH + 1));
    expect(result.status).toBe('error');
  });

  it('explains a failure with the expectation and a preview of the output', () => {
    const result = scoreCheck(equals('billing'), `technical ${'x'.repeat(500)}`);
    expect(result.detail).toMatch(/^Expected "billing", got "technical x+…"\.$/);
    expect(result.detail.length).toBeLessThan(200);
    expect(scoreCheck(equals('billing'), 'billing').detail).toBe('Passed.');
  });
});

describe('scoreCase', () => {
  const evalCase: EvalCase = {
    id: 'c1',
    input: 'Why was I charged twice?',
    checks: [
      { scorer: 'equals', nodeId: 'classifier', expected: 'billing' },
      { scorer: 'llm_judge', nodeId: 'answer', criteria: 'Explains the charge.', minScore: 4 },
      { scorer: 'contains', nodeId: 'answer', expected: 'refund' },
      { scorer: 'contains', nodeId: 'unreached', expected: 'x' },
    ],
  };

  it('scores each check against its own node, delegating judge checks in order', async () => {
    const calls: string[] = [];
    const judge: JudgeCheckFn = async (check, output, input) => {
      calls.push(`${check.nodeId}|${output}|${input}`);
      return { check, status: 'passed', actual: output, detail: 'Score 5/5', score: 5 };
    };
    const results = await scoreCase(
      evalCase,
      new Map<string, string | null>([
        ['classifier', 'Billing'],
        ['answer', 'We will refund you.'],
      ]),
      judge,
    );

    expect(results.map((result) => result.status)).toEqual(['passed', 'passed', 'passed', 'error']);
    expect(results.map((result) => result.score)).toEqual([null, 5, null, null]);
    expect(calls).toEqual(['answer|We will refund you.|Why was I charged twice?']);
  });

  it('hands the judge a missing output as null', async () => {
    const seen: Array<string | null> = [];
    const judge: JudgeCheckFn = async (check, output) => {
      seen.push(output);
      return { check, status: 'error', actual: null, detail: 'no output', score: null };
    };
    await scoreCase(evalCase, new Map(), judge);
    expect(seen).toEqual([null]);
  });
});
