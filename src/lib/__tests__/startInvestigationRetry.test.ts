import { describe, expect, it } from 'vitest';

import {
  buildInvestigationInputFingerprint,
  resolveInvestigationRunTarget,
} from '@/lib/startInvestigationRetry';

describe('調査開始の再試行対象', () => {
  it('run受付失敗後は作成済み調査を再利用する', () => {
    const existing = {
      investigationId: 'existing',
      shareToken: 'token-existing',
      inputFingerprint: 'v1-existing',
    };
    const created = {
      investigationId: 'new',
      shareToken: 'token-new',
      inputFingerprint: 'v1-new',
    };

    expect(resolveInvestigationRunTarget(existing, 'v1-existing', created)).toBe(existing);
    expect(resolveInvestigationRunTarget(existing, 'v1-new', created)).toBe(created);
  });

  it('create失敗後の初回成功では新規調査を採用する', () => {
    const created = {
      investigationId: 'new',
      shareToken: 'token-new',
      inputFingerprint: 'v1-new',
    };

    expect(resolveInvestigationRunTarget(null, 'v1-new', created)).toBe(created);
  });

  it('入力変更時は古い調査を再利用しない', () => {
    const base = {
      query: '池袋で肉',
      selectedChips: ['静か'],
      location: null,
      displayName: 'ゲスト',
      tasteProfile: { likes: ['肉'], avoid: [], allergies: '', healthGoal: 'none' },
    } as const;
    const changed = { ...base, query: '新宿で魚' };
    const existing = {
      investigationId: 'existing',
      shareToken: 'token-existing',
      inputFingerprint: buildInvestigationInputFingerprint(base),
    };
    const created = {
      investigationId: 'new',
      shareToken: 'token-new',
      inputFingerprint: buildInvestigationInputFingerprint(changed),
    };

    expect(
      resolveInvestigationRunTarget(existing, created.inputFingerprint, created)
    ).toBe(created);
  });
});
