import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createDemoPipeline } from '@/config/demoPipeline';
import supportTriage from '@/config/evalDatasets/support-triage.json';
import {
  EVAL_DATASET_SCHEMA_VERSION,
  MAX_CHECKS_PER_CASE,
  MAX_EVAL_CASES,
  MAX_REGEX_PATTERN_LENGTH,
  findUnknownNodeIds,
  parseEvalDataset,
} from '@/utils/evaluation/dataset';

const evalCase = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'c1',
  input: 'Why was I charged twice?',
  checks: [{ nodeId: 'classifier', scorer: 'equals', expected: 'billing' }],
  ...overrides,
});

const dataset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: EVAL_DATASET_SCHEMA_VERSION,
  name: 'Sample',
  cases: [evalCase()],
  ...overrides,
});

const errorOf = (raw: unknown): string => {
  const result = parseEvalDataset(raw);
  return result.ok ? 'ok' : result.error;
};

describe('parseEvalDataset', () => {
  it('parses every scorer kind', () => {
    const result = parseEvalDataset(
      dataset({
        description: 'All scorers',
        cases: [
          evalCase({
            description: 'one of each',
            checks: [
              { nodeId: 'n', scorer: 'equals', expected: 'billing' },
              { nodeId: 'n', scorer: 'contains', expected: 'refund' },
              { nodeId: 'n', scorer: 'regex', pattern: '^\\d+$' },
              { nodeId: 'n', scorer: 'regex', pattern: 'yes', flags: 'i' },
              { nodeId: 'n', scorer: 'oneOf', expected: ['a', 'b'] },
            ],
          }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dataset.cases[0]!.checks).toEqual([
        { scorer: 'equals', nodeId: 'n', expected: 'billing' },
        { scorer: 'contains', nodeId: 'n', expected: 'refund' },
        { scorer: 'regex', nodeId: 'n', pattern: '^\\d+$', flags: '' },
        { scorer: 'regex', nodeId: 'n', pattern: 'yes', flags: 'i' },
        { scorer: 'oneOf', nodeId: 'n', expected: ['a', 'b'] },
      ]);
      expect(result.dataset.cases[0]!.description).toBe('one of each');
    }
  });

  it('keeps an empty input, which is a legitimate test case', () => {
    const result = parseEvalDataset(dataset({ cases: [evalCase({ input: '' })] }));
    expect(result.ok && result.dataset.cases[0]!.input).toBe('');
  });

  it('rejects documents that are not datasets of this version', () => {
    expect(errorOf(null)).toMatch(/JSON object/);
    expect(errorOf(dataset({ version: 2 }))).toMatch(/Unsupported dataset version/);
    expect(errorOf(dataset({ name: '  ' }))).toMatch(/name/);
    expect(errorOf(dataset({ cases: [] }))).toMatch(/non-empty array/);
  });

  it('locates case-level problems by case id', () => {
    expect(errorOf(dataset({ cases: [evalCase({ id: '' })] }))).toMatch(/cases\[0\]\.id/);
    expect(errorOf(dataset({ cases: [evalCase({ input: 3 })] }))).toMatch(/case "c1": input/);
    expect(errorOf(dataset({ cases: [evalCase({ checks: [] })] }))).toMatch(/case "c1": checks/);
    expect(errorOf(dataset({ cases: [evalCase(), evalCase()] }))).toMatch(/Duplicate case id "c1"/);
  });

  it('locates check-level problems by case id and check index', () => {
    const withCheck = (check: unknown) => dataset({ cases: [evalCase({ checks: [check] })] });
    expect(errorOf(withCheck({ nodeId: 'n', scorer: 'fuzzy', expected: 'x' }))).toMatch(
      /case "c1": checks\[0\]\.scorer/,
    );
    expect(errorOf(withCheck({ scorer: 'equals', expected: 'x' }))).toMatch(/checks\[0\]\.nodeId/);
    expect(errorOf(withCheck({ nodeId: 'n', scorer: 'equals' }))).toMatch(/checks\[0\]\.expected/);
    expect(errorOf(withCheck({ nodeId: 'n', scorer: 'oneOf', expected: [] }))).toMatch(/non-empty array/);
    expect(errorOf(withCheck({ nodeId: 'n', scorer: 'oneOf', expected: ['a', 1] }))).toMatch(
      /expected\[1\]/,
    );
  });

  it('rejects expected values with nothing comparable left after normalization', () => {
    const withCheck = (check: unknown) => dataset({ cases: [evalCase({ checks: [check] })] });
    expect(errorOf(withCheck({ nodeId: 'n', scorer: 'contains', expected: '...' }))).toMatch(
      /no comparable content/,
    );
    expect(errorOf(withCheck({ nodeId: 'n', scorer: 'equals', expected: '"**"' }))).toMatch(
      /no comparable content/,
    );
    expect(errorOf(withCheck({ nodeId: 'n', scorer: 'oneOf', expected: ['ok', '?!'] }))).toMatch(
      /expected\[1\] has no comparable content/,
    );
  });

  it('rejects unsafe or invalid regex checks', () => {
    const regex = (pattern: string, flags?: string) =>
      dataset({ cases: [evalCase({ checks: [{ nodeId: 'n', scorer: 'regex', pattern, flags }] })] });
    expect(errorOf(regex('('))).toMatch(/not a valid regular expression/);
    expect(errorOf(regex('a', 'g'))).toMatch(/flags may only contain/);
    expect(errorOf(regex('a', 'y'))).toMatch(/flags may only contain/);
    expect(errorOf(regex('a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1)))).toMatch(/exceeds/);
  });

  it('enforces the size limits', () => {
    const cases = Array.from({ length: MAX_EVAL_CASES + 1 }, (_, i) => evalCase({ id: `c${i}` }));
    expect(errorOf(dataset({ cases }))).toMatch(/At most/);
    const checks = Array.from({ length: MAX_CHECKS_PER_CASE + 1 }, () => ({
      nodeId: 'n',
      scorer: 'equals',
      expected: 'x',
    }));
    expect(errorOf(dataset({ cases: [evalCase({ checks })] }))).toMatch(/at most/);
  });

  it('never throws and yields a result for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const result = parseEvalDataset(value);
        expect(typeof result.ok).toBe('boolean');
      }),
    );
  });
});

describe('findUnknownNodeIds', () => {
  it('lists each referenced node the pipeline lacks, once, in order', () => {
    const result = parseEvalDataset(
      dataset({
        cases: [
          evalCase({
            id: 'a',
            checks: [
              { nodeId: 'ghost', scorer: 'equals', expected: 'x' },
              { nodeId: 'known', scorer: 'equals', expected: 'x' },
            ],
          }),
          evalCase({ id: 'b', checks: [{ nodeId: 'ghost', scorer: 'contains', expected: 'x' }] }),
          evalCase({ id: 'c', checks: [{ nodeId: 'other', scorer: 'contains', expected: 'x' }] }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(findUnknownNodeIds(result.dataset, new Set(['known']))).toEqual(['ghost', 'other']);
    }
  });
});

describe('bundled support-triage dataset', () => {
  it('parses and only references nodes of the demo pipeline', () => {
    const result = parseEvalDataset(supportTriage);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const demoNodeIds = new Set(createDemoPipeline().nodes.map((node) => node.id));
      expect(findUnknownNodeIds(result.dataset, demoNodeIds)).toEqual([]);
      expect(result.dataset.cases.length).toBeGreaterThanOrEqual(10);
    }
  });
});
