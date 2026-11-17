import { describe, expect, it } from 'vitest';

import type { EvalCase, EvalCheck } from '@/utils/evaluation/dataset';
import { normalizeOutput } from '@/utils/evaluation/normalize';
import { MAX_REGEX_SUBJECT_LENGTH, scoreCase, scoreCheck } from '@/utils/evaluation/scorers';

const equals = (expected: string): EvalCheck => ({ scorer: 'equals', nodeId: 'n', expected });
const contains = (expected: string): EvalCheck => ({ scorer: 'contains', nodeId: 'n', expected });
const oneOf = (...expected: string[]): EvalCheck => ({ scorer: 'oneOf', nodeId: 'n', expected });
const regex = (pattern: string, flags = ''): EvalCheck => ({ scorer: 'regex', nodeId: 'n', pattern, flags });

const statusOf = (check: EvalCheck, output: string | null): string => scoreCheck(check, output).status;

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
      { scorer: 'contains', nodeId: 'answer', expected: 'refund' },
      { scorer: 'contains', nodeId: 'unreached', expected: 'x' },
    ],
  };

  it('scores each check against its own node and treats missing nodes as no output', () => {
    const results = scoreCase(
      evalCase,
      new Map<string, string | null>([
        ['classifier', 'Billing'],
        ['answer', null],
      ]),
    );
    expect(results.map((result) => result.status)).toEqual(['passed', 'error', 'error']);
    expect(results[0]!.actual).toBe('Billing');
  });
});
