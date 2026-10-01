// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TermsConsentModal } from '@/components/TermsConsentModal';

const mocks = vi.hoisted(() => ({
  markLocal: vi.fn(),
  recordForAccount: vi.fn(),
}));

vi.mock('@/lib/termsConsent', () => ({
  TERMS_CONSENT_LABEL: '利用規約とプライバシーポリシーに同意します。',
  TERMS_CONSENT_SUMMARY: 'summary',
  markTermsConsentRecordedLocally: mocks.markLocal,
  recordTermsConsentForAccount: mocks.recordForAccount,
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TermsConsentModal', () => {
  it('server記録が成功するまでlocalとpending actionを進めない', async () => {
    let resolveRecord!: (value: unknown) => void;
    mocks.recordForAccount.mockReturnValueOnce(new Promise((resolve) => {
      resolveRecord = resolve;
    }));
    const onAccept = vi.fn();
    const { getByTestId } = render(
      <TermsConsentModal visible onAccept={onAccept} onClose={vi.fn()} />,
    );

    const accept = getByTestId('terms-consent-accept');
    expect(accept.hasAttribute('disabled')).toBe(true);
    fireEvent.click(getByTestId('terms-consent-consent'));
    expect(accept.hasAttribute('disabled')).toBe(false);
    fireEvent.click(accept);
    expect(mocks.markLocal).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
    expect(getByTestId('terms-consent-modal')).toBeTruthy();

    resolveRecord({
      ok: true,
      scope: 'account',
      acceptedAt: '2026-08-24T00:00:00.000Z',
    });
    await waitFor(() => expect(onAccept).toHaveBeenCalledTimes(1));
    expect(mocks.markLocal).toHaveBeenCalledWith('2026-08-24T00:00:00.000Z');
  });

  it('server記録失敗時はエラーを表示しaction/local記録を止める', async () => {
    mocks.recordForAccount.mockResolvedValueOnce({
      ok: false,
      reason: 'server-unavailable',
      message: 'サーバー記録に失敗しました',
    });
    const onAccept = vi.fn();
    const { getByTestId } = render(
      <TermsConsentModal visible onAccept={onAccept} onClose={vi.fn()} />,
    );

    fireEvent.click(getByTestId('terms-consent-consent'));
    fireEvent.click(getByTestId('terms-consent-accept'));
    await waitFor(() => expect(getByTestId('terms-consent-error').textContent).toContain(
      'サーバー記録に失敗しました',
    ));
    expect(mocks.markLocal).not.toHaveBeenCalled();
    expect(onAccept).not.toHaveBeenCalled();
  });
});
