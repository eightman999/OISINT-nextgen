import { afterEach, describe, expect, it, vi } from 'vitest';

import { supportMessageBody } from '@/lib/support';
import type { SupportMessage } from '@/lib/support';

const { openURL } = vi.hoisted(() => ({
  openURL: vi.fn(async (_url: string) => {}),
}));

vi.mock('react-native', () => ({ Linking: { openURL } }));

// hasConfiguredSupportEmail / configuredSupportEmail はモジュール読み込み時に
// 環境変数を評価するため、テストごとに stubEnv → 再読込する。
async function loadSupport(email: string) {
  vi.resetModules();
  vi.stubEnv('EXPO_PUBLIC_SUPPORT_EMAIL', email);
  return await import('@/lib/support');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  openURL.mockClear();
});

const message: SupportMessage = {
  kind: 'contact',
  subject: '[OISINT] お問い合わせ / その他',
  fields: [{ label: 'お問い合わせ内容', value: '本文です' }],
};

describe('support', () => {
  it('メール窓口が設定されていればメール作成画面を開く', async () => {
    const support = await loadSupport('support@example.com');
    expect(support.hasConfiguredSupportEmail).toBe(true);
    expect(support.configuredSupportEmail).toBe('support@example.com');

    const result = await support.handoffSupportMessage(message);
    expect(result).toBe('opened');
    expect(openURL).toHaveBeenCalledTimes(1);
    expect(openURL.mock.calls[0][0]).toContain('mailto:support@example.com');
  });

  it('メール窓口が未設定ならコピーへフォールバックし、受付先はGitHub Issuesを指す', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    const support = await loadSupport('');
    expect(support.hasConfiguredSupportEmail).toBe(false);
    expect(support.configuredSupportEmail).toBeNull();
    expect(support.SUPPORT_ISSUES_URL).toBe('https://github.com/eightman999/OISINT/issues');

    const result = await support.handoffSupportMessage(message);
    expect(result).toBe('copied');
    expect(openURL).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('【お問い合わせ内容】');
  });

  it('メール未設定でコピーもできない環境では unavailable を返す', async () => {
    vi.stubGlobal('navigator', {});

    const support = await loadSupport('');
    const result = await support.handoffSupportMessage(message);
    expect(result).toBe('unavailable');
    expect(openURL).not.toHaveBeenCalled();
  });
});

// #267: 訂正・削除申立て（correction）の本文テンプレートの回帰テスト。
describe('supportMessageBody', () => {
  it('correction の種別ラベルと申立て項目を本文へ含める', () => {
    const body = supportMessageBody({
      kind: 'correction',
      subject: '[OISINT] 情報の訂正・削除申立て / 訂正',
      fields: [
        { label: '対象URL（共有トークン）', value: 'https://oisint.com/i/abc123' },
        { label: '店舗名', value: '店A' },
        { label: '根拠URL', value: '' },
      ],
    });

    expect(body).toContain('OISINT 情報の訂正・削除申立て');
    expect(body).toContain('【対象URL（共有トークン）】\nhttps://oisint.com/i/abc123');
    expect(body).toContain('【店舗名】\n店A');
    // 未入力の項目は値を捏造せず「（未入力）」と明示する
    expect(body).toContain('【根拠URL】\n（未入力）');
  });

  it('既存の contact / feedback の種別ラベルを変えない', () => {
    expect(supportMessageBody({ kind: 'contact', subject: 's', fields: [] })).toContain(
      'OISINT お問い合わせ'
    );
    expect(supportMessageBody({ kind: 'feedback', subject: 's', fields: [] })).toContain(
      'OISINT フィードバック'
    );
  });
});
