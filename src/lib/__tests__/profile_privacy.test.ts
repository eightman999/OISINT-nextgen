import { describe, expect, it } from 'vitest';

import { mockInvestigation } from '@/data/mock';
import { generateDecisionText } from '@/lib/decisionText';
import {
  DEFAULT_TASTE_PROFILE,
  locationToQuery,
  tasteProfileToQuery,
} from '@/lib/profile';
import type { Investigation } from '@/types';

// spec.md §33: アレルギー・健康目的・GPS 座標は共有面 (raw_query / 共有URL / 決定文) に
// 到達させない。ここでは現在の出力仕様をピン留めする (#151)。
describe('profile privacy pinning (§33)', () => {
  describe('locationToQuery', () => {
    it('emits a fixed coarse label for GPS selections: no digits, no coordinates', () => {
      const query = locationToQuery({
        label: '現在地付近',
        source: 'gps',
        latitude: 35.7295123,
        longitude: 139.7109456,
      });

      // 精度のピン留め: 桁落としではなく座標を一切出さない固定文字列。
      expect(query).toBe('場所: 現在地付近');
      expect(query).not.toMatch(/\d/);
    });

    it('uses the human label for map selections even when coordinates are present', () => {
      const query = locationToQuery({
        label: '池袋駅東口',
        source: 'map',
        latitude: 35.729,
        longitude: 139.71,
      });

      expect(query).toBe('場所: 池袋駅東口');
      expect(query).not.toContain('35.729');
      expect(query).not.toContain('139.71');
    });

    it('falls back to the label when a GPS selection has no numeric coordinates', () => {
      expect(locationToQuery({ label: '現在地', source: 'gps' })).toBe('場所: 現在地');
    });

    it('returns null for a missing selection', () => {
      expect(locationToQuery(null)).toBeNull();
    });
  });

  describe('tasteProfileToQuery', () => {
    it('returns null (not an empty string) for the default empty profile', () => {
      expect(tasteProfileToQuery(DEFAULT_TASTE_PROFILE)).toBeNull();
    });

    it('joins likes with 、 and prefixes avoid entries', () => {
      expect(
        tasteProfileToQuery({
          likes: ['肉', '寿司'],
          avoid: ['混雑', '喫煙'],
          allergies: '',
          healthGoal: 'none',
        })
      ).toBe('好き: 肉、寿司 / 避けたい: 混雑、喫煙');
    });

    it('returns null when only private fields (allergies / health goal) are set', () => {
      expect(
        tasteProfileToQuery({
          likes: [],
          avoid: [],
          allergies: '甲殻類・そば',
          healthGoal: 'diet',
        })
      ).toBeNull();
    });

    it('never serializes the raw allergy string alongside public fields', () => {
      const query = tasteProfileToQuery({
        likes: ['肉'],
        avoid: ['行列'],
        allergies: '甲殻類アレルギー重度',
        healthGoal: 'high_protein',
      });

      expect(query).toContain('好き: 肉');
      expect(query).not.toContain('甲殻類');
      expect(query).not.toContain('アレルギー');
      expect(query).not.toContain('high_protein');
    });
  });

  describe('decision text does not surface rawQuery / profile-derived text', () => {
    it('omits a distinctive allergy marker present in rawQuery from both outputs', () => {
      const marker = '甲殻類アレルギーの人がいる';
      const investigation: Investigation = structuredClone(mockInvestigation);
      investigation.rawQuery = `池袋 3人 ${marker}`;

      const { short, detailed } = generateDecisionText(
        investigation,
        investigation.candidates[0]
      );

      // 決定文は候補・Evidence 由来の内容のみで構成される。rawQuery は引用しない。
      expect(short).not.toContain(marker);
      expect(detailed).not.toContain(marker);
      expect(short).not.toContain('甲殻類');
      expect(detailed).not.toContain('甲殻類');
    });
  });
});
