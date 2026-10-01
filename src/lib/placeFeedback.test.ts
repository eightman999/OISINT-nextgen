import { describe, expect, it } from 'vitest';

import {
  normalizePlaceFeedbackInput,
  placeFeedbackValueLabel,
  sanitizePlaceFeedbackSummary,
} from '@/lib/placeFeedback';

describe('place feedback service', () => {
  it('公開集計の値は固定日本語ラベルへ変換し、未知値を返さない', () => {
    expect(placeFeedbackValueLabel('noise', 'quiet')).toBe('静か');
    expect(placeFeedbackValueLabel('space', 'comfortable')).toBe('快適');
    expect(placeFeedbackValueLabel('value', 'free text')).toBeUndefined();
  });

  it('normalizes optional fields and rejects an empty or mismatched input', () => {
    expect(normalizePlaceFeedbackInput({
      visitedAt: ' 2026-08-24 ',
      aspect: 'noise',
      aspectValue: '  quiet  ',
    })).toEqual({
      visitedAt: '2026-08-24',
      aspect: 'noise',
      aspectValue: 'quiet',
    });
    expect(() => normalizePlaceFeedbackInput({})).toThrow('いずれかを入力');
    expect(() => normalizePlaceFeedbackInput({ aspectValue: 'quiet' })).toThrow('評価項目');
    expect(() => normalizePlaceFeedbackInput({ visitedAt: '2026/08/24' })).toThrow('YYYY-MM-DD');
    expect(() => normalizePlaceFeedbackInput({ aspect: 'noise', aspectValue: '店内はとても静かです' }))
      .toThrow('選択肢');
    expect(normalizePlaceFeedbackInput({ aspect: 'space', aspectValue: 'comfortable' }))
      .toEqual({ aspect: 'space', aspectValue: 'comfortable' });
  });

  it('removes every aggregate that could describe fewer than three responses', () => {
    expect(sanitizePlaceFeedbackSummary({
      placeId: 'place-1',
      visitedCount: 2,
      ratingCount: 2,
      ratingAverage: 1,
      aspects: [{ aspect: 'noise', aspectValue: 'quiet', count: 2 }],
    })).toEqual({
      placeId: 'place-1',
      visitedCount: 0,
      ratingCount: 0,
      ratingAverage: null,
      aspects: [],
    });
  });

  it('retains only safe aggregate values at or above the threshold', () => {
    expect(sanitizePlaceFeedbackSummary({
      placeId: 'place-1',
      visitedCount: 3,
      ratingCount: 4,
      ratingAverage: 0.25,
      aspects: [
        { aspect: 'noise', aspectValue: 'quiet', count: 3 },
        { aspect: 'space', aspectValue: 'cramped', count: 2 },
      ],
    })).toEqual({
      placeId: 'place-1',
      visitedCount: 3,
      ratingCount: 4,
      ratingAverage: 0.25,
      aspects: [{ aspect: 'noise', aspectValue: 'quiet', count: 3 }],
    });
  });

  it('legacy/free-text aggregate values are never displayable', () => {
    expect(sanitizePlaceFeedbackSummary({
      placeId: 'place-1',
      visitedCount: 3,
      ratingCount: 3,
      ratingAverage: 1,
      aspects: [{ aspect: 'noise', aspectValue: '店内は静かです', count: 3 }],
    }).aspects).toEqual([]);
  });
});
