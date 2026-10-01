import { describe, expect, it } from 'vitest';

import {
  matchStateAccessibilityLabel,
  matchStateSymbol,
  percent,
  statusSymbol,
  voteSymbol,
} from '@/lib/format';

describe('format', () => {
  it.each([
    ['match', '○'],
    ['partial', '△'],
    ['mismatch', '×'],
    ['unknown', '?'],
  ] as const)('match state %s -> %s', (state, expected) => {
    expect(matchStateSymbol(state)).toBe(expected);
  });

  it.each([
    ['match', '条件を満たす'],
    ['partial', '一部満たす'],
    ['mismatch', '条件を満たさない'],
    ['unknown', '判定不明'],
  ] as const)('match state %s has a spoken label', (state, expected) => {
    expect(matchStateAccessibilityLabel(state)).toBe(expected);
  });

  it('does not mark a future complete step as done', () => {
    expect(statusSymbol('complete', 'searching')).toBe('○');
    expect(statusSymbol('complete', 'complete')).toBe('✓');
  });

  it('marks previous steps as done and the current step as active', () => {
    expect(statusSymbol('recalling', 'searching')).toBe('✓');
    expect(statusSymbol('searching', 'searching')).toBe('●');
    expect(statusSymbol('ranking', 'searching')).toBe('○');
  });

  it('keeps vote and percentage formatting stable', () => {
    expect(voteSymbol(1)).toBe('👍');
    expect(voteSymbol(0)).toBe('🤔');
    expect(voteSymbol(-1)).toBe('👎');
    expect(percent(0.91)).toBe('91%');
  });
});
