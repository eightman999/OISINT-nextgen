// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isTermsConsentRecordedLocally,
  loadLocalTermsConsent,
  markTermsConsentRecordedLocally,
  TERMS_CONSENT_VERSION,
} from '../termsConsent';

// #272: 規約同意の版数回帰テスト。
// DB 側（202608230001_terms_consent.sql）の CHECK 制約と RPC 内再検証は
// 'terms-v1' のみを許可する。クライアント定数との不一致は「同意を記録した
// つもりが DB に書けない」または「旧版に同意したまま進める」事故になるため、
// 版数を一方的に変えないことを固定する。
describe('TERMS_CONSENT_VERSION', () => {
  it('DB check 制約（202608230001）と一致する v1 のまま変えない', () => {
    // 文言修正は説明の訂正であり同意内容の変更ではないため、版数は据え置く。
    // 同意内容を変える場合は migration・RPC・本テストを同時に更新すること。
    expect(TERMS_CONSENT_VERSION).toBe('terms-v1');
  });
});

describe('local terms consent record', () => {
  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, String(value)),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    });
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('同意版数と日時を端末へ保存する', () => {
    markTermsConsentRecordedLocally('2026-08-24T00:00:00.000Z');

    expect(loadLocalTermsConsent()).toEqual({
      version: TERMS_CONSENT_VERSION,
      acceptedAt: '2026-08-24T00:00:00.000Z',
    });
    expect(isTermsConsentRecordedLocally()).toBe(true);
  });

  it('旧version-only記録は同意根拠にせず、明示記録後だけ有効にする', () => {
    window.localStorage.setItem(
      'oisint:terms-consent:v1',
      JSON.stringify({ version: TERMS_CONSENT_VERSION }),
    );

    expect(isTermsConsentRecordedLocally()).toBe(false);
    expect(loadLocalTermsConsent()?.acceptedAt).toBe('');
    markTermsConsentRecordedLocally('2026-08-24T00:00:00.000Z');
    expect(loadLocalTermsConsent()?.acceptedAt).toBe('2026-08-24T00:00:00.000Z');
  });
});
