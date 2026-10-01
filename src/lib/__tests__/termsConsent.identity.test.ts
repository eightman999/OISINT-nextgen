// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTermsConsentForAction,
  isTermsConsentRecordedLocally,
  loadLocalTermsConsent,
  markPendingSignInConsent,
  markTermsConsentRecordedLocally,
  syncLocalTermsConsentForAccount,
} from '@/lib/termsConsent';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  rpc: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ isLiveDataProvider: true }));
vi.mock('@/lib/supabase', () => {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    maybeSingle: mocks.maybeSingle,
  };
  return {
    supabase: {
      auth: { getUser: mocks.getUser },
      rpc: mocks.rpc,
      from: vi.fn(() => query),
    },
  };
});

const anonymousA = { id: 'subject-a', is_anonymous: true };
const permanentA = { id: 'subject-a', is_anonymous: false };
const permanentB = { id: 'subject-b', is_anonymous: false };

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-08-24T12:00:00.000Z') });
  const values = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  vi.clearAllMocks();
  mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
  mocks.rpc.mockResolvedValue({ data: '2026-08-24T00:00:00.000Z', error: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('terms consent subject binding (#272)', () => {
  it('匿名Aの同意は同一UUIDの恒久Aへだけ同期できる', async () => {
    markTermsConsentRecordedLocally('2026-08-24T00:00:00.000Z', {
      id: anonymousA.id,
      kind: 'anonymous',
    });
    expect(isTermsConsentRecordedLocally({ id: anonymousA.id, kind: 'anonymous' })).toBe(true);

    mocks.getUser.mockResolvedValue({ data: { user: permanentA }, error: null });
    await expect(ensureTermsConsentForAction()).resolves.toEqual({ status: 'ready' });
    expect(mocks.rpc).toHaveBeenCalledWith('record_terms_consent', {
      p_terms_version: 'terms-v1',
    });
    expect(loadLocalTermsConsent()).toMatchObject({
      subjectId: 'subject-a',
      subjectKind: 'permanent',
    });
  });

  it('Aのlocal同意を別UUID Bへ自動帰属せず、Bの明示同意を要求する', async () => {
    markTermsConsentRecordedLocally('2026-08-24T00:00:00.000Z', {
      id: anonymousA.id,
      kind: 'anonymous',
    });
    mocks.getUser.mockResolvedValue({ data: { user: permanentB }, error: null });

    await expect(ensureTermsConsentForAction()).resolves.toEqual({ status: 'needs-consent' });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(isTermsConsentRecordedLocally({ id: permanentB.id, kind: 'permanent' })).toBe(false);
  });

  it('subjectなしlegacy/version-only記録は恒久Bの同意根拠にしない', async () => {
    markTermsConsentRecordedLocally('2026-08-24T00:00:00.000Z');
    mocks.getUser.mockResolvedValue({ data: { user: permanentB }, error: null });

    await expect(ensureTermsConsentForAction()).resolves.toEqual({ status: 'needs-consent' });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('subjectなしlegacy記録を任意の匿名UUIDへ自動帰属しない', async () => {
    markTermsConsentRecordedLocally('2026-08-24T00:00:00.000Z');
    mocks.getUser.mockResolvedValue({ data: { user: anonymousA }, error: null });

    await expect(ensureTermsConsentForAction()).resolves.toEqual({ status: 'needs-consent' });
    expect(isTermsConsentRecordedLocally({ id: anonymousA.id, kind: 'anonymous' })).toBe(false);
  });

  it('signed-outのversion-only local記録は同意済み扱いにしない', async () => {
    window.localStorage.setItem(
      'oisint:terms-consent:v1',
      JSON.stringify({ version: 'terms-v1' }),
    );
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(ensureTermsConsentForAction()).resolves.toEqual({ status: 'needs-consent' });
    expect(isTermsConsentRecordedLocally()).toBe(false);
  });

  it('serverの版数が一致してもacceptedAt不正ならclient日時を捏造せず停止する', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: permanentB }, error: null });
    mocks.maybeSingle.mockResolvedValue({
      data: { terms_version: 'terms-v1', terms_accepted_at: '' },
      error: null,
    });

    await expect(ensureTermsConsentForAction()).resolves.toMatchObject({ status: 'error' });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(loadLocalTermsConsent()).toBeNull();
  });

  it('異常な未来のlocal日時は保存せず、同意根拠にしない', async () => {
    window.localStorage.setItem(
      'oisint:terms-consent:v1',
      JSON.stringify({
        version: 'terms-v1',
        acceptedAt: '2200-01-01T00:00:00.000Z',
        subjectId: permanentB.id,
        subjectKind: 'permanent',
      }),
    );
    expect(isTermsConsentRecordedLocally({ id: permanentB.id, kind: 'permanent' })).toBe(false);
  });

  it('sign-in直前の明示同意だけは成功した恒久subjectへ一度だけhandoffする', async () => {
    const acceptedAt = '2026-08-24T00:00:00.000Z';
    markPendingSignInConsent(acceptedAt);
    mocks.getUser.mockResolvedValue({ data: { user: permanentB }, error: null });
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValue({
        data: { terms_version: 'terms-v1', terms_accepted_at: acceptedAt },
        error: null,
      });

    await expect(syncLocalTermsConsentForAccount()).resolves.toBeUndefined();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(loadLocalTermsConsent()).toMatchObject({
      subjectId: permanentB.id,
      subjectKind: 'permanent',
    });

    mocks.rpc.mockClear();
    await expect(syncLocalTermsConsentForAccount()).resolves.toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
