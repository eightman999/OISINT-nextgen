// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  emptyPersonalizationSnapshot,
  loadLocalPersonalization,
  previewPreferenceObservationFromSnapshot,
} from '@/lib/personalization';
import { usePlaceFeedback } from '@/hooks/usePlaceFeedback';

const mocks = vi.hoisted(() => ({
  getOwnPlaceFeedback: vi.fn(),
  getPlaceFeedbackSummary: vi.fn(),
  loadFeedbackLearningBase: vi.fn(),
  saveFeedbackLearningProfile: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  getOwnPlaceFeedback: mocks.getOwnPlaceFeedback,
  getPlaceFeedbackSummary: mocks.getPlaceFeedbackSummary,
  savePlaceFeedback: vi.fn(),
}));

vi.mock('@/lib/accountRepository', () => ({
  loadFeedbackLearningBase: mocks.loadFeedbackLearningBase,
  saveFeedbackLearningProfile: mocks.saveFeedbackLearningProfile,
}));

function installLocalStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  };
  previousLocalStorage = window.localStorage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  return storage;
}

let previousLocalStorage: Storage;

const ownFeedback = {
  id: 'feedback-owned-515',
  placeId: 'place-owned-515',
  rating: 1 as const,
  aspect: 'noise' as const,
  aspectValue: 'quiet',
};

beforeEach(() => {
  mocks.getOwnPlaceFeedback.mockResolvedValue(ownFeedback);
  mocks.getPlaceFeedbackSummary.mockResolvedValue([]);
  mocks.loadFeedbackLearningBase.mockResolvedValue({
    serverBacked: true,
    profileExists: false,
    snapshot: emptyPersonalizationSnapshot(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: previousLocalStorage,
  });
});

describe('usePlaceFeedback personalization server-first boundary (#515)', () => {
  it('server保存が失敗した時はlocal snapshot/tokenを変更しない', async () => {
    const storage = installLocalStorage();
    mocks.saveFeedbackLearningProfile.mockRejectedValue(new Error('rpc failed'));
    const { result } = renderHook(() => usePlaceFeedback(ownFeedback.placeId));

    await waitFor(() => expect(result.current.feedback?.id).toBe(ownFeedback.id));
    await act(async () => {
      await result.current.applyFeedbackToPersonalization();
    });

    expect(result.current.personalizationApplied).toBe(false);
    expect(result.current.personalizationError).toBe(
      'おすすめへの反映を保存できませんでした。時間を置いて再度お試しください。',
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(loadLocalPersonalization()).toBeNull();
  });

  it('保存成功時はRPCが返したcanonical snapshotだけをlocalへ同期する', async () => {
    const storage = installLocalStorage();
    const canonical = previewPreferenceObservationFromSnapshot(emptyPersonalizationSnapshot(), {
      eventKey: 'server-canonical-feedback',
      sourceKind: 'feedback',
      strength: 1,
      axes: { quiet: 20 },
    });
    mocks.saveFeedbackLearningProfile.mockResolvedValue({
      persisted: true,
      applied: true,
      snapshot: canonical,
    });
    const { result } = renderHook(() => usePlaceFeedback(ownFeedback.placeId));

    await waitFor(() => expect(result.current.feedback?.id).toBe(ownFeedback.id));
    await act(async () => {
      await result.current.applyFeedbackToPersonalization();
    });

    expect(result.current.personalizationApplied).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(loadLocalPersonalization()?.scores.quiet).toBe(canonical.scores.quiet);
  });

  it('同時更新のCAS conflictはcanonical再読込→観測再計算→再試行する', async () => {
    const storage = installLocalStorage();
    const canonicalBase = previewPreferenceObservationFromSnapshot(emptyPersonalizationSnapshot(), {
      eventKey: 'other-feedback',
      sourceKind: 'feedback',
      strength: 1,
      axes: { value: 86 },
    });
    const canonicalNext = previewPreferenceObservationFromSnapshot(canonicalBase, {
      eventKey: 'feedback-v1-other',
      sourceKind: 'feedback',
      strength: 1,
      axes: { quiet: 86 },
    });
    mocks.saveFeedbackLearningProfile
      .mockResolvedValueOnce({ persisted: true, applied: false, conflict: true, snapshot: canonicalBase })
      .mockResolvedValueOnce({ persisted: true, applied: true, snapshot: canonicalNext });
    const { result } = renderHook(() => usePlaceFeedback(ownFeedback.placeId));

    await waitFor(() => expect(result.current.feedback?.id).toBe(ownFeedback.id));
    await act(async () => {
      await result.current.applyFeedbackToPersonalization();
    });

    expect(mocks.saveFeedbackLearningProfile).toHaveBeenCalledTimes(2);
    expect(mocks.saveFeedbackLearningProfile.mock.calls[1][2]).toMatchObject({
      profileExists: true,
      updatedAt: canonicalBase.updatedAt,
    });
    expect(result.current.personalizationApplied).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('プロフィール削除とのCAS conflictでは次のretryをprofileなしで送る', async () => {
    const storage = installLocalStorage();
    const base = previewPreferenceObservationFromSnapshot(emptyPersonalizationSnapshot(), {
      eventKey: 'existing-profile-feedback',
      sourceKind: 'feedback',
      strength: 1,
      axes: { value: 80 },
    });
    const afterDeletion = emptyPersonalizationSnapshot();
    const canonicalNext = previewPreferenceObservationFromSnapshot(afterDeletion, {
      eventKey: 'feedback-v1-after-deletion',
      sourceKind: 'feedback',
      strength: 1,
      axes: { quiet: 86 },
    });
    mocks.loadFeedbackLearningBase.mockResolvedValueOnce({
      serverBacked: true,
      profileExists: true,
      snapshot: base,
    });
    mocks.saveFeedbackLearningProfile
      .mockResolvedValueOnce({
        persisted: true,
        applied: false,
        conflict: true,
        profileExists: false,
        snapshot: afterDeletion,
      })
      .mockResolvedValueOnce({
        persisted: true,
        applied: true,
        profileExists: true,
        snapshot: canonicalNext,
      });
    const { result } = renderHook(() => usePlaceFeedback(ownFeedback.placeId));

    await waitFor(() => expect(result.current.feedback?.id).toBe(ownFeedback.id));
    await act(async () => {
      await result.current.applyFeedbackToPersonalization();
    });

    expect(mocks.saveFeedbackLearningProfile).toHaveBeenCalledTimes(2);
    expect(mocks.saveFeedbackLearningProfile.mock.calls[1][2]).toMatchObject({
      profileExists: false,
      updatedAt: afterDeletion.updatedAt,
    });
    expect(result.current.personalizationApplied).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
