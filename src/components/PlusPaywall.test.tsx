// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlusPaywall } from '@/components/PlusPaywall';

const mocks = vi.hoisted(() => ({
  loadOfferings: vi.fn(),
  purchase: vi.fn(),
  restore: vi.fn(),
}));

vi.mock('expo-router', () => ({
  router: { back: vi.fn(), push: vi.fn() },
}));

vi.mock('@/providers/AuthProvider', () => ({
  useAuth: () => ({ isAuthenticated: false, isAnonymous: true }),
}));

vi.mock('@/providers/EntitlementProvider', () => ({
  useEntitlement: () => ({
    snapshot: { tier: 'free' },
    offerings: [],
    busy: false,
    loading: false,
    loadOfferings: mocks.loadOfferings,
    purchase: mocks.purchase,
    restore: mocks.restore,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PlusPaywall', () => {
  it('does not promise unimplemented Plus benefits', () => {
    const { getByText, queryByText } = render(<PlusPaywall />);
    getByText('無料プランの調査・投票・根拠確認はそのまま利用できます。Plusの適用範囲と利用枠は、購入前の表示内容とアカウント状態で確認できます。');
    expect(queryByText(/端末を越えて好みを引き継げます/)).toBeNull();
    expect(queryByText(/追加の調査枠/)).toBeNull();
  });

  it('shows legal and store-management guidance before purchase', () => {
    const { getByTestId, getByText } = render(<PlusPaywall />);
    getByTestId('plus-legal-links');
    getByText(/アカウント削除はストア定期購入の解約ではありません/);
    for (const id of ['terms', 'privacy', 'commercial', 'refund', 'support']) {
      getByTestId(`plus-legal-${id}`);
    }
  });
});
