// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvestigationEventLog } from '@/components/InvestigationEventLog';
import { getInvestigationEvents } from '@/lib/api';
import { mockInvestigation } from '@/data/mock';
import type { Investigation, InvestigationEvent } from '@/types';

vi.mock('@/lib/api', () => ({
  getInvestigationEvents: vi.fn(),
}));

const getInvestigationEventsMock = vi.mocked(getInvestigationEvents);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function investigationWithStatus(status: Investigation['status']): Investigation {
  return { ...mockInvestigation, status };
}

function makeEvent(overrides: Partial<InvestigationEvent> & { id: string }): InvestigationEvent {
  return {
    investigationId: mockInvestigation.id,
    eventType: 'step_started',
    message: 'ダミーイベント',
    metadata: {},
    createdAt: '2026-08-14T10:00:00Z',
    ...overrides,
  };
}

describe('InvestigationEventLog', () => {
  it('進行中は展開表示のまま、イベントを新しい順に並べる（#332）', async () => {
    getInvestigationEventsMock.mockResolvedValue([
      makeEvent({ id: 'ev-1', message: '過去の類似調査を確認しています' }),
      makeEvent({ id: 'ev-2', message: '候補店を探索しています' }),
    ]);

    const { findByTestId, getByText, queryByTestId } = render(
      <InvestigationEventLog investigation={investigationWithStatus('searching')} />
    );

    const log = await findByTestId('inv-event-log');
    getByText('調査ログ');
    getByText('2件');
    // 進行中は折りたたみトグルを出さず常時展開
    expect(queryByTestId('inv-event-log-toggle')).toBeNull();

    const text = log.textContent ?? '';
    // created_at 昇順で受け取った配列を新しい順（ev-2 → ev-1）に表示する
    expect(text.indexOf('候補店を探索しています')).toBeLessThan(
      text.indexOf('過去の類似調査を確認しています')
    );
  });

  it('step_failed は失敗理由（metadata.message）まで表示する（#332）', async () => {
    getInvestigationEventsMock.mockResolvedValue([
      makeEvent({
        id: 'ev-fail',
        eventType: 'step_failed',
        message: 'ステップ searching が失敗しました',
        metadata: { step: 'searching', message: 'Geoapify API timeout' },
      }),
    ]);

    const { findByText, getByText } = render(
      <InvestigationEventLog investigation={investigationWithStatus('failed')} />
    );

    // 失敗ステータスでも常時展開し、メッセージと詳細理由の両方が読める
    await findByText('ステップ searching が失敗しました');
    getByText('Geoapify API timeout');
  });

  it('完了後は折りたたみ、トグルで展開できる', async () => {
    getInvestigationEventsMock.mockResolvedValue([
      makeEvent({ id: 'ev-done', message: '調査が完了しました' }),
    ]);

    const { findByTestId, getByText, queryByText } = render(
      <InvestigationEventLog investigation={investigationWithStatus('complete')} />
    );

    const toggle = await findByTestId('inv-event-log-toggle');
    expect(queryByText('調査が完了しました')).toBeNull();
    getByText('表示');

    fireEvent.click(toggle);
    getByText('調査が完了しました');
    getByText('閉じる');

    fireEvent.click(toggle);
    expect(queryByText('調査が完了しました')).toBeNull();
  });

  it('message が無い行は event_type を代わりに表示する', async () => {
    getInvestigationEventsMock.mockResolvedValue([
      makeEvent({ id: 'ev-null', eventType: 'recall_completed', message: null }),
    ]);

    const { findByText } = render(
      <InvestigationEventLog investigation={investigationWithStatus('recalling')} />
    );

    await findByText('recall_completed');
  });

  it('イベントが無い間は何も描画しない', async () => {
    getInvestigationEventsMock.mockResolvedValue([]);

    const { queryByTestId } = render(
      <InvestigationEventLog investigation={investigationWithStatus('searching')} />
    );

    // fetch 解決後も空なら非表示のまま
    await Promise.resolve();
    expect(queryByTestId('inv-event-log')).toBeNull();
  });

  it('ログ取得の失敗では画面を壊さず何も表示しない', async () => {
    getInvestigationEventsMock.mockRejectedValue(new Error('network error'));

    const { queryByTestId } = render(
      <InvestigationEventLog investigation={investigationWithStatus('searching')} />
    );

    await Promise.resolve();
    expect(queryByTestId('inv-event-log')).toBeNull();
  });
});
