import { describe, expect, it } from 'vitest';

import { DEFAULT_DATASET, DEFAULT_OUT_DIR, parseEvalCliArgs } from '@/cli/evalArgs';

describe('parseEvalCliArgs', () => {
  it('defaults to the bundled dataset, the demo pipeline, and no gate', () => {
    expect(parseEvalCliArgs([])).toEqual({
      kind: 'run',
      options: {
        dataset: DEFAULT_DATASET,
        graph: null,
        outDir: DEFAULT_OUT_DIR,
        simulate: false,
        failUnder: null,
      },
    });
  });

  it('reads every option', () => {
    expect(
      parseEvalCliArgs([
        '--dataset',
        'cases.json',
        '--graph=pipeline.json',
        '--out',
        'reports',
        '--simulate',
        '--fail-under',
        '87.5',
      ]),
    ).toEqual({
      kind: 'run',
      options: {
        dataset: 'cases.json',
        graph: 'pipeline.json',
        outDir: 'reports',
        simulate: true,
        failUnder: 0.875,
      },
    });
  });

  it('asks for help', () => {
    expect(parseEvalCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseEvalCliArgs(['-h', '--dataset', 'x'])).toEqual({ kind: 'help' });
  });

  it.each([
    [['--datset', 'x']],
    [['cases.json']],
    [['--dataset']],
    [['--simulate=yes']],
  ])('rejects malformed arguments %j', (argv) => {
    expect(parseEvalCliArgs(argv).kind).toBe('error');
  });

  it('rejects blank values', () => {
    expect(parseEvalCliArgs(['--out', ' '])).toEqual({ kind: 'error', error: '--out needs a value.' });
  });

  it.each(['0', '100', '90'])('accepts the percentage %s', (value) => {
    expect(parseEvalCliArgs(['--fail-under', value])).toMatchObject({
      options: { failUnder: Number(value) / 100 },
    });
  });

  it.each(['101', '-5', 'abc', '', '1e2', '50%'])('rejects the percentage %j', (value) => {
    expect(parseEvalCliArgs([`--fail-under=${value}`])).toEqual({
      kind: 'error',
      error: '--fail-under must be a percentage between 0 and 100.',
    });
  });
});
