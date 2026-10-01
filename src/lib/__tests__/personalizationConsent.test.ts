import { describe, expect, it } from 'vitest';

import {
  PERSONALIZATION_CONSENT_VERSION,
  PERSONALIZATION_RETENTION_LABEL,
} from '../personalizationConsent';

// #281/#167: 保持期間の表示と削除実装の導線を固定する回帰テスト。
// アカウント削除の実装済み導線を、好みだけ削除の説明と混同しない。
describe('PERSONALIZATION_RETENTION_LABEL', () => {
  it('実装済みのアカウント削除導線に言及する (#167)', () => {
    expect(PERSONALIZATION_RETENTION_LABEL).toContain('アカウント削除');
  });

  it('実在する削除操作（アカウント画面の「好みだけ削除」）を案内する', () => {
    expect(PERSONALIZATION_RETENTION_LABEL).toContain('好みだけ削除');
  });

  it('監査イベントが利用者から変更・削除できない事実を表示し続ける', () => {
    // 0011_user_personalization_audit.sql: user_product_audit_events は追記専用で
    // 利用者には select しか許可されない。
    expect(PERSONALIZATION_RETENTION_LABEL).toContain('監査イベント');
  });

  it('consent version は DB check 制約（202608160002）と一致する v2 のまま変えない', () => {
    // 文言修正は説明の訂正であり同意目的の変更ではないため、版数は据え置く。
    expect(PERSONALIZATION_CONSENT_VERSION).toBe('personalization-v2');
  });
});
