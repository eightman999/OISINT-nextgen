// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadGrowthSessionMetrics } from '@/lib/growthLoop';

import { GrowthLoopProgress } from '../GrowthLoopProgress';

vi.mock('@/lib/growthLoop', () => ({
  loadGrowthSessionMetrics: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GrowthLoopProgress', () => {
  it('first actionを投票または条件追加として最短案内する', async () => {
    vi.mocked(loadGrowthSessionMetrics).mockResolvedValueOnce(null);
    const { getByTestId } = render(
      <GrowthLoopProgress
        investigationId="inv-1"
        refreshKey="v1"
        fallbackParticipantCount={2}
      />,
    );

    expect(getByTestId('growth-loop-progress').textContent).toContain('最短は候補を1つ開いて投票');
    expect(getByTestId('growth-loop-progress').textContent).toContain('条件を追加');
    expect(getByTestId('growth-loop-progress').textContent).toContain('参加2人');
  });

  it('集計された順位変化を分かりやすく表示する', async () => {
    vi.mocked(loadGrowthSessionMetrics).mockResolvedValueOnce({
      schema: 'oisint.growth_session.v1',
      events: {
        investigation_created: 1,
        share_opened: 3,
        participant_joined: 2,
        participant_activated: 2,
        requirement_added: 1,
        vote_cast: 2,
        ranking_changed: 1,
        participant_returned: 1,
        participant_returned_7d: 1,
        participant_returned_via_push: 1,
        participant_created_new_investigation: 0,
      },
      derived: {
        share_to_join_conversion: 0.666667,
        join_to_first_action_conversion: 1,
        group_completed: true,
        invite_coefficient: 0,
        return_7d_rate: 0.5,
      },
    });

    const { getByTestId } = render(
      <GrowthLoopProgress
        investigationId="inv-1"
        refreshKey="v1"
        fallbackParticipantCount={0}
      />,
    );

    await waitFor(() => expect(getByTestId('growth-ranking-updated')).toBeTruthy());
    expect(getByTestId('growth-loop-progress').textContent).toContain('最初の行動2人');
    expect(getByTestId('growth-loop-progress').textContent).toContain('順位変化1回');
    expect(getByTestId('growth-loop-progress').textContent).toContain('再訪1人');
  });
});
