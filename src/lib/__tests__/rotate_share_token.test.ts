import { describe, expect, it } from 'vitest';

import {
  createInvestigation,
  getInvestigation,
  getInvestigationByShareToken,
  joinInvestigation,
  rotateShareToken,
  subscribeInvestigation,
} from '@/lib/api';
import type { Investigation } from '@/types';

// share_token rotate（#177）の mock provider 検証。
// 受け入れ条件: 旧 token 即時無効 / 参加済み members 維持 / 新 token 反映（owner のみ）。
async function createInvestigationWithGuest(): Promise<{
  investigationId: string;
  oldToken: string;
}> {
  const { investigationId, shareToken: oldToken } = await createInvestigation({
    query: '池袋で3人。肉。',
    displayName: '幹事',
    userId: 'owner-1',
    idempotencyKey: 'rotate-share-token-key',
    authSubject: 'owner-1',
  });
  await joinInvestigation({
    shareToken: oldToken,
    displayName: '参加者',
    userId: 'guest-1',
  });
  return { investigationId, oldToken };
}

describe('rotateShareToken (mock provider)', () => {
  it('owner の rotate で新 token が発行され、旧 token は即時無効になる', async () => {
    const { investigationId, oldToken } = await createInvestigationWithGuest();

    const newToken = await rotateShareToken(investigationId, 'owner-1');

    expect(newToken).toMatch(/^[0-9a-f]{32}$/);
    expect(newToken).not.toBe(oldToken);

    // 旧 token では investigation を引けない（共有リンクの即時失効）
    expect(getInvestigationByShareToken(oldToken)).toBeUndefined();
    await expect(
      joinInvestigation({ shareToken: oldToken, displayName: '後から', userId: 'guest-2' })
    ).rejects.toThrow('調査が見つかりません');

    // 新 token が反映され、新 token では参加できる
    expect(getInvestigation(investigationId)?.shareToken).toBe(newToken);
    await expect(
      joinInvestigation({ shareToken: newToken, displayName: '新規', userId: 'guest-3' })
    ).resolves.toMatchObject({ investigationId });
  });

  it('rotate しても参加済みメンバー（role 含む）は維持される', async () => {
    const { investigationId } = await createInvestigationWithGuest();
    const membersBefore = getInvestigation(investigationId)?.members;

    await rotateShareToken(investigationId, 'owner-1');

    expect(getInvestigation(investigationId)?.members).toEqual(membersBefore);
    expect(
      getInvestigation(investigationId)?.members.map((member) => member.id)
    ).toEqual(expect.arrayContaining(['owner-1', 'guest-1']));
  });

  it('owner 以外（参加メンバー・非メンバー）は rotate できず token も変わらない', async () => {
    const { investigationId, oldToken } = await createInvestigationWithGuest();

    await expect(rotateShareToken(investigationId, 'guest-1')).rejects.toThrow(
      '共有リンクを再発行する権限がありません'
    );
    await expect(rotateShareToken(investigationId, 'stranger-1')).rejects.toThrow(
      '共有リンクを再発行する権限がありません'
    );
    expect(getInvestigation(investigationId)?.shareToken).toBe(oldToken);
  });

  it('存在しない investigation の rotate は拒否される', async () => {
    await expect(rotateShareToken('missing-id', 'owner-1')).rejects.toThrow(
      '共有リンクを再発行する権限がありません'
    );
  });

  it('rotate は購読リスナーへ新 token を通知する（画面の共有リンク更新経路）', async () => {
    const { investigationId } = await createInvestigationWithGuest();

    const events: Investigation[] = [];
    const unsubscribe = subscribeInvestigation(investigationId, (next) => {
      events.push(next);
    });
    const newToken = await rotateShareToken(investigationId, 'owner-1');
    unsubscribe();

    // 初期スナップショット + rotate 通知
    expect(events.at(-1)?.shareToken).toBe(newToken);
  });
});
