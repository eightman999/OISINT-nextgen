import { generateDecisionText } from '@/lib/decisionText';
import { mockInvestigation } from '@/data/mock';
import { describe, it } from 'vitest';

function assertIncludes(text: string, expected: string): void {
  if (!text.includes(expected)) {
    throw new Error(`Expected text to include: ${expected}`);
  }
}

function assertNotIncludes(text: string, unexpected: string): void {
  if (text.includes(unexpected)) {
    throw new Error(`Expected text not to include: ${unexpected}`);
  }
}

/** Lightweight contract checks that do not require changing the repository's test runner. */
export function runDecisionTextTests(): void {
  const before = JSON.stringify(mockInvestigation);
  const selected = mockInvestigation.candidates[0];
  if (!selected) throw new Error('Test fixture has no selected candidate');

  const { short, detailed } = generateDecisionText(mockInvestigation, selected, {
    dateTime: '2026年8月23日 19:00',
    phoneNumber: '03-1234-5678',
    mapUrl: 'https://maps.example.test/shop-a',
  });

  assertIncludes(short, '店名: 店A');
  assertIncludes(short, '日時・住所: 2026年8月23日 19:00 / 東京都豊島区池袋1-2-3');
  assertIncludes(short, '地図リンク: https://maps.example.test/shop-a');
  assertIncludes(short, '電話番号: 03-1234-5678');
  assertIncludes(detailed, '選んだ理由: 池袋駅東口から徒歩5分（example.com）');
  assertIncludes(detailed, '落とした2件の理由:');
  assertIncludes(detailed, '残る不明: 0件');
  assertIncludes(detailed, '検証用URL: https://example.com/shop-a');
  assertNotIncludes(`${short}\n${detailed}`, '引用文は原文と照合していません');

  const fallback = generateDecisionText(mockInvestigation, selected);
  assertIncludes(fallback.short, '日時・住所: 不明 / 東京都豊島区池袋1-2-3');
  assertIncludes(fallback.short, '地図リンク: 不明');
  assertIncludes(fallback.short, '電話番号: 不明');

  const uncertain = mockInvestigation.candidates[2];
  if (!uncertain) throw new Error('Test fixture has no uncertain candidate');
  const uncertainText = generateDecisionText(mockInvestigation, uncertain).detailed;
  assertIncludes(uncertainText, '残る不明: 1件');
  assertIncludes(uncertainText, '「カード可」について確認する');
  assertIncludes(uncertainText, '根拠を確認できる情報は不明（出典不明）');

  if (JSON.stringify(mockInvestigation) !== before) {
    throw new Error('Decision text generation must not mutate its inputs');
  }
}

describe('decision text generation', () => {
  it('generates safe short and detailed paste-ready text without mutating input', () => {
    runDecisionTextTests();
  });
});
