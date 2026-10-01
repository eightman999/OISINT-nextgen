// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useInvestigation } from '@/hooks/useInvestigation';
import type { Investigation } from '@/types';

const mocks = vi.hoisted(() => ({
  getInvestigation: vi.fn(() => undefined),
  getInvestigationAsync: vi.fn(),
  subscribeInvestigation: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  isLiveDataProvider: true,
  getInvestigation: mocks.getInvestigation,
  getInvestigationAsync: mocks.getInvestigationAsync,
  subscribeInvestigation: mocks.subscribeInvestigation,
}));

const snapshotA = {
  id: 'private-a',
  title: 'A private investigation',
  status: 'complete',
  rawQuery: 'A private query',
  requirements: [],
  candidates: [],
  members: [],
  events: [],
  shareToken: 'share-a',
  visibility: 'private',
} as unknown as Investigation;

afterEach(() => {
  vi.clearAllMocks();
});

describe('useInvestigation subject boundary', () => {
  it('A→B切替直後はprivate snapshotを隠し、遅延A fetch/realtimeを無視し、B 404後にAへ戻さない', async () => {
    let resolveA!: (value: Investigation) => void;
    let resolveB!: (value: undefined) => void;
    const listeners: ((next: Investigation) => void)[] = [];
    mocks.getInvestigationAsync
      .mockReturnValueOnce(new Promise((resolve) => { resolveA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveB = resolve; }));
    mocks.subscribeInvestigation.mockImplementation((_id: string, listener: (next: Investigation) => void) => {
      listeners.push(listener);
      return vi.fn();
    });

    const { result, rerender } = renderHook(
      ({ subject }: { subject: string }) => useInvestigation('private-a', subject),
      { initialProps: { subject: 'permanent:subject-a' } },
    );
    await waitFor(() => expect(mocks.getInvestigationAsync).toHaveBeenCalledTimes(1));

    rerender({ subject: 'permanent:subject-b' });
    expect(result.current.investigation).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => {
      resolveA(snapshotA);
      listeners[0]?.(snapshotA);
      await Promise.resolve();
    });
    expect(result.current.investigation).toBeNull();

    await waitFor(() => expect(mocks.getInvestigationAsync).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveB(undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.error).toBe('調査が見つかりません'));
    expect(result.current.investigation).toBeNull();
  });
});
