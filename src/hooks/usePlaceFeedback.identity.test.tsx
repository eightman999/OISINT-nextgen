// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePlaceFeedback, type PlaceFeedbackSubject } from '@/hooks/usePlaceFeedback';
import { PlaceFeedbackPanel } from '@/components/PlaceFeedbackPanel';

const mocks = vi.hoisted(() => ({
  getOwnPlaceFeedback: vi.fn(),
  getPlaceFeedbackSummary: vi.fn(),
  savePlaceFeedback: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  getOwnPlaceFeedback: mocks.getOwnPlaceFeedback,
  getPlaceFeedbackSummary: mocks.getPlaceFeedbackSummary,
  savePlaceFeedback: mocks.savePlaceFeedback,
}));

vi.mock('@/lib/accountRepository', () => ({
  loadFeedbackLearningBase: vi.fn(),
  saveFeedbackLearningProfile: vi.fn(),
}));

vi.mock('@/lib/preferenceLearning', () => ({
  hasProcessedPreferenceObservation: vi.fn(() => false),
}));

vi.mock('@/lib/preferenceLearningFeedback', () => ({
  buildPlaceFeedbackObservation: vi.fn(() => ({ observation: null, reasons: [], signalKey: 'test' })),
}));

vi.mock('@/lib/personalization', () => ({
  loadLocalPersonalization: vi.fn(() => null),
  markLocalPersonalizationObservation: vi.fn((snapshot) => snapshot),
  previewPreferenceObservationFromSnapshot: vi.fn((snapshot) => snapshot),
  previewPreferenceObservationLocally: vi.fn(() => null),
  saveLocalPersonalization: vi.fn(),
}));

const subjectA: PlaceFeedbackSubject = { userId: 'subject-a', isAnonymous: false };
const subjectB: PlaceFeedbackSubject = { userId: 'subject-b', isAnonymous: false };

const feedbackA = {
  id: 'feedback-a',
  placeId: 'same-place',
  rating: 1 as const,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('usePlaceFeedback subject boundary', () => {
  it('resets unsaved input on subject changes and ignores a previous subject save completing later', async () => {
    mocks.getOwnPlaceFeedback.mockResolvedValue(undefined);
    mocks.getPlaceFeedbackSummary.mockResolvedValue([]);
    let resolveSaveA!: (value: typeof feedbackA) => void;
    mocks.savePlaceFeedback
      .mockReturnValueOnce(new Promise((resolve) => { resolveSaveA = resolve; }))
      .mockResolvedValueOnce({ ...feedbackA, id: 'feedback-b', rating: -1 });

    function FeedbackView({ subject }: { subject: PlaceFeedbackSubject }) {
      const state = usePlaceFeedback('same-place', [], subject);
      return <PlaceFeedbackPanel {...state} onSave={state.save} />;
    }
    const { getByTestId, queryByTestId, queryByText, rerender } = render(<FeedbackView subject={subjectA} />);
    await waitFor(() => expect(mocks.getOwnPlaceFeedback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryByText('記録を読み込んでいます…')).toBeNull());
    fireEvent.change(getByTestId('place-feedback-visited-at'), { target: { value: '2026-09-21' } });
    fireEvent.click(getByTestId('place-feedback-rating-1'));

    rerender(<FeedbackView subject={subjectB} />);
    expect((getByTestId('place-feedback-visited-at') as HTMLInputElement).value).toBe('');
    expect(getByTestId('place-feedback-rating-1').getAttribute('aria-checked')).toBe('false');
    await waitFor(() => expect(mocks.getOwnPlaceFeedback).toHaveBeenCalledTimes(2));

    rerender(<FeedbackView subject={subjectA} />);
    await waitFor(() => expect(mocks.getOwnPlaceFeedback).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(queryByText('記録を読み込んでいます…')).toBeNull());
    fireEvent.click(getByTestId('place-feedback-rating-1'));
    fireEvent.click(getByTestId('place-feedback-save'));
    await waitFor(() => expect(mocks.savePlaceFeedback).toHaveBeenCalledTimes(1));

    rerender(<FeedbackView subject={subjectB} />);
    await waitFor(() => expect(mocks.getOwnPlaceFeedback).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(queryByText('記録を読み込んでいます…')).toBeNull());
    fireEvent.click(getByTestId('place-feedback-rating--1'));
    await act(async () => { resolveSaveA(feedbackA); });
    expect(queryByTestId('place-feedback-owned')).toBeNull();
    expect(getByTestId('place-feedback-rating--1').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(getByTestId('place-feedback-save'));
    await waitFor(() => expect(mocks.savePlaceFeedback).toHaveBeenLastCalledWith('same-place', { rating: -1 }, undefined));
  });

  it('同じplaceのA→B切替では即時にAのsnapshotを隠し、遅延A応答を破棄する', async () => {
    let resolveA!: (value: typeof feedbackA) => void;
    let resolveB!: (value: undefined) => void;
    mocks.getOwnPlaceFeedback
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
    mocks.getPlaceFeedbackSummary.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ subject }: { subject: PlaceFeedbackSubject }) =>
        usePlaceFeedback('same-place', [], subject),
      { initialProps: { subject: subjectA } },
    );
    await waitFor(() => expect(mocks.getOwnPlaceFeedback).toHaveBeenCalledWith('same-place'));

    rerender({ subject: subjectB });
    expect(result.current.feedback).toBeUndefined();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveA(feedbackA);
      await Promise.resolve();
    });
    expect(result.current.feedback).toBeUndefined();

    await waitFor(() => expect(mocks.getOwnPlaceFeedback).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveB(undefined);
      await Promise.resolve();
    });
    expect(result.current.feedback).toBeUndefined();
  });

  it('BのsaveはAのfeedback idを引き継がず、署名なしsubjectも本人行を読まない', async () => {
    mocks.getOwnPlaceFeedback
      .mockResolvedValueOnce(feedbackA)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    mocks.getPlaceFeedbackSummary.mockResolvedValue([]);
    mocks.savePlaceFeedback.mockResolvedValue({ ...feedbackA, rating: -1 });

    const { result, rerender } = renderHook(
      ({ subject }: { subject: PlaceFeedbackSubject }) =>
        usePlaceFeedback('same-place', [], subject),
      { initialProps: { subject: subjectA } },
    );
    await waitFor(() => expect(result.current.feedback?.id).toBe('feedback-a'));

    rerender({ subject: subjectB });
    expect(result.current.feedback).toBeUndefined();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.save({ rating: -1 });
    });
    expect(mocks.savePlaceFeedback).toHaveBeenCalledWith(
      'same-place',
      { rating: -1 },
      undefined,
    );

    rerender({ subject: { userId: null, isAnonymous: false } });
    expect(result.current.feedback).toBeUndefined();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.getOwnPlaceFeedback).toHaveBeenCalledTimes(2);
  });
});
