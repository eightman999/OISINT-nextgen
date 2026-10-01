import { describe, expect, it } from 'vitest';

import {
  factKeyLabel,
  formatFactValue,
  isDisplayableFact,
  MIN_DISPLAY_EVIDENCE_COUNT,
  selectDisplayFacts,
} from '@/lib/placeFacts';
import type { PlaceFact } from '@/types';

function fact(overrides: Partial<PlaceFact>): PlaceFact {
  return {
    placeId: 'p-a',
    key: 'card_accepted',
    value: true,
    confidence: 0.8,
    evidenceCount: 3,
    conflicting: false,
    lastVerifiedAt: '2026-08-14T10:00:00Z',
    ...overrides,
  };
}

describe('isDisplayableFact（薄い fact のフォールバック判定 #333）', () => {
  it('矛盾が無く根拠 Evidence が閾値未満の「薄い」fact は表示しない', () => {
    expect(MIN_DISPLAY_EVIDENCE_COUNT).toBe(2);
    expect(isDisplayableFact(fact({ evidenceCount: 1 }))).toBe(false);
    expect(isDisplayableFact(fact({ evidenceCount: 2 }))).toBe(true);
  });

  it('conflicting=true は件数に関わらず警告として表示する（§15 矛盾を潰さない）', () => {
    expect(isDisplayableFact(fact({ evidenceCount: 1, conflicting: true }))).toBe(true);
  });

  it('confidence が 0..1 の外・非数なら clamp せず表示しない（§30 と同方針）', () => {
    expect(isDisplayableFact(fact({ confidence: -0.1 }))).toBe(false);
    expect(isDisplayableFact(fact({ confidence: 1.2 }))).toBe(false);
    expect(isDisplayableFact(fact({ confidence: Number.NaN }))).toBe(false);
    expect(isDisplayableFact(fact({ confidence: 1.2, conflicting: true }))).toBe(false);
    expect(isDisplayableFact(fact({ confidence: 0 }))).toBe(true);
    expect(isDisplayableFact(fact({ confidence: 1 }))).toBe(true);
  });
});

describe('selectDisplayFacts（表示対象の選別と決定論の並び）', () => {
  it('薄い fact を除外し、矛盾ありを先頭に、以降は key 昇順で返す', () => {
    const facts = [
      fact({ key: 'reservation', evidenceCount: 2 }),
      fact({ key: 'noise_level', evidenceCount: 1 }), // 薄い → 除外
      fact({ key: 'opening_hours', conflicting: true }),
      fact({ key: 'card_accepted', evidenceCount: 3 }),
    ];

    expect(selectDisplayFacts(facts).map((item) => item.key)).toEqual([
      'opening_hours',
      'card_accepted',
      'reservation',
    ]);
  });

  it('全て薄い/不正なら空配列（既存 Evidence 表示へのフォールバック）', () => {
    expect(
      selectDisplayFacts([
        fact({ evidenceCount: 1 }),
        fact({ key: 'genre', confidence: 2 }),
      ])
    ).toEqual([]);
  });
});

describe('factKeyLabel / formatFactValue（控えめな日本語整形）', () => {
  it('既知キーは日本語ラベル、未知キーは推測で訳さず key のまま', () => {
    expect(factKeyLabel('opening_hours')).toBe('営業時間');
    expect(factKeyLabel('space_comfort')).toBe('席の快適さ');
    expect(factKeyLabel('unknown_future_key')).toBe('unknown_future_key');
  });

  it('boolean / number / string / 範囲 / feedback 集計値を整形する', () => {
    expect(formatFactValue('card_accepted', true)).toBe('あり');
    expect(formatFactValue('reservation', false)).toBe('なし');
    expect(formatFactValue('capacity', 24)).toBe('24席');
    expect(formatFactValue('opening_hours', '17:00-23:00')).toBe('17:00-23:00');
    expect(formatFactValue('budget_dinner', { min: 2500, max: 3500 })).toBe('2500〜3500円');
    expect(formatFactValue('budget_dinner', { min: 3000, max: 3000 })).toBe('3000円');
    expect(
      formatFactValue('noise_level', { value: 'quiet', count: 4, share: 0.75 })
    ).toBe('静か');
  });

  it('未知の形は JSON 文字列のまま出し、値を捏造しない', () => {
    expect(formatFactValue('genre', ['焼肉', '韓国料理'])).toBe('["焼肉","韓国料理"]');
    expect(formatFactValue('time_limit', null)).toBe('不明');
  });

  it('filter claimのlabelと徒歩分数を表示用に整形する', () => {
    expect(formatFactValue('non_smoking', true)).toBe('あり');
    expect(formatFactValue('wifi_available', false)).toBe('なし');
    expect(formatFactValue('nearest_station_walk_minutes', 5)).toBe('5分');
  });
});
