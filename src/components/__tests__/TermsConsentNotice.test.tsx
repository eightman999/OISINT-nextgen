// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TermsConsentNotice } from '@/components/TermsConsentNotice';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  markLocal: vi.fn(),
  recordForAccount: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: { push: mocks.push },
}));

vi.mock('@/lib/termsConsent', () => ({
  TERMS_CONSENT_LABEL: '利用規約とプライバシーポリシーに同意します。',
  markTermsConsentRecordedLocally: mocks.markLocal,
  recordTermsConsentForAccount: mocks.recordForAccount,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TermsConsentNotice', () => {
  it('規約同意チェックボックスの押下を正式な同意記録へつなぐ', async () => {
    mocks.recordForAccount.mockResolvedValueOnce({
      ok: true,
      scope: 'local',
      acceptedAt: '2026-08-27T00:00:00.000Z',
    });
    const { getByTestId } = render(<TermsConsentNotice testID="terms-notice" />);
    const consent = getByTestId('terms-notice-consent');

    expect(consent.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(consent);
    await waitFor(() => expect(consent.getAttribute('aria-checked')).toBe('true'));
    expect(mocks.recordForAccount).toHaveBeenCalledTimes(1);
    expect(mocks.markLocal).toHaveBeenCalledWith('2026-08-27T00:00:00.000Z');
  });

  it('controlled stateでは変更を親へ通知する', () => {
    const onCheckedChange = vi.fn();
    const { getByTestId, rerender } = render(
      <TermsConsentNotice
        testID="terms-notice"
        checked={false}
        persistConsent={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const consent = getByTestId('terms-notice-consent');

    fireEvent.click(consent);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(consent.getAttribute('aria-checked')).toBe('false');

    rerender(
      <TermsConsentNotice
        testID="terms-notice"
        checked
        persistConsent={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    expect(consent.getAttribute('aria-checked')).toBe('true');
  });
});
