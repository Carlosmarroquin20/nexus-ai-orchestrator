import { describe, expect, it } from 'vitest';

import {
  deltaTone,
  formatJudgeMean,
  formatPassRate,
  formatRate,
  formatRateDelta,
  formatSigned,
} from '@/utils/evaluation/display';

describe('evaluation display formatting', () => {
  it('formats rates with at most one decimal, and nothing measured as a dash', () => {
    expect(formatRate(5 / 6)).toBe('83.3%');
    expect(formatRate(1)).toBe('100%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(null)).toBe('—');
  });

  it('formats pass rates with their counts', () => {
    expect(formatPassRate({ passed: 5, total: 6, rate: 5 / 6 })).toBe('5/6 · 83.3%');
    expect(formatPassRate({ passed: 0, total: 0, rate: null })).toBe('—');
  });

  it('formats judge means on the 1-5 scale', () => {
    expect(formatJudgeMean(4.25)).toBe('4.25 / 5');
    expect(formatJudgeMean(null)).toBe('—');
  });

  it('signs differences explicitly', () => {
    expect(formatRateDelta(1 / 6)).toBe('+16.7 pts');
    expect(formatRateDelta(-0.05)).toBe('−5 pts');
    expect(formatRateDelta(0)).toBe('±0 pts');
    expect(formatRateDelta(null)).toBe('—');
    expect(formatSigned(-120, (ms) => `${ms} ms`)).toBe('−120 ms');
  });

  it('judges a difference by the direction that counts as better', () => {
    expect(deltaTone(0.1, true)).toBe('better');
    expect(deltaTone(0.1, false)).toBe('worse');
    expect(deltaTone(-30, false)).toBe('better');
    expect(deltaTone(1e-12, true)).toBe('neutral');
    expect(deltaTone(null, true)).toBe('neutral');
  });
});
