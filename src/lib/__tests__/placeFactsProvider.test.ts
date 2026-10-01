import { describe, expect, it } from 'vitest';

import { mockPlaceFacts } from '@/data/mockPlaceFacts';
import { getPlaceFacts } from '@/lib/api';

describe('getPlaceFacts (mock provider #333)', () => {
  it('既知の place はダミー place_facts を返し、警告表示用の conflicting キーを含む', async () => {
    const facts = await getPlaceFacts('p-a');

    expect(facts).toEqual(mockPlaceFacts['p-a']);
    // mock で警告表示（conflicting=true）と確度高/低の両方を確認できること（AC）
    expect(facts.some((fact) => fact.conflicting)).toBe(true);
    expect(facts.some((fact) => fact.confidence >= 0.9)).toBe(true);
    expect(facts.some((fact) => !fact.conflicting && fact.confidence <= 0.5)).toBe(true);
  });

  it('place_facts が無い place は空配列（既存 Evidence 表示へのフォールバック）', async () => {
    await expect(getPlaceFacts('p-b')).resolves.toEqual([]);
    await expect(getPlaceFacts('p-c')).resolves.toEqual([]);
  });

  it('返り値は clone であり、呼び出し側の変更が seed を汚染しない', async () => {
    const facts = await getPlaceFacts('p-a');
    facts[0].key = 'mutated';

    const again = await getPlaceFacts('p-a');
    expect(again[0].key).toBe('opening_hours');
  });

  it('ダミーデータの place_id が mock の place（p-a）と対応している', async () => {
    const facts = await getPlaceFacts('p-a');
    expect(facts.every((fact) => fact.placeId === 'p-a')).toBe(true);
  });
});
