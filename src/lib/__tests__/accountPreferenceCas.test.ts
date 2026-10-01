import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  saveFeedbackLearningProfile,
  saveStoredPreferenceProfile,
} from '@/lib/accountRepository';
import type { LocalPersonalizationSnapshot } from '@/lib/personalization';

const mocks = vi.hoisted(() => {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return {
    getUser: vi.fn(),
    from: vi.fn(() => query),
    rpc: vi.fn(),
    query,
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

const storedRow = {
  scenario_id: null,
  axis_scores: {
    evidence: 50,
    health: 50,
    quiet: 70,
    value: 50,
    novelty: 50,
    groupFit: 50,
  },
  likes: [],
  avoid: [],
  model_version: 'profile-v1',
  source_kinds: ['profile_edits'],
  learning_state: {},
  consent_version: 'personalization-v2',
  consent_purpose: 'restaurant_recommendations',
  consented_at: '2026-08-24T00:00:00.000Z',
  updated_at: '2026-08-24T00:00:01.000Z',
};

const snapshot: LocalPersonalizationSnapshot = {
  scenarioId: null,
  scores: storedRow.axis_scores,
  likes: [],
  avoid: [],
  modelVersion: 'profile-v1',
  sourceKinds: ['profile_edits'],
  learningState: {} as LocalPersonalizationSnapshot['learningState'],
  updatedAt: '2026-08-24T00:00:01.000Z',
};

beforeEach(() => {
  mocks.getUser.mockResolvedValue({
    data: { user: { id: '00000000-0000-4000-8000-000000001011', is_anonymous: false } },
    error: null,
  });
  mocks.query.maybeSingle.mockResolvedValue({ data: storedRow, error: null });
  mocks.rpc.mockResolvedValue({ data: true, error: null });
});

afterEach(() => vi.clearAllMocks());

describe('account repository preference CAS (#515)', () => {
  it('profile save sends the canonical revision and existence bit to the 11-argument core RPC', async () => {
    await saveStoredPreferenceProfile(
      snapshot,
      { profileExists: true, updatedAt: storedRow.updated_at },
      'account',
    );

    expect(mocks.rpc).toHaveBeenCalledWith(
      'save_user_preference_profile',
      expect.objectContaining({
        p_expected_updated_at: storedRow.updated_at,
        p_base_profile_exists: true,
      }),
    );
    expect(mocks.query.maybeSingle).not.toHaveBeenCalled();
  });

  it('stale full snapshots use the caller-supplied revision instead of rereading before write', async () => {
    mocks.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: '40001', message: 'preference profile changed' },
    });

    await expect(saveStoredPreferenceProfile(
      snapshot,
      { profileExists: true, updatedAt: '2000-01-01T00:00:00.000Z' },
      'account',
    )).rejects.toThrow(
      '保存済みプロフィールが更新されました。再読み込みしてから再度お試しください。',
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      'save_user_preference_profile',
      expect.objectContaining({
        p_expected_updated_at: '2000-01-01T00:00:00.000Z',
        p_base_profile_exists: true,
      }),
    );
    expect(mocks.query.maybeSingle).not.toHaveBeenCalled();
  });

  it('feedback learning sends the current nine-argument CAS payload', async () => {
    await saveFeedbackLearningProfile(snapshot, '00000000-0000-4000-8000-000000001013', {
      profileExists: true,
      updatedAt: storedRow.updated_at,
    });

    expect(mocks.rpc).toHaveBeenCalledWith(
      'save_place_feedback_learning',
      expect.objectContaining({
        p_feedback_id: '00000000-0000-4000-8000-000000001013',
        p_expected_updated_at: storedRow.updated_at,
        p_base_profile_exists: true,
      }),
    );
  });
});
