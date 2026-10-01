// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { usePlaceFeedback } from '@/hooks/usePlaceFeedback';

describe('usePlaceFeedback (#110)', () => {
  it('loads the own row, saves it, then updates the same row through the facade', async () => {
    const { result } = renderHook(() => usePlaceFeedback('hook-place-110'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.feedback).toBeUndefined();

    await act(async () => {
      await result.current.save({ visitedAt: '2026-08-24', rating: 1 });
    });
    expect(result.current.feedback).toMatchObject({
      placeId: 'hook-place-110',
      visitedAt: '2026-08-24',
      rating: 1,
    });
    const firstId = result.current.feedback?.id;

    await act(async () => {
      await result.current.save({ visitedAt: '2026-08-25', rating: 0 });
    });
    expect(result.current.feedback?.id).toBe(firstId);
    expect(result.current.feedback).toMatchObject({ visitedAt: '2026-08-25', rating: 0 });
    expect(result.current.error).toBeNull();
  });

  it('surfaces a fixed user-facing error when saving fails', async () => {
    const { result } = renderHook(() => usePlaceFeedback('hook-place-110-error'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      try {
        await result.current.save({});
      } catch {
        // UI側で固定エラーを表示するため、hookは状態を保持して再throwする。
      }
    });
    expect(result.current.error).toBe('来店記録を保存できませんでした。入力内容と通信状態を確認してください。');
  });
});
