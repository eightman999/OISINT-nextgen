// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalPersonalizationSnapshot } from '@/lib/personalization';
import { createPreferenceLearningState } from '@/lib/preferenceLearning';
import { AccountDashboard } from '../../app/account';

const mocks = vi.hoisted(() => ({
  loadStoredPreferenceProfile: vi.fn(),
  saveStoredPreferenceProfile: vi.fn(),
  deleteStoredPreferenceProfile: vi.fn(),
  loadLocalPersonalization: vi.fn<(subject?: { id: string }) => LocalPersonalizationSnapshot | null>(() => null),
  loadAccountTermsConsent: vi.fn(),
  auth: null as any,
}));

vi.mock('expo-router', () => ({
  router: { push: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => ({}),
}));

vi.mock('@/providers/AuthProvider', () => ({
  useAuth: vi.fn(() => mocks.auth),
}));

vi.mock('@/lib/accountRepository', () => ({
  AccountOperationError: class AccountOperationError extends Error {},
  deleteAccount: vi.fn(),
  deleteStoredPreferenceProfile: mocks.deleteStoredPreferenceProfile,
  loadStoredPreferenceProfile: mocks.loadStoredPreferenceProfile,
  saveAccountDisplayName: vi.fn(),
  saveStoredPreferenceProfile: mocks.saveStoredPreferenceProfile,
}));

vi.mock('@/lib/personalization', () => ({
  clearLocalPersonalization: vi.fn(),
  loadLocalPersonalization: mocks.loadLocalPersonalization,
  saveLocalPersonalization: vi.fn(),
  restoreStoredPersonalizationLocally: vi.fn(),
}));

vi.mock('@/lib/termsConsent', () => ({
  ensureTermsConsentForAction: vi.fn(),
  isTermsConsentRecordedLocally: vi.fn(() => false),
  loadAccountTermsConsent: mocks.loadAccountTermsConsent,
  markTermsConsentRecordedLocally: vi.fn(),
  TERMS_CONSENT_VERSION: 'terms-v1',
}));

vi.mock('@/components/AgeRequirementNote', () => ({ AgeRequirementNote: () => null }));
vi.mock('@/components/Footer', () => ({ Footer: () => null }));
vi.mock('@/components/GoogleMapsImportPanel', () => ({ GoogleMapsImportPanel: () => null }));
vi.mock('@/components/PushNotificationSettings', () => ({ PushNotificationSettings: () => null }));
vi.mock('@/components/TermsConsentModal', () => ({ TermsConsentModal: () => null }));
vi.mock('@/components/TermsConsentNotice', () => ({ TermsConsentNotice: () => null }));

function authFor(userId: string, displayName: string) {
  return {
    userId,
    status: 'authenticated' as const,
    displayName,
    email: `${userId}@example.test`,
    avatarUrl: null,
    authBusy: false,
    errorMessage: null,
    setDisplayName: vi.fn(),
    signOut: vi.fn(),
    resetLocalAuthState: vi.fn(),
  };
}

function profile(like: string) {
  return {
    scenarioId: null,
    axisScores: {},
    likes: [like],
    avoid: [],
    modelVersion: 'test',
    sourceKinds: [],
    learningState: { interactionCount: 0 },
    consentVersion: 'personalization-v2',
    consentPurpose: 'test',
    consentedAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
  };
}

function localSnapshot(like: string, subjectId: string) {
  const scores = {
    value: 50,
    evidence: 50,
    health: 50,
    quiet: 50,
    novelty: 50,
    groupFit: 50,
  } as const;
  return {
    scenarioId: null,
    scores,
    likes: [like],
    avoid: [],
    modelVersion: 'test',
    sourceKinds: [],
    learningState: createPreferenceLearningState(scores, { likes: [like], avoid: [] }, undefined, '2026-08-24T00:00:00.000Z'),
    updatedAt: '2026-08-24T00:00:00.000Z',
    subjectId,
    subjectKind: 'permanent' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth = authFor('subject-a', 'A profile');
  mocks.loadAccountTermsConsent.mockResolvedValue(null);
});

afterEach(cleanup);

describe('AccountDashboard subject boundary', () => {
  it('A profile→B切替ではrender直後に旧cloud profile/nameを隠し、Aの遅延応答を反映しない', async () => {
    let resolveA!: (value: ReturnType<typeof profile>) => void;
    let resolveB!: (value: ReturnType<typeof profile>) => void;
    mocks.loadStoredPreferenceProfile
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));

    const view = render(<AccountDashboard isWide={false} />);
    expect(view.getByTestId('account-subscription-delete-note')).toBeTruthy();
    await waitFor(() => expect(mocks.loadStoredPreferenceProfile).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveA(profile('A-only'));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByText('A-only')).toBeTruthy());

    mocks.auth = authFor('subject-b', 'B profile');
    view.rerender(<AccountDashboard isWide={false} />);

    expect((view.getByTestId('account-display-name') as HTMLInputElement).value).toBe('');
    expect(view.queryByText('A-only')).toBeNull();
    expect(view.getByText('保存状態を確認中')).toBeTruthy();

    await waitFor(() => expect(mocks.loadStoredPreferenceProfile).toHaveBeenCalledTimes(2));
    // Aの旧readが遅れて返ってきた場合も、Bの表示へ戻してはならない。
    await act(async () => {
      resolveA(profile('A-late'));
      await Promise.resolve();
    });
    expect(view.queryByText('A-late')).toBeNull();

    await act(async () => {
      resolveB(profile('B-only'));
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByText('B-only')).toBeTruthy());
    expect(view.queryByText('A-only')).toBeNull();
    expect((view.getByTestId('account-display-name') as HTMLInputElement).value).toBe('B profile');
  });

  it('端末localプロフィールもsubjectごとに隔離し、BへAのtags/countを表示・同期しない', async () => {
    const localA = localSnapshot('A-local-only', 'subject-a');
    const localB = localSnapshot('B-local-only', 'subject-b');
    mocks.loadLocalPersonalization.mockImplementation((subject?: { id: string }) => {
      if (subject?.id === 'subject-a') return localA;
      if (subject?.id === 'subject-b') return localB;
      return null;
    });
    mocks.loadStoredPreferenceProfile.mockResolvedValue(null);

    const view = render(<AccountDashboard isWide={false} />);
    await waitFor(() => expect(view.getByText('A-local-only')).toBeTruthy());

    mocks.auth = authFor('subject-b', 'B profile');
    view.rerender(<AccountDashboard isWide={false} />);
    expect(view.queryByText('A-local-only')).toBeNull();
    expect(view.queryByText(/A-local-only/)).toBeNull();

    await waitFor(() => expect(view.getByText('B-local-only')).toBeTruthy());
    expect(view.queryByText('A-local-only')).toBeNull();
    expect(view.getByTestId('account-sync-profile')).toBeTruthy();
  });

  it('Aの削除確認・busyをBへ持ち越さず、Bの初回クリックは確認だけにする', async () => {
    const localA = localSnapshot('A-local-only', 'subject-a');
    const localB = localSnapshot('B-local-only', 'subject-b');
    mocks.loadLocalPersonalization.mockImplementation((subject?: { id: string }) =>
      subject?.id === 'subject-a' ? localA : subject?.id === 'subject-b' ? localB : null,
    );
    let resolveSave!: () => void;
    mocks.saveStoredPreferenceProfile.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    mocks.loadStoredPreferenceProfile.mockResolvedValue(null);

    const view = render(<AccountDashboard isWide={false} />);
    await waitFor(() => expect(view.getByTestId('account-delete-preferences')).toBeTruthy());
    fireEvent.click(view.getByTestId('account-delete-preferences'));
    expect(view.getByText('本当に削除する')).toBeTruthy();
    fireEvent.click(view.getByTestId('account-sync-profile'));

    mocks.auth = authFor('subject-b', 'B profile');
    view.rerender(<AccountDashboard isWide={false} />);
    expect(view.queryByText('本当に削除する')).toBeNull();
    await waitFor(() => expect(view.getByTestId('account-delete-preferences')).toBeTruthy());
    expect((view.getByTestId('account-delete-preferences') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByTestId('account-delete-preferences'));
    expect(view.getByText('本当に削除する')).toBeTruthy();
    expect(mocks.deleteStoredPreferenceProfile).not.toHaveBeenCalled();
    expect(mocks.saveStoredPreferenceProfile).toHaveBeenCalledWith(
      localA,
      { profileExists: false, updatedAt: null },
    );
    resolveSave();
  });
});
