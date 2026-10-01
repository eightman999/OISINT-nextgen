// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_HANDOFF_STORAGE_KEY,
  clearPendingAccountHandoff,
  completePendingAccountHandoff,
  loadPendingAccountHandoff,
  prepareGoogleAccountHandoff,
} from '@/lib/accountHandoff';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ isLiveDataProvider: true }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    functions: { invoke: mocks.invoke },
  },
}));

const operationId = '00000000-0000-4000-8000-000000001166';
const localStorageValues = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => localStorageValues.get(key) ?? null,
  setItem: (key: string, value: string) => localStorageValues.set(key, value),
  removeItem: (key: string) => localStorageValues.delete(key),
  clear: () => localStorageValues.clear(),
};

describe('account handoff local boundary (#166)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'localStorage', { configurable: true, value: localStorageMock });
    localStorageMock.clear();
    mocks.rpc.mockResolvedValue({ data: operationId, error: null });
    mocks.invoke.mockResolvedValue({ data: { status: 'completed' }, error: null });
  });

  afterEach(() => {
    clearPendingAccountHandoff();
  });

  it('匿名subjectをRPC引数へ渡さず、サーバー発行operationだけを保存する', async () => {
    await expect(prepareGoogleAccountHandoff('anonymous-subject-a')).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith('prepare_account_handoff');
    expect(mocks.rpc.mock.calls[0]).toEqual(['prepare_account_handoff']);
    const saved = loadPendingAccountHandoff();
    expect(saved?.operationId).toBe(operationId);
    expect(saved?.subjectId).toBe('anonymous-subject-a');
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain('anonymous-subject-a');
  });

  it('不正なRPC応答ではOAuth用状態を保存せずfail-closedする', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 'not-an-operation', error: null });
    await expect(prepareGoogleAccountHandoff('anonymous-subject-a')).rejects.toThrow();
    expect(window.localStorage.getItem(ACCOUNT_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it('同一subjectだけが完了EdgeへoperationIdを送り、成功後にpendingを消す', async () => {
    await prepareGoogleAccountHandoff('anonymous-subject-a');
    await expect(completePendingAccountHandoff('anonymous-subject-a')).resolves.toEqual({
      status: 'completed',
    });
    expect(mocks.invoke).toHaveBeenCalledWith('complete-account-handoff', {
      body: { operationId },
    });
    expect(JSON.stringify(mocks.invoke.mock.calls)).not.toContain('anonymous-subject-a');
    expect(loadPendingAccountHandoff()).toBeNull();
  });

  it('別subject・不正応答・Edgeエラーは送信成功や所有権移管として扱わない', async () => {
    await prepareGoogleAccountHandoff('anonymous-subject-a');
    await expect(completePendingAccountHandoff('permanent-subject-b')).resolves.toEqual({
      status: 'none',
    });
    expect(mocks.invoke).not.toHaveBeenCalled();

    await prepareGoogleAccountHandoff('anonymous-subject-a');
    mocks.invoke.mockResolvedValueOnce({ data: { status: 'unexpected' }, error: null });
    await expect(completePendingAccountHandoff('anonymous-subject-a')).rejects.toThrow();
    expect(loadPendingAccountHandoff()).not.toBeNull();

    mocks.invoke.mockResolvedValueOnce({ data: null, error: new Error('unauthorized') });
    await expect(completePendingAccountHandoff('anonymous-subject-a')).rejects.toThrow();
    expect(loadPendingAccountHandoff()).not.toBeNull();
  });

  it('期限切れ・壊れたlocal状態を読み取り時に削除する', () => {
    window.localStorage.setItem(
      ACCOUNT_HANDOFF_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        operationId,
        subjectId: 'anonymous-subject-a',
        createdAt: Date.now() - 16 * 60 * 1000,
      }),
    );
    expect(loadPendingAccountHandoff()).toBeNull();
    expect(window.localStorage.getItem(ACCOUNT_HANDOFF_STORAGE_KEY)).toBeNull();

    window.localStorage.setItem(ACCOUNT_HANDOFF_STORAGE_KEY, '{broken');
    expect(loadPendingAccountHandoff()).toBeNull();
    expect(window.localStorage.getItem(ACCOUNT_HANDOFF_STORAGE_KEY)).toBeNull();
  });
});
