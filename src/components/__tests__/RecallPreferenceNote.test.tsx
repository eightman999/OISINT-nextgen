// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecallPreferenceNote, recallPreferenceView } from '@/components/RecallPreferenceNote';
import { getInvestigationEvents } from '@/lib/api';
import { mockInvestigation } from '@/data/mock';
import type { InvestigationEvent } from '@/types';

vi.mock('@/lib/api', () => ({
  getInvestigationEvents: vi.fn(),
}));

const getInvestigationEventsMock = vi.mocked(getInvestigationEvents);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function recallEvent(overrides: Partial<InvestigationEvent> = {}): InvestigationEvent {
  return {
    id: 'ev-recall',
    investigationId: mockInvestigation.id,
    eventType: 'recall_preference',
    message: '過去の類似調査で高評価だった店が 1 件あります',
    metadata: {},
    createdAt: '2026-08-14T10:00:12Z',
    ...overrides,
  };
}

describe('RecallPreferenceNote', () => {
  it('recall_preference の集計値（店名・条件種別）を表示する（#111）', async () => {
    getInvestigationEventsMock.mockResolvedValue([
      recallEvent({
        metadata: {
          places: [{ placeId: 'p-a', name: '店A', avgVote: 1, similarity: 0.61 }],
          kinds: [{ kind: 'quiet', priority: 'must', count: 2 }],
        },
      }),
    ]);

    const { findByTestId, getByText } = render(
      <RecallPreferenceNote investigation={mockInvestigation} />
    );

    await findByTestId('recall-preference-note');
    getByText('過去の好みの手がかり');
    getByText(/「静か」が重視されていました/);
    getByText(/店A などが高評価でした/);
  });

  it('recall_preference が無ければ何も表示しない', async () => {
    getInvestigationEventsMock.mockResolvedValue([]);

    const { container, findByText } = render(
      <div>
        <RecallPreferenceNote investigation={mockInvestigation} />
        <span>done</span>
      </div>
    );

    await findByText('done');
    expect(container.querySelector('[data-testid="recall-preference-note"]')).toBeNull();
  });

  it('avgVote <= 0 の店は高評価の店として数えない', () => {
    const view = recallPreferenceView(
      recallEvent({
        metadata: {
          places: [{ placeId: 'p-a', name: '店A', avgVote: -1 }],
          kinds: [],
        },
      })
    );
    expect(view).toBeNull();
  });

  it('他人の query 文面に相当する項目は表示対象にしない（集計値のみ）', () => {
    const view = recallPreferenceView(
      recallEvent({
        metadata: {
          rawQuery: '池袋で静かな店',
          places: [{ placeId: 'p-a', name: '店A', avgVote: 1 }],
          kinds: [],
        },
      })
    );
    expect(view?.placeNames).toEqual(['店A']);
  });
});
