import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  growthSessionMetricsSchema,
  loadGrowthSessionMetrics,
  recordGrowthReturn,
  recordGrowthShareOpen,
} from '@/lib/growthLoop';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', () => ({ isLiveDataProvider: true }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: { rpc },
}));

const INVESTIGATION_ID = '00000000-0000-4000-8000-000000000541';
const SHARE_TOKEN = '0123456789abcdef0123456789abcdef';

const validMetrics = {
  schema: 'oisint.growth_session.v1',
  events: {
    investigation_created: 1,
    share_opened: 3,
    participant_joined: 2,
    participant_activated: 1,
    requirement_added: 1,
    vote_cast: 2,
    ranking_changed: 1,
    participant_returned: 1,
    participant_returned_7d: 1,
    participant_returned_via_push: 1,
    participant_created_new_investigation: 1,
  },
  derived: {
    share_to_join_conversion: 0.666667,
    join_to_first_action_conversion: 0.5,
    group_completed: true,
    invite_coefficient: 0.5,
    return_7d_rate: 0.5,
  },
} as const;

describe('growthLoop', () => {
  beforeEach(() => rpc.mockReset());

  it('本文や表示名を含まない固定schemaだけを受け取る', () => {
    expect(growthSessionMetricsSchema.parse(validMetrics)).toEqual(validMetrics);
    expect(
      growthSessionMetricsSchema.safeParse({
        ...validMetrics,
        raw_query: '保存してはいけない',
      }).success,
    ).toBe(false);
    expect(
      growthSessionMetricsSchema.safeParse({
        ...validMetrics,
        events: { ...validMetrics.events, display_name: '利用者名' },
      }).success,
    ).toBe(false);
  });

  it('share tokenは形式検証後にRPCへだけ渡す', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(recordGrowthShareOpen(SHARE_TOKEN)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_growth_share_open', {
      p_share_token: SHARE_TOKEN,
    });

    await expect(recordGrowthShareOpen('broken-token')).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('UUID以外をreturn RPCへ送らず、正常応答だけを採用する', async () => {
    await expect(recordGrowthReturn('not-an-id')).resolves.toBe(false);
    expect(rpc).not.toHaveBeenCalled();

    rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(recordGrowthReturn(INVESTIGATION_ID)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_growth_return', {
      p_investigation_id: INVESTIGATION_ID,
    });
  });

  it('session集計をstrict parseし、未知fieldや壊れた応答を拒否する', async () => {
    rpc.mockResolvedValueOnce({ data: validMetrics, error: null });
    await expect(loadGrowthSessionMetrics(INVESTIGATION_ID)).resolves.toEqual(validMetrics);

    rpc.mockResolvedValueOnce({
      data: { ...validMetrics, user_id: 'leak' },
      error: null,
    });
    await expect(loadGrowthSessionMetrics(INVESTIGATION_ID)).rejects.toThrow(
      '共同セッションの集計形式を確認できませんでした。',
    );
  });
});
